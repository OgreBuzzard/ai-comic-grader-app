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
// =============================================================================
const ROBOGRADE_VERSION = '3.2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

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

  // Fetch grade reference image for the assessed grade
  async function fetchGradeReference(grade, baseUrl) {
    const validGrades = ['5.0','5.5','6.0','6.5','7.0','7.5','8.0','8.5','9.0','9.2','9.4','9.6','9.8','9.9','10.0'];
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
    await Promise.all([cvFetch, pqFetch]);
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
      censusBlock = `${censusContext}
CRITICAL — CENSUS USE IS INTERNAL ONLY:
The CGC census data above is a calibration anchor for you, NOT a fact to share with the user. The graderNotes, aiAssessment, psaNotes, and labelNotes fields are all user-visible. NEVER mention the census, submission counts, average grades across submissions, distribution percentages, statistical priors, population data, or any phrasing that reveals you consulted external data about this issue. NEVER write things like "the census average for this book is X," "most copies grade lower," "statistically this should be a Y," "based on submission data," or "I'm anchoring to the population." The user must read the assessment as if you graded only what you see in their photos.

If census data raised or lowered your grade from what the photos alone would suggest, justify the grade using on-the-book observations — defects you actually see, eye appeal, page quality, structural condition — never the statistics. If you cannot find an on-the-book justification for the census-informed grade, trust the photos over the census and grade what you see. The census is a sanity check, not an override.
`;
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
  const hasBackCover   = slotsFilled ? !!slotsFilled.back : images.length >= 2;
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
════════════════════════════════════
HIGH-GRADE ASSESSMENT MODE
════════════════════════════════════

This is a second-pass high-grade assessment. The user has added 4 corner macros (positions 5-8 in the image set, order: Top Left, Top Right, Bottom Left, Bottom Right of the FRONT cover) to allow tighter grading.

INITIAL ASSESSMENT (from the standard 4-photo pass):
• Initial RG: ${initialRGScore != null ? initialRGScore : 'unknown'}
• Initial CGC: ${initialCgcGrade || 'unknown'}
• Initial PSA: ${initialPsaGrade || 'unknown'}
• Initial component scores — Front: ${initialFront ?? '?'}, Back: ${initialBack ?? '?'}, Spine: ${initialSpine ?? '?'}, Interior: ${initialInterior ?? '?'}

RULES FOR HIGH-GRADE ASSESSMENT:

1. FLOOR RULE: The initial grades are a floor, not a guess. The final RG must be ≥ ${initialRGScore != null ? initialRGScore : 80}, the CGC grade must be ≥ ${initialCgcGrade || '8.0'}, and the PSA grade must be ≥ ${initialPsaGrade || '8.0'}. Initial assessments on high-grade books tend to run conservative because wide shots don't show corner detail — the macros are here to confirm or raise, not lower.

2. DROP EXCEPTION: You may drop below the floor ONLY if a corner macro reveals a specific, describable defect that was not visible in the original wide shot (for example, a color-breaking stress line hidden by glare, or a tiny corner crease invisible at wide angle). If you drop, you must call out the specific new defect in graderNotes with its exact location, and you must explain in aiAssessment why it wasn't visible before. If you cannot name a specific new defect, do not drop.

3. CATEGORIES YOU CAN CHANGE: Only Front and Spine. The corner macros give you more information about the front cover and the inner corners at the top and bottom of the spine. Back and Interior were not re-examined.

4. CATEGORIES YOU MUST NOT CHANGE: Back score stays at ${initialBack ?? 'initial value'}. Interior score stays at ${initialInterior ?? 'initial value'}. Copy these forward exactly from the initial assessment. Do not re-derive them.

5. RG RANGE: The final RG score must be in the range [${initialRGScore != null ? initialRGScore : 80}, 100]. CGC must be in [${initialCgcGrade || '8.0'}, 10.0]. PSA must be in [${initialPsaGrade || '8.0'}, 10.0].

6. CENSUS ANCHOR: Take the census distribution seriously. If 35%+ of submissions grade 9.4+, the book in front of you has a high prior probability of being 9.4+. If the average census grade is 9.5, a clean-looking copy should be in that vicinity. Do not under-grade a clean book because you feel cautious.

7. PRESUMPTION OF CLEAN: The default assumption for each corner macro is "this corner is clean and confirms a high grade." Only conclude a corner is damaged if you can specifically identify and name the defect. Do not invent defects.

8. CONFIDENCE: For high-grade assessments, set confidenceRange between 3 and 6. Default to 3 (corner macros provide tight evidence). Widen toward 6 only if specific image-quality issues impair your read: heavy glare obscuring a corner, blurred macro, raking light too oblique to evaluate stress lines. Do not widen for "general caution" — only for image-quality issues you can name. Never exceed 6 on a high-grade run.

9. FREQUENCY REMINDER: 40% of CGC-graded books receive a 9.8. This is the single most common outcome. If the book looks pristine in all 8 photos, 9.8 is the likely answer, not a conservative 9.4.

` : '';


  // ── RoboGrade formula (4-category, backwards from final score) ───────────────
  // Score = (Front × 0.5) + (Back × 0.2) + (Spine × 0.2) + (Interior × 0.1)
  // Spine includes inner corners at top and bottom of spine
  const backScoreDefault = hasBackCover ? '0' : 'null';

  // ── CGC grade tier thresholds (factual allowances per grade, reworded) ────────
  const CGC_GRADE_TIERS = `
10.0: Flawless in every respect. No handling or manufacturing defects. Interior must be White — OW/W pages cannot reach 10.0. No distribution ink, printer tears, bindery tears. Only one pre-1975 book has ever received this grade.
9.9: One small non-color-breaking bend allowed, or one non-color-breaking spine stress line. No corner or edge wear. Off-White to White pages minimum; Off-White pages cannot reach 9.9. Tiny distribution ink permitted.
9.8: One or two minor handling defects allowed (e.g., very small color-breaking spine stress, light bend). Cream to OW pages generally cannot reach 9.8. Minor printer defects acceptable if run-wide. For Silver/Bronze: slightly impacted staples, minor distribution ink, printer creases, light ink transfer, extra manufacturing staples, one small printer or Marvel tear allowed. For Golden Age: small bindery tear or chip, slightly off-register cover, light dust shadows or tanning, unobtrusive date stamps or small writing sometimes permitted. Rarest high grade for pre-1965 material; essentially nonexistent in Golden Age. Page quality cannot be Cream to OW or lower.
9.6: A few more small defects allowed but each must be very minor — a couple of tiny color-breaking spine stress lines, very small wear to one or two corners, a tiny edge crease, very small edge or staple tear, very light cover tanning, slight staple discoloration, one very small light stain (spot of foxing, tiny rust stain, small disturbed-ink spot). One small manufacturing chip allowed (bindery, Marvel chip, or printer chip) but no handling-caused missing pieces. Squarebounds: one small staple-caused hole allowed; very small spine split up to 1/16" allowed. Minor gloss imperfections visible only in raking light allowed. Nothing below Cream to OW in page quality. Interior pages can have minor defects.
9.4: Several small or a couple of moderate defects. A few tiny spine stress lines, very small corner blunting, one small edge tear or crease, very light soiling or tanning. Staples clean, firmly attached. Pages supple. Some binding/printing defects permitted. Unobtrusive date stamps or minor writing allowed. Cream to OW pages generally acceptable.
9.2: More wear starting to show. Minor spine ticks, light corner blunting. Still presents well. A few moderate defects beginning.
9.0: Increasing wear but still strong presentation. Minor bends, small color-breaking creases, minor chips. Possible minor sun/dust shadows or light tanning. Light Tan to OW pages generally cap here.
8.5: One moderate defect or a cluster of small defects. Cover shows wear but retains reasonable gloss.
8.0: Minor bends or creases that break color; minor chips on edges. Minor tanning possible. At the lower end of 8.0, minor tape may appear (noted on label). Books with a single neatly detached centerfold (one staple) start at 8.0. Light Tan to OW pages max grade: 8.5.
7.5: Accumulation of defects; cover shows moderate wear. Generally flat, some gloss remains.
7.0: Longer tears possible, color discoloration, fading, light soiling, light stains. Cover detached at one staple possible. Detached centerfold with both staples possible.
6.5: Significant wear accumulation. Some structural defects possible.
6.0: Multiple defects including longer tears, soiling, fading. Missing inserts possible.
5.5: Substantial wear. Cover gloss significantly reduced.
5.0: Moderate to substantial accumulation of defects.
4.0: Multiple major defects. Larger tears, heavy creases, abrasions, severe stains. Cover inks possibly faded. Some story or ad pages may be missing. Interior panels or coupons can be cut. Excessive tape possible. An otherwise high-grade book missing only story pages or front/back cover (not both) starts here.
3.0: Complete but severe defects throughout. Large missing pieces possible. Covers or pages possibly detached. Significant tape possible.
2.0: Heavily worn and damaged. May be stained. Extensive tape repairs. Stories complete but ad pages, coupons, or panels may be missing. Spine or cover possibly split.
1.5: Fully split spine reattached with tape or staples counts as 1.5 (clean split alone = 1.8). Missing cover pieces can slightly exceed 3"×3".
0.5: Extensive defect accumulation or significant missing parts (1/3+ of front or back cover). No single defect alone causes 0.5 — it requires combination. Staining severe enough to cause color loss, staple disintegration, or brittleness together can reach 0.5.
NG: Missing entire cover (coverless). Also: front cover present but back cover absent and less than half of interior pages present; or back cover present but front absent and less than 3/4 of interior present.
`;

  // Returns the 3-4 tier definitions most relevant to a given numeric grade
  function gradeTierContext(gradeStr) {
    const g = parseFloat(gradeStr);
    if (isNaN(g)) return CGC_GRADE_TIERS; // return all if unknown
    // Select adjacent tiers
    const allTiers = CGC_GRADE_TIERS.trim().split('\n').filter(l => l.trim());
    const tierGrades = [10.0, 9.9, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.0, 3.0, 2.0, 1.5, 0.5];
    const idx = tierGrades.findIndex(t => g >= t);
    const lo = Math.max(0, idx - 1);
    const hi = Math.min(tierGrades.length - 1, idx + 2);
    const relevant = new Set(tierGrades.slice(lo, hi + 1).map(String));
    return allTiers.filter(line => {
      const m = line.match(/^(\d+\.?\d*)/);
      return m && relevant.has(m[1]);
    }).join('\n');
  }

  // ── Unified system prompt: one image pass, neutral first, three grades ───────
  const systemPrompt = `You are an expert comic book condition analyst. Examine the photos ONCE and record neutral observations, then derive three independent grades from those observations.

════════════════════════════════════
PHASE 0 — GATE CHECK (mandatory first)
════════════════════════════════════

Before grading, determine what the photos actually show.

Classify the content into ONE of these buckets:
  COMIC         — a comic book, single-issue or trade, including adult comics (Vampirella, Heavy Metal, underground comix), horror titles, and pornographic comics from known publishers. Magazines like Playboy are NOT comics.
  NOT_COMIC     — anything that isn't a comic book: magazines, trade paperbacks (unless clearly graphic novels), photos of random objects, screenshots, people, animals, blank paper, trading cards, prose books, tests/abuse.
  FLAGGED       — photos containing real-world graphic violence, actual injury or gore (not comic-art depictions), explicit pornographic photography (not comic art), child sexual content, or extremist symbols outside a clear historical/educational comic context.
  CROP_FAILURE  — the comic IS a comic, but one or both of the cover photos is cropped such that part of the comic extends outside the image boundary. See the CROP CHECK section below.

Key distinctions:
• Horror comic covers with blood, gore, or monster imagery → COMIC (the art is the art)
• Suggestive or partially nude comic art (Vampirella, Sin City, underground) → COMIC
• Pornographic comic from a known publisher (Eros, Last Gasp, Fantagraphics erotic line, etc.) → COMIC
• A photo of an actual person, even fully clothed → NOT_COMIC unless a comic book is the clear subject
• A photo showing real blood, real injury, or real violence → FLAGGED
• A Playboy, Penthouse, Hustler, or similar magazine → NOT_COMIC (these are magazines, not comics)

For questionable comic-art content: if you can identify a likely title and issue, and the user provided a title, treat as COMIC. If you cannot identify the book at all and the imagery is pornographic or disturbing, treat as FLAGGED.

CROP CHECK (apply ONLY if content is otherwise COMIC):
Examine the front cover photo and the back cover photo (if a back cover photo was submitted). For each, confirm that ALL FOUR CORNERS AND ALL FOUR EDGES of the comic are visible inside the image boundary. A "corner" or "edge" means the physical corner/edge of the comic book itself, not the corner of the photo.

Pass criteria — ALL must be true:
  • All four corners of the comic are inside the image frame
  • All four edges of the comic are visible from corner to corner
  • No portion of the comic extends past any side of the photo

Fail criteria — ANY one triggers CROP_FAILURE:
  • A corner of the comic is outside the image frame
  • An edge of the comic extends past the image boundary on any side (the comic "bleeds off" the photo edge)
  • The cover content (logo, title, art, indicia, UPC, price box, publisher box, "FACSIMILE EDITION" wording) is cut off by any photo edge
  • A significant portion of the cover is missing from the photo

Note: A tight crop where the comic almost fills the frame is FINE as long as the full comic is visible. The check fails only when the comic itself extends past a photo edge — not when the margin around it is small.

This check is STRICT for a reason. The margins of a comic cover are exactly where facsimile-edition markers, modern Marvel/DC logos, UPCs, and key restoration evidence live. A photo that crops out the top edge of the comic could be hiding "FACSIMILE EDITION" text in that margin. A photo that crops out the bottom-right corner could be hiding a modern UPC.

Common failure pattern: user fills the frame with the comic such that one or more edges of the comic extends past the photo boundary. This MUST fail — even if every visible part of the cover looks fine, the cut-off margin could contain disqualifying evidence.

If CROP_FAILURE: return ONLY this JSON and STOP. Do not grade. Do not speculate on defects.
{
  "gateResult": "CROP_FAILURE",
  "cropFailure": {
    "frontFourCornersVisible": true or false,
    "backFourCornersVisible": true or false,
    "frontIssue": "short description of what's cropped on front cover, or empty string if front is fine",
    "backIssue": "short description of what's cropped on back cover, or empty string if back is fine or back was not submitted"
  }
}

If NOT_COMIC or FLAGGED: return ONLY this JSON and STOP. Do not grade. Do not speculate on defects.
{
  "gateResult": "NOT_COMIC" or "FLAGGED",
  "gateReason": "one short sentence explaining what you observed"
}

If COMIC: set "gateResult": "COMIC" in the output and proceed with Phases 1 and 2.

════════════════════════════════════
PHASE 1 — NEUTRAL OBSERVATIONS
════════════════════════════════════

STRUCTURAL CHECK (mandatory first, do this BEFORE anything else):

Step 1 — PAPER LOSS / MISSING PIECE inspection. Examine the cover edges and corners for any region where cover paper is GONE — not bent, not blunted, but absent, with the underlying interior page or nothing at all visible where the cover should be. Paper loss is categorically different from corner blunting:
  • Corner blunting = paper still present, corner is rounded/softened/folded. Cosmetic.
  • Paper loss / piece out = paper is GONE, white interior page or void visible. Structural.
A 1" piece missing from a corner is NOT "corner blunting ~1/16""; it is "Piece out, ~1" along bottom edge, severe". Confusing these two is a critical failure.

If you see paper loss anywhere, record it as defect type "Piece out" or "Missing piece" with category=Front (or Back/Spine as appropriate), and apply the missing-piece ceiling rule below to ALL grades immediately. Do NOT bury it under "corner blunting" or "edge wear".

Step 2 — PER-CORNER INSPECTION. Look at each of the four corners individually:
  • Top-left corner: condition?
  • Top-right corner: condition?
  • Bottom-left corner: condition?
  • Bottom-right corner: condition?
Internal inspection is per-corner. Output consolidation happens AFTER inspection: if every observed corner has the same defect kind and severity, write ONE consolidated note ("Corner blunting, all four corners, ~1/16" each"). If corners differ in defect kind or severity — for example, three blunted plus one with paper loss — write SEPARATE entries for the differing corners. Never homogenize a heterogeneous set into one entry.

Step 3 — Edges and surfaces. Examine every edge (top, bottom, left, right) and the cover surfaces for tears, holes, creases, soiling, stress lines, and other defects.

Step 4 — FACSIMILE / REPRINT INSPECTION (mandatory). Before grading, determine whether this book is an original printing or a modern facsimile/reprint. Marvel, DC, and other publishers regularly release facsimile editions of famous key issues (Amazing Fantasy #15, Hulk #181, Action Comics #1, Detective Comics #27, X-Men #1, Fantastic Four #1, Captain America Comics #1, etc.). These reproduce the original cover faithfully — same art, same logo, same trade dress, same price box, sometimes same indicia text — and can fool a casual inspection.

Look for ANY of these modern-era markers anywhere in the submitted photos:
  • The text "FACSIMILE EDITION" anywhere on cover, back cover, indicia, or spine
  • A modern UPC barcode anywhere on the cover (originals printed before 1976 had no UPC; even original 1976+ books had a specific UPC layout that differs from modern Marvel/DC trade dress)
  • Back cover with a modern Marvel or DC advertisement or house ad (originals had period ads — Daisy BB guns, Hostess fruit pies, X-Ray Specs, etc.)
  • Indicia (on inside front cover or first page) showing TWO publication dates — original year AND a modern year, or modern publisher address (e.g., Marvel's modern address "1290 Avenue of the Americas" or "135 W 50th St" instead of the original publisher's period address)
  • Modern paper stock — bright clean white at page edges, no period-appropriate aging despite the cover claiming a Silver/Golden Age date
  • Cover print quality noticeably sharper than period offset printing could achieve (modern digital reproduction vs. 1960s newsprint)
  • Modern publisher logo placement, color, or design

If you find ANY of these markers: populate the printing field with "Facsimile Reprint" (append the year in parentheses if visible, e.g., "Facsimile Reprint (2019)"). Set issueDate to the reprint year, NOT the original year. State the facsimile finding plainly in aiAssessment — the user needs to know they have a reprint, not the original.

If the book appears genuinely period-appropriate (no modern markers, period-appropriate paper aging, original publisher trade dress, era-correct printing quality): leave printing as empty string and proceed normally.

When uncertain: lean toward populating "Facsimile Reprint". A reprint mislabeled as authentic creates a much worse user outcome than an authentic book correctly graded but conservatively flagged for review.

SELF-REVIEW BEFORE FINALIZING (S13 v7):
After you have written your defect list, re-read it and ask: does any defect description contain language suggesting MAJOR damage — words like "chunk", "missing", "torn off", "piece out", "large", "significant tear", "tape covering", "color touched"? If yes, the defect's severity field MUST be "High" and the missing-piece ceiling / restoration cap must be applied to BOTH the CGC grade AND the RoboGrade. A defect described as significant cannot coexist with a mid-grade or high-grade output.

EPISTEMIC HUMILITY: A photograph cannot show everything that an in-hand inspection reveals. Tiny missing pieces (under 1/16"), faint creases, and small back-cover defects can hide in shadow, glare, or low pixel density. Do NOT make confident absence-claims like "no missing pieces observed" or "no tears detected" in your notes — those statements have been wrong before and they don't belong in the inventory anyway (the inventory is what you DO see, not what you don't). Simply omit absent defects from the inventory.

DEFECT INVENTORY — for every defect record:
• Type (use official CGC terminology)
• Location (which corner, edge, or area)
• Measurement (use the ruler visible in photos for scale)
• Severity: High, Med, or Low
• Whether any crease is color-breaking
• Category: Front | Back | Spine | Interior
  - Front: front cover surface and outer front corners
  - Back: back cover surface and outer back corners
  - Spine: spine surface, spine roll, spine stress lines, and inner corners at top/bottom of spine
  - Interior: pages, staples, interior printing

EYE APPEAL DISCIPLINE (v2.1):
You are inventorying observable defects, not auditing the book for everything that could be wrong. A typical Silver Age book has 4-8 distinct defects worth noting at any grade — not 12-15. Resist the urge to find a defect on every corner, every edge, and every surface area. If a corner looks fine, no defect goes in the inventory. If three of four corners are clean and one is blunted, the inventory has ONE corner blunting entry, not four (one real + three "no defect" entries).

When the photos show a book that "presents well" — strong color saturation, flat spine, sharp-looking corners, bright cover — your inventory should reflect that. A clean-presenting book with three real defects inventories as three defects, not as three real defects plus eight imagined ones from over-scrutiny.

PAGE QUALITY:
Assess from any interior photo. Phone cameras under typical indoor lighting consistently make pages look 1-2 tiers more yellowed than they actually are. Calibration data from 10 PSA-graded books in 2026 showed that the prior calibration was systematically under-reading PQ by 2 tiers on average — books PSA called Off-White to White were being called Cream to Off-White. The rules below correct that.

THREE ANCHORING RULES:

1. AGE-AWARE DEFAULT (STRENGTHENED). Books published before 1985 (Silver Age and Bronze Age) overwhelmingly grade at Off-White to White or White in the wild. Genuinely cream or tan pages are uncommon and tied to specific storage conditions (damp, sun-bleaching, acidic storage). For a pre-1985 book, the default page quality is Off-White to White unless you see SPECIFIC, NAMEABLE evidence to the contrary. "The page looks a bit yellow under indoor light" is NOT specific evidence — that is camera/lighting bias and the rule above tells you to discount it. Specific evidence means: visible foxing dots or rust marks, brown-tinged edges that contrast with a lighter center, obvious brittleness or splitting, or uniform tone visibly darker than the photo's white balance reference. Without that, default to OW/W.

2. ANCHOR AGAINST THE REFERENCE (when present). When a Page Quality Reference image is provided, use it as the literal ground truth. The reference shows real interior photos of professionally graded books labeled with their actual page quality designations. Match the closest reference example. The reference covers the upper part of the scale; if the interior you are assessing looks comparable to ANY of the reference photos, the answer is Off-White to White or White accordingly. ONLY assign Off-White or lower when the interior is visibly more tanned than EVERY reference example.

   STEPWISE FALLBACK BELOW THE REFERENCE: When you decide the interior IS warmer than every reference example, the next step down is **Off-White**, not Cream to Off-White. Do not skip a tier. C/OW requires substantial evidence of tanning beyond what would justify OW — a noticeably yellowed or cream cast across the page, not just "warmer than the reference whites." If you are dropping below the reference floor at all, the burden of proof is on the C/OW or lower designation; OW is the conservative default below the reference.

   COMPARE EYE TO EYE, NOT BOOK TO BOOK. The reference photos and the photo you are assessing may have different lighting conditions, white balance, or exposure. Compare the unprinted page areas (margins between panels, gutters, white speech balloons) of the assessment photo to the unprinted page areas of the reference photos. Do not be misled by overall photo warmth that comes from the camera, the surface beneath the book, or ambient lighting. The page tone is what matters — not the surrounding photo cast.

3. FAVOR THE WHITER TIER WHEN AMBIGUOUS. When sample sits between two reference colors, pick the whiter designation. Use the darker designation only when the sample is clearly at or past that reference tone.

Full designations only: White, Off-White to White, Off-White, Cream to Off-White, Cream, Light Tan to Cream, Light Tan, Tan, Brown, Brown/Brittle, Brittle.

PQ score for interior component: White=100, OW/W=94, OW=86, C/OW=76, Cream=64, LT/C=50, LT=36, Tan=22, Brown=10, Brittle=0

════════════════════════════════════
PHASE 2 — THREE GRADES FROM YOUR OBSERVATIONS
════════════════════════════════════

── ROBOGRADE (primary, AI-native) ──
Scoring: four components summed directly to the final. Each component has its own maximum:
  Front:    0–50 points  (front cover surface and outer front corners)
  Back:     0–20 points  (back cover surface and outer back corners)
  Spine:    0–20 points  (spine surface, spine roll, inner corners at spine, staple area)
  Interior: 0–10 points  (page quality, staple condition, interior printing/defects)

Final score = Front + Back + Spine + Interior. Always between 0 and 100.

All scores are INTEGERS. No decimals anywhere. Round naturally.

RULE: Score each category independently from defects in that category ONLY.
A perfect score in a category means no observed defects. Deduct from the maximum based on defect severity and accumulation.

Per-category calibration (applied proportionally to the category maximum):
  Front (max 50):
    • 50 = pristine, sharp corners, flat, no observed defects
    • 47-49 = a single trace defect (minor corner wear, light spine-adjacent tick)
    • 43-46 = one small defect or trace accumulation
    • 38-42 = minor defects present, still strong eye appeal
    • 30-37 = moderate defect accumulation or one color-breaking defect
    • 20-29 = substantial wear or significant defect
    • 10-19 = major structural or cosmetic issues
    • 0-9 = severe, extensive, possibly structural compromise
    CUMULATIVE-FRONT-DEFECT RULE (v2.4): If the front cover shows widespread
    soiling/discoloration AND has multiple additional defects (any combination
    of corner blunting + edge wear + a crease + spine-side stress), Front
    sub-score MUST be ≤ 30 regardless of how each individual defect is rated.
    Mid-grade books (CGC 3.0-4.5 territory) routinely show this combination.
    Without this rule, individual defects each get rated as Med severity and
    the sum lands in the 32-40 range, which corresponds to a CGC 5.5-7.0 cover.
    The point is the cumulative effect: a cover with widespread soiling AND
    multiple additional wear features is a 30-or-below cover even if no
    single defect is High severity. When in doubt at 30, go to 28.
    CREATOR-SIGNATURE RULE (v2.7, neutral + ceiling cap): If a marking
    on the cover is CONFIDENTLY identifiable as a deliberate creator
    signature — meaning it reads as a name written in a stylized
    signing manner, appears in a customary signing location, and is
    consistent with a creator's autograph (illustrator, writer, editor,
    or other professional associated with the book) — handle it as
    follows:
      • Record it in the defects array with type "Creator signature"
        (NOT "Writing on cover"), severity "Low". The entry exists so
        the owner can see the signature was identified and factored in.
        It is INFORMATIONAL — see point below.
      • Score Front, Back, Spine, and Interior AS IF THE SIGNATURE IS
        NOT PRESENT. Do NOT deduct any points for the signature itself.
        A clean signed book scores identically to the same clean book
        with no signature. The signature does not lower the sub-score.
      • CEILING CAP: a signed book CANNOT exceed Robograde 92 (predicted
        ~9.6 / NM+). If the score calculation would land above 92, cap
        it at 92. This reflects that an unverified signature on the
        cover keeps a book out of the very top grade tier (Robograder
        does not authenticate, so we cannot grant the "as if pristine"
        ceiling), but it does NOT pull a mid- or high-grade book
        downward. A book that would have scored 88 still scores 88; a
        book that would have scored 95 caps to 92.
      • In aiAssessment and aiGraderNotes, describe the signature as a
        noted attribute (e.g. "Cover bears an apparent creator
        signature reading 'Len Wein'"). Do NOT use damage language.
        Do NOT say it "prevents higher grades" except in the specific
        sense of the 92 ceiling — and only mention the ceiling when
        the book would otherwise have exceeded it.
      • You DO NOT and CANNOT authenticate signatures. Never say a
        signature is genuine, authentic, real, verified, or consistent
        with a creator's known style. Use "apparent signature reading
        '<name>'" — the word "apparent" is required.
      • DISFIGUREMENT EXCEPTION: if the signature is so large and
        prominent that it physically dominates the cover image (e.g. a
        cover-spanning paint-pen mark obscuring artwork across more
        than half the cover), apply a single Med-severity deduction to
        Front for the physical impact. This exception is for genuine
        disfigurement only — a typical signature on the cover face,
        however large, does NOT qualify. If you are unsure whether
        something qualifies as disfigurement, it does not.
    CONFIDENCE BAR: Apply this rule ONLY when you can read a plausible
    creator name in a deliberate signing style. If the writing is
    ambiguous (a scrawl, a number, an owner writing their name in
    block letters in the bag-flap area, a price, a date stamp), treat
    it as ordinary cover writing under the normal defect rubric — do
    NOT neutralize unknown writing as a "signature" just because it
    might be one. Erring toward "still a defect when unsure" is the
    correct posture: under-noting an unconfirmed signature is
    recoverable; over-neutralizing actual defacement is not.
  Back (max 20):
    • 20 = pristine, no observed defects
    • 18-19 = trace wear only
    • 15-17 = minor defect or light accumulation
    • 11-14 = moderate defect accumulation
    • 7-10 = substantial wear or significant defect
    • 0-6 = major issues
  Spine (max 20):
    • 20 = pristine spine, no roll, no stress lines, no fraying, staples clean
    • 18-19 = trace — one very minor non-color-breaking tick
    • 15-17 = light stress lines, slight roll, or minor corner blunting at spine
    • 11-14 = multiple stress lines, visible roll, minor fraying, or one color-breaking crease
    • 7-10 = significant stress accumulation, split starting, staple pull
    • 0-6 = severe structural issues at spine
  Interior (max 10):
    Interior score is DERIVED from page quality. Start from the PQ-mapped value below. If NO documented interior defect is present (no staple rust, no detached centerfold, no missing page, no significant interior soiling), the interior score MUST equal the PQ-mapped value exactly. Do NOT apply any deduction without a corresponding documented defect. A "general feeling" that the interior is rough is not a deduction trigger.
    PQ → starting interior score (this IS the final score when no deduction applies):
      • White                   → 10
      • Off-White to White      → 9
      • Off-White               → 8
      • Cream to Off-White      → 7
      • Cream                   → 6
      • Light Tan to Cream      → 5
      • Light Tan               → 4
      • Tan                     → 3
      • Brown                   → 2
      • Brown/Brittle           → 1
      • Brittle                 → 0
    Deductions (apply at most ONE, capped to -2; only when the corresponding defect is observed AND noted in the defect list):
      • Staple rust or significant oxidation: -1
      • Detached centerfold or detached interior wrap: -2 (capped)
      • Significant interior soiling, foxing, or stains: -1
      • Missing interior page or coupon: -2 (capped)
    EXAMPLES of correct output:
      • OW/W pages, no documented interior defect → Interior = 9
      • White pages, staple rust noted → Interior = 9 (10 - 1)
      • Off-White pages, no interior defects in the response → Interior = 8 (NOT 7)
      • Cream pages, missing centerfold → Interior = 5 (capped at -2)
    SAFETY FLOOR: An interior score of 0 is reserved for Brittle pages or for severe interior damage. NEVER assign 0 to a book with White, Off-White to White, or Off-White pages — that is internally inconsistent and will be flagged as a bug.

No back cover photo provided case: set backScore to null. Redistribute the 20 Back points into Front, raising Front's maximum to 70. All other categories unchanged.

STAPLE INSPECTION PROTOCOL (v3.2, May 22 — required for every assessment):

This protocol replaces default-clean staple assertions. Staple rust with migration is one of the most common defects under-reported in image-based grading, and asserting "no rust" when staples aren't clearly visible has been a credibility failure. Apply this protocol in order:

  1. ORIENT before describing. Identify which edge of each visible photo corresponds to the spine BEFORE describing staple condition. For a front cover photo, the spine is the LEFT edge. For a back cover photo, the spine is the RIGHT edge. For an interior page photo, the spine is wherever the binding is visible. State the orientation in your reasoning (it does not need to appear in the output JSON, but you must orient before observing).

  2. LOCATE the two staples. Standard saddle-stitched comics have two staples, roughly one third and two thirds down the spine. In each photo where the spine edge is visible, note whether each staple position is visible OR obscured.

  3. DESCRIBE what is visible, do NOT render a default verdict. For each staple location, observe:
     • Is the staple head itself visible at this resolution and angle?
     • If visible: what color is the metal? Silver/grey = clean. Brown/orange/black = oxidation likely.
     • Discoloration in the paper surrounding the staple — brown/orange staining radiating outward indicates rust migration. Estimate extent (mm of spread) and intensity (faint/moderate/heavy).
     • Structural state — appears intact, dislodged, popped, or missing?

  4. RESOLUTION HONESTY. If the images do not allow reliable inspection of the staples (resolution too low, staples obscured by binding, photographed from angle that hides the staple area, or the staple region is out of focus), state this EXPLICITLY in the stapleCondition field. DO NOT default to "intact" or "clean" when you cannot actually verify. Under-reporting a condition you cannot confirm is the correct posture — over-claiming cleanliness misleads collectors who will later discover the issue when the book is professionally graded.

  5. DEFECT ENTRY. If rust or rust migration is OBSERVED (not suspected, not defaulted-to-absent), add a defect entry of type "Staple rust" with category "Interior" and severity based on extent:
     • Low: faint discoloration localized to within ~2mm of the staple
     • Med: clear brown staining with migration extending ~3-8mm into surrounding paper
     • High: heavy rust with extensive migration, multiple stained pages visible, or visible staple structural failure
     If a staple is missing, dislodged, or popped, add a "Staple defect" entry at Med or High severity (category "Interior").

  6. STAPLE CONDITION FIELD. The stapleCondition string in the JSON output must match one of these patterns:
     • If staples verified clean at adequate resolution: a specific description like "Both staples visible, silver metal, no surrounding discoloration in spine paper of back cover."
     • If staples not clearly visible at provided resolution: "Staple condition cannot be reliably determined from provided image resolution — close-up photo recommended for confirmation."
     • If defect(s) observed: a specific description matching the defect entries, e.g. "Top staple shows brown rust with ~5mm migration into surrounding paper, visible on back cover spine edge."
     Do NOT use bare "Staples intact and firmly set, no visible rust or migration" as a default. That phrasing is now reserved for cases where you have actually verified each staple at adequate resolution.

  7. PRECISION WIDENING. If you used the "cannot be reliably determined" stapleCondition path in step 6, widen the confidence range (baseConf default is ${baseConf}; add at least +2 to the precision range for staple-inspection uncertainty alone). Also widen for: glare/poor focus, no raking light photo, restoration suspected.

Step 1: Assign Front score (0–50) based on front-cover defects only.
Step 2: Assign Back score (0–20) based on back-cover defects only. If none observed, score is 19–20.
Step 3: Assign Spine score (0–20) based on spine defects only.
Step 4: Assign Interior score (0–10) using the calibration above. Start from PQ, then deduct for staple/interior defects.
Step 5: Compute final score: Front + Back + Spine + Interior. Simple addition.

${!hasBackCover ? 'No back cover photo provided — set backScore to null. Front max becomes 70 (absorbing Back\'s 20). Total still 0–100.' : ''}
Confidence base: ±${baseConf}. Adjust up if: glare/poor focus, no raking light photo, staples not visible (see STAPLE INSPECTION PROTOCOL step 7), restoration suspected.

CRITICAL: The final score is literally Front + Back + Spine + Interior. The arithmetic must check out exactly. If your holistic impression disagrees with the sum by more than 2 points, revisit the component scores — one is wrong, not the formula.

── CGC GRADE ──
Apply CGC standards to your defect inventory from Phase 1.

GRADING PHILOSOPHY (v2.1) — THINK LIKE BLACKJACK:
The cost of overshooting a grade is asymmetric and much higher than the cost of undershooting. If a user submits a book to PSA or CGC based on your prediction and the official grade comes in lower than what you predicted, that is a costly outcome for the user (the submission fee, the shipping, the wait, and the disappointment). They will lose trust in Robograder. If instead you predict slightly low and the official grade comes in higher, the user is delighted — they got a "bonus" they didn't expect.

Therefore: when calibrating between two adjacent grade points, prefer the lower one. When uncertain whether a defect rises to a grade-affecting level, count it. When the holistic impression sits between two grades, pick the lower. The exception is when defects are clearly minor and eye appeal is strong — never grade conservatively just for safety. The goal is precision: get as close to the official grade as you can WITHOUT going over. Like blackjack: 21 is perfect, 20 is great, 22 is a bust.

This applies to BOTH the CGC grade and the RoboGrade. Component scores derived in Phase 2 should reflect this same conservative-when-uncertain disposition.

Grade calibration:
• Assign 9.0–9.6 for minor defects. Do not cap at 8.5 out of caution.
• Strong eye appeal + flat spine + bright colors + sharp corners = high grade.
• At high grades (8.5+), stress lines, bends, soiling, and printer tears become potentially grade-defining.
• Missing piece ceilings: <1/4"→max ~9.0 | 1/4"–1/2"→max ~8.0 | >1/2"→max ~5.0 | >1"→max ~3.0
• SEVERE-DEFECT CAP (S13 v7): if ANY of the following defects is present, the final RoboGrade is capped at 35 and the predicted CGC/PSA grades are capped at 2.5, regardless of how clean the rest of the book is. CGC and PSA both apply this cap in their grading practice. Defects that trigger the cap:
  • Paper loss / piece out larger than 1" in any single dimension
  • Tape on the book (any quantity, any location — even a small piece)
  • Missing interior pages or wraps
  • Color touch / amateur color restoration
  • Spine split running more than 50% of spine length
  • Severe water damage with cockling or staining over a large area
  This cap exists because these defects are structural and not improvable through normal handling or pressing — a book with one of them belongs in the Good or Fair grade range no matter how nice everything else looks. If the four-component sum exceeds 35 in the presence of one of these defects, scale all four components down proportionally to reach the cap (rough guide: front gets the largest absolute reduction since it's the largest component).
• ENHANCE: a single yes/no judgment about whether professional treatment (any of pressing, UV, or cleaning, or any combination) is likely to improve this book's grade. Output "Y" if any of these would help: visible spine roll or rippling that pressing could correct, color-breaking creases that pressing might soften, soiling that cleaning could lift, or tanning on unprinted white areas that UV could lighten. Output "N" if defects are dominated by structural damage that no treatment can address (missing pieces, tears, severe creases, stains that have set). Leave null if uncertain.
Grader notes — PSA-STYLE RESTRAINT (v2.1 calibration):

PSA's grader notes are the gold standard for clarity. PSA describes a typical Silver Age 7.0 book with one or two sentences per cover side, naming only the defects that matter to the grade. RG's prior versions were over-enumerating — listing 12-15 separate notes for a mid-grade book with the same defects repeated across multiple corners. Match PSA's restraint.

CONSOLIDATION RULES (apply BEFORE writing notes):
  • Group same defect type across multiple locations into ONE note ONLY when the locations share the same defect kind and severity. Do NOT write four separate corner-blunting notes if all four corners are blunted equally; write "Corner blunting, all four corners". But DO write separate notes when corners differ — e.g. "Corner blunting, top corners, ~1/16"" and "Piece out, bottom-right corner, ~1" if those are the actual conditions. Same applies to spine stress lines (consolidate to "Spine stress lines, multiple along full spine length"), edge wear, soiling, etc., when uniform; split when non-uniform.
  • Never note absence of defects. Do NOT write "no missing pieces observed", "no tape detected", "no restoration", "pages supple, no brittleness". Absence is the default — only call out what IS there.
  • Never restate page quality in notes. PQ has its own field; mentioning it again in notes is duplicative clutter.
  • Never note things that are not defects: arrival dates, distributor markings, pedigree marks, normal manufacturing characteristics. Note these only if they affect the grade.
  • Never describe handling history ("book has been read multiple times") — describe the defects themselves.

JUSTIFICATION RULES (S12 May 6 — added because RG was deducting from Back without listing any back defect):
  • If a category (Front, Back, Spine) is below its maximum (Front<50, Back<20, Spine<20), there MUST be at least one defect entry in that category in the defects array. If you cannot name a specific defect for the category, then the category should NOT lose points. Score deduction without a named defect is incoherent and erodes trust in the assessment.
  • Interior category is special: ALWAYS include at least one note about Interior in the defects array, even when the category is at full marks (10/10). At minimum, describe the page quality observation: "Interior: White pages" or "Interior: Off-White to White pages, supple, clean" or similar. Use category="Interior" for these. The reader needs to see that Interior was actually evaluated, not silently assumed.
  • Interior PQ-summary notes are exempt from the "never restate page quality" rule above — the goal is to confirm Interior was evaluated. Keep these notes brief (1 short sentence) and never duplicate the standalone PQ field's exact wording.

TARGET NOTE COUNT:
  • High grade (8.5+): 1-4 notes
  • Mid grade (5.0-8.0): 3-7 notes
  • Low grade (3.0-4.5): 5-10 notes
  • Heavy damage (below 3.0): 8-15 notes
  More than these counts indicates over-enumeration. Consolidate.

COLOR-BREAKING CALIBRATION:
  Color-breaking is a specific, restrained classification. A typical Silver Age book has 0-2 color-breaking defects, NOT 5-10. Reserve the color-breaking flag for clearly-visible breaks where the printed color is interrupted by the crease/fold/stress line. Surface stress lines that don't visibly break color should be noted as non-color-breaking, OR — when the book has many stress lines that are mostly clean — omit the color-breaking qualifier entirely with phrasing like "Multiple light spine stress lines, mostly non-color-breaking".

  Default position: a stress line is non-color-breaking unless you can see the color discontinuity in the photo.

SEVERITY DISCIPLINE:
  PSA's notes use restrained language — "stress lines, some break color", "edge wear", "tiny piece missing", "light tanning". RG should match this register. AVOID escalated language like "multiple", "moderate", "significant", "heavy", "extensive" unless the defect actually warrants it. A book with normal shelf wear gets "Light edge wear", not "Moderate edge wear and abrasion throughout".

  Same applies to severity field: do not over-call High severity. Most Silver Age defects are Low or Med. High is reserved for defects that actually drop a grade tier on their own (color-breaking creases, missing pieces over 1/4", spine splits, tape, etc.).

Format: one bullet per note starting with •, official CGC terminology, mark color-breaking only when truly color-breaking.

CGC GRADE TIER REFERENCE — what each grade officially permits:
${CGC_GRADE_TIERS.trim()}

── PSA GRADE ──
PSA entered comic grading in July 2025. They use the same numeric scale as CGC but with fewer intermediate steps and their own page quality terminology. PSA weights eye appeal more explicitly than CGC — a book that presents well at a grade boundary should get the benefit of the doubt.

PSA numeric grades (no 9.2, no 1.8, no 1.5; bottom is 0.3 not 0.5):
10, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.5, 0.3

PSA GRADE TIER REFERENCE (what each grade officially permits):
10 (Gem Mint): Effectively flawless. No handling defects; only trace printing defects. White or exceptionally white pages.
9.8 (Near Mint/Mint): Nearly perfect. Only the smallest printing or handling defects. Flat cover, well-centered, bright color, sharp corners. Off-White to White pages at minimum.
9.6 (Near Mint+): Sharp corners, very limited wear. Minor spine stress with a few color breaks permitted. Trace edge or corner wear. Strong gloss. Cream/OW to White pages acceptable. Distributor markings permitted with minor overspray. Arrival dates permitted.
9.4 (Near Mint): A few tiny spine stresses, one small edge tear, or minor corner blunting. Cover flat and firmly secured, only trace fading or surface wear. Staples clean. Supple pages, cream/OW to White. Small bindery/printing defects allowed. Unobtrusive date stamps permitted.
9.2 (Near Mint-): Slight wear beginning. Small spine ticks, small corner blunting. Still presents strongly with high eye appeal.
9.0 (VF/NM): Wear more apparent but eye appeal still strong. Small bends, small color-breaking creases, small chips. Minor sun or dust shadows and light tanning possible.
8.5 (VF+): Accumulation of small defects or one moderate defect. Cover shows wear but retains reasonable gloss.
8.0 (VF): Small bends, small color-breaking creases, minor edge chips. Minor shadows or tanning. At the low end of 8.0, small tape may be present (noted on label). A book with a single neatly detached centerfold (one staple) starts at 8.0.
7.5 (VF-): Accumulation of defects, moderate cover wear. Generally flat, gloss mostly intact.
7.0 (FN/VF): Longer tears, color discoloration, fading, soiling, light stains possible. Cover detached at one staple or centerfold detached at both staples possible.
6.5 (FN+): Significant wear accumulation. Some structural defects possible.
6.0 (FN): Longer tears, more soiling, more fading. Missing inserts possible.
5.5 (FN-): Substantial wear, reduced cover gloss.
5.0 (VG/FN): Moderate to substantial defect accumulation.
4.5 / 4.0 (VG+ / VG): Major defects. Larger tears, heavy creases, abrasions, severe stains. Cover inks possibly faded. Some story or ad pages can be missing; panels or coupons may be cut. Heavy tape may be present. An otherwise high-grade book missing a front or back cover (not both) or missing story pages starts here.
3.5 / 3.0 (VG- / G/VG): Complete with all pages but glaring defects or a heavy accumulation of smaller defects. Possibly large missing pieces. Covers or pages possibly detached. Gloss usually gone. Significant tape possible.
2.5 / 2.0 (G+ / G): Worn and damaged. May be stained. Extensive tape repairs. Stories complete but ad pages, coupons, or panels may be missing. Spine or cover possibly split.
1.5 / 1.0 (Fa/G / Fa): Heavy accumulation of major defects across the book.
0.5 (Poor): Heavily defaced, multiple major defects, some missing pieces.
0.3 (Poor Incomplete): Coverless or missing wraps, pages, or staples. Very low page quality.

Special PSA designations:
• Authentic (AU) — authentication only, no numeric grade
• Conserved — professional conservation using archivally safe, reversible materials
• Restored — amateur restoration using non-archival or non-reversible materials
• Married — wrong-issue cover or pages added; noted on label but graded normally
• Qualified — used when noted defects would otherwise distort the numeric grade

PSA page quality scale (10 designations — note these are NOT the same as CGC's scale):
White | Off-White to White | Off-White | Cream to Off-White | Cream | Light Tan to Off-White | Light Tan | Tan | Brown | Brittle
Caps: Light Tan to Off-White max grade 8.5; Brittle max grade 3.5.
"White" on a pre-1984 book means exceptionally preserved, not merely light-colored — PSA requires White pages for a 10.

PSA-specific calibration rules:
• Tape is ALWAYS treated as a defect and always noted on the label — PSA never classifies tape as restoration.
• Pressing and cleaning prior to submission are accepted. Pressed comics receive full numeric grades (unlike pressed cards).
• Distributor ink or markings are permitted at 9.6+ if overspray is minor.
• Arrival dates do not affect grade.
• Professional (Conserved) work is distinguished from amateur (Restored) work — the quality-plus-quantity A/B/C × 1-5 scheme used by CGC does NOT apply to PSA.
• Eye appeal is weighted explicitly: at grade boundaries, a book with strong presentation (bright colors, flat spine, sharp corners) earns the higher grade.

Deriving the PSA grade from your CGC assessment:
Start from your CGC grade. Apply these adjustments in this order:
  1. If tape is present, PSA grade is AT MOST equal to CGC — often one tier lower because PSA's explicit tape-as-defect rule bites harder.
  2. If defects are clearly enumerable and eye appeal matches the defect list, keep PSA the same as CGC.
  3. If eye appeal exceeds what the defect list implies (strong gloss, bright color, flat spine, sharp corners, minimal tanning), adjust PSA upward by one tier — especially for Silver and Bronze Age material where early market data shows PSA running slightly more generous than CGC.
  4. PSA has fewer intermediate grades than CGC. If your CGC grade lands at 9.2, 1.8, or 1.5, you must round to the nearest PSA grade: 9.2→9.2 (exists on both), 1.8→2.0, 1.5→1.5 (exists on both). Most CGC grades have a PSA equivalent.
  5. If your CGC grade is 0.5 Poor and the book is coverless or missing wraps/pages/staples, PSA grade should be 0.3.

Map page quality to PSA's 10-designation scale (do NOT use CGC's scale for PSA):
CGC "Off-White to White" → PSA "Off-White to White"
CGC "Off-White" → PSA "Off-White"
CGC "Cream to Off-White" → PSA "Cream to Off-White"
CGC "Light Tan to Off-White" → PSA "Light Tan to Off-White" (caps grade at 8.5)
CGC "Light Tan to Cream" → PSA "Light Tan" (PSA has no "to Cream" variant)
CGC "Tan to Off-White" or "Tan to Cream" → PSA "Tan"
CGC "Brown to Off-White" or "Brown to Tan" or "Brown" → PSA "Brown"
CGC "Brown/Brittle" or "Slightly Brittle" → PSA "Brown" (if still structurally sound) or "Brittle"
CGC "Brittle" → PSA "Brittle" (caps grade at 3.5)

Do not invent defects not visible in photos. If the PSA grade equals the CGC grade, psaNotes must be an empty string. When PSA differs, explain the reason in psaNotes in 1-2 sentences (e.g. "Eye appeal argues for the higher grade — strong color saturation and flat spine despite the minor stress lines.").

If a CGC or PSA label is visible: read grade, cert number, page quality, and key issue notations directly from it.
${censusBlock}
${notesBlock}
${highGradeBlock}
════════════════════════════════════
RETURN ONLY THIS JSON — no markdown, no preamble
════════════════════════════════════
{
  "gateResult": "COMIC",
  "title": "series title, strip leading The",
  "issue": "e.g. 57 or A1",
  "issueDate": "cover date as 'Mon YYYY', e.g. 'Feb 1968' or 'Sep 1942'; for season-only books use 'Spr/Sum/Fall/Win YYYY' e.g. 'Sum 1942'. If this is a facsimile or reprint (see 'printing' field), use the reprint's ACTUAL publication year, NOT the original year. For example: a 2019 facsimile of Amazing Fantasy #15 has issueDate 'Dec 2019', not 'Aug 1962'.",
  "publisher": "publisher name",
  "printing": "Printing or variant designation. Leave EMPTY STRING for typical original-printing copies (the default — most books). Populate ONLY when there is clear evidence of a non-standard printing. Conventions: 'Facsimile Reprint' (or 'Facsimile Reprint (YYYY)' if the reprint year is visible in indicia or back cover) when this is a modern facsimile edition that reproduces an original key issue — Marvel and DC have published many of these; '2nd print' / '3rd print' / etc. for direct-edition reprints from the original era; 'Newsstand variant' for distinguishable newsstand copies of direct-edition books; 'Reprint' for older non-facsimile reprints. CRITICAL: when populating 'Facsimile Reprint', also note the facsimile finding plainly in aiAssessment so the user understands what they have, and use the reprint year (not the original year) for issueDate.",
  "pageQuality": "full designation e.g. Off-White to White",
  "grade": "CGC grade estimate e.g. 7.0",
  "graderNotes": "• one bullet per defect, official CGC terminology",
  "aiAssessment": "2-4 sentences: overall impression, dominant defects, grade rationale, enhancement judgment. Describe ONLY what you see in this specific copy's photos — defects, eye appeal, page quality, structure. NEVER mention census data, submission counts, average grades, distribution percentages, statistical anchoring, or any external data about this issue. Grade rationale must reference the book's actual condition, not population statistics.",
  "labelNotes": "key issue notations from label if visible, empty string if none",
  "keyInfo": "1-2 sentences about key-issue significance — ONLY populate if (a) the issue appears in the census data injected above AND (b) you are confident the fact is widely documented. Examples: 'First full appearance of Wolverine.' / 'First appearance of the Punisher.' Stay silent (empty string) if the issue is not a recognized key, even if you might guess at its significance. Better to omit than to hallucinate.",
  "enhance": true,
  "labelDetected": false,
  "officialCGCGrade": null,
  "officialCGCCert": null,
  "officialPageQuality": null,
  "psaGrade": "PSA grade estimate",
  "psaNotes": "why PSA differs, empty string if same",
  "officialPSAGrade": null,
  "officialPSACert": null,
  "roboGrade": {
    "version": "${ROBOGRADE_VERSION}",
    "score": 0,
    "confidenceRange": ${baseConf},
    "frontScore": 0,
    "backScore": ${backScoreDefault},
    "spineScore": 0,
    "interiorScore": 0,
    "pageQuality": "",
    "defects": [
      {"type":"","location":"","measurement":"","severity":"Med","colorBreaking":false,"category":"Front"}
    ],
    "stapleCondition": "",
    "restorationFlags": []
  }
}`;


  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
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
              ? 'Please perform the high-grade assessment. Apply the floor rule: the final RG, CGC, and PSA grades must be at or above the initial values unless a specific new defect is identified in the corner macros. Carry Back and Interior scores forward unchanged. Return the JSON grading object.'
              : 'Please assess this comic. CRITICAL FIRST STEP: examine every corner and every edge for paper loss / missing pieces (paper GONE, interior page visible underneath) BEFORE listing any other defects. Treat paper loss as a separate defect category from corner blunting — they are not interchangeable. Then examine each of the four corners individually and apply the per-corner inspection rule from the STRUCTURAL CHECK section. Then return the JSON grading object.' }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Anthropic API error: ' + err });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    let clean = text.replace(/```json/gi, '').replace(/```/g, '').replace(/'''/g, '').trim();
    const _fb = clean.indexOf('{'), _lb = clean.lastIndexOf('}');
    if (_fb !== -1 && _lb !== -1 && (_fb > 0 || _lb < clean.length - 1)) clean = clean.slice(_fb, _lb + 1);

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse response: ' + text }); }

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
      return res.status(200).json({
        gateResult: parsed.gateResult,
        gateReason: parsed.gateReason || '',
        cropFailure: parsed.cropFailure || null,
        lockout: _lockoutInfo,
        _diagnostics: {
          comicvineRef: referenceImageBlock !== null,
          pageQualityRef: pageQualityImageBlock !== null,
          pageQualityRefIsPsa: pqIsPsaReference,
          hasInteriorPhoto: hasInteriorPhoto,
          gateTerminated: true
        }
      });
    }

    // Normalize grade to always include decimal (e.g. "10" → "10.0", "9" → "9.0")
    if (parsed.grade && !String(parsed.grade).includes('.')) {
      parsed.grade = parseFloat(parsed.grade).toFixed(1);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Grade reference refinement pass — DISABLED May 13, 2026 (S13 v22).
    //
    // ORIGINAL DESIGN (Matt, pre-S13): the CONFIRMING GRADE step was
    // supposed to be a CHEAP IN-PROMPT calibration — include Hulk 181
    // reference images at the assessed grade plus one step above and
    // below in the SAME single Anthropic call, and let the model
    // self-check. No second API call. The reference images were the
    // calibration anchor; the model's existing pass would land more
    // accurately because it had real graded examples to compare
    // against in-context.
    //
    // WHAT THIS CODE DID INSTEAD: a full second Anthropic call with the
    // user's photos + ONE reference image at the assessed grade. Doubled
    // the cost and roughly doubled the latency. It's not what was asked
    // for — it's a different feature that got built under the same name.
    //
    // Why we're disabling rather than fixing in place:
    //   1. It runs on EVERY raw-CGC assessment (the "5.0-10.0 range"
    //      comment was aspirational; the condition was actually just
    //      isCGC && !labelDetected && parsed.grade).
    //   2. Doubled per-assessment cost ($0.08 → ~$0.16).
    //   3. Doubled per-assessment latency. Verified via debug-log timing
    //      on a real device: API total ~45s, of which ~22s was the
    //      refinement pass. Caused the visible "freeze" between scan
    //      animation completing and the step buttons cycling green —
    //      the freeze the team chased for multiple build iterations
    //      thinking it was an animation timer bug.
    //   4. Calibration evidence that it improved grading accuracy was
    //      never collected. We don't have data showing it actually
    //      helped — only the cost and latency it definitely added.
    //
    // FUTURE WORK to restore the ORIGINAL intent (not this implementation):
    //   - In the primary prompt assembly above, after the user's photos
    //     are added to imageBlocks, also append THREE reference images:
    //     Hulk 181 at the predicted grade, one tier above, one tier below.
    //   - This requires knowing the grade BEFORE the call, which means
    //     either (a) running a tiny preliminary pass to get a rough
    //     grade then a full pass with references (still two calls),
    //     or (b) including a wider reference set (e.g. 5.0, 7.0, 9.0,
    //     9.6, 9.8) so the model can self-calibrate across the range
    //     in a single call. Option (b) is the cheaper architectural
    //     match for "no second API call."
    //   - Each added reference image adds ~$0.012 + small latency,
    //     so 5 references adds ~$0.06 and a few seconds. Still cheaper
    //     than the doubled-call refinement was.
    //
    // To restore the (broken) refinement pass implementation as-is:
    // uncomment the block below. If you do, narrow the trigger to
    // grade >= 8.5 at minimum, and use 'claude-opus-4-6' to match the
    // primary call (the block below already has this fix applied).
    //
    // The downstream parsed._diagnostics.gradeRef field will now always
    // be false. The client's animateStepsFromDiagnostics treats absence
    // of gradeRef as "done" (not "failed") for the CONFIRMING GRADE
    // step — since the single-pass assessment IS the confirmation when
    // no separate refinement runs.
    //
    // if (isCGC && !parsed.labelDetected && parsed.grade) {
    //   const refImage = baseUrl ? await fetchGradeReference(parsed.grade, baseUrl) : null;
    //   if (refImage) {
    //     const refinementSystemPrompt = systemPrompt.replace(CGC_GRADE_TIERS.trim(), gradeTierContext(parsed.grade));
    //     const refPrompt = `You previously assessed this comic as grade ${parsed.grade}. Here is the official CGC grading reference page for ${parsed.grade}. Compare your assessment photos against this reference. If the reference shows the book should look better or worse than what you assessed, adjust your grade. Return the same JSON format with your refined grade and updated graderNotes and aiAssessment. If ${parsed.grade} still seems correct, return the same grade.
    //
    // IMPORTANT — do not name the reference book in your notes. The reference is a real CGC-graded comic that we use as a calibration anchor, but users do not see it and would be confused if their book was being compared against a different title. In your graderNotes and aiAssessment, refer to it generically as "the ${parsed.grade} reference" or "the reference at this grade" — never as "Hulk 181", "Hulk #181", "the Hulk reference", or any specific issue name. Examples:
    //   GOOD: "Compared to the ${parsed.grade} reference..."
    //   GOOD: "The reference at this grade shows..."
    //   BAD: "Compared to the Hulk 181 reference..."
    //   BAD: "Comparing to Hulk #181 at ${parsed.grade}..."
    // ${notesBlock}`;
    //     try {
    //       const refResp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    //         method: 'POST',
    //         headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    //         body: JSON.stringify({
    //           model: 'claude-opus-4-6',  // was 'claude-opus-4-5' — switched to 4.6 to match primary call if re-enabled
    //           max_tokens: 1000,
    //           system: refinementSystemPrompt,
    //           messages: [{
    //             role: 'user',
    //             content: [
    //               { type: 'text', text: `GRADE REFERENCE for ${parsed.grade}: The following image is a real CGC ${parsed.grade} comic with annotated defects, used as a calibration anchor. Do not name the title or issue number of this reference book in your output — refer to it generically as "the ${parsed.grade} reference."` },
    //               refImage,
    //               ...imageBlocks,
    //               { type: 'text', text: refPrompt }
    //             ]
    //           }]
    //         })
    //       }, 25000);
    //       if (refResp.ok) {
    //         const refData = await refResp.json();
    //         const refText = refData.content?.map(b => b.text || '').join('') || '';
    //         let refClean = refText.replace(/```json/gi, '').replace(/```/g, '').replace(/'''/g, '').trim();
    //         const _rfb = refClean.indexOf('{'), _rlb = refClean.lastIndexOf('}');
    //         if (_rfb !== -1 && _rlb !== -1) refClean = refClean.slice(_rfb, _rlb + 1);
    //         let refParsed;
    //         try { refParsed = JSON.parse(refClean); } catch(e) { refParsed = null; }
    //         if (refParsed && refParsed.grade) {
    //           if (!String(refParsed.grade).includes('.')) refParsed.grade = parseFloat(refParsed.grade).toFixed(1);
    //           const _sRobo = parsed.roboGrade;
    //           const _sPsa  = parsed.psaGrade;
    //           const _sPsaN = parsed.psaNotes;
    //           parsed = refParsed;
    //           if (_sRobo && !parsed.roboGrade) parsed.roboGrade = _sRobo;
    //           if (_sPsa  && !parsed.psaGrade)  parsed.psaGrade  = _sPsa;
    //           if (_sPsaN && !parsed.psaNotes)  parsed.psaNotes  = _sPsaN;
    //           parsed._diagnostics = { comicvineRef: referenceImageBlock !== null, gradeRef: true };
    //         }
    //       }
    //     } catch (e) {
    //       // Refinement failed — use original assessment
    //     }
    //   }
    // }
    // ─────────────────────────────────────────────────────────────────────

    // Attach diagnostic info
    // Note (May 13, 2026): with the refinement pass disabled, gradeRef
    // is always false. The client's animateStepsFromDiagnostics marks
    // the CONFIRMING GRADE step as "failed" (red) when gradeRef is false.
    // That's actually misleading now — there's no failure, we just
    // aren't running that step. Either:
    //   (a) update animateStepsFromDiagnostics to treat absence of
    //       gradeRef as "skipped" not "failed" (mark green or omit
    //       the step from the tracker), or
    //   (b) reword the step label so "CONFIRMING GRADE" no longer
    //       implies the refinement pass, and always set it to 'done'
    //       when gradeRef === false (because the single-pass assessment
    //       IS the confirmation).
    // Going with (b) at the client side — simpler change.
    const gradeRefSucceeded = false;  // refinement pass disabled
    parsed._diagnostics = {
      comicvineRef: referenceImageBlock !== null,
      pageQualityRef: pageQualityImageBlock !== null,
      pageQualityRefIsPsa: pqIsPsaReference,
      hasInteriorPhoto: hasInteriorPhoto,
      gradeRef: gradeRefSucceeded,
      psaGrade:  !!(parsed.psaGrade),
      roboGrade: !!(parsed.roboGrade)
    };
    if (parsed.psaGrade && !String(parsed.psaGrade).includes('.')) {
      parsed.psaGrade = parseFloat(parsed.psaGrade).toFixed(1);
    }

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

      // ── Interior-from-PQ enforcement (S11 calibration safety net) ─────────
      // The prompt rule says interior = PQ-mapped value if no deduction is
      // documented. The model occasionally drifts and applies an unjustified
      // -1. Enforce the rule deterministically here. If interior < PQ-mapped
      // AND no deduction-trigger keyword appears in the defect list, clamp
      // interior up to the PQ-mapped value.
      const PQ_TO_INTERIOR = {
        'White': 10, 'Off-White to White': 9, 'Off-White': 8,
        'Cream to Off-White': 7, 'Cream': 6, 'Light Tan to Cream': 5,
        'Light Tan': 4, 'Tan': 3, 'Brown': 2, 'Brown/Brittle': 1, 'Brittle': 0,
      };
      const pqMapped = PQ_TO_INTERIOR[rg.pageQuality];
      if (typeof pqMapped === 'number' && typeof i === 'number' && i < pqMapped) {
        // Look for deduction triggers in the defect list. The prompt asks for
        // these specific kinds of interior defects to justify a deduction:
        // staple rust, detached centerfold, missing page, interior soiling.
        const defects = Array.isArray(rg.defects) ? rg.defects : [];
        const interiorDefectText = defects
          .filter(d => d && (d.category === 'Interior' || d.location?.toLowerCase().includes('interior')))
          .map(d => `${d.type || ''} ${d.location || ''} ${d.notes || ''}`.toLowerCase())
          .join(' ');
        const hasTrigger = (
          /staple\s*(rust|oxid)/.test(interiorDefectText) ||
          /detached/.test(interiorDefectText) ||
          /missing\s*(page|coupon|wrap|centerfold)/.test(interiorDefectText) ||
          /(soiling|foxing|stain)/.test(interiorDefectText)
        );
        if (!hasTrigger) {
          i = pqMapped;
          rg._interiorClamped = { from: rg.interiorScore, to: pqMapped, reason: `PQ "${rg.pageQuality}" maps to ${pqMapped}, no documented deduction trigger` };
        }
      }

      if (f != null && s != null && i != null) {
        // Clamp each component to its valid range and round to integer
        if (b == null) {
          // No back cover — Front absorbs Back's 20 points, so max is 70
          f = clampInt(f, 0, 70);
        } else {
          f = clampInt(f, 0, 50);
          b = clampInt(b, 0, 20);
        }
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

      // 5. Floor rule for PSA grade — same logic.
      const psaFloor = parseFloat(initialPsaGrade);
      const psaNew   = parseFloat(parsed.psaGrade);
      if (!isNaN(psaFloor) && !isNaN(psaNew) && psaNew < psaFloor) {
        const notes = String(parsed.aiAssessment || '').toLowerCase();
        const mentionsMacro = notes.includes('macro') || notes.includes('corner');
        if (!mentionsMacro) {
          enforcement.push(`PSA grade floored ${parsed.psaGrade} → ${initialPsaGrade}`);
          parsed.psaGrade = String(psaFloor.toFixed(1));
        }
      }

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

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
