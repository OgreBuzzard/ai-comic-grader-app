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
const ROBOGRADE_VERSION = '4.14';

export default async function handler(req, res) {
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
    highGrade = false,
    initialRoboGrade = null,
    initialCgcGrade = '',
    initialPsaGrade = ''
  } = req.body;
  if (!images || images.length === 0) return res.status(400).json({ error: 'No images provided' });

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
  const notesBlock = notesContext.length > 0 ? '\n\n' + notesContext.join('\n\n') : '';

  const isCGC = true; // Unified prompt — PSA and RoboGrade derived within single pass

  // Fetch ComicVine cover reference image if title and issue are available
  let referenceImageBlock = null;
  const baseUrl = req.headers['host']
    ? `https://${req.headers['host']}`
    : (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : '');

  // Run ComicVine cover fetch and page quality fetch in parallel
  let pageQualityImageBlock = null;
  let pqIsPsaReference = false;  // true once pq_psa.jpg is uploaded; prompt language adapts
  if (isCGC) {
    const cvFetch = (title && issueNumber && COMICVINE_API_KEY) ? (async () => {
      try {
        const searchTitle = title.replace(/^The\s+/i, '').trim();
        const cvSearchUrl = `https://comicvine.gamespot.com/api/search/?api_key=${COMICVINE_API_KEY}&format=json&query=${encodeURIComponent(searchTitle + ' ' + issueNumber)}&resources=issue&field_list=image,volume,issue_number&limit=5`;
        const cvResp = await fetchWithTimeout(cvSearchUrl, { headers: { 'User-Agent': 'ComicGraderApp/1.0' } }, 5000);
        if (cvResp.ok) {
          const cvData = await cvResp.json();
          const results = cvData.results || [];
          const match = results.find(r => {
            const issNum = String(r.issue_number || '').replace(/^0+/, '');
            const targetIss = String(issueNumber).replace(/^0+/, '');
            return issNum === targetIss;
          }) || results[0];
          if (match && match.image && match.image.medium_url) {
            const imgResp = await fetchWithTimeout(match.image.medium_url, {}, 4000);
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
  }






  // ── Census lookup ──────────────────────────────────────────────────────────
  // Full 2,359-issue CGC census table lives in ./census.js. We import the
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
  try {
    const { formatCensusForPrompt } = await import('./census.js');
    const censusContext = formatCensusForPrompt(title, issueNumber) || '';
    if (censusContext) {
      censusBlock = `

CGC CENSUS DATA (Phase 3 calibration anchor for this specific issue):
${censusContext}
CRITICAL — CENSUS USE IS INTERNAL ONLY: the census data above is a calibration anchor for you, NOT a fact to share with the user. graderNotes, aiAssessment, and labelNotes are all user-visible. NEVER mention the census, submission counts, average grades across submissions, distribution percentages, statistical priors, or population data. NEVER write things like "the census average for this book is X," "most copies grade lower," "statistically this should be a Y," "based on submission data," or "I'm anchoring to the population." The user must read the assessment as if you graded only what you see in their photos. If census data influences your grade, justify the grade using on-the-book observations only. The census is a sanity check, not an override — when in doubt, trust the photos.`;
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
  // Base confidence range. Tightens as evidence accumulates:
  //   High-grade run (4 main + 4 corner macros = 8 images): ±3.
  //     Corner macros directly inspect the most defect-prone areas, narrowing
  //     uncertainty significantly compared to wide-frame standard photos.
  //   Standard run with 4+ images: ±6 (was ±8 before May 6).
  //     Tightened because the v2.2 calibration data is improving and ±8
  //     was reading as overly conservative even on clean books.
  //   3 images: ±12 (one main slot missing materially widens uncertainty).
  //   <3 images: ±16 (very limited input).
  const baseConf = highGrade
    ? 3
    : (photoCount >= 4 ? 6 : photoCount === 3 ? 12 : 16);

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

2. DROP EXCEPTION: You may drop below the floor ONLY if a corner macro reveals a specific, describable defect that was not visible in the original wide shot (for example, a color-breaking stress line hidden by glare, or a tiny corner crease invisible at wide angle). If you drop, you must call out the specific new defect in graderNotes with its exact location, and you must explain in aiAssessment why it wasn't visible before. If you cannot name a specific new defect, do not drop.

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

  // ── Unified system prompt: one image pass, neutral first, three grades ───────
  const systemPrompt = `You are an expert comic book condition analyst. Examine the photos ONCE and record neutral observations, then derive three independent grades from those observations.

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

STRUCTURAL DAMAGE SCAN — DO THIS FIRST, BEFORE ANYTHING ELSE:

Three forms of damage are catastrophic to grade and routinely misidentified as lesser defects. Scan for each BEFORE categorizing any other defect — once your mind has named something "crease" or "edge wear" or "soiling", you will not reconsider it as paper loss/tape/tear. Catch these first.

  CHECK 1 — TAPE. Scan every photo, especially the spine. THE DECISIVE TEST IS GEOMETRY, NOT TONE: tape has STRAIGHT, PARALLEL, MACHINE-CUT edges. Damage does not. Ask: is there a band or region bounded by a straight line — an edge so straight it looks ruled, running continuously for an inch or more? Paper wear, creasing, and stress lines produce IRREGULAR, organic, wandering edges. They never draw a ruler-straight border down the length of a spine. So a darker or different-textured band running down the spine with a clean straight edge on one or both sides is TAPE — even if it also looks like wear, even if it has cracks across it, even if part of you wants to call it stress lines. The straight parallel border overrides every other interpretation. Multiple parallel straight-edged bands down the spine = multiple strips of reinforcing tape. Aged tape also shows horizontal cracks across its surface (adhesive cracking — a row of small parallel breaks) and is often glossier than surrounding paper, but the STRAIGHT EDGE is the test that settles it. If you find a straight-bordered band, name it "Tape" — do NOT call it stress lines, creases, or soiling. This is the single most-missed defect and miscalling it as stress lines destroys the assessment's integrity.

  CHECK 2 — PAPER LOSS / MISSING PIECE. THE DECISIVE TEST IS THE SILHOUETTE AND WHAT SHOWS THROUGH — PLUS BROKEN PRINTED SHAPES. A missing piece means cover paper is GONE. Three tells, any one confirms it: (a) the rectangular silhouette of the cover is broken — a chunk of the outline is simply absent, with a jagged torn edge; (b) within the cover's interior, a region of the PRINTED IMAGE is interrupted by a patch that does not belong — printed artwork cut off mid-figure (a face sheared flat, a background ending at a hard jagged line), and beyond that line a DIFFERENT surface: an interior page (different color, different printing, sometimes text or art that doesn't match the cover ad) or the backdrop the comic rests on; (c) BROKEN PRINTED SHAPES — a known regular shape on the cover is no longer regular, OR a printed letter is incomplete. A circle that should be perfectly round has a jagged bite taken out of its edge. A solid block of color (a logo, a starburst, a speech balloon, a banner) has a ragged irregular cut into it that does not match the original printed boundary. A letter is missing a stroke (the H at the end of a word has lost its right vertical; the O is open on one side; the E has lost its top bar). These are SHAPE-INTEGRITY violations: comics are printed with mechanical precision, so any irregular interruption of a circle, rectangle, banner, or letter shape is paper that has torn off — even when no interior page shows through (the surface beneath may be the next page of the book or the photo backdrop, both of which can blend in tonally with worn cover paper). The test for (c) is mechanical: does the printed shape complete the way it was printed? If a circle's arc breaks, if a letter has a missing stroke, if a solid color field has a ragged organic edge instead of a clean printed one — paper is missing there. This is paper loss, not soiling, not a stain, not edge wear, not a crease, not printing variation. A large missing piece (2"×1.5" or anything of that scale) is catastrophic — CGC 1.5–2.0 territory — and must never be absorbed into "edge wear" or "soiling". Even a small missing piece that interrupts a printed shape is HIGH severity and must be named — it is structural damage, not surface wear. Measure it and name it "Missing piece" / "Piece out" with HIGH severity. Smooth cover edge with intact rectangular silhouette, all printed shapes complete, and no show-through = NOT paper loss (that's blunting/edge wear). Silhouette disruption OR mismatched show-through field OR broken printed shape/letter = paper loss, full stop.

  CHECK 3 — TEARS, especially around staples and along edges. A tear is a discontinuity where paper is split but not yet missing — the two sides still attached at one end. Inspect particularly: around each staple (top and bottom, both covers — stress concentrates here and tears initiate at the staple holes), along cover edges where they meet the spine, anywhere a piece appears lifted, separated, or partially detached. May show as a thin dark line, a visible split, or a section angled differently from surrounding flat area. If found, name "Tear" with location and length — do NOT call it edge wear, crease, or stress line. Tears > 1/2" are HIGH severity.

  CHECK 4 — RUST and FOXING. Two distinct defects, both routinely missed or conflated:
    RUST (call it "rust", never "oxidation"): orange-brown staining originating AT a staple and bleeding outward into the surrounding paper, OR brown discoloration on the staple itself. Look at BOTH staples on every photo that shows the spine/interior. A staple that is brown rather than silver = rust. Orange-brown halo around a staple hole = rust migration. This is a Spine-category defect. Even light rust must be named — it indicates moisture exposure and only worsens.
    FOXING: scattered small reddish-brown SPOTS or speckles distributed across paper (not originating from a staple) — caused by mold/oxidation in the paper itself. Distinct from general soiling (which is broad, grey-brown, and dirt-like) and from rust (which originates at metal). Foxing is spotty and reddish; soiling is broad and grey; rust radiates from staples. Name foxing as "Foxing" and factor it into page quality, not as generic soiling.

If CHECK 1–4 finds anything, name it in the defects array — TAPE / MISSING PIECE / TEAR / RUST as the defect type, with location and severity. Do not let pattern-matching to common defect categories (creases, stress lines, edge wear, soiling) obscure these structural failures. The checks above are your internal observation step; the defects array is where findings show up in the output. There is no separate structuralScan field — your output of structural defects IS the defects array.

After all four checks, proceed below.

ROUTINE INSPECTION:

PER-CORNER INSPECTION: examine TL, TR, BL, BR individually. Consolidate AFTER inspection: identical kind+severity across all four → one entry ("Corner blunting, all four corners, ~1/16""); differing corners → separate entries. Never homogenize heterogeneous corners.

EDGES AND SURFACES: examine top/bottom/left/right edges and cover surfaces for creases, soiling, stress lines, other defects (tears and paper loss already caught in structural damage scan).

COLOR-BREAK DETECTION: a color break is a small region — often a few pixels wide — where ink is absent, exposing white/grey paper. Diagnostic for spine ticks, color-breaking creases, color-breaking stress lines. Scan continuous colored regions (especially dark saturated areas — blacks, deep reds, dense blues/greens) for small white/grey patches interrupting color. Common locations: spine edge (ticks), along any crease, at bent corner tips. Even a 2-3 pixel white spot counts. Small color breaks distinguish 9.6 from 9.4 — critical to call.

SPINE TICK ID: 1–3mm WHITE marks along spine edge (left of front cover photo), perpendicular or slightly diagonal, paper showing through stressed ink. White-on-color is the signature — colored or grey is NOT a tick. Harder but not impossible on white/cream spine regions. Examine ALL photos: front cover for full spine length, TL+BL corner macros for top/bottom thirds at higher resolution, spine photo for cross-confirmation. A candidate tick visible on one photo but unconfirmable on others is more likely misidentified.

SPINE ROLL ID: curl/warp where cover no longer lies flat. Best assessed from spine-edge photo (oblique side view). Describe using natural qualifiers (light, moderate, heavy).

STAPLE ID: two staples ~1/3 and 2/3 down the spine. Spine edge: LEFT of front cover photo, RIGHT of back cover photo, at binding in interior photos. Look for: RUST (around staples or migrating to pages — always call this "rust", never "oxidation" or "oxidized" which understate the severity), missing/dislodged/popped staples, structural failure. Clean intact staples → no defect entry (defect list is for defects, not absences).

FACSIMILE / REPRINT INSPECTION (mandatory). Marvel, DC, and others release facsimile editions of famous keys (Amazing Fantasy #15, Hulk #181, X-Men #1, etc.) that reproduce the original cover faithfully and can fool casual inspection. Markers:
  • "FACSIMILE EDITION" text anywhere on cover, back, indicia, or spine
  • Modern UPC barcode (pre-1976 originals had none; 1976+ originals used a specific layout different from modern Marvel/DC)
  • Modern paper stock — bright clean white edges with no period aging despite a Silver/Golden Age cover date
  • Print quality sharper than period offset printing (modern digital reproduction vs 1960s newsprint)
  • Modern publisher logo placement, color, or design
If found: printing = "Facsimile Reprint" (append year in parentheses if visible, e.g., "Facsimile Reprint (2019)"); issueDate = reprint year; state the finding plainly in aiAssessment. Period-appropriate book with no modern markers: leave printing empty. When uncertain, lean toward populating "Facsimile Reprint" — mislabeling a reprint as authentic is a worse user outcome than the reverse.

SELF-REVIEW BEFORE FINALIZING: if any defect description contains MAJOR-damage language ("chunk", "missing", "torn off", "piece out", "large", "significant tear", "tape covering", "color touched"), severity MUST be "High" and the grade reflects the structural impact per Phase 3 tier definitions.

EPISTEMIC HUMILITY: photos can't show everything. Tiny missing pieces (<1/16"), faint creases, small back-cover defects can hide in shadow/glare/low resolution. Do NOT claim absences ("no missing pieces observed", "no tears detected"). Omit absent defects from the inventory.

DEFECT INVENTORY — for every defect:
• Type (official CGC terminology)
• Location (corner, edge, area)
• Measurement (use comic dimensions for scale — modern Marvel/DC ~6.625"×10.25", Silver Age ~7"×10.25", Bronze Age ~6.875"×10.25", Golden Age ~7.5"×10.5". Estimate defect size proportionally.)
• Severity: High/Med/Low
• colorBreaking flag for creases
• Category: Front/Back/Spine/Interior
  - Front: front cover surface + outer front corners
  - Back: back cover surface + outer back corners
  - Spine: spine surface, roll, stress lines, inner corners at top/bottom of spine, ALL STAPLE CONDITION (staple rust, missing staples, popped staples, holes around staple posts — every staple-related defect goes here, NOT Interior)
  - Interior: pages, page quality, interior printing only (no staples — see Spine)

CORNER NAMING — SPELL THEM OUT. When referring to corners, use full words: "top left", "top right", "bottom left", "bottom right". Never use the abbreviations TL, TR, BL, BR — they are not standard CGC shorthand. When two or more corners share the same defect, group them: "both bottom corners", "top and bottom right corners", "all four corners". Saves space without losing clarity.

LEFT AND RIGHT REFER TO THE IMAGE, NOT THE COMIC. "Top left corner of front cover" means the corner at the top-left of the front cover PHOTO as it appears. Do not translate to the comic's physical orientation. The reader is looking at the same photo you are; describe what's in the top-left of that image as "top left", regardless of which physical corner of the book that is. Same for the back cover: "top left of back cover" means top-left of the back cover photo. Each face is described in its own photo's frame.

GETTING LEFT AND RIGHT RIGHT — this is a common error. Before you commit a location, look once more at the photo and confirm: the damage you're about to describe as "top left" is in the upper-LEFT region of that photo, not the upper-right. Same for bottom corners. Two-second check, prevents the most-flagged mistake users notice.

EYE APPEAL DISCIPLINE: inventory observable defects, not everything that could be wrong. A typical Silver Age book has 4-8 distinct defects worth noting at any grade — not 12-15. Clean-presenting book with three real defects inventories as three, not three plus eight imagined.

PAGE QUALITY:
Phone cameras under typical indoor lighting consistently make pages look 1-2 tiers more yellowed than they actually are. Calibration data from 10 PSA-graded 2026 books showed prior calibration was systematically under-reading PQ by 2 tiers — books PSA called OW/W were being called C/OW. Rules below correct that.

1. AGE-AWARE DEFAULT. Pre-1985 books (Silver Age and Bronze Age) overwhelmingly grade OW/W or White in the wild. Genuinely cream or tan pages are uncommon and tied to specific storage conditions (damp, sun-bleaching, acidic storage). For pre-1985 books, default is OW/W unless you see SPECIFIC, NAMEABLE evidence: visible foxing dots or rust marks, brown-tinged edges contrasting with a lighter center, obvious brittleness. "Looks a bit yellow under indoor light" is camera/lighting bias, NOT specific evidence.

2. ANCHOR AGAINST THE PSA REFERENCE IMAGE (Grade_Reference/pq_psa.jpg, provided every assessment). Shows real interior photos of PSA-graded Silver Age books labeled with their page quality designations across the upper scale. Ground truth — match the closest reference. If your assessment interior looks comparable to ANY reference photo, the answer is OW/W or White accordingly. Only assign OW or lower if visibly more tanned than EVERY reference example.

   COMPARE EYE TO EYE, NOT BOOK TO BOOK. Reference photos and your assessment photo have different lighting/white balance/exposure. Compare unprinted page areas (margins between panels, gutters, white speech balloons) — page tone matters, not surrounding photo cast.

   WHITE BACKING TECHNIQUE: if the assessment photo includes a white backing board or surface next to the interior page, use it as a lighting-bias correction reference. Pure white = RGB #FFFFFF. Observe deviation in THIS photo from #FFFFFF — that's the camera's white-balance shift. Mentally subtract before classifying. Skip if no clearly-white element visible.

   STEPWISE FALLBACK: if interior IS warmer than every reference, next step down is OW, not C/OW. Don't skip a tier. C/OW requires substantial tanning beyond what would justify OW.

3. FAVOR THE WHITER TIER WHEN AMBIGUOUS. Sample between two reference colors → pick the whiter designation. Use the darker only when clearly at or past that reference tone.

4. TWO-PART TEST BEFORE TAGGING C/OW OR LOWER. Both must be true:
   (a) Unprinted page margins are noticeably warmer than the WARMEST reference example margin (compared margin-to-margin).
   (b) At least one piece of specific evidence: visible foxing, rust marks, brown-tinged edges, obvious brittleness, or uniform tone-shift visibly darker than any white element in the assessment photo.
   If only (a) without (b), the warmth is camera/lighting bias. Default to OW/W or OW.

PQ DESIGNATION ↔ INTERIOR SCORE (absolute 1:1 mapping, Interior score MUST equal this number):
  White=10 • OW/W=9 • OW=8 • C/OW=7 • Cream=6 • LT/C=5 • LT=4 • Tan=3 • Brown=2 • Brown/Brittle=1 • Brittle=0

## PHASE 2 — THREE GRADES FROM YOUR OBSERVATIONS

── ROBOGRADE (primary, AI-native) ──
Four components summed directly to final. All scores INTEGERS, no decimals.
  Front:    0–50  (front cover surface + outer front corners)
  Back:     0–20  (back cover surface + outer back corners)
  Spine:    0–20  (spine surface, roll, inner corners at spine, staple area)
  Interior: 0–10  (page quality — 1:1 PQ map, no deductions)
Final = Front + Back + Spine + Interior (0–100).

Score each category independently from defects in that category ONLY. Perfect = no observed defects in that category. Deduct from max based on severity and accumulation.

Per-category calibration (proportional to max):
  Front (max 50): 50 pristine | 47-49 single trace | 43-46 one small or trace accumulation | 38-42 minor defects, strong eye appeal | 30-37 moderate accumulation or one color-breaking | 20-29 substantial wear or significant defect | 10-19 major issues | 0-9 severe/structural
    CUMULATIVE-FRONT-DEFECT RULE: widespread soiling/discoloration + multiple additional defects (any combo of corner blunting + edge wear + crease + spine-side stress) → Front MUST be ≤ 30 regardless of individual severities. Mid-grade books (CGC 3.0-4.5) routinely show this. Without this, individual defects each rate Med and the sum lands 32-40 (CGC 5.5-7.0 territory). When in doubt at 30, go to 28.
    CREATOR-SIGNATURE RULE: confidently identifiable creator signature (reads as a name in stylized signing manner, customary signing location, consistent with an autograph from someone associated with the book) → record as "Creator signature" (NOT "Writing on cover") with empty severity. NO point deduction anywhere. In aiAssessment describe as observed ("Cover bears an apparent signature reading 'Len Wein'") — word "apparent" required, Robograder does not authenticate. EXCEPTION: signature that physically dominates the cover (e.g., cover-spanning paint-pen mark obscuring >50% of artwork) → single Med Front deduction. Ambiguous writing (scrawls, numbers, owner names in block letters, prices, date stamps) → ordinary defect rubric, not signature. When in doubt, treat as defect.
    ADDITIONALLY: populate the top-level "signatures" array with one entry per identified signature. Each entry has shape {"signer": "Name as read"} — name the signer ONLY when you can read it clearly and it plausibly belongs to someone associated with the book (creator, writer, artist). For signatures you can SEE but cannot read or place, use {"signer": ""} — empty string means "signature present, signer unknown." Robograder does not authenticate; we're recording observation, not validating. Multiple signatures: one entry per signature. No signatures: empty array.
  Back (max 20): 20 pristine | 18-19 trace | 15-17 minor defect or light accumulation | 11-14 moderate | 7-10 substantial or significant defect | 0-6 major
  Spine (max 20): 20 pristine | 18-19 trace, one very minor non-color-breaking tick | 15-17 light stress lines, slight roll, minor blunting at spine | 11-14 multiple stress lines, visible roll, minor fraying, or one color-breaking crease | 7-10 significant stress, split starting, staple pull | 0-6 severe structural
  Interior (max 10): 1:1 mapping from PQ designation (mapping above). No deductions. Staple rust, detached centerfold, etc. → Spine. Soiling/foxing → factored into PQ designation. Missing interior pages out of scope.

SPINE TICK SCORING: deduct 1 Spine point per non-color-breaking tick, 2 Spine points per color-breaking tick. Set defect.colorBreaking = true when ink visibly disrupted exposing white paper.

SPINE ROLL SCORING: Low -1 to -2; Med -3 to -5; High -6 to -10.

STAPLE SCORING: Staple defects → Spine category (not Interior). Severity: Low = faint <2mm; Med = clear brown stain with 3–8mm migration; High = heavy migration, multiple pages stained, or structural failure. Missing/dislodged/popped staple → Med or High.

SEVERITY WORD MAPPING (applies to ALL defects):
  • light/minor/slight/small/faint/trace → Low
  • moderate/medium/noticeable → Med
  • extensive/heavy/significant/severe/deep/major → High
Measurement in defect.measurement is welcome when it adds clarity, but NOT required. "Moderate spine roll" with severity Med is acceptable.

ENHANCEMENT TAGGING — defects removable by pressing/cleaning get a measurement-field tag:
  • Bend without color break → "pressing candidate"
  • Spine tick without color break → "pressing candidate"
  • Surface dirt, fingerprints, light smudges → "cleaning candidate"
  • Spine roll (Low or Med, non-color-breaking) → "pressing candidate"
  • Color-breaking defects → NOT enhancement candidates (permanent)
  • Missing pieces, tape residue, water damage, High spine roll → NOT enhancement candidates

Confidence base: ±${baseConf}. Adjust up if glare/poor focus, no raking light photo, staples not visible, restoration suspected.

SCORE CEILING — your precision modifier bounds your maximum score. With a ±${baseConf} precision modifier, your honest maximum score is ${100 - baseConf} (the modifier then allows the true grade to range up to 100). Do NOT assign a score above ${100 - baseConf} on this assessment.${highGrade ? ' This is a Deep Assessment with corner macros, so ±3 is justified and the ceiling is 97.' : ' A standard 4-photo assessment cannot see the fine corner and edge detail that distinguishes a near-perfect copy; the photos simply do not carry that information. A Deep Assessment (corner macros) is required to justify a score above ' + (100 - baseConf) + '. If the book genuinely looks pristine, score it at the ' + (100 - baseConf) + ' ceiling and let the ±' + baseConf + ' modifier express the upside — do not exceed the ceiling.'}

CRITICAL: final = Front + Back + Spine + Interior exactly. If holistic impression disagrees with the sum by more than 2 points, revisit the components — one is wrong, not the formula.

── CGC GRADE ──
Apply CGC standards to the defect inventory.

BLACKJACK PHILOSOPHY: cost of overshooting is asymmetric and much higher than undershooting. User submits to PSA/CGC based on your prediction; if official comes in lower, that's costly (fees, shipping, wait, disappointment, lost trust). If official comes in higher, user is delighted. Between two adjacent grades, prefer the lower. When uncertain whether a defect rises to grade-affecting, count it. Holistic impression between two grades → pick the lower. EXCEPTION: clearly minor defects with strong eye appeal — never grade conservatively just for safety. Goal: precision without going over. 21 is perfect, 20 is great, 22 is a bust.

Applies to BOTH CGC grade and RoboGrade. Component scores in Phase 2 reflect this same conservative-when-uncertain disposition.

Grade calibration:
• Assign 9.0–9.6 for minor defects. Don't cap at 8.5 out of caution.
• Strong eye appeal + flat spine + bright colors + sharp corners = high grade.
• At 8.5+, stress lines, bends, soiling, printer tears become potentially grade-defining.
• Structural defects (tape, missing pieces, splits, water damage): NO hard cap. Effect is gradient per Phase 3 tier definitions.
• ENHANCE: yes/no on whether pressing/UV/cleaning would improve grade. "Y" if visible spine roll/rippling pressing could correct, color-breaking creases pressing might soften, soiling cleaning could lift, or tanning on unprinted white areas UV could lighten. "N" if defects are dominated by structural damage no treatment fixes (missing pieces, tears, severe creases, set stains). null if uncertain.

GRADER NOTES (drafted Phase 2, finalized Phase 4):
Avoid over-enumerating same defect across corners/surfaces. Concise, official CGC terminology.

CONSOLIDATION:
  • Same defect type + same severity across locations → ONE entry ("Corner blunting, all four corners"). Differing kind or severity → separate entries. Never homogenize heterogeneous corners.
  • Never note absence of defects ("no missing pieces", "no tape", "no restoration", "pages supple, no brittleness"). Absence is the default.
  • Arrival dates, distributor markings, pedigree marks, normal manufacturing characteristics are NOT defects. If notable, mention in aiAssessment not graderNotes.
  • Never describe handling history ("book has been read"). Describe defects.

JUSTIFICATION RULES:
  • If a category (Front, Back, Spine) is below its maximum (Front<50, Back<20, Spine<20), there MUST be at least one defect entry in that category in the defects array. If you cannot name a specific defect for the category, then the category should NOT lose points. Score deduction without a named defect is incoherent and erodes trust in the assessment.
  • Interior category: ALWAYS include at least one note in the defects array describing the page quality observation, even at full marks. Use category="Interior". The duplication with the standalone pageQuality field is acceptable here. The reader needs to see Interior was evaluated.

PAGE QUALITY SEVERITY — HARD RULE: any defect entry whose type is "Page quality" (or which describes page color, tanning designation, or paper tone) gets severity="" (empty string). Page quality is a descriptive observation, NOT a defect. Low/Med/High severity tags apply ONLY to actual defects. Writing "Page quality, Cream to Off-White, severity=Low" is wrong. The correct entry is "Page quality, Cream to Off-White, severity=\"\"". Never assign Low/Med/High to a Page quality entry.

INTERIOR CATEGORY SCOPE — HARD RULE: the Interior category is for PAGE CONDITION ONLY — page quality, interior printing, interior tears, interior tanning, foxing on pages. Staples are NOT Interior. Staple condition, staple rust, staple-area tears, and any staple observation go in the SPINE category. Do not put staple entries in Interior. Do not include "staples appear intact" or any other non-defect observation; if there is no staple defect, say nothing about staples — Interior remains page-quality-only and Spine remains silent on staples unless there is a real defect to name.

TARGET NOTE COUNT:
  • High grade (8.5+): 1-4 notes
  • Mid grade (5.0-8.0): 3-7 notes
  • Low grade (3.0-4.5): 5-10 notes
  • Heavy damage (below 3.0): 8-15 notes
  More than these counts indicates over-enumeration. Consolidate.

COLOR-BREAKING CALIBRATION:
  Color-breaking is a specific, restrained classification. A typical Silver Age book has 0-2 color-breaking defects, NOT 5-10. Reserve the color-breaking flag for clearly-visible breaks where the printed color is interrupted by the crease/fold/stress line. Default position: a stress line is non-color-breaking unless you can see the color discontinuity in the photo.

Format: one bullet per note starting with •, official CGC terminology, mark color-breaking only when truly color-breaking.

## PHASE 3 — CONFIRMING THE GRADE

Phase 2 produced a candidate CGC grade. Before finalizing, verify it against canonical references.

GRADE VERIFICATION STEP — REQUIRED:
Read the CGC tier definition for your candidate grade below. Also read the definitions for one grade above and one grade below. Confirm your candidate is the best fit — does the description of your candidate grade match this book's actual defect profile? If a neighboring grade describes the book better, switch.

CGC GRADE TIER REFERENCE (factual standards, original wording):
${gradeTierContext()}

If a CGC or PSA label is visible: read grade, cert number, page quality, and key issue notations directly from it — the label overrides the tier-based assessment.
${censusBlock}${notesBlock}${highGradeBlock}
## PHASE 4 — OUTPUT

RESPONSE FORMAT — STRICT: your entire response must be the JSON object below and nothing else. The first character of your response must be the literal opening curly brace. The last character must be the literal closing curly brace. Do not write any text before the JSON — no phase headers, no reasoning narration, no "let me check", no markdown, no acknowledgements. The phases above are your internal process; they do not appear in the response. Do not write any text after the JSON. If you have reasoning to share, it goes inside the JSON's aiAssessment field, written tersely.

HARD OUTPUT LIMITS (enforce while writing):
  • defects array: MAX 12 entries. Beyond 12, consolidate by location ("Multiple corner blunting") and drop trace defects in favor of grade-relevant ones.
  • Each defect description (location + measurement combined): MAX 20 words.
  • aiAssessment: MAX 3 sentences. Direct.
  • graderNotes bullets: MAX 8 entries, MAX 15 words each.
  • keyInfo: MAX 2 sentences. Empty string if uncertain.
Over-elaboration in output is the dominant cause of slow runs. Be thorough in observation, brief in writing.

{
  "gateResult": "COMIC",
  "title": "series title, strip leading The",
  "issue": "e.g. 57 or A1",
  "issueDate": "cover date as 'Mon YYYY' (e.g. 'Feb 1968'); season-only books 'Spr/Sum/Fall/Win YYYY'. For facsimile/reprint (see 'printing'), use the REPRINT year, not the original. Example: 2019 facsimile of AF #15 → 'Dec 2019', not 'Aug 1962'.",
  "publisher": "publisher name",
  "printing": "Printing/variant designation. EMPTY STRING for typical original printings (default). Populate ONLY with clear evidence: 'Facsimile Reprint' (append year in parens if visible) for modern facsimile editions of original key issues; '2nd print'/'3rd print' for direct-edition reprints from the original era; 'Newsstand variant' for distinguishable newsstand copies; 'Reprint' for older non-facsimile reprints. When populating 'Facsimile Reprint', note the finding in aiAssessment and use the reprint year for issueDate.",
  "pageQuality": "full designation e.g. Off-White to White",
  "grade": "CGC grade estimate e.g. 7.0",
  "graderNotes": "• one bullet per defect, official CGC terminology",
  "aiAssessment": "Overall impression, dominant defects, grade rationale. ONLY what you see in this copy's photos. NEVER mention census/submission counts/distribution/external data.",
  "labelNotes": "key issue notations from label if visible, empty string if none",
  "keyInfo": "Key-issue significance — populate ONLY if (a) the issue appears in injected census data AND (b) the fact is widely documented. Empty string otherwise.",
  "enhance": true,
  "labelDetected": false,
  "officialCGCGrade": null,
  "officialCGCCert": null,
  "officialPageQuality": null,
  "officialPSAGrade": null,
  "officialPSACert": null,
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

    // Build the messages payload (used by both streaming and non-streaming
    // branches; identical content either way).
    const _antBody = {
      model: 'claude-opus-4-8',
      // S15 May 29: explicitly set effort=medium. Opus 4.8's default is 'high'
      // which roughly 2.5x'd our input token count and pushed per-assessment
      // cost from ~$0.10 to ~$0.16. Medium should claw most of that back
      // without sacrificing the accuracy gains we measured on PSA calibration.
      // If accuracy regresses meaningfully on the next 10-book run, bump back
      // to 'high' (or drop to 'low' and re-test).
      effort: 'medium',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          ...(referenceImageBlock ? [
            { type: 'text', text: 'REFERENCE IMAGE: The following image is a clean cover scan of this exact issue from ComicVine, showing how the book should look without damage. Use it to identify missing pieces, color loss, and damage by comparing against your assessment photos.' },
            referenceImageBlock
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

      const ctrl = new AbortController();
      const _streamTimeout = setTimeout(() => ctrl.abort(), 55000);

      let streamResponse;
      try {
        streamResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(_antBody),
          signal: ctrl.signal
        });
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
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(_antBody)
      }, 55000);
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
      text = data.content[0].text.trim();
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
          strikeHistory.push({
            timestamp: new Date().toISOString(),
            gateResult: parsed.gateResult,
            reason: parsed.gateReason || ''
          });
          const totalStrikes = strikeHistory.length;
          const recent24h = countStrikesInWindow(strikeHistory, STRIKE_LOCKOUT_WINDOW_MS);
          const recent96h = countStrikesInWindow(strikeHistory, STRIKE_PERMANENT_WINDOW_MS);
          const update = {
            strikes: totalStrikes,
            strikeHistory,
            lastStrikeAt: new Date().toISOString()
          };
          if (recent96h >= STRIKE_PERMANENT_THRESHOLD) {
            update.accountFlagged = true;
            update.flaggedAt = data.flaggedAt || new Date().toISOString();
            _lockoutInfo = { type: 'permanent' };
          } else if (recent24h >= STRIKE_LOCKOUT_THRESHOLD) {
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
      pageQualityRef: pageQualityImageBlock !== null,
      pageQualityRefIsPsa: pqIsPsaReference,
      hasInteriorPhoto: hasInteriorPhoto,
      gradeRef: gradeRefSucceeded,
      roboGrade: !!(parsed.roboGrade)
    };
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
      //    graderNotes (which would justify a drop), never go below the initial
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
    if (parsed.roboGrade && typeof parsed.roboGrade.score === 'number') {
      const rawScore = Math.round(parsed.roboGrade.score);
      const scoreCeiling = 100 - baseConf;
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

    if (parsed.roboGrade && typeof parsed.roboGrade.confidenceRange === 'number') {
      const score = Math.round(parsed.roboGrade.score || 0);
      const modeCap = highGrade ? 6 : 16;
      let conf = Math.max(0, Math.min(modeCap, Math.round(parsed.roboGrade.confidenceRange)));
      // Ceiling: if score + conf > 100, narrow conf to fit. Never widen
      // (that would imply unsupported pessimism).
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
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          model: 'claude-opus-4-8',
          refineModel: 'claude-opus-4-8',
          highGrade: !!highGrade,
          gradeRefRan: gradeRefSucceeded,
          gateResult: parsed.gateResult || 'COMIC',
          predictedGrade: parsed.grade || null,
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
          // counts and a hardcoded rate table. Opus 4.8 = $5/M input,
          // $25/M output. Cache reads at 10% of input rate, cache creation
          // at 1.25x input rate (Anthropic pricing as of May 2026). If we
          // change models, this rate block must change with it — keep the
          // constants here next to the model string.
          costUsd: (function(){
            const RATE_IN  = 5  / 1e6;   // $/token
            const RATE_OUT = 25 / 1e6;
            const RATE_CACHE_READ   = RATE_IN * 0.10;
            const RATE_CACHE_CREATE = RATE_IN * 1.25;
            const inT  = _inputTokens || 0;
            const outT = _outputTokens || 0;
            const cr   = _cacheReadInputTokens || 0;
            const cc   = _cacheCreationInputTokens || 0;
            return +(inT * RATE_IN + outT * RATE_OUT + cr * RATE_CACHE_READ + cc * RATE_CACHE_CREATE).toFixed(6);
          })(),
          stopReason: _stopReason,
          responseModel: _responseModel,
          rawTextChars: _rawTextChars,
          defectCount: Array.isArray(parsed.roboGrade && parsed.roboGrade.defects) ? parsed.roboGrade.defects.length : null,
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
          model: 'claude-opus-4-8',
          refineModel: 'claude-opus-4-8',
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
