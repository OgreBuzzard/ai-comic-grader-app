// =============================================================================
// ROBOGRADE PROMPT VERSION
// =============================================================================
// Bump this string EVERY TIME the scoring/defect rules in the prompt
// below change. The value is interpolated into the JSON schema the model
// fills in, so a stale value here silently mis-stamps the prompt version
// on every assessment record.
//
// Schema versioning convention:
//   hundredths (+0.01) — minor tweaks (wording, clarification)
//   tenths (+0.1)      — new rule, new defect category, gate change,
//                        scoring change
//   whole (+1.0)       — milestone release
//
// History:
//   2.5 — facsimile detection + pre-API MISSING_COVER gate (S13)
//   3.0 — pre-convention milestone (S13/early S14) — live during convention launch
//   3.1 — neutral signature rule + Robograde 92 ceiling cap (S14, post-convention)
//   3.2 — STAPLE INSPECTION PROTOCOL: replaces default-clean staple assertions
//         with required observation, resolution-honesty path, and precision
//         widening when staples can't be reliably inspected (S14 May 22)
//   3.3 — SPINE TICK INSPECTION PROTOCOL + enhancement tagging: required
//         systematic sweep of spine edge for white-on-color ticks, severity
//         rubric tied to Spine score deductions, pressing/cleaning candidate
//         tags for non-color-breaking defects (S14 May 22)
// =============================================================================
import { ROBOGRADE_VERSION } from '../lib/version.js';
import { PRIMARY_MODEL, MAIN_EFFORT, ratesFor, costOf } from '../lib/model.js';
import { parseAblation, applyAblation } from '../lib/ablation.js';
import { anthropicWithRetry, fetchTimeout } from '../lib/anthropic_retry.js';
import { getBookNote } from '../lib/book_notes.js';
import { defectIndexPromptBlock } from '../lib/defect_index.js';
import { buildMainPrefix } from '../lib/main_prompt.js';
import { enforceCgcGrade } from '../lib/grade_definitions.js';
import { computePhotograderPM, mergePhotograder, PHOTOGRADER_RUBRIC_MAIN } from '../lib/photograder.js';
import { reserveCredit, refundCredit, insufficientCreditsPayload } from '../lib/credits.js';

// ── A/B TEST TOGGLE (TEMPORARY) ──────────────────────────────────────
// When true, the ComicVine reference is suppressed for ALL assessments so we
// can compare with-reference vs without-reference grades on ASM 1 / ASM 8.
// Set false (or delete) after the A/B is done. The per-request suppressReference
// body flag also works; this constant forces it globally for the test.
const AB_FORCE_SUPPRESS_REFERENCE = false;

