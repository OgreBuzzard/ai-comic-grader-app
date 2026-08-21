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
import { anthropicWithRetry, fetchTimeout } from '../lib/anthropic_retry.js';
import { getBookNote } from '../lib/book_notes.js';
import { defectIndexPromptBlock } from '../lib/defect_index.js';
import { computePhotograderPM, mergePhotograder, PHOTOGRADER_RUBRIC_MAIN } from '../lib/photograder.js';

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
    mode = null
  } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

  // ── S16: slab-detection micro-call (mode:'slabcheck') ───────────────────────
  // A tiny Haiku vision call answering "is this comic in a graded slab case?"
  // at capture time, so the camera flow can skip interior/PQ/raking photos for
  // slabbed books (which can't be opened). Folded into assess.js to reuse auth,
  // the Anthropic key, and the assessment_timings logging — and to stay under
  // the 12-function Vercel ceiling (a dedicated endpoint would be the 13th).
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
  const baseUrl = req.headers['host']
    ? `https://${req.headers['host']}`
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '');

  // LOCAL REFERENCE COVERS (served from /reference_covers/). If clean front/back
  // scans exist for this exact book, use them and SKIP ComicVine — higher quality,
  // no rate limit, and we also get the BACK cover (ComicVine gives covers only).
  // Filenames mirror the reference-library sheet: <title-slug>_<issue>[_<year>]_front.jpg / _back.jpg.
  let usedLocalRef = false;
  if (baseUrl && title && issueNumber && !suppressReference && !AB_FORCE_SUPPRESS_REFERENCE) {
    try {
      const _slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const _iss = String(issueNumber).replace(/^#/, '').replace(/^0+(\d)/, '$1').trim();
      const _yr = (typeof issueYear === 'number' && issueYear > 1900) ? issueYear : null;
      const _bases = [];
      if (_yr) _bases.push(`${_slug}_${_iss}_${_yr}`);
      _bases.push(`${_slug}_${_iss}`);
      for (const _b of _bases) {
        const _frontUrl = `${baseUrl}/reference_covers/${_b}_front.jpg`;
        const _fr = await fetchWithTimeout(_frontUrl, {}, 5000);
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
          }
        } catch (e) { /* back optional */ }
        console.log(`[localref] used ${_b} front=yes back=${referenceBackImageBlock ? 'yes' : 'no'} -> skipping ComicVine`);
        break;
      }
    } catch (e) { /* no local reference -> fall through to ComicVine */ }
  }

  // Run ComicVine cover fetch and page quality fetch in parallel
  let pageQualityImageBlock = null;
  let pqIsPsaReference = false;  // true once pq_psa.jpg is uploaded; prompt language adapts
  if (isCGC) {
    const cvFetch = (title && issueNumber && COMICVINE_API_KEY && !suppressReference && !AB_FORCE_SUPPRESS_REFERENCE && !usedLocalRef) ? (async () => {
      try {
        const searchTitle = title.replace(/^The\s+/i, '').trim();
        const targetIss = String(issueNumber).replace(/^0+/, '');
        const hintYear = (typeof issueYear === 'number' && issueYear > 1930) ? issueYear : null;
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
        const volUrl = `https://comicvine.gamespot.com/api/volumes/?api_key=${COMICVINE_API_KEY}&format=json&filter=name:${encodeURIComponent(searchTitle)}&field_list=id,name,start_year,count_of_issues&limit=50`;
        const volResp = await fetchWithTimeout(volUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 5000);
        if (!volResp.ok) return;
        const volData = await volResp.json();
        // Tolerant title match: normalize away punctuation/hyphens/extra spaces
        // and leading "The", accept exact or prefix. Old exact === broke on
        // hyphenation ("Spider-Man" vs "Spider Man") and subtitle drift.
        const _norm = x => String(x||'').toLowerCase().replace(/^the\s+/,'').replace(/[^a-z0-9]+/g,' ').trim();
        const _st = _norm(searchTitle);
        let volumes = (volData.results || []).filter(v => {
          const vn = _norm(v.name);
          return vn === _st || vn.startsWith(_st) || _st.startsWith(vn);
        });
        if (!volumes.length) volumes = volData.results || [];
        if (!volumes.length) return;
        // Choose the volume.
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
        // Fetch the specific issue of THIS volume.
        const issUrl = `https://comicvine.gamespot.com/api/issues/?api_key=${COMICVINE_API_KEY}&format=json&filter=volume:${vol.id},issue_number:${encodeURIComponent(targetIss)}&field_list=image,cover_date,issue_number&limit=1`;
        const issResp = await fetchWithTimeout(issUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 5000);
        if (!issResp.ok) return;
        const issData = await issResp.json();
        const match = (issData.results || [])[0];
        referenceYear = match ? yearFrom(match.cover_date) : null;
        console.log(`[comicvine] title="${searchTitle}" iss=${targetIss} results=${(volData.results||[]).length} matched=${volumes.length} chosen=${vol?`${vol.name} (${vol.start_year})`:'NONE'} issue=${match?'found':'none'} image=${match&&match.image?'yes':'no'}`);
        if (match && match.image) {
          // Highest-res scan available — a small missing piece is not resolvable
          // at the ~600px medium_url. original_url is the full scan.
          const img = match.image;
          const refUrl = img.original_url || img.super_url || img.screen_large_url || img.screen_url || img.medium_url || null;
          if (refUrl) {
            referenceImageUrl = refUrl;
            const imgResp = await fetchWithTimeout(refUrl, {}, 5000);
            if (imgResp.ok) {
              const imgBuffer = await imgResp.arrayBuffer();
              referenceImageBlock = { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(imgResp.headers.get('content-type')), data: Buffer.from(imgBuffer).toString('base64') } };
            }
          }
        }
      } catch (e) { /* CV fetch failed — proceed without reference */ }
    })() : Promise.resolve();

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
  // Source: facts derived from CGC's published grading guide. Wording is
  // original; no CGC prose preserved verbatim. Restored in v3.95 after S13
  // removal left only loose summary tiers. See Grade_Reference/CGC_GRADE_DEFINITIONS.md
  // for the human-readable version of this content.
  const CGC_GRADE_TIERS = `
10.0 GEM MINT: Perfect. No stress lines on spine. Razor-sharp corners. Cover flat. Staples clean, tight, centered. Full gloss, vibrant color, no fading. No tanning, foxing, soiling, stains, fingerprints, or dust shadows. No post-distribution writing or stamps (witnessed signatures permitted). Interior must be White — Off-White to White cannot reach 10.0. No distribution ink, printer tears, bindery tears, Marvel tears, miscuts (slight miswrap or minor off-register acceptable on vintage). No modern ink defects. Slight Golden Age blade pulls and light Silver Age roller marks allowed. Practically nonexistent before 1975.
9.9 MINT: One small non-color-breaking cover bend OR one non-color-breaking spine stress line allowed. Perfectly cut, well-centered cover. No edge or corner wear. Very small distribution ink allowed; no ink smears/lift/transfer/distortion. Off-White to White pages acceptable; Off-White is not. Full gloss and color. Staples free of rust, discoloration, or wear around holes. Usually the ceiling for 1970s-80s comics. Fewer than 50 1950s-60s copies exist at 9.9. Only three pre-1950 books have ever received it.
9.8 NEAR MINT/MINT: One or two handling defects allowed: a very small color-breaking spine stress line, or a couple of light cover bends. Tiny wear allowed on one corner or around a staple. Cream to Off-White pages essentially not allowed. Many printing defects acceptable, particularly when run-wide. Silver/Bronze allowance: slightly impacted staples, slight distribution ink, printer creases, minor Siamese pages, light ink transfer, extra manufacturing staples, one very small printer or Marvel tear, light transfer stain. Golden allowance: very small bindery tear or chip, slightly off-register, miswraps, very light dust shadows, very minor cover tanning, small unobtrusive date or store stamps, minor writing where unobtrusive.
9.6 NEAR MINT+: A handful of very small defects allowed (no more than one or two at once): a few very small color-breaking spine stress lines; very small wear to one or two corners; a tiny edge-only crease; a very small edge or staple tear; very light cover tanning; slight staple discoloration; one very small light stain (foxing spot, tiny rust mark, small disturbed-ink spot). One very small manufacturing piece-out (bindery, Marvel, or printer chip) allowed; no handling-caused missing pieces. Squarebounds: one small staple-caused hole, very small (~1/16") spine split, very minor printer tears. Minor gloss imperfections visible only in raking light OK. Page quality minimum: Cream to Off-White. Interior may have minor defects. Staples firmly attached. Realistic ceiling for many early Silver Age keys.
9.4 NEAR MINT: Threshold of ultra-high grades. Light handling defects begin to appear, only one or a few at once. Allowable: a very small spine split, one or two small color-breaking corner or edge creases, a very small chip-out, a very slight spine roll, several small non-color-breaking spine stress lines OR a few color-breaking ones. Cover may have a handful of bends or a small corner indent. Light stacking bend or polybag crease acceptable. Centerfold may be fully detached from one staple. Slightest fading, very light cover tanning, one small fingerprint affecting ink, extremely light staple rust, small erasure mark, or minor gloss smudging allowed. Very small, light stain (water, tape, foxing) acceptable. Slight pressing side effects allowed.
9.2 NEAR MINT-: Regular handling defects more apparent; eye appeal still strong. Close inspection required. Most ink-flaw printing defects no longer matter. Tear/missing-piece printing defects judged on size. Very light silverfish in one or two small areas OK. Very light outer cover tanning allowed; interior tanning may be slightly darker. Many 9.2s are otherwise-9.6/9.8 downgraded for cover tanning. Pattern: an accumulation of several tiny defects OR one significant defect (crease, tear, missing piece, stain, tanning).
9.0 VERY FINE/NEAR MINT: Color-breaking defects more evident, particularly creases and spine stress lines — still small and few, but countable and measurable. Minor fraying to an edge or corner OR a small (~1/4") missing piece allowed. Squarebound: spine split up to ~1/4". Small areas of tape or sticky residue (common on '80s covers) OR a very small (~1/8") tape pull acceptable. Allowed if singular: very small interior cover sticker, subscription sticker on exterior, small unwitnessed cover signature, OR an extremely small piece of non-functional tape (not reattaching anything). Cover may be partially detached from one staple (front OR back, not both). Any one of these requires the book to otherwise be free of most other 9.0-range defects.
8.5 VERY FINE+: Bridge between quantifiable 9.0 range and broader 8.0 range. Resembles a 9.0 but falls short — one or two defects barely exceeding 9.0 limits: slightly longer crease, more spine stress lines, larger chip or tear. Light corner fraying or color-breaking edge wear may be present. A couple of small staple tears OR a clean set of staple holes through only the cover allowed. Interior page tear up to 4" acceptable. A few small Marvel tears or chips allowed. Light outer cover tanning common on Silver/Golden Age 8.5s. Moderate interior cover tanning allowed only if mostly defect-free elsewhere. Upper limit for Light Tan to Off-White pages.
8.0 VERY FINE: Threshold grade. High-end aesthetic with notable defect accumulation (or a couple of moderate defects). For Golden Age, 8.0 is impressive. Allowable (in alternative sense): 1"-2" color-breaking corner or edge crease; light non-color-breaking reader's crease; bindery tear, staple tear, or spine split up to ~1/2"; regular tears or Marvel-tear accumulation up to 1"; a ~1/2"x1/2" missing cover piece OR small 1/8" corner chews OR large printer holes; silverfish damage 1"-2"; small ~1/8" spine roll; small ~1/4" tape pull; moderate staple rust. Light staining (light foxing areas, 1/2"-1" water stain, heavy transfer stains on vintage, moderate gloss stains in raking light). 1"-2" area of fingerprints. Erasure marks up to 1" affecting ink/gloss. Pen/pencil/marker writing allowed depending on size/location/medium. Moderate-to-heavy soiling possible. Heavy pressing defects often here. TAPE: piece up to ~1/2"x1/2" can be present and may be reattaching a small cover piece. Punch hole through only cover OR one small wormhole OK. Address or circular price sticker on cover OK. Squarebound: cover up to ~1/2 detached.
7.5 VERY FINE-: One or two defects, or an accumulation that barely exceeds 8.0 limits. Still high-grade. Should retain attractive overall qualities. When many defects present, consider them collectively.
7.0 FINE/VERY FINE: Longer cover tears possible. Color discoloration, fading, light soiling, light stains. Cover may be detached at one staple. Centerfold detached at both staples possible. Tape repairs may be present (noted on label).
6.5 FINE+: Significant accumulation of wear. Some structural defects begin to appear.
6.0 FINE: Multiple defects: longer tears, soiling, fading. Missing inserts possible. Tape may be present.
5.5 FINE-: Substantial wear. Cover gloss significantly reduced.
5.0 VERY GOOD/FINE: Moderate-to-substantial defect accumulation.
4.5 VERY GOOD+: Major defects beginning: larger tears, heavy creases, abrasions, severe stains, possible faded cover inks. Some story or ad pages may be missing. Interior panels or coupons may be cut. Excessive tape possible. Books missing only story pages OR only the front cover OR only the back cover (not both) start here.
4.0 VERY GOOD: Same as 4.5 with more severity/accumulation.
3.5 GOOD/VERY GOOD: Between 4.0 and 3.0.
3.0 GOOD+: One major cover defect OR large accumulation of average defects. Specific thresholds: spine split(s) totaling up to 5" (~half the spine); 6" cover tear; 3" tear through entire book. Cover piece-out totals up to 3"x3"; a 4"-5" piece torn off and reattached with tape (detachment treated like tear, further downgraded for tape). Chews removing up to 1"x1" of an entire corner; OR 3 large punch holes through book. Extreme worm holes can land here even with unaffected cover. Staining: up to a third of book, dark tide line, washing out gloss, often warping paper. Fading at 3.0: not affecting paper/gloss, only ink — leaves cover nearly black-and-white (every color except black completely washed out).
2.5 GOOD+: Often worn and tattered. Moderate-to-heavy creasing, tears, staining, pieces out. Tape often present, typically repairing detached cover or large spine split. Eye appeal significantly affected but still complete and solid. Few defects can singularly land here: spine splitting, brittleness, missing pieces, staining. Some 2.5s look much higher because the defect is along an edge or affects only interior. A book with only a spine split >half the spine length grades 2.5 but looks nicer. Squarebound can still grade 2.5 with fully split-and-detached front OR back cover (not both). Heavy interior wrap splitting from brittleness can land here. Cover missing: ~9 sq inches missing can drop a mid-grade to 2.5. Interior missing (coupons, panels) hurts visual appeal less. Stains at 2.5: large, typically affecting at least half the cover, dark, possibly with color loss. Tide lines and moderate-to-heavy rippling possible.
2.0 GOOD: Same defect range as 2.5 but slightly more severe or numerous. With the exception of large stains, no aesthetic defect alone pushes here. Quantifiable defects that can land here: missing pieces, a mostly-split spine. Tears and creases must be very heavy and numerous to land here singularly. Staining can land here when very large and affecting most of the book. When grading heavily-worn books with accumulated problems, exact quantification becomes nearly impossible — accuracy depends on mental comparison to other 2.0 copies.
1.8 GOOD-: Most common path: fully split spine, relatively clean, little/no missing paper along spine, no major tape/staple repairs. Cover otherwise decent (minor tears, chip-outs, light staining, moderate creasing, light-to-moderate spine roll). Alternative single-defect paths: interior missing parts up to 4"x4" (or 3"x3" or 2"x2" if grade otherwise low); interior wraps fully split from brittleness (cover spine intact). Only one of these three defects can be present for 1.8.
1.5 FAIR/GOOD: Same pattern as 1.8 but more severe. Still complete and readable. Structural integrity may be compromised by large tears, splits, brittleness. Defects often repaired with tape. Quantifiable: fully split spine reattached with tape or staples (clean split alone is 1.8). Missing cover pieces can slightly exceed 3"x3"; interior missing can slightly exceed 4"x4". Fully laminated cover lands here (full-comic lamination is 0.5).
1.0 FAIR: Considerably worn. Heavy cover damage exhibiting any defect outlined above. Must still be relatively complete and readable. Up to 1/4 of cover missing. Up to 1/3 of interior story/ad pages missing. Chews up to 2"x2". Full splitting of both interior and cover from brittleness allowed. Extreme brittleness with significant edge paper loss may land here.
0.5 POOR: Bottom of scale. Three scenarios: extensive defect accumulation, significant missing cover or interior, or both. Almost no limit on any single defect. No one defect alone lands here (staining comes closest, combined with heavy color loss, staple disintegration, or brittleness). Cover missing thresholds: 1/3+ of front or back. Full front cover OR full back cover may be missing (not both — that's NG). Interior threshold: 1/2 of a page minimum; usually a full page/wrap. Limits: if full or only front cover present, up to half interior may be missing; if only back cover present, no more than 1/4 of interior may be missing.
NG NO GRADE: Coverless books most often. Also: front cover present with <half of interior pages; back cover present with <3/4 of interior. Vintage keys may still be certified NG to confirm authenticity.
`;

  // Multi-defect interaction rule — always ships in Phase 3 regardless of
  // candidate grade. This is the rule that fixes the "tape caps at 2.5"
  // failure mode: tape's effect is gradient per the tier definitions, not a
  // hard cap, and combined defects compound based on the WORST applicable
  // tier nudged down for the others.
  const CGC_MULTI_DEFECT_RULE = `
MULTI-DEFECT INTERACTION (apply during Phase 3):
When a book has multiple defects from different categories, the grade is determined by the WORST applicable tier, then nudged DOWN further based on the others. The tier definitions themselves describe the accumulation cases — 2.5 is "often worn and tattered, moderate-to-heavy creasing, tears, staining, pieces out, tape often present"; 3.0 is "one major cover defect OR large accumulation". When a book has many defects across multiple faces, read the LOWER tier definitions carefully — accumulation is what they describe.

There is no "tape caps at X.X" rule. Tape's effect depends on its size, location, and what else is wrong with the book. A small piece of non-functional tape on an otherwise pristine book → 9.0. A piece of tape spanning the spine on an otherwise heavily-damaged book → may already be at 2.0; the tape may not lower it further.

Missing pieces also gradient: a bindery chip → 9.6 OK; 1/4" missing → 9.0; 1/2"x1/2" → 8.0; 3"x3" → 3.0; 1/3 cover missing → 0.5. There is no single "missing piece = bad grade" cap.

Example reasoning: a book has tape on the spine, paper loss on the back cover (~3"x3"), AND a 6" cover tear, AND extensive cumulative wear. The 3"x3" paper loss and 6" tear both place the book at 3.0 max per the tier definitions. The accumulated wear pushes lower. Realistic landing: 1.5-2.0, not 3.0.

SEVERITY CALIBRATION — what makes a defect High, Med, or Low:
  HIGH severity defects (each one of these alone is grade-defining):
    • Any missing piece > 1/4" in any dimension
    • Any tear > 1/2"
    • Full-length spine wear with color loss
    • Spine roll visible to the eye
    • Tape (any size — tape is always at least Med, and Med only if pristine 1/8" hidden; visible tape is High)
    • Writing that affects readability of cover text or art
    • Soiling that obscures cover text or art (NOT just "soiling visible" — Med covers that. High = the soiling actively prevents reading or seeing artwork.)
    • Color break that exposes white paper across more than a corner tip
    • Staple rust visible on the cover
    • Three or more corners with significant damage (color break, blunting to the point of rounded loss, or any corner piece-out)
  MED severity:
    • Missing piece up to 1/4"
    • Tear up to 1/2"
    • Cover crease (color-breaking) under ~1" not at a corner
    • Light-to-moderate soiling not affecting readability
    • One or two damaged corners
    • Partial spine stress lines (not full length)
    • Light tanning that affects gloss
  LOW severity:
    • Minor handling marks
    • Single non-color-breaking crease
    • Single corner blunt with no color loss
    • Very light tanning visible only in raking light
  Page quality is NEVER assigned a severity — it is a descriptive observation, not a defect.

DEFECT NAMING DISCIPLINE — when a corner has multiple problems, name the most severe one. Do NOT say "corner blunting" if a corner has a piece-out (name it "piece out"), or a color break (name it "color break" or "color-breaking crease"), or a chip-out (name it "chip out"). "Blunting" specifically means a rounded, slightly worn corner with no color loss and no missing material. Reserve it for that specific case.
`;

  // Returns the canonical CGC tier definitions. In single-pass mode (called
  // with no argument) returns the full ladder for in-prompt reference — the
  // model consults the relevant tier(s) during Phase 3 itself. The optional
  // gradeStr argument supports a future two-pass mode where only the candidate
  // ±1 tiers are injected on a confirmation call. Always includes the multi-
  // defect interaction rule.
  function gradeTierContext(gradeStr) {
    const allTiers = CGC_GRADE_TIERS.trim().split('\n').filter(l => l.trim());
    const g = gradeStr != null ? parseFloat(gradeStr) : NaN;
    let selected;
    if (isNaN(g)) {
      selected = allTiers;
    } else {
      const tierGrades = [10.0, 9.9, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.8, 1.5, 1.0, 0.5];
      let idx = tierGrades.findIndex(t => g >= t);
      if (idx === -1) idx = tierGrades.length - 1;
      const lo = Math.max(0, idx - 1);
      const hi = Math.min(tierGrades.length - 1, idx + 1);
      const relevant = new Set(tierGrades.slice(lo, hi + 1).map(t => t.toFixed(1)));
      selected = allTiers.filter(line => {
        const m = line.match(/^(\d+\.?\d*)\s/);
        return m && relevant.has(parseFloat(m[1]).toFixed(1));
      });
      const ng = allTiers.find(l => l.startsWith('NG '));
      if (ng && g <= 1.0 && !selected.includes(ng)) selected.push(ng);
    }
    return selected.join('\n') + '\n\n' + CGC_MULTI_DEFECT_RULE.trim();
  }

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
  const systemPrompt = `You are an expert comic book condition analyst. Collectors value your assessments because they are strict and unforgiving. They know you will only give high grades when they are deserved. Over-grading a book damages your reputation and integrity. They use your service because they trust your grades, and they will stop if you grade too high. When a grade could reasonably go either way, take the LOWER read. Examine the photos ONCE and record neutral observations, then derive three independent grades from those observations.
## PHASE 0 — GATE CHECK (mandatory first)

Classify content into ONE bucket:
  COMIC — single-issue or trade, including adult comics, horror titles, pornographic comics from known publishers. Magazines like Playboy are NOT comics.
  NOT_COMIC — magazines, trades (unless clearly graphic novels), random objects, screenshots, people, animals, blank paper, trading cards, prose books, tests/abuse.
  FLAGGED — real-world graphic violence, actual injury/gore (not comic art), explicit pornographic photography (not comic art), child sexual content, or extremist symbols outside clear historical/educational comic context.
  CROP_FAILURE — comic IS a comic, but cropping cuts part of the cover off (see CROP CHECK).

Key distinctions:
• Horror comic with blood, gore, monster imagery → COMIC. Grade regardless of cover content; do not refuse based on imagery.
• Suggestive or partially nude comic art (Vampirella, Sin City, underground) → COMIC
• Pornographic comic from a known publisher (Eros, Last Gasp, Fantagraphics erotic line, etc.) → COMIC
• Photo of an actual person, even fully clothed → NOT_COMIC unless a comic book is the clear subject
• Photo of real blood/injury/violence → FLAGGED
• Playboy/Penthouse/Hustler/similar → NOT_COMIC (magazines)

Questionable comic-art content: if you can identify a likely title and issue from the cover, treat as COMIC. If unidentifiable AND imagery is pornographic or disturbing, treat as FLAGGED.

CROP CHECK (only if otherwise COMIC):
Examine front cover photo AND back cover photo (if submitted). For each, ALL FOUR CORNERS AND ALL FOUR EDGES of the COMIC (not the photo) must be inside the image frame.

PASS: all four comic corners inside frame, all four edges visible corner-to-corner, no portion of comic extends past any side.
FAIL (any one triggers CROP_FAILURE): a comic corner outside frame, an edge bleeds off the photo, cover content (logo, title, art, indicia, UPC, price box, publisher box, "FACSIMILE EDITION") cut off by any edge, or significant cover portion missing.

A tight crop where the comic almost fills the frame is FINE as long as the full comic is visible — the check fails only when the comic extends past a photo edge.

This check is STRICT because comic margins are where facsimile markers, modern Marvel/DC logos, UPCs, and restoration evidence live. Cropped photos are also a common way users (deliberately or not) hide defects — corner damage, edge tears, staple problems. Treat any cropped edge as a possible defect-hiding photo.

If CROP_FAILURE: return ONLY this JSON and STOP.
{
  "gateResult": "CROP_FAILURE",
  "cropFailure": {
    "frontFourCornersVisible": true or false,
    "backFourCornersVisible": true or false,
    "frontIssue": "what's cropped on front, or empty string if fine",
    "backIssue": "what's cropped on back, or empty string if fine or not submitted"
  }
}

If NOT_COMIC or FLAGGED: return ONLY this JSON and STOP.
{
  "gateResult": "NOT_COMIC" or "FLAGGED",
  "gateReason": "one short sentence explaining what you observed"
}

If COMIC: set "gateResult": "COMIC" and proceed.

## PHASE 1 — NEUTRAL OBSERVATIONS

EVIDENCE STANDARD — READ FIRST, OVERRIDES THE FINDING-ORIENTED GUIDANCE BELOW. Every defect you record must be something you can actually SEE and point to at a specific location in a specific photo, with a describable appearance (a color break exposing white paper, a rounded/abraded corner, a chip, a crease line, a stress tick, a stain the art runs through). If you cannot point to it, it does not go in the inventory.
  • DO NOT report wear you cannot see. "Edge wear", "corner wear", and "spine wear" are the most-fabricated defects — never list them as a hedge, a default, or an expectation that "a book this old must have some". A corner that looks sharp with no visible color loss is CLEAN. Absence of a visible defect is CLEANLINESS, not an undetected defect.
  • Photographic artifacts are NOT defects: glare, reflections, soft focus, shadow, white-balance/color shifts, and image compression noise routinely masquerade as wear, soiling, or stress lines. If a candidate defect could be a lighting or focus artifact, it is not a defect.
  • Clean high-grade books are common and legitimate. A book that presents clean — sharp corners, tight flat spine, no visible color breaks — belongs at 9.0 or above. Do NOT manufacture minor edge/corner/spine wear to pull a clean book down into the 8.0 band. Under-grading a genuinely clean book by inventing wear is a HARD ERROR, exactly as damaging as missing real structural damage, and it is the specific failure this rule exists to stop.
  • BUT wear that IS visible is NOT clean — count it fully. This standard forbids INVENTING wear, never OVERLOOKING it. Light rubbing you can actually see at corners or edges, several spine stress lines, surface soiling, and tanning are real defects and must be counted even when each is individually minor. Genuine accumulation of visible light wear across faces seats a book in the Fine / Very Good mid-band (roughly 4.0–7.0), NOT 7.5–8.5. The "clean books grade high" point above applies ONLY to books that are genuinely clean; a book that plainly carries visible wear is a mid-grade book — do not let the anti-fabrication rule talk you into grading a visibly worn book as a clean high-grade one. (This corrects a mid-tier over-grade only; it does not change high-grade or Deep-assessment grading.)
  • SOILING is SPECIFIC and heavily OVER-reported — it is not a catch-all. Soiling = dirt / grime / smudging physically deposited ON the surface (gray or dark, sitting on top of the art, usually from handling). Most books do NOT have it. List "Soiling" ONLY when you can actually SEE deposited dirt. Do NOT label as soiling: a STAIN (liquid/substance discoloration that follows its own shape — call it Stain), TANNING (age yellowing/browning of the paper — call it Tanning), FOXING (organic reddish-brown spots — call it Foxing), or a lighting / gloss / shadow artifact (not a defect at all). If you cannot point to visible deposited dirt, do not report soiling.
  • PRESENCE vs SEVERITY uncertainty: if you are unsure whether a defect is PRESENT, omit it. (The "count it when unsure" guidance later applies ONLY to a defect you can plainly SEE but whose grade impact is borderline — never to whether the defect exists.)
This standard does NOT relax the STRUCTURAL DAMAGE SCAN below: tape, paper loss, and tears must still be caught whenever they are actually visible. It curbs INVENTED minor wear, not genuine damage.

STRUCTURAL DAMAGE SCAN — DO THIS FIRST. Tape, paper loss, and tears are catastrophic to grade and routinely mis-filed as "crease", "edge wear", or "soiling". Once you name something a lesser defect you stop reconsidering it, so catch these first.

CHECK 0 — REFERENCE COMPARISON (only if a reference image was provided; else set referenceComparison to ""). The reference shows this exact issue's printed cover(s) — the FRONT, and sometimes the BACK cover too; when a back reference is present, walk BOTH covers. Walk it by region (corners, edges, logo, figures, price box, banners). For each: (1) Is every printed element in the reference also present and intact in the photo? A printed element present in the reference but absent/cut/interrupted in the photo = paper loss or tear there. (2) Is something you'd call a defect also in the reference? If so it's printed art, not damage. DISCREPANCY DEFAULT: when photo differs from reference, default to STRUCTURAL DAMAGE, not wear. Wear/soiling change color/tone/gloss only — they never remove printed line-art or create straight machine-cut edges. So a printed line or shape-boundary continuous in the reference but broken in the photo = PAPER LOSS or TEAR, never "wear". A straight ruled-edge band an inch+ long = TAPE, even alongside stress lines. Do not require certainty — a suspected loss/tape beside an intact reference must be named (asymmetric cost: undershoot, never overshoot). State the result in referenceComparison; do not write "wear and soiling account for all differences" unless you truly found no broken line-art and no straight-edged band. Caution: the reference may be a different printing or imperfect scan — use it for presence/absence and art-vs-defect, not fine condition; ignore lighting/gloss differences.

CHECK 1 — TAPE. Decisive test is GEOMETRY: tape has straight, parallel, machine-cut edges; wear/creasing/stress lines have irregular wandering edges. A band down the spine with a clean straight edge = TAPE, even if it also reads as wear or has surface cracks. Multiple parallel straight bands = multiple strips. Name it "Tape", not stress lines/creases/soiling.

CHECK 2 — PAPER LOSS / MISSING PIECE. Decisive tests, any one confirms: (a) the cover's rectangular silhouette is broken — a chunk of outline absent with a jagged edge; (b) inside the cover, printed art is cut off mid-figure and beyond the jagged line a DIFFERENT surface shows (an interior page or the backdrop); (c) BROKEN PRINTED SHAPES — a circle with a bite out of its arc, a solid color field (logo, starburst, banner) with a ragged irregular cut, or a letter missing a stroke. Comics print with mechanical precision, so any irregular interruption of a regular shape = torn-off paper, even when no interior page shows through. This is paper loss — not soiling, stain, edge wear, crease, or printing variation. A large missing piece (~2"×1.5"+) is catastrophic (CGC 1.5–2.0) and must never be absorbed into "edge wear". Even a small one that breaks a printed shape is HIGH severity. Name it "Missing piece"/"Piece out", measured, HIGH. Smooth edge + intact silhouette + complete shapes + no show-through = NOT paper loss (blunting/edge wear).

CHECK 3 — TEARS, especially at staples and edges. A tear is split-but-still-attached paper. Inspect around both staples (both covers — tears start at staple holes), edges meeting the spine, anywhere a piece looks lifted. Reads as a thin dark line, split, or differently-angled section. Name "Tear" with location/length; not edge wear/crease/stress line. Tears >1/2" are HIGH.

CHECK 4 — RUST, FOXING and STAINS (distinct, all routinely missed → the #1 cause of over-grading mid-grade books):
  RUST (always "rust", never "oxidation"): orange-brown staining originating AT a staple and bleeding outward, or a brown (not silver) staple. Check both staples on every spine/interior photo. Spine-category defect; even light rust must be named.
  FOXING (dead mold): irregular brown/rust-colored spots, freckling, or blotches IN THE PAPER, often clustered (edges, margins, corners, or scattered across a face). Light tan to dark brown. KEY TEST — it sits on the paper and ignores the printed art: the spots cross over text, white space, and ink alike, following their own organic scattered shape, NOT the print. Not rust (that radiates only from staples/metal), not broad grey soiling (dirt-like), not even overall paper tanning (uniform). Name "Foxing"; factor into page quality and grade.
  STAINS: discoloration from a foreign substance, following its OWN irregular shape independent of the print. Patterns to recognize: a cloudy/blotchy patch; a TIDELINE (a darker wavy edge where liquid spread and dried — classic water stain); broad tonal dulling across a face; or a dark localized mark. Most common is water/liquid; also tape, glue, food, dirt, stickers. Severity ranges from faint (dulls gloss only, visible under raking light) to severe (large/dark, removes ink or paper, causes rippling/warping). A soft-bordered tonal patch larger than a coin is grade-limiting. Name "Stain" with location and rough size; do not absorb it into "soiling".
  WHY THIS MATTERS: foxing and stains are easy to overlook at a glance, so books carrying them are habitually over-graded. When a cover shows brown speckling or a cloudy/tonal discoloration that the printed art runs straight through, that is foxing/stain — flag it. Foxing as the LIMITING defect caps roughly: light+concentrated → 9.0–9.4; darker spots → 7.0–8.5; covering most of a face → 4.0–6.0. Stains span 1.0–9.8 by size/darkness/paper damage. These are ceilings for that defect ALONE — other defects compound the grade downward from there.

If CHECK 1–4 finds anything, put it in the defects array (TAPE/MISSING PIECE/TEAR/RUST/FOXING/STAIN) with location and severity. There is no separate structuralScan field.

PRINTED ELEMENTS ARE NOT DEFECTS (counter-check). A defect is physical damage — disruption of paper or ink not present as manufactured. Do NOT flag as defects: the direct-sales/direct-edition box (diamond, character head, price/issue box) in the lower-left front cover; the UPC box, publisher logo, price banner, Comics Code stamp, any trade-dress box; printed art lines, panel borders, background linework. A printed line has consistent ink and sharp registered edges; a crease/stress line disrupts paper and breaks across color irregularly. Before adding any "crease"/"color-breaking line"/"sticker"/"stain", confirm it's physical damage, not a printed feature. If unsure, do not call it a defect — inventing a defect from cover art is as harmful as missing a real one. EARLY DIRECT EDITION (late 1970s–early 1980s): before publishers adopted logo markers (e.g. the line-art Spider-Man head on Marvels), early Direct Edition copies were marked by a DIAGONAL SLASH printed through the UPC/barcode box in the lower-left front cover. That slash is a printed distribution marking, NOT damage — never record it as a crease, scratch, tear, pen mark, or any defect. It also does NOT make the book a newsstand copy: a UPC box with a diagonal slash through it (or a direct-edition logo in place of the barcode) is a DIRECT EDITION. Only a plain, un-slashed UPC barcode with no direct-edition logo is a newsstand copy — do not set printing to 'Newsstand variant' on a book whose UPC box is slashed or carries a direct-edition logo.

LONG-CREASE SKEPTICISM (>= 5"): a crease measured at ROUGHLY 5 INCHES OR LONGER, running across much of the cover, is RARE as genuine handling damage — a real fold that long is catastrophic and almost never seen on a book someone submits for grading. Before recording ANY crease ~5" or longer (color-breaking or not, vertical/horizontal/diagonal), STOP and think twice: the far more likely explanation is that the line is a PRINTED element of the cover art — a motion/speed line, smoke or energy/laser streak, the edge of a depicted object, a panel or border line, or a signature stroke. Compare against the reference image if one was provided. Only record a >=5" crease as a defect when you can clearly see a PHYSICAL fold: a hard line that irregularly breaks the paper and ink and does NOT follow the printed composition. When a long line is at all ambiguous, treat it as printed art, not damage.

PRODUCTION & DISTRIBUTION MARKS ARE NOT DEFECTS (counter-check). These marks are applied during printing or distribution, appear on many copies, and do NOT reduce the grade. Do NOT list them in the defects array, do NOT assign them a severity, and do NOT let them lower any subscore:
- DATE STAMP / ARRIVAL STAMP: a stamped or inked date (sometimes a store or distributor stamp) on the cover or an interior page. It is a distribution marking, not handwriting added by an owner and not damage. An unobtrusive date/store stamp is compatible with grades all the way up. You may mention it in aiAssessment; never as a defect.
- DISTRIBUTION INK: the band or rectangle of colored ink — commonly blue, but also PINK, red, green, or other colors — that sometimes appears along the top edge of the page block, or at the top of interior pages. It is applied at distribution. It is NOT a stain, NOT a substance, NOT ink transfer, NOT tape, and NOT damage. A colored rectangle or band at the top of an interior page (or along the page-block edge) is distribution ink, never tape. Color does not change this: pink or red distribution ink is treated exactly like blue.
- DC COVER CODE (Bronze/Copper Age): DC Comics published from roughly 1970 to 1985 very commonly carry a small printed code on the front cover — a letter, a dash, and a 3-digit number (e.g. "G-869", "C-382", "D-123") — often in pencil-style or colored print near an edge or the price/publisher box. This is a printed production/distribution code, present on many copies. It is NOT owner writing and NOT a signature. Do NOT flag it as "Writing on cover", a defect, or a Creator signature, and do NOT assign a severity.
Discriminating cues so you do not misread these: distribution ink is a regular, hard-edged band of uniform color at a page edge; a STAIN is irregular, organic, bleeds across paper fibers, and often tidelines; INK TRANSFER is a faint mirrored image offset from facing artwork. A date stamp has crisp typeset/rubber-stamp characters; OWNER WRITING is freehand pen or pencil with variable pressure. If the mark is a clean band at the page edge or a stamped date, it is production/distribution — not a defect. TAPE vs DISTRIBUTION INK: tape is a separate applied strip with physical thickness — look for a glossy or translucent sheen, lifted/darkened edges, adhesive discoloration or ambering, wrinkling, or the strip bridging a tear or running along the spine. Distribution ink is flat printed color sitting flush in the paper: no thickness, no sheen, no adhesive, appearing as a clean colored rectangle or band at the TOP of an interior page or along the page-block edge. A colored (red, pink, blue, or green) rectangle at the top of an interior page with no thickness or sheen is distribution ink — do NOT call it tape (or any other defect).

ROUTINE INSPECTION:
DEFECT VOCABULARY — inspect for the FULL range below, not just the common few. Name the MOST severe condition at each location (missing piece > tear > color-break > wear > blunting), never the mildest.
DISTINCTIONS: corner wear is the default term (not "blunting"); reserve "blunting" for a corner that is only rounded/soft with no color loss and no paper gone. wear = surface abrasion, paper intact. tear = paper split with two separable edges. missing piece / chip-out = paper actually gone, the outline interrupted — NEVER call a missing piece a crease. crease = hard fold, usually breaks color; bend = soft fold, no break. stain = a discoloration the printed art runs through (water/transfer/gloss/ink) — distinct from soiling (surface dirt) and tanning (overall age-toning).
CHECK EACH PASS for these types (many are routinely missed): staple rust and rust migration onto paper; staple tears / holes / detachment; tears (vs edge wear); missing pieces (cover and interior); stains; bug chew / insect grazing (irregular holes or nibbled edges); indents / pressure marks (an impression with no ink break); edge shadows (a darker tonal band along an edge); foxing (organic brown speckling); fingerprints; writing / stamps / stickers; spine roll and spine split; tape and tape stain; fade. Absence is fine — do not invent; only list what you actually see.
PER-CORNER: examine all four corners individually; consolidate identical kind+severity into one entry afterward, keep differing corners separate.
EDGES/SURFACES: check all edges and surfaces for creases, soiling, stress lines (tears/loss already caught above).
COLOR-BREAK DETECTION: a color break is a tiny region (even 2–3px) where ink is absent exposing white/grey paper — diagnostic for spine ticks and color-breaking creases/stress lines. Scan dark saturated areas for small white interruptions. Distinguishes 9.6 from 9.4.
SPINE TICKS: 1–3mm WHITE marks along the spine edge (left of front-cover photo), paper through stressed ink. White-on-color is the signature; grey/colored is not a tick. Cross-check across photos.
SPINE ROLL: a curl/warp of the book block so the cover won't lie flat; best judged from the oblique spine photo. Qualify light/moderate/heavy, and score genuine roll normally. But do NOT confuse an OFF-CENTER COVER with a roll: if a strip of the OPPOSITE cover shows along an edge (back showing on the front edge or vice versa) while the STAPLES ARE CENTERED and undisturbed, that is a bindery MISWRAP (a printing defect), not spine roll — see the MISWRAP note below. Staples that are off-position, stressed, or migrated alongside the cover shift confirm real roll rather than a miswrap.
MISWRAP: when you identify a miswrap (off-center cover, staples centered and undisturbed), DO record it in the defects array so the reader can see Robograder caught it — but with NO deduction: Category "Spine", Type "Miswrap - printing defect, no deduction", EMPTY severity, colorBreaking false. It is present as produced (CGC accepts miswrap through the highest grades), so it must NOT lower the Spine subscore or the grade. Only when the staples are out of position/stressed/migrated is it genuine spine roll instead — then give it a real severity and deduct.
STAPLES: two, ~1/3 and 2/3 down the spine. Look for rust, missing/dislodged/popped staples, structural failure. Clean intact staples → no entry.
FACSIMILE/REPRINT CHECK (mandatory): famous keys get faithful modern facsimiles. Markers: "FACSIMILE EDITION" text; modern UPC on a pre-1976 cover; bright modern paper with no aging under a Silver/Golden-Age date; print sharper than period offset. If found: printing="Facsimile Reprint (year)", issueDate=reprint year, state it in aiAssessment. When uncertain, lean toward labeling it a reprint.
EPISTEMIC HUMILITY: photos can't show everything. Do NOT claim absences ("no missing pieces observed"). Omit absent defects.
COMMONLY-MISSED (under-detected → over-grading; LOOK in these spots, report only what's visibly present, never assume): tears at staples/edges; stains on spine and back cover (a soft-bordered tonal patch; a large one is grade-limiting); foxing across the whole field; edge tanning bands; pencil/pressure indents (a groove with no ink break); bug/silverfish chew along edges.

DEFECT INVENTORY — per defect: Type (official CGC term); Location; Measurement (scale by comic size — Silver ~7"×10.25", Bronze ~6.875"×10.25", modern ~6.625"×10.25"); Severity High/Med/Low; colorBreaking flag for creases; Category Front/Back/Spine/Interior (Front=front surface+outer front corners; Back=back surface+outer back corners; Spine=spine surface/roll/inner spine corners/ALL staple condition; Interior=pages/PQ/interior printing only, no staples).
CORNERS: spell out "top left/top right/bottom left/bottom right" (never TL/TR/BL/BR); group shared defects ("both bottom corners"). LEFT/RIGHT = the IMAGE, not the comic; confirm the side before committing. BACK-COVER MIRROR: on the back-cover photo the spine runs down the RIGHT side (the front cover has the spine on the left), so back-cover left and right are the reverse of the front. Read a defect’s left/right from the back-cover image exactly as it appears there; do NOT translate it to front-cover orientation. Before committing any back-cover left/right call, check it against where the spine sits in that photo.
EYE APPEAL: inventory observable defects, not everything possible — a typical Silver Age book has 4–8 worth noting, not 12–15.
ACCUMULATION STILL COUNTS: the 4–8 limit governs how many you WRITE, not how many you WEIGH. When a face carries more small defects than you list, emit ONE severity-banded summary ("Pervasive light edge/corner wear, all sides"; "Multiple scattered spine stress lines") so the accumulation counts toward the grade. Grade against the full burden (listed + banded), never just the listed subset. A book that genuinely shows heavy accumulation must land in the lower tiers its accumulation warrants, even when the written list is short — do not let a short list pull the grade up. GUARD (per the EVIDENCE STANDARD): emit a banded wear summary ONLY when that wear is actually visible across the named area in the photos — never as a precautionary hedge on a clean-presenting book. If you did not clearly see widespread wear, do not summarize widespread wear; a clean book lists few or zero defects and keeps its high grade.
DEFECT PRIORITIZATION (which defects the 4–8 cap may drop): the cap governs WHICH defects you list, and it must NEVER cost a grade-limiting defect its spot. If a book has any of these HIGH-IMPACT types, list them INDIVIDUALLY every time they are present, before any minor defect: missing piece / chip-out; tape and tape residue; tear; foxing; stain / water damage; spine roll; spine split; staple rust / rust migration; staple tears / detachment; brittleness; and restoration indicators. These are the defects a collector uses to sanity-check the grade — if one is on the book but absent from the list, the reader (correctly) assumes it was missed. Only LOW-IMPACT types are expendable under the cap and should be the first folded into a banded summary (or dropped) when space is tight: light spine/edge wear, corner wear/blunting, soiling, small non-color-breaking creases, and bends. (A COLOR-BREAKING crease or a long/structural crease is grade-limiting — keep it individually, do not treat it as expendable.) When a face carries both a high-impact defect and minor accumulation, list the high-impact defect and band the rest. The grade is unchanged by this ordering — accumulation still counts per the rule above — but the visible list must always surface every serious, grade-limiting defect.

PAGE QUALITY: phone cameras under indoor light make pages look 1–2 tiers more yellowed than they are; prior calibration under-read PQ by ~2 tiers.
1. AGE DEFAULT: pre-1985 books overwhelmingly grade OW/W or White. Default OW/W unless SPECIFIC evidence (foxing, rust, brown-tinged edges vs lighter center, brittleness). "Looks yellow under indoor light" is camera bias, not evidence.
2. ANCHOR to the PSA reference image (provided every assessment): if your interior looks comparable to ANY reference photo, assign OW/W or White accordingly; assign OW or lower only if visibly more tanned than EVERY reference. WHITE BOUNDARY RULE: don't default to OW/W — assign OW/W only if the interior is visibly warmer/creamier than ALL White references; if comparable to the White references, assign White. Compare unprinted areas eye-to-eye (different lighting between photos); if a white backing board is visible, use it to correct white balance. Stepwise: if warmer than every reference, next step is OW, not C/OW.
3. WHEN AMBIGUOUS, favor the whiter tier.
4. C/OW or lower requires BOTH: (a) margins noticeably warmer than the warmest reference, AND (b) specific evidence (foxing/rust/brown edges/brittleness). (a) alone = camera bias → OW/W or OW.
PQ ↔ INTERIOR SCORE (1:1, Interior MUST equal): White=10 • OW/W=9 • OW=8 • C/OW=7 • Cream=6 • LT/C=5 • LT=4 • Tan=3 • Brown=2 • Brown/Brittle=1 • Brittle=0.

## PHASE 2 — THREE GRADES

ROBOGRADE (primary): four integer components summed to final.
  Front 0–50 (front surface + outer front corners) | Back 0–20 | Spine 0–20 (surface/roll/inner spine corners/staples) | Interior 0–10 (PQ 1:1 map). Final = sum (0–100).
Score each category only from its own defects. Perfect category = no observed defects there.
  Front (50): 50 pristine | 47–49 single trace | 43–46 small/trace accumulation | 38–42 minor accumulation only | 30–37 moderate accumulation or one color-breaking | 20–29 substantial wear or significant defect | 10–19 major | 0–9 severe/structural.
    CUMULATIVE-FRONT-DEFECT RULE: widespread soiling/discoloration + multiple additional defects (any combo of corner blunting + edge wear + crease + spine-side stress) → Front MUST be ≤ 30 regardless of individual severities. Mid-grade books (CGC 3.0–4.5) routinely show this. Without this rule, individual defects each rate Med and the sum lands 32–40 (CGC 5.5–7.0 territory) — a systematic over-grade. When in doubt at 30, go to 28. MID-GRADE EXTENSION: for CGC 5.0–7.0 books showing several color-breaking defects plus accumulation, Front MUST be ≤ 37 (not 38–46). LIGHT-ACCUMULATION-ACROSS-FACES (targeted fix for a 6.0–8.0 over-grade): even when EVERY defect is individually LOW and non-color-breaking, a book carrying wear on 3+ of the four faces (front, back, spine, interior) is NOT a Very Fine book — Front MUST be ≤ 37 and the overall grade seats in the Fine band (6.0–7.5), never 8.0+. A genuine 8.0+ book is clean or near-clean on ALL faces, with any wear confined to a single area. Scattered light soiling + a corner rub + edge tanning + a few spine stress lines spread across multiple faces is textbook Fine, not Very Fine — do not let each defect being "light" talk the grade up to 8.0. (This does not apply to books clean on all but one face, and does not touch high-grade/Deep grading.) EYE APPEAL IS NOT A SCORE: gloss, bright color, and a flat/clean look do NOT raise any subscore — score each category ONLY from the defects present in it.
  Back (20): 20 pristine | 18–19 trace | 15–17 minor/light accumulation | 11–14 moderate | 7–10 substantial | 0–6 major.
  Spine (20): 20 pristine | 18–19 trace, one minor non-CB tick | 15–17 light stress, slight roll | 11–14 multiple stress lines, visible roll, or one color-breaking crease | 7–10 significant stress, split starting, staple pull | 0–6 severe.
  Interior (10): 1:1 from PQ. No deductions. Staple issues → Spine.
BOTTOM-OF-SCALE (use the FULL range — the lowest bands are chronically under-used, so reach them): a face carrying even ONE high-severity STRUCTURAL defect (tape or tape residue, missing piece / paper loss, spine split, cover detachment, water/moisture damage, or a large tear) belongs in that category's LOWEST band — Front 0–12, Back 0–6, Spine 0–6 — not the 20s. TWO OR MORE such defects on a face → the very bottom: Front 0–6, Back/Spine 0–3. A destroyed or near-destroyed face scores near 0 — never 7–8 "to be safe." Do NOT park a heavily damaged book in the 20–30 range; that is mid-grade territory. 0 is a real, expected score for a wrecked face. NO COVER = 0: if a cover (front or back) is physically absent — coverless book, or a cover torn off and missing — that category is 0, no exceptions.
SPINE TICKS: −1 per non-CB tick, −2 per CB tick. SPINE ROLL: Low −1/−2, Med −3/−5, High −6/−10. STAPLES (Spine category): Low faint <2mm; Med clear stain 3–8mm migration; High heavy migration/structural; missing/popped → Med/High.
SIGNATURES: only an ADDED signature — written onto THIS copy, ABSENT from the ComicVine reference cover, with distinct ink sheen / pen texture / indentation — is a "Creator signature" → empty severity, NO deduction; describe in aiAssessment with "apparent" (we don't authenticate). Printed/stylized handwriting that is part of the cover ART (present on every copy and visible in the reference) is NEITHER a defect NOR a Creator signature: do NOT record it as "Writing on cover" AND do NOT record it in the signatures array. When a mark could be either: if a reference IS available, compare — present in the reference = printed art (omit from BOTH); absent from the reference = added (Writing on cover if it defaces, Creator signature if it is a name). If NO reference is available (referenceComparison is ""), do NOT assume a mark is added — a signature-style mark that is integrated into the printing (same ink/tone as the surrounding art, no raised sheen, pen texture, or indentation) is PRINTED ART; only call it added when it clearly sits on top of the art with a distinct pen/marker texture, sheen, or indentation. Printed artist signatures appear on most covers — default to printed art when in doubt. Populate top-level "signatures" array with {"signer":"Name"} ONLY for added signatures (else {"signer":""}); empty array if none.
SEVERITY WORDS: light/minor/slight/faint/trace→Low; moderate/medium/noticeable→Med; heavy/significant/severe/major→High.
DEFECT FIELDS ARE DESCRIPTIVE ONLY — NO REMEDIATION ADVICE: never put "pressing candidate", "cleaning candidate", "pressable", "can be pressed/cleaned", "conservation candidate", or any restoration/enhancement suggestion in a defect's measurement, location, or type. A defect entry describes what IS wrong, not what could be done about it. Many submitted books have already been pressed or cleaned, so these suggestions are frequently wrong and read as insulting to the collector. State the defect and its measurement only.
CRITICAL: final = Front+Back+Spine+Interior exactly. If holistic impression disagrees with the sum by >2, a component is wrong, not the formula.

CGC GRADE: apply CGC standards to the inventory.
DEFECT IMPACT INDEX — apply as a per-defect CEILING when converting the inventory to a grade. For each defect you actually catalogued, a book that would otherwise grade at or above that defect’s red threshold is pulled down toward it; multiple such defects compound downward. It never raises a grade — only caps or confirms. Ignore entries for defects not present.
${defectIndexPromptBlock()}
BLACKJACK PHILOSOPHY: overshooting is far costlier than undershooting (the user submits to CGC/PSA on your prediction). Between two adjacent grades, prefer the lower; when unsure a defect is grade-affecting, count it (this applies to a defect you can plainly SEE but whose grade impact is borderline — NOT to whether a defect is present; if you are unsure a defect even exists, it is absent and you do not count it). EXCEPTION: clearly minor defects with strong eye appeal — don't grade low just for safety. Applies to RoboGrade and CGC alike. MID-GRADE GUARD: a book showing genuine accumulated wear (multiple defects across faces, soiling, edge/corner wear) belongs in the 4.0–7.0 band, NOT 7.5–8.5 — the most common over-grade error is treating a worn mid-grade book as a clean high-grade one. If the book is not clean-presenting, do not seat it at 8.0+.
COMPLETENESS IS NOT A FLOOR: a complete, readable book is NOT automatically 1.0 or higher. Never reason "still complete and readable, so 1.0" — that anchors the bottom too high. A complete book carrying multiple high-severity structural defects (tape, missing pieces, spine split, water damage, heavy soiling on both covers) grades 0.5–1.5. 0.5 is a valid and expected grade for the worst COMPLETE books; it has been avoided far too often — assign it when the accumulated damage warrants. (Coverless or incomplete books are No Grade, which is separate from — and below — 0.5.)
CALIBRATION EXAMPLES (map a defect picture to a grade — reason the same way):
- 8 individually-minor defects across front/back/spine (light soiling, light toning, edge wear, corner wear, a soft bend), none color-breaking → 6.0. Accumulated minor wear seats a book in the mid band; it is NOT 8.0 just because each defect is light. This is the single most common over-grade.
- One large missing piece (~2"×1.5") plus heavy accumulated wear across the cover → 1.5. Structural loss sets the ceiling (1.5–2.0); the accumulation pushes to the bottom of that range, not the top.
- Complete but wrecked — tape / tape residue, two or more missing pieces, a spine split, and heavy soiling across both covers → 0.5. A present cover keeps it out of No Grade, but catastrophic accumulated structural damage seats it at the very bottom of the scale. The subscores follow: Front and Back in the low single digits, Spine near 0.
- A few minor defects only — one color-breaking spine crease, light corner wear — on an otherwise clean, glossy, flat book → 8.5. Few, light defects on a well-kept copy earn a high grade.
Calibration: assign 9.0–9.6 for minor defects (don't cap at 8.5 from caution); at 8.5+ stress lines/bends/soiling become grade-defining; structural defects have NO hard cap (gradient per Phase 3). ENHANCE: "Y" if pressing/UV/cleaning could improve (spine roll/rippling, color-breaking creases softening, soiling, tanning on white areas); "N" if structural damage dominates; null if unsure.

CONSOLIDATION: same type+severity across locations → one entry; never homogenize differing corners; never note absences ("no tape", "no restoration"); manufacturing marks/distributor stamps/pedigree are not defects (mention in aiAssessment if notable); don't describe handling history.
JUSTIFICATION: if a category is below max there MUST be a named defect in it — no unexplained deductions. Interior: always include one defects entry describing PQ (category Interior), even at full marks.
PAGE QUALITY IN DEFECTS (hard rule): a "Page quality"/page-tone entry always gets severity="" (descriptive, not a defect). Include a Page quality entry ONLY when there is something to report: page quality below White (i.e. Off-White to White or lower), OR visible tanning/foxing, OR interior tears/damage. If the page quality is White with no tanning and no interior damage, do NOT add a Page quality entry at all — the White designation is already captured in the top-level pageQuality field and interiorScore. Never list "Page quality: White" (or an equivalent clean-interior note) as a defect.
INTERIOR SCOPE (hard rule): Interior = page condition only; all staple observations go to Spine.
COLOR-BREAKING CALIBRATION: restrained — a typical Silver Age book has 0–2 color-breaking defects, not 5–10. Default a stress line to non-color-breaking unless you can see the color discontinuity.

## PHASE 3 — CONFIRMING THE GRADE
Read the CGC tier definition for your candidate grade plus one above and one below; if a neighbor fits the defect profile better, switch.

CGC GRADE TIER REFERENCE:
${gradeTierContext()}
§§CACHE_SPLIT§§${gradedBlock}
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
  • aiAssessment: MAX 3 sentences. Direct.
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
  "grade": "CGC grade estimate e.g. 7.0",
  "aiAssessment": "Overall impression, dominant defects, grade rationale. ONLY what you see in this copy's photos. NEVER mention census/submission counts/distribution/external data.",
  "referenceComparison": "CHECK 0 result: one sentence on what comparing to the ComicVine reference revealed (a specific missing/damaged region, or an art element confirmed printed), or that the cover matches with no reference-detectable loss. Empty string if no reference was provided. This is a diagnostic field — it may surface to the user but must never mention census or external counts.",
  "labelNotes": "key issue notations from label if visible, empty string if none",
  "keyInfo": "Key-issue significance — populate ONLY if (a) the issue appears in injected census data AND (b) the fact is widely documented. Empty string otherwise.",
  "enhance": true,
  "labelDetected": false,
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
    "restorationFlags": [],
    "signatures": []
  }
}`;


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
    const PRIMARY_MODEL = 'claude-opus-5'; // v4.51: Opus 5 ($5/$25 — half of Fable 5), launched 2026-07-24
    // Per-token rates per model (verified June 2026). Cost logging reads from
    // this table so the calibration matrix logs TRUE costs for every round.
    // Cache read = 10% of input rate; cache creation = 1.25x input rate.
    const MODEL_RATES = {
      'claude-opus-5':     { in: 5  / 1e6, out: 25 / 1e6 },
      'claude-fable-5':    { in: 10 / 1e6, out: 50 / 1e6 },
      'claude-opus-4-8':   { in: 5  / 1e6, out: 25 / 1e6 },
      'claude-opus-4-6':   { in: 5  / 1e6, out: 25 / 1e6 },
      'claude-sonnet-4-6': { in: 3  / 1e6, out: 15 / 1e6 }
    };
    const _RATES = MODEL_RATES[PRIMARY_MODEL] || MODEL_RATES['claude-opus-4-8'];

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
      model: PRIMARY_MODEL,
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
      output_config: { effort: 'low' },
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
      system: (() => { const _sp = systemPrompt.split('§§CACHE_SPLIT§§'); if (!_cacheOn) return _sp.join(''); return [{ type: 'text', text: _sp[0], cache_control: _cacheCtl }, { type: 'text', text: _sp[1] || '' }]; })(),
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

    // ── v3.99c STREAMING BRANCH ────────────────────────────────────────────
    // Variables we need to produce regardless of branch:
    //   text                  : the model's raw output text
    //   _usage, _inputTokens, _outputTokens, _cacheReadInputTokens,
    //   _cacheCreationInputTokens, _stopReason, _responseModel  : token usage
    //
    // Both branches set these and then converge on the existing parse logic.
    let text;
    let _usage = {};
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
          { deadlineMs: 55000, maxAttempts: 3, label: 'primary-stream' }
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
      const _gatePayload = {
        gateResult: parsed.gateResult,
        gateReason: parsed.gateReason || '',
        cropFailure: parsed.cropFailure || null,
        lockout: _lockoutInfo,
        _diagnostics: {
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
    if (parsed.grade && !String(parsed.grade).includes('.')) {
      parsed.grade = parseFloat(parsed.grade).toFixed(1);
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

    parsed._diagnostics = {
      comicvineRef: referenceImageBlock !== null,
      referenceImageUrl: referenceImageUrl,
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
            if (f - gap >= 0) {
              rg.frontScore = f - gap;
            } else {
              // Front absorbs what it can, rest goes proportionally to others
              const fGap = f;
              rg.frontScore = 0;
              const remainGap = gap - fGap;
              const pool = (b || 0) + s + i;
              if (pool > 0) {
                if (b != null) rg.backScore     = Math.max(0, Math.round(b - remainGap * (b / pool)));
                rg.spineScore    = Math.max(0, Math.round(s - remainGap * (s / pool)));
                rg.interiorScore = Math.max(0, Math.round(i - remainGap * (i / pool)));
              }
            }
          }
          rg._mathCorrected = {
            declared: original,
            computed: computed,
            chosen: chosen,
            rule: 'divergence>8, prefer lower; sub-scores rebalanced'
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
          parsed.grade = String(cgcFloor.toFixed(1));
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
          model: PRIMARY_MODEL,
          refineModel: PRIMARY_MODEL,
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
          costUsd: (function(){
            const RATE_IN  = _RATES.in;
            const RATE_OUT = _RATES.out;
            const RATE_CACHE_READ   = RATE_IN * 0.10;
            const RATE_CACHE_CREATE = RATE_IN * (_cacheTtl === '1h' ? 2.0 : 1.25);
            const inT  = _inputTokens || 0;
            const outT = _outputTokens || 0;
            const cr   = _cacheReadInputTokens || 0;
            const cc   = _cacheCreationInputTokens || 0;
            return +(inT * RATE_IN + outT * RATE_OUT + cr * RATE_CACHE_READ + cc * RATE_CACHE_CREATE).toFixed(6);
          })(),
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

    if (wantsSSE) {
      sseEvent('result', parsed);
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(200).json(parsed);
  } catch (err) {
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
          model: PRIMARY_MODEL,
          refineModel: PRIMARY_MODEL,
          // Diagnostic v3.97: imageCount is the only payload-side number we
          // can reliably capture in the error path (API never returned, so
          // no token usage). Helps identify whether timeouts cluster on
          // higher-image-count requests (Deep Assessment with 8 images vs
          // standard 4).
          imageCount: (typeof imageBlocks !== 'undefined' && Array.isArray(imageBlocks)) ? imageBlocks.length : null,
          highGrade: (typeof highGrade !== 'undefined') ? !!highGrade : null,
          // S15 May 28: errored assessments cost $0 because the API never
          // returned (no tokens billed). Setting to 0 (not null) so the
          // admin Logs view can sum/avg cleanly without null-handling.
          costUsd: 0,
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