export default async function handler(req, res) {
  // CORS: the iOS Capacitor app calls this endpoint cross-origin (local file
  // origin → robograder.app), which triggers a preflight OPTIONS request with
  // custom headers (Authorization, Accept: text/event-stream). The PWA is
  // same-origin and never preflights. Answer the preflight before the POST gate.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-client-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // ── v3.99c: SSE streaming mode ──────────────────────────────────────────────
  // Clients that send `Accept: text/event-stream` get phase events as the
  // assessment progresses, followed by a final result event. Phase boundaries
  // are detected by scanning the streaming JSON output for field markers
  // (gateResult / pageQuality / grade / roboGrade). No prompt change is needed.
  //
  // Clients that omit the Accept header (or send anything else) get the legacy
  // single-shot JSON response unchanged. The two paths are kept fully separate
  // so a bug in streaming can never corrupt the working JSON flow.
  const acceptHeader = (req.headers['accept'] || req.headers['Accept'] || '').toLowerCase();
  const wantsSSE = acceptHeader.includes('text/event-stream');

  // SSE event writer. Sends one event per call. No-op when wantsSSE is false.
  // The writer is safe to call before headers are set — it lazy-initializes
  // the SSE response on first event.
  let sseInitialized = false;
  function sseEvent(type, dataObj) {
    if (!wantsSSE) return;
    if (!sseInitialized) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Disable nginx-style proxy buffering if any layer respects this hint.
      res.setHeader('X-Accel-Buffering', 'no');
      sseInitialized = true;
    }
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(dataObj)}\n\n`);
      // Flush if available. Vercel's Node response doesn't expose flush()
      // on all runtimes; the optional chain prevents a crash where it
      // doesn't exist.
      if (typeof res.flush === 'function') res.flush();
    } catch (e) {
      // If the client disconnected mid-stream, write() throws. Nothing to
      // do — the timing record still gets written in the finally path.
    }
  }

  // SSE-aware error responder. In SSE mode, emits an error event and ends
  // the stream; otherwise falls through to res.status().json().
  function sseError(status, payload) {
    if (wantsSSE) {
      sseEvent('error', { status, ...payload });
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(status).json(payload);
  }
  // ── end v3.99c SSE setup ────────────────────────────────────────────────────

  // ── S15 phase timing instrumentation ─────────────────────────────────────
  // Wall-clock deltas at phase boundaries. Server-only — never sent to the
  // Anthropic API (zero token cost). Attached to the response under
  // _diagnostics.phaseTimings, and written fire-and-forget to a Firestore
  // collection `assessment_timings/{roboGradeId}` (or a timestamp key on
  // failure) for aggregate analysis across many assessments.
  //
  // Purpose: diagnose where the ~50% timeout failure rate is coming from.
  // Until we have data on which phase dominates wall time, any "fix" is a
  // guess.
  const T0 = Date.now();
  const phaseTimings = {};
  function markPhase(name) {
    phaseTimings[name] = Date.now() - T0;
  }
  function phaseDelta(name, since) {
    phaseTimings[name] = Date.now() - since;
  }

  // ── Abuse prevention helpers ─────────────────────────────────────────────
  // Inline so the function can be invoked from anywhere in the handler.
  const STRIKE_LOCKOUT_THRESHOLD = 3;
  const STRIKE_LOCKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const STRIKE_LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000;
  const STRIKE_PERMANENT_THRESHOLD = 10;
  const STRIKE_PERMANENT_WINDOW_MS = 96 * 60 * 60 * 1000;
  // S20: two strike categories. HARD = true non-comic abuse (strict 3/24h + the
  // 10/96h permanent flag). SOFT = comic-type failures (crop failure, missing
  // images, etc.) — a more lenient 10/24h gate so an occasional bad photo from a
  // legit high-volume user doesn't lock them, while someone hammering the same
  // book with a single cover 40× still gets stopped.
  const HARD_STRIKE_GATES = ['NOT_COMIC', 'FLAGGED'];
  const STRIKE_SOFT_THRESHOLD = 10;
  const STRIKE_SOFT_WINDOW_MS = 24 * 60 * 60 * 1000;

  function countStrikesInWindow(strikeHistory, windowMs) {
    if (!Array.isArray(strikeHistory)) return 0;
    const cutoff = Date.now() - windowMs;
    return strikeHistory.filter(s => {
      const t = new Date(s.timestamp).getTime();
      return !isNaN(t) && t >= cutoff;
    }).length;
  }

  // Lazy-init Firebase Admin and return a getFirestore instance, or null on error.
  async function getAdminDb() {
    try {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      }
      return getFirestore();
    } catch(e) {
      console.error('Firebase Admin init failed:', e);
      return null;
    }
  }

  // Verify the Firebase ID token from the Authorization header. Returns uid or null.
  async function verifyUidFromAuthHeader(req) {
    try {
      const auth = req.headers.authorization || req.headers.Authorization || '';
      const m = auth.match(/^Bearer\s+(.+)$/);
      if (!m) return null;
      const idToken = m[1];
      const { getAuth } = await import('firebase-admin/auth');
      // Initialize admin app if not already done
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      }
      const decoded = await getAuth().verifyIdToken(idToken);
      return decoded.uid;
    } catch(e) {
      console.error('Token verification failed:', e);
      return null;
    }
  }

  // ── Anthropic media type normalization ───────────────────────────────────
  function normalizeMediaType(mt) {
    if (!mt) return 'image/jpeg';
    const clean = mt.toLowerCase().split(';')[0].trim();
    const valid = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (valid.includes(clean)) return clean;
    if (clean === 'image/jpg') return 'image/jpeg';
    return 'image/jpeg'; // safe fallback
  }
  const COMICVINE_API_KEY = process.env.COMICVINE_API_KEY || '';
  const {
    images,
    slotsFilled = null,    // S11: explicit slot map (front/back/interior/raking).
                           // Older clients may not send this; we infer from array length when null.
    grader = 'CGC',
    cgcGrade = null,
    cgcGraderNotes = '',
    psaGraderNotes = '',
    title = '',
    issueNumber = '',
    issueYear = null,
    issueDate = '',  // client sends 'Mon YYYY' (e.g. 'Nov 1988'); used to disambiguate book_notes printings by year
    suppressReference = false,  // A/B DIAGNOSTIC: when true, skip the ComicVine
                                // reference fetch entirely so we can compare
                                // with-reference vs without-reference grades.
    highGrade = false,
    initialRoboGrade = null,
    initialCgcGrade = '',
    initialPsaGrade = '',
    // S15 May 29: graded/slabbed book signal. The client's slab detector
    // (slab-detect.js) sets this when a CGC/PSA/CBCS label is found on the
    // front cover; the camera flow then captures only front+back (interior
    // can't be shot through the case). When true: the prompt gets an isGraded
    // block (interior derived from the label's PQ designation, spine inferred
    // from front+back), and the precision modifier uses the graded ladder
    // (10 standard / per Deep) rather than the photo-count default — a 2-photo
    // graded assessment is MORE certain than a 2-photo raw one because the
    // missing photos are structurally absent, not skipped.
    labelDetected = false,
    labelKind = '',
    // S16: when mode === 'slabcheck', assess.js does NOT run an assessment —
    // it makes a tiny Haiku vision call to decide if the front photo shows a
    // graded slab, logs cost/latency, and returns { detected, company }.
    mode = null,
    // S22 (Batch): the book's identity is already settled from its original
    // assessment and has not changed — same stored images, same book. When this
    // is present, PHASE 0 skips re-deriving title/issue/date/publisher/printing
    // and echoes these back instead. The GATE half of PHASE 0 (COMIC /
    // NOT_COMIC / FLAGGED / CROP_FAILURE) still runs in full; only the
    // identification work is skipped.
    knownIdentity = null,
    // S22: 'batch' adds a second cache breakpoint after the user images so the
    // 4 photos bill at ~10% on passes 2-5 instead of full price five times.
    // Absent (every ordinary assessment) => behaviour is exactly as before.
    cacheProfile = null
  } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  // ── S16: slab-detection micro-call (mode:'slabcheck') ───────────────────────
  // A tiny Haiku vision call answering "is this comic in a graded slab case?"
  // at capture time, so the camera flow can skip interior/PQ/raking photos for
  // slabbed books (which can't be opened). Folded into assess.js to reuse auth,
  // the Anthropic key, and the assessment_timings logging — and to stay under
  // what was then a 12-function Vercel ceiling. (STALE as of 2026-10-11: the
  // account is on Vercel PRO — there is no function limit and no cron limit.
  // Folding it in here is still fine, but it is no longer forced.)
  // ~$0.001–0.003/call (Haiku, one image, ~10-token answer). NEVER charges a
  // credit. Logged to assessment_timings with kind:'slabcheck' so cost + speed
  // appear in the admin Logs tab. Returns { detected, company, costUsd, ms }.
  if (mode === 'slabcheck') {
    const _sc0 = Date.now();
    const uid = await verifyUidFromAuthHeader(req);
    if (!uid) return res.status(401).json({ error: 'auth required' });
    // Front cover = images[0]; accept a data-URL string or {data, mediaType}.
    let imgBlock = null;
    try {
      const front = images[0];
      if (typeof front === 'string' && front.startsWith('data:')) {
        const comma = front.indexOf(',');
        const header = front.slice(0, comma);
        const data = front.slice(comma + 1);
        const rawType = (header.match(/data:(.*);base64/) || [])[1];
        imgBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(rawType), data } };
      } else if (front && front.data) {
        imgBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(front.mediaType || front.media_type), data: front.data } };
      }
    } catch (e) { imgBlock = null; }
    if (!imgBlock) return res.status(400).json({ error: 'no front image' });

    const scPrompt = 'You are looking at a photo of a single collectible. First decide its TYPE. If it is a TRADING CARD — a small rigid card such as Pokémon, a sports card, or Magic: The Gathering, whether raw or in a card slab — respond ONLY with {"isCard": true, "slab": false, "company": null} and nothing else. Otherwise it is a COMIC BOOK (a magazine-sized paper book); decide whether the comic is encapsulated in a rigid third-party GRADING SLAB (a sealed hard plastic case with a printed grading label across the top — CGC, PSA, or CBCS) or is RAW (no case and no grading label; a raw comic\'s top edge is its own cover art — publisher banner, price box, barcode — which is NOT a grading label). Respond with ONLY a JSON object and nothing else: {"isCard": false, "slab": true or false, "company": "CGC" | "PSA" | "CBCS" | null}. Set company only when slab is true and you can read which grader; otherwise null.';

    let scText = '', scIn = 0, scOut = 0, scModel = '', scStop = '';
    try {
      const _scBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: [imgBlock, { type: 'text', text: scPrompt }] }]
      });
      const scResp = await anthropicWithRetry(
        (remainingMs) => fetchTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: _scBody
        }, remainingMs),
        { deadlineMs: 20000, maxAttempts: 3, label: 'slabcheck' }
      );
      const scJson = await scResp.json();
      scModel = scJson.model || '';
      scStop = scJson.stop_reason || '';
      if (scJson.usage) { scIn = scJson.usage.input_tokens || 0; scOut = scJson.usage.output_tokens || 0; }
      const tb = Array.isArray(scJson.content) ? scJson.content.find(b => b.type === 'text') : null;
      scText = tb ? tb.text : '';
    } catch (e) {
      return res.status(502).json({ error: 'slabcheck upstream failed' });
    }

    let detected = false, company = null, isCard = false;
    try {
      const mt = scText.match(/\{[\s\S]*\}/);
      const obj = mt ? JSON.parse(mt[0]) : {};
      isCard = obj.isCard === true;
      detected = !isCard && obj.slab === true;
      company = detected && ['CGC', 'PSA', 'CBCS'].includes(obj.company) ? obj.company : null;
    } catch (e) { detected = false; company = null; isCard = false; }

    const scMs = Date.now() - _sc0;
    // Haiku 4.5 pricing: $1/M input, $5/M output.
    const scCost = +((scIn * (1 / 1e6)) + (scOut * (5 / 1e6))).toFixed(6);

    // Fire-and-forget timing log → shows in the admin Logs tab.
    (async () => {
      try {
        const db = await getAdminDb();
        if (!db) return;
        const key = `slab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.collection('assessment_timings').doc(key).set({
          kind: 'slabcheck',
          uid,
          createdAt: new Date().toISOString(),
          totalMs: scMs,
          inputTokens: scIn,
          outputTokens: scOut,
          costUsd: scCost,
          responseModel: scModel,
          stopReason: scStop,
          slabDetected: detected,
          slabCompany: company,
          isCard: isCard,
          rawText: typeof scText === 'string' ? scText.slice(0, 500) : null
        });
      } catch (e) { console.error('slabcheck timing write failed (non-fatal):', e); }
    })();

    return res.status(200).json({ detected, company, isCard, costUsd: scCost, ms: scMs, model: scModel });
  }

  // ── Front + back cover requirement (server-side gate, pre-API) ─────────────
  // Every assessment must include both a front and back cover photo. Single-cover
  // assessments are blocked because (a) facsimile editions can hide markers on
  // either side and the model needs both to confidently identify reprints, and
  // (b) public listings require both, so allowing single-cover assessments would
  // produce un-listable records.
  //
  // This check uses the explicit slotsFilled map when sent by the client (post-S11
  // clients always send it); falls back to "must have at least 2 images" for older
  // clients. No credit is charged on this failure — the client routes the user
  // back to the Edit view with a message.
  {
    const _hasFront = slotsFilled ? !!slotsFilled.front : (images.length >= 1);
    const _hasBack  = slotsFilled ? !!slotsFilled.back  : (images.length >= 2);
    if (!_hasFront || !_hasBack) {
      return res.status(200).json({
        gateResult: 'MISSING_COVER',
        gateReason: !_hasFront && !_hasBack
          ? 'Both front and back cover photos are required.'
          : !_hasFront
            ? 'A front cover photo is required.'
            : 'A back cover photo is required.',
        missingCover: {
          frontMissing: !_hasFront,
          backMissing:  !_hasBack
        },
        _diagnostics: { gateTerminated: true, preApiGate: true }
      });
    }
  }

  // ── Server-side abuse check ──────────────────────────────────────────────
  // Verify the user's identity, check for permanent flag or active lockout.
  // Fails open on infrastructure error (no service account, network issue) so
  // legitimate users aren't locked out by our problems. Client also checks.
  let _authedUid = null;
  let _userRef = null;
  let _userData = null;
  let _creditsRemaining = null;   // S22: echoed to the client so it can sync
  try {
    const uid = await verifyUidFromAuthHeader(req);
    if (uid) {
      _authedUid = uid;
      const db = await getAdminDb();
      if (db) {
        _userRef = db.collection('users').doc(uid);
        const snap = await _userRef.get();
        if (snap.exists) {
          _userData = snap.data();
          if (_userData.accountFlagged) {
            return res.status(403).json({
              error: 'account_flagged',
              message: 'Your account has been flagged for review due to repeated invalid uploads. Please contact support if you believe this is an error.'
            });
          }
          if (_userData.assessmentLockedUntil) {
            const unlockAt = new Date(_userData.assessmentLockedUntil).getTime();
            if (unlockAt > Date.now()) {
              return res.status(429).json({
                error: 'temp_lockout',
                unlockAt: _userData.assessmentLockedUntil,
                message: `Assessment temporarily locked due to repeated invalid uploads. Try again after ${new Date(_userData.assessmentLockedUntil).toLocaleString()}.`
              });
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('Abuse check failed (continuing):', e);
  }

  // ── SERVER-SIDE CREDIT FLOOR (S22, note 9646) ────────────────────────────
  // Everything above this line is free: the slabcheck micro-call returns before
  // it, and MISSING_COVER is answered before it. From here on we are about to
  // spend an Opus call, so the balance is checked FIRST and the request is
  // refused with 402 if the user cannot pay. See lib/credits.js for why this
  // debits only for clients that opt in with `serverCredits`.
  let _creditDebited = false;
  // A Batch pass is PRE-PAID: assess_batch_start.js already took 3 credits in a
  // transaction before any pass ran, and assess_batch_run.js forwards the user's
  // token to this endpoint five times. Charging here would bill the batch a
  // second time — and would 402 the user out of a batch they already paid for.
  // cacheProfile 'batch' is set only by assess_batch_run.js; a normal client
  // never sends it.
  const _isBatchPass = (req.body && req.body.cacheProfile) === 'batch';
  const _CREDIT_COST = _isBatchPass ? 0 : 1;
  try {
    const _db = await getAdminDb();
    const _r = await reserveCredit(_db, _authedUid, {
      cost: _CREDIT_COST,
      debit: req.body && req.body.serverCredits === true,
      label: _isBatchPass ? 'batchpass' : 'main'
    });
    _creditDebited = _r.debited;
    _creditsRemaining = _r.remaining;
  } catch (e) {
    if (e && e.code === 'insufficient_credits') {
      return sseError(402, insufficientCreditsPayload(e, _CREDIT_COST));
    }
    console.error('[credits:main] unexpected reserve failure (continuing):', e);
  }
  // Hand the debited credit back. Safe to call on any exit path: it no-ops
  // unless THIS request actually took the credit.
  async function _refundIfDebited(why) {
    if (!_creditDebited) return;
    _creditDebited = false;
    console.log('[credits:main] refunding —', why);
    try { await refundCredit(await getAdminDb(), _authedUid, _CREDIT_COST, 'main'); }
    catch (e) { console.error('[credits:main] refund threw:', e && e.message); }
  }

  const imageBlocks = images.map(img => {
    const [header, data] = img.split(',');
    const rawType = header.match(/data:(.*);base64/)[1];
    return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(rawType), data } };
  });

  // Fetch with timeout helper
  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetch page quality reference image (used for all raw book assessments).
  // Prefer pq_psa.jpg (v2.1+ — built from PSA-graded interior photos with PSA's
  // designations), fall back to pq.jpg (the original CGC-grading-book scan).
  // The fallback exists so deployments work cleanly during the upgrade window
  // before pq_psa.jpg is uploaded to the repo. Once it lands, every assessment
  // uses it automatically.
  async function fetchPageQualityReference(baseUrl) {
    const candidates = [
      `${baseUrl}/Grade_Reference/pq_psa.jpg`,
      `${baseUrl}/Grade_Reference/pq.jpg`
    ];
    for (const url of candidates) {
      try {
        const resp = await fetchWithTimeout(url, {}, 4000);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        const b64 = Buffer.from(buf).toString('base64');
        return {
          imageBlock: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          isPsaReference: url.endsWith('pq_psa.jpg')
        };
      } catch (e) {
        // try next candidate
      }
    }
    return null;
  }

  // Fetch grade reference image for the assessed grade.
  // Files on disk: 0_5, 1_0, 1_5, 1_8, 2_0, 2_5, 3_0, 3_5, 4_0, 4_5,
  // 5_0, 5_5, 6_0, 6_5, 7_0, 7_5, 8_0, 8_5, 9_0, 9_2, 9_4, 9_6, 9_8, 9_9, 10_0.
  async function fetchGradeReference(grade, baseUrl) {
    const validGrades = [
      '0.5','1.0','1.5','1.8','2.0','2.5','3.0','3.5','4.0','4.5',
      '5.0','5.5','6.0','6.5','7.0','7.5','8.0','8.5','9.0','9.2','9.4','9.6','9.8','9.9','10.0'
    ];
    const gradeStr = String(parseFloat(grade).toFixed(1));
    if (!validGrades.includes(gradeStr)) return null;
    const filename = gradeStr.replace('.', '_') + '.jpg';
    const url = `${baseUrl}/Grade_Reference/${filename}`;
    try {
      const resp = await fetchWithTimeout(url, {}, 4000);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const ct = resp.headers.get('content-type') || 'image/jpeg';
      return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(ct), data: b64 } };
    } catch (e) {
      return null;
    }
  }


  // Build grader notes context to append to prompts
  const notesContext = [];
  if (cgcGraderNotes && cgcGraderNotes.trim()) {
    notesContext.push(`OFFICIAL CGC GRADER NOTES FOR THIS BOOK:\n${cgcGraderNotes.trim()}\nThese are the official defects documented by CGC graders. Factor in any interior defects listed here (staple rust, page quality issues, centerfold detachment, interior tanning, etc.) that may not be visible in the photos when forming your regrade assessment.`);
  }
  if (psaGraderNotes && psaGraderNotes.trim()) {
    notesContext.push(`OFFICIAL PSA GRADER NOTES FOR THIS BOOK:\n${psaGraderNotes.trim()}\nThese are the official defects documented by PSA graders. Factor these in when forming your assessment.`);
  }
  // Per-book artwork/production correction note (lib/book_notes.js), keyed by
  // title + issue + year so it attaches only to the intended printing. Prevents
  // the grader from scoring an intrinsic art element as a defect. The year comes
  // from issueDate ('Mon YYYY'); fall back to issueYear if a numeric year is sent.
  const _noteYear = (() => {
    const m = String(issueDate || '').match(/(?:19|20)\d{2}/);
    if (m) return Number(m[0]);
    return (typeof issueYear === 'number' && issueYear > 1900) ? issueYear : null;
  })();
  let _bookNote = getBookNote(title, issueNumber, _noteYear, 'main');
  if (_bookNote) {
    notesContext.push(`BOOK-SPECIFIC NOTE FOR THIS TITLE/ISSUE:\n${_bookNote}`);
  }
  let notesBlock = notesContext.length > 0 ? '\n\n' + notesContext.join('\n\n') : '';

  const isCGC = true; // Unified prompt — PSA and RoboGrade derived within single pass

  // Fetch ComicVine cover reference image if title and issue are available
  let referenceImageBlock = null;
  let referenceBackImageBlock = null;  // local back-cover reference (ComicVine has covers only)
  let referenceYear = null;  // cover-date year of the ComicVine issue we pulled (diagnostic)
  let referenceVolumeName = null;  // which volume/series we chose (diagnostic)
  let referenceImageUrl = null;  // the actual CV cover URL, persisted for admin side-by-side display
  let referenceBackImageUrl = null;  // local back-cover URL (when a local reference is used)
  let refDebug = 'localref: not run';  // persisted diagnostic: why local reference did/didn't apply
  const baseUrl = req.headers['host']
    ? `https://${req.headers['host']}`
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'https://robograder.app');   // never empty — local reference fetch needs a base

  // Reference lookup identity. On a fresh capture the client sends no title/issue,
  // so these start empty and the reference is resolved AFTER the main model has
  // identified the book (see the post-model reference block below), using its
  // accurate title/issue. When the client DOES supply them (slabs, manual entry),
  // the reference is also resolved pre-model here so it can inform grading too.
  let refTitle = title, refIssue = issueNumber, refYear = issueYear;
  let refIdDebug = (title && issueNumber) ? 'id=client' : 'id=none';

  // No pre-model identify call. The book is identified for free by the main
  // grading model; the reference (local reference_covers, else ComicVine) is
  // resolved AFTER grading using that accurate title/issue and shown for display.
  // See the post-model reference block further down. ComicVine's own pre-model
  // path (from a client-supplied title, e.g. re-assessments/slabs) is unchanged.

  // ── Reference-cover title aliases ────────────────────────────────────────
  // S22 BUG (Matt, Uncanny X-Men #1): the file uncanny-x-men_1_1963_front.jpg was
  // sitting in reference_covers/ and never used. refDebug said why:
  //   postmodel(HIT iss="1" x-men_1_1963->404, x-men_1->404 cv=HIT)
  // The 1963 book is literally titled "The X-Men", so the model returns that, the
  // slugifier strips the article, and we look for x-men_1_1963. The app only shows
  // "Uncanny X-Men" because normalizeTitle() canonicalises it CLIENT-side, long
  // after this lookup has already fallen through to ComicVine.
  //
  // So the lookup gets the same folding the FMV key has: a small table of titles
  // the trade knows by more than one name. Every alias is tried, so a file named
  // either way is found. Add a pair here when a reference file exists but refDebug
  // shows a 404 on a near-miss slug.
  const REF_TITLE_ALIASES = [
    ['x-men', 'uncanny-x-men'],
    ['incredible-hulk', 'hulk'],
    ['invincible-iron-man', 'iron-man'],
    ['mighty-thor', 'thor'],
    ['journey-into-mystery', 'thor'],
    ['amazing-spider-man', 'spider-man'],
  ];
  function refSlugCandidates(title) {
    const slug = x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const out = new Set();
    // Raw and de-"The" — reference files are named without a leading article.
    const seeds = [slug(String(title).replace(/^the\s+/i, '')), slug(title)].filter(Boolean);
    seeds.forEach(sd => {
      out.add(sd);
      for (const [a, b] of REF_TITLE_ALIASES) {
        if (sd === a) out.add(b);
        else if (sd === b) out.add(a);
      }
    });
    return [...out];
  }

  // LOCAL REFERENCE COVERS (served from /reference_covers/). If clean front/back
  // scans exist for this exact book, use them and SKIP ComicVine — higher quality,
  // no rate limit, and we also get the BACK cover (ComicVine gives covers only).
  // Filenames mirror the reference-library sheet: <title-slug>_<issue>[_<year>]_front.jpg / _back.jpg.
  let usedLocalRef = false;
  let runComicVine = null;  // defined in the isCGC block; reused by the post-model reference lookup
  // Diagnostic: if the local-reference block is skipped, record WHY (so refDebug
  // is never a silent 'not run'). The block below overwrites refDebug on run.
  const _refSkip = !baseUrl ? 'no baseUrl' : !refTitle ? 'no title' : !refIssue ? 'no issueNumber'
    : suppressReference ? 'suppressReference=true' : AB_FORCE_SUPPRESS_REFERENCE ? 'AB_FORCE_SUPPRESS_REFERENCE=true' : null;
  if (_refSkip) refDebug = refIdDebug + ' | localref skip: ' + _refSkip + ' (title=' + JSON.stringify(refTitle) + ' iss=' + JSON.stringify(refIssue) + ')';
  if (baseUrl && refTitle && refIssue && !suppressReference && !AB_FORCE_SUPPRESS_REFERENCE) {
    try {
      const _dbg = [];
      // Raw, de-"The", and any aliased title (see REF_TITLE_ALIASES).
      const _slugs = refSlugCandidates(refTitle);
      const _iss = String(refIssue).replace(/^#/, '').replace(/^0+(\d)/, '$1').trim();
      const _yr = (() => {
        if (typeof refYear === 'number' && refYear > 1900) return refYear;
        const _m = String(issueDate || '').match(/(?:19|20)\d{2}/);   // client sends year as issueDate 'Mon YYYY'
        if (_m) return Number(_m[0]);
        return null;
      })();
      const _bases = [];
      for (const _s of _slugs) {
        if (_yr) _bases.push(`${_s}_${_iss}_${_yr}`);
        _bases.push(`${_s}_${_iss}`);
      }
      for (const _b of _bases) {
        const _frontUrl = `${baseUrl}/reference_covers/${_b}_front.jpg`;
        const _fr = await fetchWithTimeout(_frontUrl, {}, 5000);
        _dbg.push(_b + '->' + _fr.status);
        if (!_fr.ok) continue;
        const _fbuf = await _fr.arrayBuffer();
        referenceImageBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(_fr.headers.get('content-type')), data: Buffer.from(_fbuf).toString('base64') } };
        referenceImageUrl = _frontUrl;
        referenceVolumeName = 'Local reference';
        referenceYear = _yr;
        usedLocalRef = true;
        try {
          const _backUrl = `${baseUrl}/reference_covers/${_b}_back.jpg`;
          const _br = await fetchWithTimeout(_backUrl, {}, 5000);
          if (_br.ok) {
            const _bbuf = await _br.arrayBuffer();
            referenceBackImageBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(_br.headers.get('content-type')), data: Buffer.from(_bbuf).toString('base64') } };
            referenceBackImageUrl = _backUrl;
          }
        } catch (e) { /* back optional */ }
        console.log(`[localref] used ${_b} front=yes back=${referenceBackImageBlock ? 'yes' : 'no'} -> skipping ComicVine`);
        break;
      }
      refDebug = refIdDebug + ' | base=' + baseUrl + ' | ' + (usedLocalRef ? 'HIT ' : 'MISS ') + (_dbg.length ? _dbg.join(', ') : 'no candidates tried');
    } catch (e) { refDebug = 'localref ERROR: ' + String((e && e.message) || e); }
  }

  // Run ComicVine cover fetch and page quality fetch in parallel
  let pageQualityImageBlock = null;
  let pqIsPsaReference = false;  // true once pq_psa.jpg is uploaded; prompt language adapts
  if (isCGC) {
    runComicVine = async function(cvTitle, cvIssue, cvYearHint) {
      try {
        const searchTitle = String(cvTitle).replace(/^The\s+/i, '').trim();
        const targetIss = String(cvIssue).replace(/^0+/, '');
        const hintYear = (() => {
          if (typeof cvYearHint === 'number' && cvYearHint > 1930) return cvYearHint;
          const _m = String(issueDate || '').match(/(?:19|20)\d{2}/);   // client sends year in issueDate 'Mon YYYY'
          if (_m) return Number(_m[0]);
          return null;
        })();  // disambiguates same-title volumes (e.g. Daredevil 1964 Marvel vs golden-age)
        const yearFrom = (s) => { const m = String(s||'').match(/(\d{4})/); return m ? parseInt(m[1],10) : null; };

        // VOLUME-FIRST LOOKUP. The fuzzy /search endpoint relevance-ranks modern
        // issues first and buries the vintage original below the result cap, so
        // "Amazing Spider-Man 8" was pulling a 2018/2022 relaunch cover, not the
        // 1963 original — useless on exactly the vintage keys that matter.
        // Instead: (1) find VOLUMES by title, (2) choose the right volume by
        // start_year (earliest = original series by default; closest to a
        // client year hint when provided), (3) fetch THAT volume's specific
        // issue number directly. This asks ComicVine for "issue N of the 1963
        // volume" explicitly rather than hoping the original ranks high enough.
        // VOLUME CACHE (Firestore): the /volumes endpoint is what ComicVine rate-limits,
        // so caching the volume list once per title is the main fix for the ~90% no-volume
        // failures. A cached hit skips the endpoint entirely.
        const _cvDb = await getAdminDb();
        const _norm = x => String(x||'').toLowerCase().replace(/^the\s+/,'').replace(/[^a-z0-9]+/g,' ').trim();
        const _volKey = (_norm(searchTitle).replace(/\s+/g,'-') || 'x');
        let volumes = null;
        if (_cvDb) { try { const _vc = await _cvDb.collection('cv_volume_cache').doc(_volKey).get(); if (_vc.exists) { volumes = (_vc.data()||{}).volumes || null; if (volumes) console.log(`[cvcache] volume HIT ${_volKey} (${volumes.length})`); } } catch(e){} }
        if (!volumes) {
          const volUrl = `https://comicvine.gamespot.com/api/volumes/?api_key=${COMICVINE_API_KEY}&format=json&filter=name:${encodeURIComponent(searchTitle)}&field_list=id,name,start_year,count_of_issues&limit=50`;
          const volResp = await fetchWithTimeout(volUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 5000);
          if (!volResp.ok) return;
          const volData = await volResp.json();
          if (volData.status_code && volData.status_code !== 1) { console.log(`[cvcache] volume lookup rate-limited/err status=${volData.status_code} title="${searchTitle}"`); return; }
          const _st = _norm(searchTitle);
          volumes = (volData.results || []).filter(v => { const vn = _norm(v.name); return vn === _st || vn.startsWith(_st) || _st.startsWith(vn); });
          if (!volumes.length) volumes = volData.results || [];
          if (volumes.length && _cvDb) { try { await _cvDb.collection('cv_volume_cache').doc(_volKey).set({ volumes: volumes.map(v => ({ id: v.id, name: v.name, start_year: v.start_year })), title: searchTitle, cachedAt: Date.now() }); console.log(`[cvcache] volume STORE ${_volKey} (${volumes.length})`); } catch(e){} }
        }
        if (!volumes || !volumes.length) return;
        // Choose the volume.
        // S25 disambiguation fix: an Annual/Special/King-Size/Giant-Size sub-series
        // is a SEPARATE volume whose start_year can beat the main series on a year
        // hint (e.g. "Fantastic Four Annual" start 1963 vs "Fantastic Four" 1961 for
        // a 1963-hinted FF #27 -> wrongly pulled Annual #27/1994). So: if the book
        // is NOT an annual, drop annual/special variants from the pool; if it IS,
        // keep only those. Then prefer an exact title match before the year sort.
        const _variantRe = /\b(annual|special|king size|giant size|giant sized)\b/;
        const _isAnnualQ = _variantRe.test(_norm(searchTitle));
        let _pool = volumes.slice();
        if (_isAnnualQ) {
          const _ann = _pool.filter(v => _variantRe.test(_norm(v.name)));
          if (_ann.length) _pool = _ann;
        } else {
          const _clean = _pool.filter(v => !_variantRe.test(_norm(v.name)));
          if (_clean.length) _pool = _clean;
        }
        const _exact = _pool.filter(v => _norm(v.name) === _norm(searchTitle));
        if (_exact.length) _pool = _exact;
        volumes = _pool;
        let vol;
        if (hintYear) {
          vol = volumes.slice().sort((a,b) => {
            const ya = yearFrom(a.start_year), yb = yearFrom(b.start_year);
            const da = ya===null?9999:Math.abs(ya-hintYear), db = yb===null?9999:Math.abs(yb-hintYear);
            return da - db;
          })[0];
        } else {
          // Earliest start_year = original series. Volumes with no year sort last.
          vol = volumes.slice().sort((a,b) => {
            const ya = yearFrom(a.start_year), yb = yearFrom(b.start_year);
            if (ya===null && yb===null) return 0;
            if (ya===null) return 1;
            if (yb===null) return -1;
            return ya - yb;
          })[0];
        }
        if (!vol || !vol.id) return;
        referenceVolumeName = `${vol.name||''} (${vol.start_year||'?'})`;
        // COVER CACHE (Firestore): cache the resolved cover URL by volume+issue so a
        // repeat book skips the /issues endpoint too.
        const _coverKey = `${vol.id}_${targetIss}`;
        let refUrl = null;
        if (_cvDb) { try { const _cc = await _cvDb.collection('cv_cover_cache').doc(_coverKey).get(); if (_cc.exists) { const _d = _cc.data()||{}; refUrl = _d.url || null; referenceYear = (_d.year ?? null); if (refUrl) console.log(`[cvcache] cover HIT ${_coverKey}`); } } catch(e){} }
        if (!refUrl) {
          const issUrl = `https://comicvine.gamespot.com/api/issues/?api_key=${COMICVINE_API_KEY}&format=json&filter=volume:${vol.id},issue_number:${encodeURIComponent(targetIss)}&field_list=image,cover_date,issue_number&limit=1`;
          const issResp = await fetchWithTimeout(issUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 5000);
          if (!issResp.ok) return;
          const issData = await issResp.json();
          if (issData.status_code && issData.status_code !== 1) { console.log(`[cvcache] issue lookup rate-limited/err status=${issData.status_code}`); return; }
          const match = (issData.results || [])[0];
          referenceYear = match ? yearFrom(match.cover_date) : null;
          console.log(`[comicvine] title="${searchTitle}" iss=${targetIss} matched=${volumes.length} chosen=${vol?`${vol.name} (${vol.start_year})`:'NONE'} issue=${match?'found':'none'} image=${match&&match.image?'yes':'no'}`);
          if (match && match.image) {
            const img = match.image;
            refUrl = img.original_url || img.super_url || img.screen_large_url || img.screen_url || img.medium_url || null;
          }
          if (refUrl && _cvDb) { try { await _cvDb.collection('cv_cover_cache').doc(_coverKey).set({ url: refUrl, title: searchTitle, volumeName: vol.name || '', year: referenceYear, volumeId: vol.id, issue: targetIss, cachedAt: Date.now() }); console.log(`[cvcache] cover STORE ${_coverKey}`); } catch(e){} }
        }
        if (refUrl) {
          referenceImageUrl = refUrl;
          const imgResp = await fetchWithTimeout(refUrl, {}, 5000);
          if (imgResp.ok) {
            const imgBuffer = await imgResp.arrayBuffer();
            referenceImageBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(imgResp.headers.get('content-type')), data: Buffer.from(imgBuffer).toString('base64') } };
          }
        }
      } catch (e) { /* CV fetch failed — proceed without reference */ }
    }
    const cvFetch = (refTitle && refIssue && COMICVINE_API_KEY && !suppressReference && !AB_FORCE_SUPPRESS_REFERENCE && !usedLocalRef) ? runComicVine(refTitle, refIssue, refYear) : Promise.resolve();

    const pqFetch = baseUrl ? fetchPageQualityReference(baseUrl).then(r => {
      if (r) {
        pageQualityImageBlock = r.imageBlock;
        pqIsPsaReference = r.isPsaReference;
      }
    }) : Promise.resolve();
    const _refImageStart = Date.now();
    await Promise.all([cvFetch, pqFetch]);
    phaseDelta('refImageFetchMs', _refImageStart);

    // First-pass fallback: if the client sent no cover year, any year-ranged book
    // note (lib/book_notes.js) was skipped above. Now that ComicVine has
    // identified the issue, use its cover year to fire the note — disambiguated
    // by the volume CV actually matched, so it can't attach to the wrong printing.
    if (!_bookNote && _noteYear == null && referenceYear) {
      const _bnCV = getBookNote(title, issueNumber, referenceYear, 'main');
      if (_bnCV) {
        _bookNote = _bnCV;
        notesBlock += `\n\nBOOK-SPECIFIC NOTE FOR THIS TITLE/ISSUE:\n${_bnCV}`;
        console.log(`[booknote] fired via ComicVine year ${referenceYear} for "${title}" #${issueNumber}`);
      }
    }
  }






  // ── Census lookup ──────────────────────────────────────────────────────────
  // Full 2,359-issue CGC census table lives in ../lib/census.js (outside api/ = NOT built as a Vercel function; it is a pure data module, and the 12-function cap is real). We import the
  // formatter function and call it with this book's title+issue. On match,
  // we inject both the census data AND the wrapper instructions about how
  // to use it. On no-match (the majority of calls — we cover ~2,500 issues
  // out of millions), we inject nothing, saving ~800 tokens per call.
  // The underlying table size has no effect on per-assessment token cost.
  // Build the full census block conditionally. When there's no census match,
  // we skip the entire instructional wrapper too — sending ~800 tokens of
  // "don't mention the census" guidance with no census attached costs money
  // for no benefit. Only inject when there's actual data to anchor against.
  let censusBlock = '';
  let _censusMatched = false;
  try {
    const { formatCensusForPrompt } = await import('../lib/census.js');
    const censusContext = formatCensusForPrompt(title, issueNumber) || '';
    if (censusContext) {
      _censusMatched = true;
      censusBlock = `

CGC CENSUS DATA (Phase 3 calibration anchor for this specific issue):
${censusContext}
CRITICAL — CENSUS USE IS INTERNAL ONLY: the census data above is a calibration anchor for you, NOT a fact to share with the user. aiAssessment and labelNotes are user-visible. NEVER mention the census, submission counts, average grades across submissions, distribution percentages, statistical priors, or population data. NEVER write things like "the census average for this book is X," "most copies grade lower," "statistically this should be a Y," "based on submission data," or "I'm anchoring to the population." The user must read the assessment as if you graded only what you see in their photos. If census data influences your grade, justify the grade using on-the-book observations only. The census is a sanity check, not an override — when in doubt, trust the photos.`;
    }
  } catch (e) {
    console.error('[census] lookup failed, continuing without census context:', e?.message || e);
  }

  // ── Photo availability ──────────────────────────────────────────────────────
  // hasInteriorPhoto: whether the user submitted a photo intended as interior/page-quality
  //   reference. Trust the explicit slotsFilled map when the client sent one; fall back
  //   to "3+ images implies an interior was probably included" for older clients.
  // hasPQReference: whether we successfully fetched the PQ reference image from the repo.
  // Both are needed for a meaningful page quality assessment — the reference alone is
  // useless without an interior to compare against.
  const hasInteriorPhoto = slotsFilled
    ? !!slotsFilled.interior
    : images.length >= 3;
  const hasPQReference = pageQualityImageBlock !== null;
  const photoCount     = images.length;
  // Base confidence range (= precision modifier, PM). RG ceiling = 100 - PM.
  //   Slabbed standard: PM 10 (ceiling 90)
  //   Slabbed Deep:     PM 4  (ceiling 96)
  //   Raw Deep:         PM 3  (ceiling 97)
  //   Raw 4 images:     PM 8  (ceiling 92)
  //   Raw 3 images:     PM 12 (ceiling 88)
  //   Raw 2 images:     PM 15 (ceiling 85)
  const baseConf = labelDetected
    ? (highGrade ? 4 : 10)
    : (highGrade
        ? 3
        : (photoCount >= 4 ? 8 : photoCount === 3 ? 12 : 15));
  const rgCeiling = 100 - baseConf;

  // Predicted grade ceiling depends on assessment tier + image count.
  // VK status does NOT affect ceilings — it only affects which tiers unlock.
  const gradeCeiling = labelDetected
    ? null  // slabbed: label grade is ceiling (handled in prompt)
    : (highGrade
        ? 9.6   // Deep Assessment
        : (photoCount >= 4 ? 9.2 : 8.5)); // Raw Main: 9.2 (4 imgs) / 8.5 (fewer)

  // ── High-grade block ────────────────────────────────────────────────────────
  // When highGrade=true, 4 corner macros (TL, TR, BL, BR) are appended after the
  // standard 4 images. The initial RG is passed in so we can enforce the floor
  // rule and keep Back/Interior scores unchanged (those categories aren't
  // re-examined by corner macros).
  const initialRGScore  = (highGrade && initialRoboGrade && typeof initialRoboGrade.score === 'number') ? Math.round(initialRoboGrade.score) : null;
  const initialFront    = (highGrade && initialRoboGrade && typeof initialRoboGrade.frontScore    === 'number') ? Math.round(initialRoboGrade.frontScore)    : null;
  const initialBack     = (highGrade && initialRoboGrade && typeof initialRoboGrade.backScore     === 'number') ? Math.round(initialRoboGrade.backScore)     : null;
  const initialSpine    = (highGrade && initialRoboGrade && typeof initialRoboGrade.spineScore    === 'number') ? Math.round(initialRoboGrade.spineScore)    : null;
  const initialInterior = (highGrade && initialRoboGrade && typeof initialRoboGrade.interiorScore === 'number') ? Math.round(initialRoboGrade.interiorScore) : null;

  const highGradeBlock = highGrade ? `
## HIGH-GRADE ASSESSMENT MODE

This is a second-pass high-grade assessment. The user has added 4 corner macros (positions 5-8 in the image set, order: Top Left, Top Right, Bottom Left, Bottom Right of the FRONT cover) to allow tighter grading.

INITIAL ASSESSMENT (from the standard 4-photo pass):
• Initial RG: ${initialRGScore != null ? initialRGScore : 'unknown'}
• Initial CGC: ${initialCgcGrade || 'unknown'}
• Initial component scores — Front: ${initialFront ?? '?'}, Back: ${initialBack ?? '?'}, Spine: ${initialSpine ?? '?'}, Interior: ${initialInterior ?? '?'}

RULES FOR HIGH-GRADE ASSESSMENT:

1. FLOOR RULE: The initial grades are a floor, not a guess. The final RG must be ≥ ${initialRGScore != null ? initialRGScore : 80} and the CGC grade must be ≥ ${initialCgcGrade || '8.0'}. Initial assessments on high-grade books tend to run conservative because wide shots don't show corner detail — the macros are here to confirm or raise, not lower.

2. DROP EXCEPTION: You may drop below the floor ONLY if a corner macro reveals a specific, describable defect that was not visible in the original wide shot (for example, a color-breaking stress line hidden by glare, or a tiny corner crease invisible at wide angle). If you drop, you must call out the specific new defect in aiAssessment with its exact location, and you must explain in aiAssessment why it wasn't visible before. If you cannot name a specific new defect, do not drop.

3. CATEGORIES YOU CAN CHANGE: Only Front and Spine. The corner macros give you more information about the front cover and the inner corners at the top and bottom of the spine. Back and Interior were not re-examined.

4. CATEGORIES YOU MUST NOT CHANGE: Back score stays at ${initialBack ?? 'initial value'}. Interior score stays at ${initialInterior ?? 'initial value'}. Copy these forward exactly from the initial assessment. Do not re-derive them.

5. RG RANGE: The final RG score must be in the range [${initialRGScore != null ? initialRGScore : 80}, 100]. CGC must be in [${initialCgcGrade || '8.0'}, 10.0].

6. CENSUS ANCHOR: Take the census distribution seriously. If 35%+ of submissions grade 9.4+, the book in front of you has a high prior probability of being 9.4+. If the average census grade is 9.5, a clean-looking copy should be in that vicinity. Do not under-grade a clean book because you feel cautious.

7. PRESUMPTION OF CLEAN: The default assumption for each corner macro is "this corner is clean and confirms a high grade." Only conclude a corner is damaged if you can specifically identify and name the defect. Do not invent defects.

8. CONFIDENCE: For high-grade assessments, set confidenceRange between 3 and 6. Default to 3 (corner macros provide tight evidence). Widen toward 6 only if specific image-quality issues impair your read: heavy glare obscuring a corner, blurred macro, raking light too oblique to evaluate stress lines. Do not widen for "general caution" — only for image-quality issues you can name. Never exceed 6 on a high-grade run.

9. FREQUENCY REMINDER: 40% of CGC-graded books receive a 9.8. This is the single most common outcome. If the book looks pristine in all 8 photos, 9.8 is the likely answer, not a conservative 9.4.

` : '';


  // ── RoboGrade formula (4-category, backwards from final score) ───────────────
  // Score = (Front × 0.5) + (Back × 0.2) + (Spine × 0.2) + (Interior × 0.1)
  // Spine includes inner corners at top and bottom of spine

  // ── CGC grade tier thresholds (factual allowances per grade, reworded) ────────
  // ── CGC grade tier definitions ───────────────────────────────────────────────
  // The CGC tier definitions, the multi-defect rule, gradeTierContext() and
  // the entire cached prefix of this prompt moved to lib/main_prompt.js in
  // v5.48, so api/cachewarm.js can send the REAL prefix for the keep-warm
  // ping. Read the banner at the top of that file before editing any of it.

  // ── S15 May 29: graded/slabbed-book prompt block ────────────────────────────
  // Injected into the system prompt only when labelDetected is true. Tells the
  // model it's seeing a slabbed book (front+back of the case only), how to
  // derive the interior/PQ from the label, how to infer spine, and to report
  // the grading company. Empty string for raw books (no behavior change).
  const gradedBlock = labelDetected ? `
GRADED / SLABBED BOOK — SPECIAL HANDLING (this assessment only):
This comic is encapsulated in a third-party grading case (CGC / PSA / CBCS). You are seeing ONLY the front and back of the slab — there is no interior or raking-light photo, because the book cannot be opened.
- INTERIOR / PAGE QUALITY: You cannot see the pages. Read the PAGE QUALITY designation printed on the label at the top of the front-cover photo (e.g. "WHITE PAGES", "OFF-WHITE TO WHITE", "OFF-WHITE") and use that as the page quality. Score the Interior sub-score from that designation, not from any visible page. If the label's page-quality text is unreadable (glare, angle, blur, or absent), DEFAULT to "Off-White to White" and an Interior sub-score of 9 of 10 — do not guess lower or higher.
- SPINE: There is no dedicated spine photo. Infer spine condition from what is visible at the spine edge in the front and back images. Apply slightly more caution to the spine sub-score given the limited view, but do not invent defects you cannot see.
- FRONT / BACK: Score normally from the two photos.
- GRADING COMPANY: State which company graded the book in aiAssessment — "Graded by CGC", "Graded by PSA", or "Graded by CBCS" — based on the label you can read. The client's color detector guessed: ${labelKind ? labelKind.toUpperCase() : 'unknown'} (use the actual label text if it disagrees).
- GLARE / TILT: Glare on the plastic case, blur, or a tilted label should reduce overall confidence, not invent defects.
` : '';

  // ── Unified system prompt: one image pass, neutral first, three grades ───────
  // S22 (Batch): pre-settled identity block, injected into PHASE 0.
  const _ki = (knownIdentity && typeof knownIdentity === 'object' && (knownIdentity.title || knownIdentity.issue)) ? knownIdentity : null;
  const knownIdentityBlock = _ki ? `
IDENTITY ALREADY ESTABLISHED — DO NOT RE-DERIVE IT.
This book was identified on a previous assessment of these same photos. Its identity is settled:
  title: ${_ki.title || ''}
  issue: ${_ki.issue || ''}
  issueDate: ${_ki.issueDate || ''}
  publisher: ${_ki.publisher || ''}
  printing: ${_ki.printing || ''}
Echo these values back VERBATIM in your output. Do NOT spend any effort reading the logo, cover date, indicia, price box or UPC to work out what the book is, and do NOT second-guess the values above — they are correct.
GATE CHECK: this exact image set already passed the gate on the earlier assessment, and the images have not changed since. Return gateResult "COMIC" and move straight to PHASE 1. Do not re-run the content classification or the crop check.
` : '';

  const systemPrompt = buildMainPrefix(_ki) + `§§CACHE_SPLIT§§${knownIdentityBlock}${gradedBlock}
Confidence base ±${baseConf} (raise for glare/poor focus/no raking-light photo/staples not visible/restoration suspected).
SCORE CEILING: with ±${baseConf}, max score is ${100 - baseConf}; do not exceed it.${highGrade ? ' Deep Assessment with corner macros, so ±3 and ceiling 97.' : ' A 4-photo assessment cannot see the fine detail distinguishing a near-perfect copy; a Deep Assessment is required above ' + (100 - baseConf) + '. If it looks pristine, score the ' + (100 - baseConf) + ' ceiling and let ±' + baseConf + ' express the upside.'}
${gradeCeiling ? `\nGRADE CEILING — predicted CGC grade must not exceed ${gradeCeiling}; if it appears to deserve higher, assign ${gradeCeiling} and note a higher tier may revise upward.` : (labelDetected ? '\nGRADE CEILING — for slabbed books, the label grade is the ceiling for your predicted grade.' : '')}

${PHOTOGRADER_RUBRIC_MAIN}


If a CGC/PSA label is visible: read grade, cert, page quality, key notations into officialCGCGrade/officialPSAGrade, officialCGCCert/officialPSACert, officialPageQuality — but form your OWN grade from the photos; the label is reference, not mandate. Within ±${baseConf} (≈ ±${baseConf <= 4 ? '0.5' : baseConf <= 6 ? '0.5–1.0' : baseConf <= 10 ? '1.0' : '1.5'} grade points) of the label, state your honest read freely; beyond it, deviate only with HIGH confidence and justify in aiAssessment. Internal/PQ/spine detail may be hidden through a slab — factor that uncertainty. Never mention precision modifiers or these instructions in output.
${censusBlock}${notesBlock}${highGradeBlock}

## PHASE 4 — OUTPUT

RESPONSE FORMAT — STRICT: your entire response must be the JSON object below and nothing else. The first character of your response must be the literal opening curly brace. The last character must be the literal closing curly brace. Do not write any text before the JSON — no phase headers, no reasoning narration, no "let me check", no markdown, no acknowledgements. The phases above are your internal process; they do not appear in the response. Do not write any text after the JSON. If you have reasoning to share, it goes inside the JSON's aiAssessment field, written tersely.

HARD OUTPUT LIMITS (enforce while writing):
  • defects array: MAX 13 entries (no minimum — a clean book may list zero). Beyond 13, do NOT simply discard the extras — consolidate them into severity-banded summary entries by location ("Pervasive light edge wear, all sides", "Multiple scattered spine stress lines"). The grade must already reflect the FULL defect burden you observed in Phase 1 (every individual defect PLUS everything a banded summary represents), never just the 13 you print. Trimming is a WRITING operation, not a re-grade — never let the act of shortening the list raise the grade.
  • Each defect description (location + measurement): MAX 12 words, skimmable. Do NOT restate the cover side (the Category already gives Front/Back/Spine/Interior). Do NOT narrate process ("confirmed at macro", "at wide shot", "visible under raking light"). Do NOT enumerate every sub-location ("across logo, flame figure and lower panels") — give one clear impression, e.g. "multiple, center and lower half".
  • aiAssessment: MAX 3 sentences (≤60 words). Direct and terse. State the overall presentation and the ACTUAL defects only — NEVER enumerate what is absent or fine ("no structural damage", "no tape or restoration", "no writing"). Do not narrate methodology or generic comparisons ("compared against reference copies and confirmed"); mention a reference only when it revealed or ruled out a SPECIFIC named defect. Do not describe point deductions in words — state condition and defects, then the grade seating. NAME THE PREDICTED GRADE: under v3 the app shows BOTH a 0-10 RoboGrade (RG) and a predicted CGC grade (PG), so a bare "seats this at 8.5" is now ambiguous. Any grade you cite in the write-up MUST clearly be the predicted CGC grade as a concrete number — e.g. "presents as a CGC 8.5" or "seats at a predicted 8.5" — never a bare number that could read as the RG. Do NOT hide the grade behind a vague band alone ("high end of the VF/NM range"); if you name a band, pair it with the concrete CGC number ("VF/NM, a CGC 8.5").
  • keyInfo: MAX 2 sentences. Empty string if uncertain.
  • photograder: REQUIRED, never omit. Always output the photograder object with focus, lighting, cropping, and angle each set to "A", "B", or "C" (a photo-quality grade for the user's shots — A good, B usable, C poor). Do not leave any of the four null or blank.
Over-elaboration in output is the dominant cause of slow runs. Be thorough in observation, brief in writing.

{
  "gateResult": "COMIC",
  "title": "series title, strip leading The",
  "issue": "e.g. 57 or A1. GOLD KEY / DELL CAUTION: these publishers frequently did NOT print a clear issue number on the cover. If the issue number is not plainly legible on the cover itself, output an EMPTY STRING rather than guessing — a blank issue is better than a wrong one. Do NOT infer the number from the cover date, price, or series context. (Pink Panther is Gold Key; Hogan's Heroes is Dell.)",
  "issueDate": "cover date as 'Mon YYYY' (e.g. 'Feb 1968'); season-only books 'Spr/Sum/Fall/Win YYYY'. For facsimile/reprint (see 'printing'), use the REPRINT year, not the original. Example: 2019 facsimile of AF #15 → 'Dec 2019', not 'Aug 1962'.",
  "publisher": "publisher name",
  "printing": "Printing/variant designation. EMPTY STRING for typical original printings (default). Populate ONLY with clear evidence: 'Facsimile Reprint' (append year in parens if visible) for modern facsimile editions of original key issues; '2nd print'/'3rd print' for direct-edition reprints from the original era; 'Newsstand variant' for distinguishable newsstand copies; 'Reprint' for older non-facsimile reprints. When populating 'Facsimile Reprint', note the finding in aiAssessment and use the reprint year for issueDate.",
  "pageQuality": "full designation e.g. Off-White to White",
  "grade": "CGC grade estimate. ONE OF THESE EXACT VALUES AND NOTHING ELSE: 0.5, 1.0, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.2, 9.4, 9.6, 9.8, 9.9, 10.0. This is the complete CGC/PSA scale; there are no values between them. 9.1, 9.3, 9.5 and 9.7 ARE NOT GRADES and no service issues them — above 9.0 the scale steps 9.0, 9.2, 9.4, 9.6, 9.8. If the book sits between two positions, you must choose one; choose the lower unless the evidence clearly supports the higher. DO NOT COPY THE v3 RoboGrade VALUE INTO THIS FIELD. v3 is a different scale — half-points from 0 to 10, where 9.5 is legal. This field is not that scale. Derive it from the defects you observed by grading down from a perfect copy, then state the ladder position that result lands on. Example: 7.0",
  "aiAssessment": "Overall impression, dominant defects, grade rationale. ONLY what you see in this copy's photos. NEVER mention census/submission counts/distribution/external data.",
  "referenceComparison": "CHECK 0 result: one sentence on what comparing to the ComicVine reference revealed (a specific missing/damaged region, or an art element confirmed printed), or that the cover matches with no reference-detectable loss, OR that the reference did NOT match this book and was not used (wrong volume/issue reference, or an unrecognizable book). Empty string if no reference was provided. This is a diagnostic field — it may surface to the user but must never mention census or external counts.",
  "labelNotes": "key issue notations from label if visible, empty string if none",
  "keyInfo": "Key-issue significance — populate ONLY if (a) the issue appears in injected census data AND (b) the fact is widely documented. Empty string otherwise.",
  "enhance": true,
  "labelDetected": false,
  "binding": "saddle | square | none — see the BINDING rule above. Default to saddle when unsure.",
  "bindingBasis": "<a few words on what in the images decided it, e.g. 'two staples visible on the spine fold' or 'flat squared spine, 100-page 1973 giant'>",
  "bindingConfidence": "high | low",
  "officialCGCGrade": null,
  "officialCGCCert": null,
  "officialPageQuality": null,
  "officialPSAGrade": null,
  "officialPSACert": null,
  "photograder": { "focus": "A", "lighting": "A", "cropping": "A", "angle": "A", "flags": [ {"category":"lighting","image":"Back Cover","note":"glare hiding lower half"} ] },
  "roboGrade": {
    "version": "${ROBOGRADE_VERSION}",
    "score": 0,
    "confidenceRange": ${baseConf},
    "frontScore": 0,
    "backScore": 0,
    "spineScore": 0,
    "interiorScore": 0,
    "pageQuality": "",
    "defects": [
      {"type":"","location":"","measurement":"","severity":"Med","colorBreaking":false,"category":"Front"}
    ],
    "restorationFlags": []
  },
  "signatures": []
}`;

  // ── DIAGNOSTIC OVERRIDES — OFF BY DEFAULT ─────────────────────────────────
  // Two request fields exist so a calibration round can vary the model and drop
  // one named prompt clause WITHOUT a deploy per arm. Absent, nothing below
  // changes: _activePrompt === systemPrompt and _activeModel === PRIMARY_MODEL.
  //
  // Auth: these are read from an ALREADY-AUTHENTICATED request. /api/assess
  // verifies a Firebase ID token before it reaches here, which is the same bar
  // every other field in the body is held to. There is deliberately no second,
  // stricter gate — an ADMIN_EMAILS check was tried on api/probe.js and that
  // variable only exists on the admin deployment, so the gate could never pass.
  //
  // Worst case if a client sent them: it grades itself with a slightly different
  // prompt. No credit, data or privacy consequence. An unknown clause id is
  // reported back rather than ignored, and a clause whose marker cannot be found
  // THROWS (see lib/ablation.js) rather than silently running a baseline that
  // would be written down as "the clause had no effect".
  //
  // CACHING: an ablated prompt is a different cached prefix, so an ablation arm
  // takes a cache MISS on its first call and costs more than a baseline arm.
  // That is expected; it does not affect the grade.
  //
  // See shared/_LIBRARY/OPUS_55_ABLATION_PLAN.md.
  const _abl = parseAblation(req.body && req.body.ablate);
  const _activeModel = (req.body && typeof req.body.model === 'string' && req.body.model.trim())
    ? req.body.model.trim()
    : PRIMARY_MODEL;
  let _activePrompt = systemPrompt;
  let _ablApplied = [];
  if (_abl.ids.length) {
    const r = applyAblation(systemPrompt, _abl.ids);
    _activePrompt = r.prompt;
    _ablApplied = r.applied;
    console.log('[ablation] applied ' + r.applied.join(',') + ' (-' + r.removedChars + ' chars), model ' + _activeModel);
  }
  // ALWAYS echoed, even on a completely normal assessment. The first version only
  // emitted this when something had been overridden, which broke the harness in a
  // way that looked exactly like a stale deploy: asking for --model claude-opus-5
  // (which IS the default) overrode nothing, so nothing came back, and the round
  // aborted reporting "the deploy does not have the override yet". It also left
  // every baseline row recording "(server default)" instead of the model that
  // actually graded it — the one fact a calibration CSV must not be vague about.
  const _diag = { model: _activeModel, ablated: _ablApplied, unknownAblate: _abl.unknown };


  try {
    markPhase('promptAssemblyAtMs');
    const _primaryStart = Date.now();

    // v3.99c: emit phase 0 (populating done) the moment we're about to call
    // Anthropic. All identification work (ComicVine fetch, image prep, gate
    // check, prompt assembly) is finished by this point. In SSE mode, the
    // client modal-tracker advances on this event. Non-SSE mode: no-op.
    sseEvent('phase', { phase: 0, name: 'populating' });

    // ── MODEL SELECTION (S17 calibration matrix) ─────────────────────────────
    // One-line switch for the model-comparison rounds. Sequence:
    //   Round 1: 'claude-fable-5'      ($10/$50 per M — 2x Opus 4.8)
    //   Round 2: 'claude-opus-4-6'     ($5/$25 — pre-jump baseline, ~$0.10/run)
    //   Round 3: 'claude-sonnet-4-6'   ($3/$15 — cost floor)
    //   Revert to 'claude-opus-4-8' (current production) after the matrix.
    // Round 2 (v4.21): Opus 4.6. VERIFIED: Opus 4.6 supports both
    // thinking:{type:'adaptive'} and output_config.effort (Anthropic in fact
    // recommends combining them on 4.6) — no payload changes needed vs 4.8.
    // Expect lower input-token cost (~$0.10/run) than 4.8's tokenizer.
    // v5.24: model id + rates now live in lib/model.js (one place, not thirteen).
    // Per-token rates per model (verified June 2026). Cost logging reads from
    // this table so the calibration matrix logs TRUE costs for every round.
    // Cache read = 10% of input rate; cache creation = 1.25x input rate.
    const _RATES = ratesFor(_activeModel);   // _activeModel is PRIMARY_MODEL unless a diagnostic override asked otherwise

    // Caching config — dashboard-controlled (config/caching doc). Default: on, 1h.
    let _cacheOn = true, _cacheTtl = '1h';
    try {
      const _cdb = await getAdminDb();
      if (_cdb) { const _cs = await _cdb.collection('config').doc('caching').get();
        if (_cs.exists) { const _c = _cs.data() || {};
          // Per-type caching (S21): gate Main comic on types.main. Fall back to the
          // legacy global `enabled` flag when a pre-per-type doc is present.
          const _t = _c.types;
          _cacheOn = _t ? (_t.main !== false) : (_c.enabled !== false);
          _cacheTtl = _c.ttl === '5m' ? '5m' : '1h'; } }
    } catch (e) {}
    const _cacheCtl = _cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    const _cacheBeta = (_cacheOn && _cacheTtl === '1h') ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } : {};

    // Build the messages payload (used by both streaming and non-streaming
    // branches; identical content either way).
    const _antBody = {
      model: _activeModel,
      // S15 May 29: explicitly set effort=medium via output_config. Opus 4.8's
      // default is 'high'; medium is the recommended default for non-coding
      // workloads. NOTE: on a structured-JSON output task with no thinking,
      // effort has limited impact on cost because output is dominated by the
      // mandated schema. Effort becomes meaningful when paired with thinking
      // (controls thinking depth) — see thinking field below.
      // IMPORTANT: effort lives inside output_config, NOT as a top-level
      // field. Per https://platform.claude.com/docs/en/build-with-claude/effort
      // the API silently ignores unknown top-level params, so a wrong shape
      // produces no error but also no behavior change.
      // S17 v4.211 (Opus 4.6 round): dropped medium → low. Opus 4.6 thinks
      // heavily on these books at effort=medium (primaryCallMs ~47s, near the
      // ~50s timeout, cost ~$0.15) whereas Opus 4.8 declines to think at all.
      // 'low' should curb 4.6's thinking, pull latency under control, and get
      // cost toward the expected <$0.10 — and gives the FAIR comparison to 4.8
      // (which effectively isn't thinking on these). If accuracy holds at low
      // effort, 4.6-low is the real cost-competitive option to weigh vs 4.8.
      // S24: effort now comes from lib/model.js (MAIN_EFFORT) so a calibration
      // round can change it in one place, next to the model id it is paired with.
      output_config: { effort: MAIN_EFFORT },
      // S15 May 29: enable adaptive thinking on Opus 4.8. Model decides when
      // and how much to think; effort=medium scopes the depth. The hope is
      // explicit reasoning helps the calibration step (defects → grade)
      // where prior calibration drift suggests the model was guessing. NOT
      // expected to help with perception (tape/missing-piece detection) —
      // that's a vision limit, not a reasoning limit. Watch the next PSA
      // calibration run for accuracy delta; revert this line if cost spikes
      // without an accuracy gain.
      thinking: { type: 'adaptive' },
      // S15 May 29: bumped 4096 → 16384. Thinking tokens count toward
      // max_tokens; 4096 risks the model running out mid-reasoning, which
      // would manifest as truncated JSON and parse failures. 16k gives
      // substantial thinking headroom + our ~1000-token JSON output without
      // overcommitting. Tune down if observed thinking tokens stay small.
      max_tokens: 16384,
      system: (() => { const _sp = _activePrompt.split('§§CACHE_SPLIT§§'); if (!_cacheOn) return _sp.join(''); return [{ type: 'text', text: _sp[0], cache_control: _cacheCtl }, { type: 'text', text: _sp[1] || '' }]; })(),
      messages: [{
        role: 'user',
        content: [
          ...(referenceImageBlock ? [
            { type: 'text', text: 'REFERENCE IMAGE(S): The following ' + (referenceBackImageBlock ? 'images are clean scans of the FRONT and BACK covers' : 'image is a clean cover scan') + ' of this exact issue, showing how the book should look without damage. Use them to identify missing pieces, color loss, and damage by comparing against your assessment photos.' },
            referenceImageBlock,
            ...(referenceBackImageBlock ? [
              { type: 'text', text: 'REFERENCE BACK COVER (clean scan of this issue\'s back cover):' },
              referenceBackImageBlock
            ] : [])
          ] : []),
          ...(pageQualityImageBlock ? [
            { type: 'text', text: pqIsPsaReference
              ? 'PAGE QUALITY REFERENCE (calibrated against PSA): The following image shows interior photos of real books that were professionally graded by PSA, labeled with PSA\'s actual page quality designation for each book. These are the ground-truth anchor for your page quality assessment. The reference covers the upper part of the scale (White through Off-White to White) — every interior shown is at OW/W or better. RULE: If the interior photo of the book you are assessing looks comparable in tone to ANY of the reference examples, assign Off-White to White or White accordingly — match the closest reference. Only assign Off-White or lower if the interior is visibly more tanned than EVERY reference image. The vast majority of Silver and Bronze Age books fall within this OW/W-and-better range. Use the same designations PSA uses (and which are also valid CGC designations).'
              : 'PAGE QUALITY REFERENCE: The following image shows the CGC page quality color scale from White (10) down to Tan (5). If any of your assessment photos show interior pages, compare the non-inked white space color against this scale to determine page quality. When in doubt, round up — most Silver and Bronze Age books grade at Off-White or higher.'
            },
            pageQualityImageBlock
          ] : []),
          ...(highGrade && imageBlocks.length >= 8 ? [
            { type: 'text', text: 'STANDARD ASSESSMENT PHOTOS (1-4): front cover, back cover, interior/page quality, raking light / spine.' },
            ...imageBlocks.slice(0, 4),
            { type: 'text', text: 'CORNER MACROS (5-8), in order: Top Left, Top Right, Bottom Left, Bottom Right of the front cover. Use these to confirm or refine the Front score only. Remember the floor rule and the drop exception from the HIGH-GRADE ASSESSMENT MODE section.' },
            ...imageBlocks.slice(4, 8)
          ] : imageBlocks),
          { type: 'text', text: highGrade
            ? 'Please perform the high-grade assessment. Apply the floor rule: the final RG and CGC grades must be at or above the initial values unless a specific new defect is identified in the corner macros. Carry Back and Interior scores forward unchanged. Return the JSON grading object.'
            : 'Please assess this comic. CRITICAL FIRST STEP: complete the STRUCTURAL DAMAGE SCAN (tape, paper loss, tears around staples and edges) BEFORE categorizing any other defects. Do not allow pattern-matching to common defects obscure structural damage. Then return the JSON grading object.' }
        ]
      }]
    };

    // ── S22: BATCH-ONLY second cache breakpoint, on the last user image ─────
    // Every ordinary assessment is untouched: this runs only when the batch
    // worker sends cacheProfile:'batch'. In a batch all five Main passes send
    // the SAME stored photos, the same known identity and the same flags, so
    // everything up to and including the images is byte-identical across passes
    // and can be read from cache at ~10% instead of paid for in full five times.
    // The reference/page-quality reference images sit ahead of the book photos
    // in the same content array, so they fall inside the prefix too.
    // Cache breakpoints change billing and latency only — never the model's
    // output — so the grades this produces are identical either way.
    if (cacheProfile === 'batch' && _cacheOn) {
      try {
        const _content = _antBody.messages[0].content;
        for (let i = _content.length - 1; i >= 0; i--) {
          if (_content[i] && _content[i].type === 'image') { _content[i].cache_control = _cacheCtl; break; }
        }
      } catch (e) { console.warn('[assess] batch image breakpoint skipped:', e.message); }
    }

    // ── v3.99c STREAMING BRANCH ────────────────────────────────────────────
    // Variables we need to produce regardless of branch:
    //   text                  : the model's raw output text
    //   _usage, _inputTokens, _outputTokens, _cacheReadInputTokens,
    //   _cacheCreationInputTokens, _stopReason, _responseModel  : token usage
    //
    // Both branches set these and then converge on the existing parse logic.
    let text;
    let _usage = {};
    // S23: filled in place by anthropicWithRetry so both the success and the
    // error record can say how many attempts it took and what the upstream
    // said. Without it a 50-second failure looks the same whether it was one
    // slow call or three 429s and two backoffs.
    const _retryStats = { attempts: 0, lastStatus: null, retried: false, waitedMs: 0 };
    let _inputTokens = null;
    let _outputTokens = null;
    let _cacheReadInputTokens = null;
    let _cacheCreationInputTokens = null;
    let _stopReason = null;
    let _responseModel = null;

    if (wantsSSE) {
      // Streaming branch: ask Anthropic for SSE, scan deltas for field
      // markers, forward phase events to our SSE client.
      _antBody.stream = true;
      const _streamBody = JSON.stringify(_antBody);

      const ctrl = new AbortController();
      const _streamTimeout = setTimeout(() => ctrl.abort(), 55000);

      let streamResponse;
      try {
        // The shared ctrl's 55s timer caps everything — retries AND the stream
        // body read. The retry only re-fires on a 429/529, which comes back at
        // the headers (before any stream body), so it's safe to retry here.
        streamResponse = await anthropicWithRetry(
          () => fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              ..._cacheBeta
            },
            body: _streamBody,
            signal: ctrl.signal
          }),
          { deadlineMs: 55000, maxAttempts: 3, label: 'primary-stream', stats: _retryStats }
        );
      } catch (e) {
        clearTimeout(_streamTimeout);
        throw e;
      }

      if (!streamResponse.ok) {
        clearTimeout(_streamTimeout);
        const errBody = await streamResponse.text();
        sseError(500, { error: 'Anthropic API error: ' + errBody, _diagnostics: { phaseTimings, primaryNotOk: true } });
        return;
      }

      // Consume the Anthropic SSE stream. Events look like:
      //   event: message_start
      //   data: {"type":"message_start", "message": {...}}
      //
      //   event: content_block_delta
      //   data: {"type":"content_block_delta", "delta":{"type":"text_delta","text":"..."}}
      //
      //   event: message_delta
      //   data: {"type":"message_delta", "usage":{"output_tokens":...}}
      //
      //   event: message_stop
      //   data: {"type":"message_stop"}
      //
      // We accumulate the text deltas, scan for field markers, and emit our
      // own SSE events to the downstream client at phase boundaries.
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      const phasesEmitted = new Set(); // 0 already emitted above; track 1-4
      let firstTokenSeen = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on SSE event delimiter (blank line).
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
          // Parse 'data: ...' line(s) from this event.
          const dataLines = evt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
          if (!dataLines.length) continue;
          const payload = dataLines.join('');
          let parsedEvt;
          try { parsedEvt = JSON.parse(payload); } catch (e) { continue; }
          const t = parsedEvt.type;
          if (t === 'content_block_delta' && parsedEvt.delta && parsedEvt.delta.type === 'text_delta') {
            const chunk = parsedEvt.delta.text || '';
            if (!firstTokenSeen && chunk) {
              firstTokenSeen = true;
              // Phase 1 (mint): model has begun producing tokens. Comparing
              // to the ComicVine reference happens in Phase 1 of the prompt.
              if (!phasesEmitted.has(1)) { sseEvent('phase', { phase: 1, name: 'mint' }); phasesEmitted.add(1); }
            }
            accumulated += chunk;
            // Scan for field markers (cheap substring checks; the markers
            // appear in stable JSON-field-declaration order).
            if (!phasesEmitted.has(2) && accumulated.includes('"pageQuality"')) {
              sseEvent('phase', { phase: 2, name: 'pq' });
              phasesEmitted.add(2);
            }
            if (!phasesEmitted.has(3) && accumulated.includes('"grade"')) {
              sseEvent('phase', { phase: 3, name: 'grading' });
              phasesEmitted.add(3);
            }
            if (!phasesEmitted.has(4) && accumulated.includes('"roboGrade"')) {
              sseEvent('phase', { phase: 4, name: 'confirming' });
              phasesEmitted.add(4);
            }
          } else if (t === 'message_start' && parsedEvt.message) {
            // Capture early usage info (input_tokens is set at message_start;
            // output_tokens is updated in message_delta).
            const u = parsedEvt.message.usage || {};
            _inputTokens = u.input_tokens || _inputTokens;
            _cacheReadInputTokens = u.cache_read_input_tokens || _cacheReadInputTokens;
            _cacheCreationInputTokens = u.cache_creation_input_tokens || _cacheCreationInputTokens;
            _responseModel = parsedEvt.message.model || _responseModel;
          } else if (t === 'message_delta') {
            const u = parsedEvt.usage || {};
            _outputTokens = u.output_tokens || _outputTokens;
            _stopReason = parsedEvt.delta && parsedEvt.delta.stop_reason || _stopReason;
          }
        }
      }

      clearTimeout(_streamTimeout);
      phaseDelta('primaryCallMs', _primaryStart);
      text = accumulated.trim();
      _usage = {
        input_tokens: _inputTokens,
        output_tokens: _outputTokens,
        cache_read_input_tokens: _cacheReadInputTokens,
        cache_creation_input_tokens: _cacheCreationInputTokens
      };

      // Safety net: if scanning didn't catch every phase (e.g. the model
      // narrated and the field markers never appeared in the expected
      // order), emit any unfired phases now so the client modal-tracker
      // can complete. The client's 1000ms floor will pace them.
      for (const [p, n] of [[1,'mint'],[2,'pq'],[3,'grading'],[4,'confirming']]) {
        if (!phasesEmitted.has(p)) { sseEvent('phase', { phase: p, name: n }); phasesEmitted.add(p); }
      }
    } else {
      // ── Non-streaming branch (legacy, byte-identical behavior) ──────────
      // S15: hard 55s timeout on the primary call. Vercel kills the function
      // at 60s; we need our own catch block to fire before then so the
      // timing data can be written to Firestore. Without this, a timed-out
      // assessment leaves no trace.
      const _primaryHeaders = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ..._cacheBeta };
      const _primaryBody = JSON.stringify(_antBody);
      const response = await anthropicWithRetry(
        (remainingMs) => fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: _primaryHeaders, body: _primaryBody
        }, remainingMs),
        { deadlineMs: 55000, maxAttempts: 3, label: 'primary' }
      );
      phaseDelta('primaryCallMs', _primaryStart);

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: 'Anthropic API error: ' + err, _diagnostics: { phaseTimings, primaryNotOk: true } });
      }

      const data = await response.json();
      // Capture token usage from Anthropic's response.
      _usage = (data && data.usage) || {};
      _inputTokens = _usage.input_tokens || null;
      _outputTokens = _usage.output_tokens || null;
      _cacheReadInputTokens = _usage.cache_read_input_tokens || null;
      _cacheCreationInputTokens = _usage.cache_creation_input_tokens || null;
      _stopReason = (data && data.stop_reason) || null;
      _responseModel = (data && data.model) || null;
      // S15 May 29: with adaptive thinking enabled (Opus 4.8), the first
      // content block is a 'thinking' block and content[0].text is undefined.
      // Find the text block by type rather than position. Falls back to
      // content[0].text for backward compat with non-thinking responses
      // (where content[0] IS the text block).
      const _textBlock = (data.content || []).find(b => b && b.type === 'text');
      text = (_textBlock ? _textBlock.text : data.content[0].text).trim();
    }

    const _rawTextChars = text.length;
    const _primaryParseStart = Date.now();
    let clean = text.replace(/```json/gi, '').replace(/```/g, '').replace(/'''/g, '').trim();
    const _fb = clean.indexOf('{'), _lb = clean.lastIndexOf('}');
    if (_fb !== -1 && _lb !== -1 && (_fb > 0 || _lb < clean.length - 1)) clean = clean.slice(_fb, _lb + 1);

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) {
      if (wantsSSE) {
        sseEvent('error', { error: 'Failed to parse response: ' + (text || '').slice(0, 500), _diagnostics: { phaseTimings, parseError: true } });
        try { res.end(); } catch (err) {}
        return;
      }
      return res.status(500).json({ error: 'Failed to parse response: ' + text, _diagnostics: { phaseTimings, parseError: true } });
    }
    phaseDelta('primaryParseMs', _primaryParseStart);

    // ── Gate check: if the model determined this isn't a comic or is flagged content,
    //    return early with a special response. Server records the strike
    //    (authoritative; client also tries but server is source of truth) and
    //    applies cool-off rules per STRIKE_LOCKOUT_* constants above.
    //
    //    All non-COMIC gate results record a strike — NOT_COMIC, FLAGGED, and
    //    CROP_FAILURE all count. CROP_FAILURE is included because a user gets 3
    //    strikes per day before any lockout, which is plenty of room to learn
    //    the photo requirements from a single mistake. Repeated crop failures
    //    in one day suggest intentional behavior or a failure to read the
    //    in-app guidance, both of which warrant the cool-off.
    if (parsed.gateResult && parsed.gateResult !== 'COMIC') {
      let _lockoutInfo = null;
      // Record strike server-side if we have an authenticated user
      if (_userRef) {
        try {
          const snap = await _userRef.get();
          const data = snap.exists ? snap.data() : {};
          const strikeHistory = Array.isArray(data.strikeHistory) ? [...data.strikeHistory] : [];
          const _cat = HARD_STRIKE_GATES.includes(parsed.gateResult) ? 'hard' : 'soft';
          strikeHistory.push({
            timestamp: new Date().toISOString(),
            gateResult: parsed.gateResult,
            category: _cat,
            reason: parsed.gateReason || ''
          });
          // Count by category (backfill category for legacy strikes via gateResult).
          const _catOf = s => s.category || (HARD_STRIKE_GATES.includes(s.gateResult) ? 'hard' : 'soft');
          const hardHist = strikeHistory.filter(s => _catOf(s) === 'hard');
          const softHist = strikeHistory.filter(s => _catOf(s) === 'soft');
          const hard24 = countStrikesInWindow(hardHist, STRIKE_LOCKOUT_WINDOW_MS);
          const soft24 = countStrikesInWindow(softHist, STRIKE_SOFT_WINDOW_MS);
          const hard96 = countStrikesInWindow(hardHist, STRIKE_PERMANENT_WINDOW_MS);
          const update = {
            strikes: strikeHistory.length,
            strikeHistory,
            lastStrikeAt: new Date().toISOString()
          };
          if (hard96 >= STRIKE_PERMANENT_THRESHOLD) {
            update.accountFlagged = true;
            update.flaggedAt = data.flaggedAt || new Date().toISOString();
            _lockoutInfo = { type: 'permanent' };
          } else if (hard24 >= STRIKE_LOCKOUT_THRESHOLD || soft24 >= STRIKE_SOFT_THRESHOLD) {
            update.assessmentLockedUntil = new Date(Date.now() + STRIKE_LOCKOUT_DURATION_MS).toISOString();
            _lockoutInfo = { type: 'temp', unlockAt: update.assessmentLockedUntil };
          }
          await _userRef.set(update, { merge: true });
        } catch(e) {
          console.error('Server-side strike recording failed:', e);
        }
      }
      phaseTimings.totalMs = Date.now() - T0;
      // A gate termination is not a graded book, so it must not cost a credit.
      // The client has always treated gate failures as free; now the server does
      // too, for the clients whose credit it actually took.
      await _refundIfDebited('gate ' + (parsed.gateResult || 'terminated'));
      const _gatePayload = {
        gateResult: parsed.gateResult,
        gateReason: parsed.gateReason || '',
        cropFailure: parsed.cropFailure || null,
        lockout: _lockoutInfo,
        _diagnostics: {
          // Echoed so the harness writes down what ACTUALLY ran. null on a
          // normal assessment. Without this, an arm that silently failed to
          // apply would be recorded as a result for that arm.
          diag: _diag,
          comicvineRef: referenceImageBlock !== null,
          censusMatched: _censusMatched,
          pageQualityRef: pageQualityImageBlock !== null,
          pageQualityRefIsPsa: pqIsPsaReference,
          hasInteriorPhoto: hasInteriorPhoto,
          gateTerminated: true,
          phaseTimings: phaseTimings
        }
      };
      if (wantsSSE) {
        sseEvent('result', _gatePayload);
        try { res.end(); } catch (e) {}
        return;
      }
      return res.status(200).json(_gatePayload);
    }

    // Normalize grade to always include decimal (e.g. "10" → "10.0", "9" → "9.0")
    // and hold it to the CGC/PSA ladder. The REAL fix for the off-ladder grade
    // is in the output schema above, which now names the legal positions and
    // tells the model not to mirror the v3 RoboGrade value into this field;
    // this is the net under it. See enforceCgcGrade in lib/grade_definitions.js.
    if (parsed.grade != null && String(parsed.grade).trim() !== '') {
      const _g = enforceCgcGrade(parsed.grade, 'main');
      if (_g) parsed.grade = _g;
    }


    // ─────────────────────────────────────────────────────────────────────
    // Grade reference refinement pass — DISABLED May 24, 2026 (S15, v3.6).
    //
    // History:
    //   - S13 (May 13): original Opus 4.5 refinement disabled (~$0.08, 8-25s cost,
    //     no measurable quality lift).
    //   - S15 (May 23): restored as a lighter-weight Hulk-181 reference comparison
    //     after v3.3 calibration drift (+1.0 median over PSA truth) was traced to
    //     missing grade anchoring.
    //   - S15 (May 24): DISABLED again after 14 calls across Sonnet and Opus
    //     versions produced `gradeBeforeRefinement: null` every single time.
    //     Refinement confirmed every primary, including the +1.5 over-calls on
    //     ASM #29. The design flaw is structural: refinement sees only the prior
    //     assessment's TEXT SUMMARY, not the original images, so when primary
    //     over-counts defects, refinement looks at the assessed-grade reference,
    //     sees comparable defects (as described in the summary), and confirms.
    //     It cannot independently disagree with primary's reading of the photos.
    //     Net effect: +$0.025/asmt and +5-12s for no grade movement, ever.
    //
    // If re-enabling, fix the design first. Two viable rewrites:
    //   (a) Resend the user's original images to refinement alongside the
    //       reference image. Refinement compares actual photos to reference
    //       photo and can independently judge severity. Cost: ~+$0.05/asmt.
    //   (b) Two-pass primary: include reference image in the primary call
    //       itself, instructing the model to compare its assessment to the
    //       reference before finalizing. Lower latency, better integration.
    //
    // Leaving the constant for downstream code that references gradeRefSucceeded
    // (timing-doc gradeRefRan field, _diagnostics.gradeRef). Both will report
    // false on every assessment now.
    // ─────────────────────────────────────────────────────────────────────
    let gradeRefSucceeded = false;
    // (refinement block intentionally removed; see history comment above)
    // ─────────────────────────────────────────────────────────────────────

    // POST-MODEL REFERENCE (v4.82): the PRIMARY reference lookup. The Main model
    // identifies the book accurately, so if no reference was resolved pre-model
    // (the usual case for a fresh capture, where the client sent no title/issue),
    // resolve it HERE with the model's own title/issue — local reference_covers
    // first, then ComicVine. This is what makes the cover show on the FIRST
    // assessment, whether the photos are in-app or from the library. (Grading has
    // already run; this only sets the stored/displayed reference, never the grade.)
    if (!referenceImageUrl && parsed && parsed.title && (parsed.issue != null && parsed.issue !== '') && baseUrl && !suppressReference && !AB_FORCE_SUPPRESS_REFERENCE) {
      try {
        const _sl = refSlugCandidates(parsed.title);
        const _is = String(parsed.issue).replace(/^#/, '').replace(/^0+(\d)/, '$1').trim();
        const _yr = (() => { const _m = String(parsed.issueDate || issueDate || '').match(/(?:19|20)\d{2}/); if (_m) return Number(_m[0]); return (typeof refYear === 'number' && refYear > 1900) ? refYear : null; })();
        const _cands = []; for (const _s of _sl) { if (_yr) _cands.push(`${_s}_${_is}_${_yr}`); _cands.push(`${_s}_${_is}`); }
        const _pmDbg = [];
        for (const _b of _cands) {
          const _u = `${baseUrl}/reference_covers/${_b}_front.jpg`;
          const _r = await fetchWithTimeout(_u, {}, 5000);
          _pmDbg.push(_b + '->' + _r.status);
          if (!_r.ok) continue;
          referenceImageUrl = _u; referenceVolumeName = 'Local reference';
          const _bu = `${baseUrl}/reference_covers/${_b}_back.jpg`;
          try { const _br = await fetchWithTimeout(_bu, {}, 5000); if (_br.ok) referenceBackImageUrl = _bu; } catch (e) {}
          break;
        }
        let _cvNote = '';
        if (!referenceImageUrl && runComicVine && COMICVINE_API_KEY) {
          try { await runComicVine(parsed.title, parsed.issue, _yr); _cvNote = referenceImageUrl ? ' cv=HIT' : ' cv=MISS'; }
          catch (e) { _cvNote = ' cv=ERR'; }
        }
        refDebug = (refDebug || '') + ' | postmodel(' + (referenceImageUrl ? 'HIT ' : 'MISS ') + 'iss=' + JSON.stringify(_is) + ' ' + _pmDbg.join(',') + _cvNote + ')';
      } catch (e) { refDebug = (refDebug || '') + ' | postmodel ERR ' + String((e && e.message) || e); }
    }

    parsed._diagnostics = {
      comicvineRef: referenceImageBlock !== null,
      referenceImageUrl: referenceImageUrl,
      referenceBackImageUrl: referenceBackImageUrl,
      refDebug: refDebug,
      referenceVolume: referenceVolumeName,
      referenceYear: referenceYear,
      referenceComparison: parsed.referenceComparison || null,
      pageQualityRef: pageQualityImageBlock !== null,
      pageQualityRefIsPsa: pqIsPsaReference,
      hasInteriorPhoto: hasInteriorPhoto,
      gradeRef: gradeRefSucceeded,
      roboGrade: !!(parsed.roboGrade)
    };
    // Also surface the CV reference URL at top level so the client persists it
    // on the item document for the admin side-by-side display.
    parsed.referenceImageUrl = referenceImageUrl;
    parsed.referenceBackImageUrl = referenceBackImageUrl;
    parsed.refDebug = refDebug;
    parsed.referenceVolume = referenceVolumeName;
    parsed.referenceYear = referenceYear;
    // S15 v3.8: strip any psaGrade/psaNotes fields the model may still produce.
    // PSA prediction was removed from the prompt; this defensively drops the
    // fields so they never reach the saved record even on transitional runs
    // where a stale cached prompt or model habit produces them.
    delete parsed.psaGrade;
    delete parsed.psaNotes;

    // RoboGrade math verification — final score is the sum of components.
    // The model sometimes outputs a score that doesn't match its own components.
    // Always recompute from components so the displayed score is consistent.
    //
    // Score ranges (v2.0 additive system):
    //   Front:    0-50  (or 0-70 if no back cover photo)
    //   Back:     0-20  (or null if no back cover photo)
    //   Spine:    0-20
    //   Interior: 0-10
    //   Score:    Front + Back + Spine + Interior
    if (parsed.roboGrade && typeof parsed.roboGrade.score === 'number') {
      const rg = parsed.roboGrade;
      const clampInt = (n, min, max) => Math.max(min, Math.min(max, Math.round(n)));
      let f = typeof rg.frontScore    === 'number' ? rg.frontScore    : null;
      let b = typeof rg.backScore     === 'number' ? rg.backScore     : null;
      let s = typeof rg.spineScore    === 'number' ? rg.spineScore    : null;
      let i = typeof rg.interiorScore === 'number' ? rg.interiorScore : null;

      // ── Interior = PQ-mapped value (absolute, no deductions) ─────────────
      // S15 v3.9: Interior score is a 1:1 mapping from page quality. Interior
      // defects (staple rust, detached centerfold, etc.) route to the Spine
      // score, not Interior. Soiling and foxing affecting the pages factor
      // into the PQ designation itself. The model may still occasionally
      // output a deduction-shaped interior score; enforce the absolute
      // mapping here.
      const PQ_TO_INTERIOR = {
        'White': 10, 'Off-White to White': 9, 'Off-White': 8,
        'Cream to Off-White': 7, 'Cream': 6, 'Light Tan to Cream': 5,
        'Light Tan': 4, 'Tan': 3, 'Brown': 2, 'Brown/Brittle': 1, 'Brittle': 0,
      };
      const pqMapped = PQ_TO_INTERIOR[rg.pageQuality];
      if (typeof pqMapped === 'number' && typeof i === 'number' && i !== pqMapped) {
        rg._interiorClamped = { from: rg.interiorScore, to: pqMapped, reason: `PQ "${rg.pageQuality}" maps to ${pqMapped} (absolute 1:1)` };
        i = pqMapped;
      }

      if (f != null && s != null && i != null) {
        // Clamp each component to its valid range and round to integer.
        // Back is always present here — missing back cover is caught at the
        // pre-API gate (returns gateResult: 'MISSING_COVER') so we never
        // reach this code path with b == null on a real assessment.
        f = clampInt(f, 0, 50);
        if (b != null) b = clampInt(b, 0, 20);
        s = clampInt(s, 0, 20);
        i = clampInt(i, 0, 10);
        // COVERLESS ENFORCEMENT: a physically absent cover scores 0, without
        // exception. Detect from the model's own words (aiAssessment) and the
        // defect types, then zero the affected face. Patterns are kept tight to
        // avoid false positives (e.g. "no cover damage" must NOT match).
        const _cvTxt = (String(parsed.aiAssessment || '') + ' ' +
          ((rg.defects || []).map(d => (d && d.type) || '').join(' '))).toLowerCase();
        // Require ABSENCE semantics. The bare "no front/back cover" pattern was a
        // false-positive trap: it also matched "no back cover DAMAGE/WEAR/defects"
        // (a CLEAN cover), zeroing that face — the ASM 55 back=0 bug. Now the cover
        // must be described as missing/absent/gone/torn off/removed, or "no X cover
        // present/remaining/at all".
        const _coverless = /\bcoverless\b|\bmissing (front|back|front and back) cover\b|no (front|back) cover (present|remaining|at all)\b/.test(_cvTxt);
        const _noFront = _coverless || /front cover (is |is entirely |completely )?(missing|absent|gone)\b|front cover (has been |was )?(torn off|removed)\b|no front cover (present|remaining|at all)\b/.test(_cvTxt);
        const _noBack  = _coverless || /back cover (is |is entirely |completely )?(missing|absent|gone)\b|back cover (has been |was )?(torn off|removed)\b|no back cover (present|remaining|at all)\b/.test(_cvTxt);
        if (_noFront) f = 0;
        if (_noBack && b != null) b = 0;
        // ── HIGH-SEVERITY FLOORS, ENFORCED IN CODE (v5.26) ──────────────────
        //
        // The prompt's BOTTOM-OF-SCALE block already states these floors. The
        // model does not reliably apply them. Measured on HG7PMR (ASM 11):
        //
        //   face    defects listed      returned      rubric allows
        //   Front   3 High + 1 Med      15/50         <= 6/50
        //   Back    3 High               5/20         <= 3/20
        //   Spine   1 High wear         10/20         <= 10/20  (at ceiling)
        //
        // Front came back at two and a half times its permitted maximum. This is
        // not a missing rule - it is a rule the model reasons past, and the
        // reason is structural: the band table ("Front 10-19 major | 0-9
        // severe") is read FIRST and BOTTOM-OF-SCALE arrives afterwards as an
        // override. Once a band is chosen there is nothing forcing a revisit.
        // The 2026-09-26 effort rounds showed the same shape from the other
        // direction: more deliberation made the grader MORE forgiving, on both
        // models, on all ten calibration books.
        //
        // These floors are countable, so count them. The model's severity
        // JUDGEMENT is good - the Opus 5 / 5.5 defect diff found severity
        // agreement within 0.12 on a 1-3 scale - it is the mapping from
        // severity to a number that drifts. So take the mapping away from it.
        //
        // Only ever LOWERS a face. Never raises one, so a model that already
        // seated a face correctly is untouched.
        (function applyHighSeverityFloors() {
          const defs = Array.isArray(rg.defects) ? rg.defects
                     : (Array.isArray(parsed.defects) ? parsed.defects : []);
          if (!defs.length) return;
          // Structural = the named list in BOTTOM-OF-SCALE. Deliberately literal:
          // a type string has to say one of these, not merely imply it.
          const STRUCTURAL = /tape|residue|missing piece|piece out|paper loss|spine split|cover detach|detached cover|water damage|moisture|rust migration|migrated rust/i;
          const tally = {};   // face -> { high, structuralHigh }
          for (const d of defs) {
            if (!d || String(d.severity || '').trim().toLowerCase() !== 'high') continue;
            const face = String(d.category || '').trim().toLowerCase();
            if (face !== 'front' && face !== 'back' && face !== 'spine') continue;
            const t = tally[face] || (tally[face] = { high: 0, structuralHigh: 0 });
            t.high++;
            if (STRUCTURAL.test(String(d.type || ''))) t.structuralHigh++;
          }
          const CAPS = {   // [two-or-more-High, one-structural-High]
            front: [6, 12],
            back:  [3, 6],
            spine: [3, 6],
          };
          const fired = [];
          const capFor = (face) => {
            const t = tally[face]; if (!t) return null;
            const [bottom, structural] = CAPS[face];
            if (t.high >= 2) return { cap: bottom, why: t.high + ' High defects' };
            if (t.structuralHigh >= 1) return { cap: structural, why: 'one High structural defect' };
            return null;
          };
          const cF = capFor('front'); if (cF && f > cF.cap) { fired.push('Front ' + f + '->' + cF.cap + ' (' + cF.why + ')'); f = cF.cap; }
          const cB = capFor('back');  if (cB && b != null && b > cB.cap) { fired.push('Back ' + b + '->' + cB.cap + ' (' + cB.why + ')'); b = cB.cap; }
          const cS = capFor('spine'); if (cS && s > cS.cap) { fired.push('Spine ' + s + '->' + cS.cap + ' (' + cS.why + ')'); s = cS.cap; }
          if (fired.length) {
            // Logged so the rate is measurable. If this fires on most damaged
            // books, the prompt's floors were never working and the clamp is
            // carrying them; if it almost never fires, they mostly were.
            rg._highSeverityFloor = fired;
            console.log('[floor] ' + fired.join(' | '));
          }
        })();

        // Write clamped values back
        rg.frontScore    = f;
        if (b != null) rg.backScore = b;
        rg.spineScore    = s;
        rg.interiorScore = i;
        const computed = f + (b || 0) + s + i;
        const original = Math.round(rg.score);
        const divergence = Math.abs(computed - original);
        // v2.4: When the model's holistic declared score and the component-sum
        // computed score disagree by more than 8 points, prefer the LOWER of
        // the two. Calibration data (S13: ASM #8 v2.3, ASM #62 v2.2, ASM #64
        // v2.2) showed a consistent pattern where declared was the more
        // accurate read: Front sub-scores were systematically over-allocated
        // (mid-grade books were getting 26-30 of 50 points when 20-22 was
        // appropriate), and the prior rule (always taking computed) dragged
        // the displayed Robograde upward by 9-14 points across all three
        // sample books. The model's holistic prose grade tracked the visible
        // condition more closely than its componentized math.
        //
        // The 8-point threshold preserves the original behavior for normal
        // rounding/clamping discrepancies (1-7 points) which are usually just
        // arithmetic drift, while flagging the cases where the two reads
        // are genuinely telling different stories. The calibration pattern
        // showed real over-allocation kicking in around the 9-point mark
        // (ASM #62 had a 9-point divergence and still came out half a grade
        // too high), so 8 is the cleanest cut-off.
        //
        // S15 NOTE: this rule was partly masking an identification failure.
        // On heavily-damaged books, Front/Back were over-allocated BECAUSE
        // severe defects (tape, paper loss, tears) were being mislabeled as
        // soft defects (creases, edge wear) that don't subtract many points.
        // The Phase 1 structural scan (CHECK 1-4, now forced into the JSON
        // via structuralScan) is the real fix — when tape and missing pieces
        // are correctly identified and scored, the components sum LOW on their
        // own and this divergence correction never needs to fire. This rule
        // stays as a safety net: it only ever takes Math.min (pulls the score
        // DOWN, never up), so it cannot inflate a grade. If it keeps firing
        // on heavy-damage books even after the scan improvements, that's a
        // signal the identification is still failing upstream — investigate
        // the defects array directly (v4.13 dropped the structuralScan output
        // field; structural findings now surface only via defects entries).
        //
        // When we override to the lower value, we also rebalance the sub-
        // scores so they still sum to the displayed Robograde — otherwise
        // a user reading sub-scores on Detail view sees 26+10+12+9=57 while
        // the headline number shows 40, which reads as a bug. Front absorbs
        // the entire correction (since over-allocation originates there),
        // unless that would push Front below 0, in which case we fall back
        // to proportional reduction.
        if (divergence > 8) {
          const chosen = Math.min(computed, original);
          rg.score = chosen;
          if (chosen < computed) {
            // Subtract the gap from Front; if not enough, distribute remainder
            // across all categories proportionally.
            const gap = computed - chosen;
            // v5.33 — WHY THERE IS A CEILING ON WHAT FRONT ABSORBS.
            //
            // "Front absorbs the whole correction" is right for the small
            // over-allocations this rule was written for. It is badly wrong for a
            // large divergence. Observed 2026-10-02, ASM 41 rep 2 on Opus 5: the
            // model declared score 29 while its own sub-scores summed to ~58, so
            // gap was 29, Front was 28, 28-29 < 0, and Front was floored to ZERO.
            // Front 0 on a 0-50 scale means a destroyed front cover, on a PSA 4.5
            // book whose front is visibly fine, and the user reads that on Detail
            // view. The other two reps of the same book returned Front 28.
            //
            // So Front absorbs at most HALF its own value; past that the entire
            // gap is spread proportionally across all four. That keeps the
            // original intent (over-allocation originates in Front) for ordinary
            // corrections and stops the pathological case.
            //
            // NOTE: this changes only how the gap is DISTRIBUTED. rg.score is
            // identical either way, so no grade moves. Whether "prefer lower" is
            // even right at a 29-point divergence — each sub-score is pinned to a
            // listed defect by the SUBSCORE-DEFECT CONSISTENCY rule while `score`
            // is one unanchored number — is a grading-policy question and is
            // deliberately NOT touched here. See TASKLIST.
            const frontCanAbsorb = Math.floor(f / 2);
            if (gap <= frontCanAbsorb) {
              rg.frontScore = f - gap;
            } else {
              // Spread the WHOLE gap proportionally, Front included.
              const pool = f + (b || 0) + s + i;
              if (pool > 0) {
                rg.frontScore    = Math.max(0, Math.round(f - gap * (f / pool)));
                if (b != null) rg.backScore = Math.max(0, Math.round(b - gap * (b / pool)));
                rg.spineScore    = Math.max(0, Math.round(s - gap * (s / pool)));
                rg.interiorScore = Math.max(0, Math.round(i - gap * (i / pool)));
              }
            }
          }
          rg._mathCorrected = {
            declared: original,
            computed: computed,
            chosen: chosen,
            rule: 'divergence>8, prefer lower; sub-scores rebalanced',
            distribution: (computed - chosen) <= Math.floor(f / 2) ? 'front-absorbs' : 'proportional-all'
          };
        } else {
          rg.score = computed;
          if (divergence > 2) {
            rg._mathCorrected = { declared: original, computed: rg.score };
          }
        }
      }
    }

    // ── High-grade enforcement (safety net) ───────────────────────────────────
    // Even with a good prompt, the model occasionally drifts on high-grade passes.
    // Enforce the carry-through and floor rules in code.
    if (highGrade && initialRoboGrade && parsed.roboGrade) {
      const rg = parsed.roboGrade;
      const enforcement = [];

      // 1. Carry Back and Interior forward unchanged — the macros don't cover them.
      if (typeof initialRoboGrade.backScore === 'number' && rg.backScore !== initialRoboGrade.backScore) {
        enforcement.push(`back carried ${rg.backScore} → ${initialRoboGrade.backScore}`);
        rg.backScore = initialRoboGrade.backScore;
      }
      if (typeof initialRoboGrade.interiorScore === 'number' && rg.interiorScore !== initialRoboGrade.interiorScore) {
        enforcement.push(`interior carried ${rg.interiorScore} → ${initialRoboGrade.interiorScore}`);
        rg.interiorScore = initialRoboGrade.interiorScore;
      }

      // 2. Recompute final score with the carried-through values.
      const f = typeof rg.frontScore    === 'number' ? rg.frontScore    : null;
      const b = typeof rg.backScore     === 'number' ? rg.backScore     : null;
      const s = typeof rg.spineScore    === 'number' ? rg.spineScore    : null;
      const i = typeof rg.interiorScore === 'number' ? rg.interiorScore : null;
      if (f != null && s != null && i != null) {
        // Additive v2.0 system: score is Front + Back + Spine + Interior.
        // If no back cover, Front's max was 70 (absorbing Back's 20).
        const computed = f + (b || 0) + s + i;
        rg.score = computed;
      }

      // 3. Floor rule for RG: unless the model explicitly flagged new defects in
      //    aiAssessment (which would justify a drop), never go below the initial
      //    RG score. We detect a justified drop heuristically: the aiAssessment
      //    mentions "macro" or "corner" AND describes a defect not in the initial.
      const initialScore = typeof initialRoboGrade.score === 'number' ? Math.round(initialRoboGrade.score) : null;
      if (initialScore != null && rg.score < initialScore) {
        const notes = String(parsed.aiAssessment || '').toLowerCase();
        const mentionsMacro = notes.includes('macro') || notes.includes('corner');
        if (!mentionsMacro) {
          // No justification — snap back to initial floor
          enforcement.push(`RG score floored ${rg.score} → ${initialScore}`);
          rg.score = initialScore;
          // Also re-floor the front component to make the arithmetic work.
          // In the additive system: Front = initialScore - Back - Spine - Interior
          if (typeof s === 'number' && typeof i === 'number') {
            const needed = initialScore - (b || 0) - s - i;
            const frontMax = (b == null) ? 70 : 50;
            if (f != null && needed > f) {
              rg.frontScore = Math.max(0, Math.min(frontMax, Math.round(needed)));
            }
          }
        }
      }

      // 4. Floor rule for CGC grade: never go below the initial CGC grade unless
      //    a corner-macro defect justifies the drop (heuristic same as above).
      const cgcFloor = parseFloat(initialCgcGrade);
      const cgcNew   = parseFloat(parsed.grade);
      if (!isNaN(cgcFloor) && !isNaN(cgcNew) && cgcNew < cgcFloor) {
        const notes = String(parsed.aiAssessment || '').toLowerCase();
        const mentionsMacro = notes.includes('macro') || notes.includes('corner');
        if (!mentionsMacro) {
          enforcement.push(`CGC grade floored ${parsed.grade} → ${initialCgcGrade}`);
          // The floor too: initialCgcGrade arrives from the client.
          parsed.grade = enforceCgcGrade(cgcFloor, 'main-floor') || String(cgcFloor.toFixed(1));
        }
      }

      // PSA floor enforcement removed in v3.8 — PSA prediction was stripped
      // from the model output entirely. The initialPsaGrade input parameter
      // is preserved for backward compatibility with callers but no longer
      // enforced.

      if (enforcement.length > 0) {
        rg._highGradeEnforcement = enforcement;
      }
      rg._highGradePass = true;
    }

    // ── Confidence range clamping (S12 May 6) ────────────────────────────
    // Two-stage clamp regardless of high-grade or standard mode:
    //   1. Mode cap: high-grade caps at 6, standard caps at 16. The model
    //      occasionally returns excessive ranges; this protects against
    //      egregious widening.
    //   2. Score+conf cap: score + confidenceRange must not exceed 100.
    //      A score of 94 with ±8 implies an upper bound of 102 which is
    //      nonsensical (max grade is 100). Narrow the conf if needed so
    //      that score + conf ≤ 100.
    // Floor is 0 (perfect score 100 → 0; not negative).
    //
    // S15 May 27 — SCORE CEILING (Matt's spec):
    //   The highest score an assessment is willing to assign is bounded by
    //   its OWN precision modifier. A 4-photo standard assessment carries
    //   a ±6 base precision modifier; its honest upper bound is therefore
    //   100 - 6 = 94, with the ±6 letting the true grade range up to 100.
    //   A Deep assessment (corner macros) narrows the modifier to ±3, so
    //   its ceiling is 100 - 3 = 97, with ±3 reaching up to 100.
    //   Rationale: a 4-photo read simply cannot SEE enough to justify a
    //   near-perfect score outright — the corner detail that distinguishes
    //   a 9.4 from a 9.8 isn't present. The score ceiling enforces that
    //   honesty structurally. The model is ALSO told this in the prompt,
    //   but this clamp is the guarantee.
    //   We use baseConf as the modifier (3 for high-grade, 6 for 4-photo
    //   standard, wider for fewer photos). Cap = 100 - baseConf.
    // ── Photograder (S21): the photo-quality letters the model returned drive
    // the precision modifier (PM). PM replaces baseConf as BOTH the score ceiling
    // (100 − PM) and the displayed ± — so worse photos widen the ± and pull the
    // ceiling down (we can't confirm a high grade when photos hide detail). Main
    // is computed fresh (no prior tier to clamp against).
    parsed.photograder = mergePhotograder(null, parsed.photograder);
    const _pm = computePhotograderPM(parsed.photograder, 'main', !!labelDetected, null);
    parsed.photograder.pm = _pm;
    parsed.photograder.tier = 'main';
    if (parsed.roboGrade && typeof parsed.roboGrade.score === 'number') {
      const rawScore = Math.round(parsed.roboGrade.score);
      const scoreCeiling = 100 - _pm;
      if (rawScore > scoreCeiling) {
        parsed.roboGrade.score = scoreCeiling;
        // Recompute the per-category scores proportionally? No — the
        // sub-scores are diagnostic and the model set them deliberately.
        // We only clamp the headline score. If sub-scores sum higher than
        // the clamped headline, that's an acceptable display nuance (the
        // headline is the honest ceiling; sub-scores show where the points
        // were observed). A future pass could reconcile, but over-
        // engineering the reconciliation risks distorting the diagnostic.
        if (!parsed._diagnostics) parsed._diagnostics = {};
        parsed._diagnostics.scoreCeilingApplied = { rawScore, ceiling: scoreCeiling, baseConf };
      }
    }

    if (parsed.roboGrade) {
      // S21: the ± is the Photograder PM (overrides whatever the model wrote).
      // Since the ceiling is 100 − PM, the score fits and the headroom clamp is
      // a no-op, but keep it as a guard against display implying a >100 score.
      let conf = _pm;
      const score = Math.round(parsed.roboGrade.score || 0);
      const headroom = Math.max(0, 100 - score);
      if (conf > headroom) conf = headroom;
      parsed.roboGrade.confidenceRange = conf;
    }

    // ── S15 phase timing finalize ────────────────────────────────────────
    phaseTimings.totalMs = Date.now() - T0;
    if (!parsed._diagnostics) parsed._diagnostics = {};
    parsed._diagnostics.phaseTimings = phaseTimings;

    // Await the Firestore write. On Vercel serverless, fire-and-forget
    // promises often don't complete — the function process is suspended
    // as soon as the response is sent. The wall-clock data is what makes
    // this whole feature useful for diagnosing timeouts, so we pay the
    // (small, <200ms typically) write latency to ensure it persists.
    try {
      // Echo the diagnostic overrides on the main success path too (the gate
      // path has its own copy). Outside the `if (db)` below so a Firestore
      // outage cannot drop it — the harness needs to record what ACTUALLY ran,
      // and an arm that silently failed to apply must never be written down as
      // a result for that arm.
      if (!parsed._diagnostics) parsed._diagnostics = {};
      parsed._diagnostics.diag = _diag;
      const db = await getAdminDb();
      if (db) {
        const key = (parsed.roboGrade && parsed.roboGrade.roboGradeId)
          || parsed.roboGradeId
          || `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // S20 (#33): hand the log's doc key back to the client so it can store it
        // on the saved item (assessmentTimingKeys). That's the reliable bridge
        // for admin "Logs → tap to open item": the item's roboGradeId is minted
        // client-side AFTER this call, so it can't be the key here — but the
        // client CAN persist this key onto the item it saves.
        if (!parsed._diagnostics) parsed._diagnostics = {};
        parsed._diagnostics.timingKey = key;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          // _activeModel, not PRIMARY_MODEL: an ablation round overrides the
          // model per request, and a timings record that names the wrong model
          // is worse than none — the admin dashboard reads these, and a round
          // mislabelled as Opus 5 would silently poison every later comparison.
          model: _activeModel,
          refineModel: _activeModel,
          ablated: _ablApplied.length ? _ablApplied.join(',') : null,
          // Census diagnostics — written to the record the admin dashboard reads.
          // censusMatched answers "did census fire?"; the title/issue fields show
          // exactly what was passed to the lookup, so a silent no-match (wrong
          // title format, empty issue) is debuggable instead of invisible.
          censusMatched: _censusMatched,
          censusTitleSent: title || null,
          censusIssueSent: issueNumber || null,
          highGrade: !!highGrade,
          gradeRefRan: gradeRefSucceeded,
          gateResult: parsed.gateResult || 'COMIC',
          // S16: Cap predicted grade at the tier-based ceiling (or 9.9 absolute max)
          predictedGrade: parsed.grade ? String(Math.min(parseFloat(parsed.grade), gradeCeiling || 9.9).toFixed(1)) : null,
          gradeBeforeRefinement: parsed.gradeBeforeRefinement || null,
          // Diagnostic v3.97: token usage and output complexity. These are the
          // missing variables we need to identify what's actually driving the
          // per-call latency variance (the 22.7s vs 48.7s on identical prompt+model).
          inputTokens: _inputTokens,
          outputTokens: _outputTokens,
          cacheReadInputTokens: _cacheReadInputTokens,
          cacheCreationInputTokens: _cacheCreationInputTokens,
          // S15 May 28: per-assessment dollar cost. Computed inline so the
          // admin Logs view can display it without re-deriving from token
          // counts and a hardcoded rate table. Cache reads bill at 10% of the
          // input rate. Cache WRITES bill by the TTL we requested (_cacheCtl):
          // a 1-hour cache writes at 2x input, the default 5-minute at 1.25x.
          // (S20 fix: this was hardcoded 1.25x, which UNDERbilled every 1-hour
          // cache write — the log read cheaper than the real Anthropic invoice.
          // Tying the multiplier to _cacheTtl keeps it honest if the caching
          // lever is flipped.) If we change models, _RATES changes with it.
          costUsd: costOf({
            input_tokens: _inputTokens || 0,
            output_tokens: _outputTokens || 0,
            cache_read_input_tokens: _cacheReadInputTokens || 0,
            cache_creation_input_tokens: _cacheCreationInputTokens || 0
          }, _activeModel, _cacheTtl),
          // S17 calibration logging: sub-scores + PQ + PM in the record itself
          // so a calibration round can be read straight off the Logs list
          // without opening rawText, plus the reference-attachment flags that
          // were previously computed and discarded (these answer "was the PQ
          // reference actually attached?" definitively per assessment).
          rgScore: (parsed.roboGrade && parsed.roboGrade.score) ?? null,
          frontScore: (parsed.roboGrade && parsed.roboGrade.frontScore) ?? null,
          backScore: (parsed.roboGrade && parsed.roboGrade.backScore) ?? null,
          spineScore: (parsed.roboGrade && parsed.roboGrade.spineScore) ?? null,
          interiorScore: (parsed.roboGrade && parsed.roboGrade.interiorScore) ?? null,
          pageQuality: parsed.pageQuality || null,
          precisionMod: (parsed.roboGrade && parsed.roboGrade.confidenceRange) ?? null,
          pageQualityRef: pageQualityImageBlock !== null,
          pageQualityRefIsPsa: pqIsPsaReference,
          comicvineRef: referenceImageBlock !== null,
          referenceYear: referenceYear,
          referenceVolume: referenceVolumeName,
          referenceComparison: parsed.referenceComparison || null,
          // S23 2026-10-16: marks this row as one that actually TOUCHED THE MAIN
          // PREFIX. api/cachewarm's traffic gate reads it. Before this existed
          // the gate treated ANY assessment_timings row as proof the Main cache
          // was warm — but Deeps, Card assessments, slab-checks and Batch passes
          // all write rows and none of them warm the Main prefix. A Card at
          // 08:37 would suppress the Main ping, and the Main entry would quietly
          // die an hour later.
          // WHICH prefix this run touched, not merely "a Main ran". There are
          // two Main prefixes: the ordinary one (_ki === null, what every
          // app-initiated Main sends and what /api/cachewarm pings) and the
          // _ki variant that assess_batch_run.js sends with a settled identity.
          // They are different cache entries. Stamping both 'main' let a Batch
          // Main suppress the keep-warm ping for an entry it never warmed —
          // the same defect that Card assessments caused on 2026-10-16, one
          // layer down. The gate counts 'main' only.
          warmedPrefix: _cacheOn ? (_ki ? 'main_ki' : 'main') : null,
          attempts: _retryStats.attempts || null,
          upstreamStatus: _retryStats.lastStatus ?? null,
          retryWaitedMs: _retryStats.waitedMs || 0,
          stopReason: _stopReason,
          responseModel: _responseModel,
          rawTextChars: _rawTextChars,
          defectCount: Array.isArray(parsed.roboGrade && parsed.roboGrade.defects) ? parsed.roboGrade.defects.length : null,
          // S19: full defect list in the record so a calibration round reads
          // straight off /api/timings (no per-item fetch, no fuzzy matching).
          defects: (parsed.roboGrade && parsed.roboGrade.defects) || null,
          imageCount: Array.isArray(imageBlocks) ? imageBlocks.length : null,
          title: parsed.title || null,
          issue: parsed.issue || null,
          // Diagnostic v3.97-d2: capture the model's raw text output so we
          // can see field-by-field where output tokens are being spent.
          // Capped at 8KB to keep the Firestore doc small. The full text
          // exceeds 8KB only when the model has gone well above its caps,
          // which is itself diagnostically interesting.
          rawText: typeof text === 'string' ? text.slice(0, 8000) : null,
          timedOut: false
        });
      }
    } catch (e) {
      console.error('assessment_timings write failed (non-fatal):', e);
    }

    // ── TIER GRADE CEILING — ENFORCED ON THE SERVER (S23, 2026-10-18) ────
    // `gradeCeiling` has existed since S16 and was enforced in exactly two
    // places, neither of which is the number anyone sees:
    //   - the PROMPT ("predicted CGC grade must not exceed X"), which is a
    //     request, not a constraint; and
    //   - `_diagnostics.predictedGrade`, a clamped COPY written to the log.
    // `parsed.grade` itself was never clamped. So a 4-photo Main whose stated
    // ceiling is 9.2 could return and display 9.4 or 9.6 whenever the model
    // declined to obey the instruction — the same class of failure as the Deep
    // returning 9.8 on RG-ID 77H9H6, which was fixed in api/assess_deep.js by
    // adding a real server cap. This is that cap for this endpoint.
    //
    // The ceilings (raw books; a slabbed book has none, its label governs):
    //   Deep / high-grade pass  9.6      Main, 4 photos  9.2      fewer  8.5
    // 9.6, 9.2 and 8.5 are all legal CGC rungs, but the value goes through
    // enforceCgcGrade anyway so this can never be the thing that invents an
    // off-ladder grade.
    //
    // The floor rule above can only raise a high-grade pass to the Main's own
    // grade, which is already at or under this ceiling, so the two cannot
    // disagree. If that ever changes, the log line below is the tell.
    if (gradeCeiling != null) {
      const _gc = parseFloat(parsed.grade);
      if (Number.isFinite(_gc) && _gc > gradeCeiling) {
        const _capped = enforceCgcGrade(gradeCeiling, 'main-ceiling') || String(gradeCeiling.toFixed(1));
        console.log(`[grade-ceiling] ${highGrade ? 'high-grade pass' : 'main'} returned ${parsed.grade}; tier ceiling is ${gradeCeiling} (${photoCount} photos) — forced to ${_capped}`);
        // NOT `enforcement.push(...)`: that array is block-scoped to the
        // high-grade branch above (declared at the `if (highGrade ...)`), so
        // referencing it here throws on an ordinary Main. Caught by running the
        // module rather than by `node --check`, which cannot see it.
        parsed._diagnostics = parsed._diagnostics || {};
        parsed._diagnostics.gradeCeilingApplied = { from: parsed.grade, to: _capped, ceiling: gradeCeiling, photoCount: photoCount };
        parsed.grade = _capped;
      }
    }

    // ── "(+)" — THIS GRADE COULD GO HIGHER ───────────────────────────────
    // Two conditions, and BOTH must hold:
    //   1. the pass landed exactly on its tier ceiling, so a deeper pass is
    //      allowed to return a higher number, and
    //   2. nothing worse than a LOW-severity defect was found.
    // Condition 2 is what stops this meaning "you ran a Main". The Main
    // ceiling is a hard tier cap, not a judgement -- a 4-image Main cannot
    // exceed 9.2 however clean the book is -- so at-ceiling ALONE would mark
    // every decent-looking book, including ones the Deep will drop to 8.5.
    // Requiring a clean defect list makes the mark mean what it says: we found
    // no reason this book should not go higher, and the next tier can confirm.
    const _ceilDefects = Array.isArray(parsed.defects) ? parsed.defects : [];
    const _hasRealDefect = _ceilDefects.some(d => {
      const sev = String((d && d.severity) || '').trim().toLowerCase();
      return sev === 'high' || sev === 'med' || sev === 'medium';
    });
    // Slabbed books have no ceiling (the label grade governs), so never "(+)".
    parsed.gradeAtCeiling =
      gradeCeiling != null &&
      parseFloat(parsed.grade) === gradeCeiling &&
      !_hasRealDefect;

    // S22: when THIS request took the credit, the client must not take it
    // again — it reads creditsRemaining and syncs instead of decrementing.
    if (_creditDebited && Number.isFinite(_creditsRemaining)) {
      parsed.creditsCharged = _CREDIT_COST;
      parsed.creditsRemaining = _creditsRemaining;
    }
    if (wantsSSE) {
      sseEvent('result', parsed);
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(200).json(parsed);
  } catch (err) {
    // The assessment failed, so the user keeps their credit.
    await _refundIfDebited('assessment error: ' + String((err && err.message) || err).slice(0, 120));
    // Capture timing even on error — these are the diagnostically valuable cases.
    phaseTimings.totalMs = Date.now() - T0;
    phaseTimings.errorAtMs = phaseTimings.totalMs;
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `t_err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          // _activeModel, not PRIMARY_MODEL: an ablation round overrides the
          // model per request, and a timings record that names the wrong model
          // is worse than none — the admin dashboard reads these, and a round
          // mislabelled as Opus 5 would silently poison every later comparison.
          model: _activeModel,
          refineModel: _activeModel,
          ablated: _ablApplied.length ? _ablApplied.join(',') : null,
          // Diagnostic v3.97: imageCount is the only payload-side number we
          // can reliably capture in the error path (API never returned, so
          // no token usage). Helps identify whether timeouts cluster on
          // higher-image-count requests (Deep Assessment with 8 images vs
          // standard 4).
          imageCount: (typeof imageBlocks !== 'undefined' && Array.isArray(imageBlocks)) ? imageBlocks.length : null,
          highGrade: (typeof highGrade !== 'undefined') ? !!highGrade : null,
          // ── S23 2026-10-11: THE $0 WAS WRONG, AND IT HID REAL MONEY ──────
          // The old comment here read "errored assessments cost $0 because the
          // API never returned (no tokens billed)". That is true for a failure
          // BEFORE the request goes out. It is false for the case that actually
          // dominates: a TIMEOUT. By then Anthropic has received the full
          // prompt and all four images, processed them, written or read the
          // cache, and started streaming. We abort the connection at 55s; the
          // billing already happened. A timed-out Main costs about what a cold
          // successful one costs -- roughly $0.30 -- and it was being recorded
          // as free.
          //
          // We have no usage object (that arrives with the response we never
          // got), so this is an ESTIMATE and it is deliberately a FLOOR:
          // the prefix is priced as a cache READ even though a cold one is 20x
          // that, and output tokens are ignored entirely. Flagged with
          // costEstimated so nothing downstream mistakes it for a measurement.
          // A pre-flight failure (no prompt assembled yet) still records 0.
          ...(function(){
            try {
              if (typeof _activePrompt !== 'string' || !_activePrompt) return { costUsd: 0 };
              const R = ratesFor(_activeModel);
              const sp = _activePrompt.split('\u00a7\u00a7CACHE_SPLIT\u00a7\u00a7');
              const prefixTok = Math.round((sp[0] || '').length / 3.8);
              const tailTok   = Math.round((sp[1] || '').length / 3.8);
              const imgTok    = ((typeof imageBlocks !== 'undefined' && Array.isArray(imageBlocks)) ? imageBlocks.length : 0) * 2600;
              const cacheOn   = (typeof _cacheOn !== 'undefined') ? !!_cacheOn : true;
              const prefixCost = cacheOn ? prefixTok * R.in * R.cacheRead : prefixTok * R.in;
              return {
                costUsd: +(prefixCost + (tailTok + imgTok) * R.in).toFixed(6),
                costEstimated: true,
                costEstimateNote: 'floor: prefix priced as a cache read, output ignored'
              };
            } catch (e) { return { costUsd: 0 }; }
          })(),
          // How it got here: one slow attempt, or several upstream rejections
          // and backoff? attempts/upstreamStatus answer that, and phases says
          // where in the pipeline the clock ran out.
          attempts: _retryStats.attempts || null,
          upstreamStatus: _retryStats.lastStatus ?? null,
          retryWaitedMs: _retryStats.waitedMs || 0,
          errorMessage: String(err.message || err).slice(0, 500),
          timedOut: /timeout|abort/i.test(String(err.message || err))
        });
      }
    } catch (e) {
      console.error('assessment_timings (err path) write failed (non-fatal):', e);
    }
    if (wantsSSE) {
      sseEvent('error', { error: err.message, _diagnostics: { phaseTimings } });
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(500).json({ error: err.message, _diagnostics: { phaseTimings } });
  }
}
