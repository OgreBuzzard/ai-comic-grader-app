// =============================================================================
// api/assess_deep.js — Deep Assessment endpoint
// =============================================================================
//
// Architecture (v4.0, S15 Move B):
//   Takes the initial assessment's full JSON + 4 corner macros of the front
//   cover (Top Left, Top Right, Bottom Left, Bottom Right). Asks ONE question:
//   do these macros change the Front or Spine sub-scores?
//
//   Back and Interior scores are FROZEN — no new evidence for them, no reason
//   to reconsider. Any new defects found in the macros are tagged
//   `deepAddition: true` so the UI can highlight them. Precision narrows
//   because more evidence is in hand.
//
// Why a separate endpoint:
//   The legacy path ran Deep Assessment through /api/assess with highGrade=true,
//   which re-evaluated every phase from scratch on ~25,000 input tokens (the
//   full prompt + 8 images). S15 timings showed these calls cost ~$0.18 each
//   and frequently timed out. This endpoint sends ~12,000 input tokens (focused
//   prompt + 4 macros + initial JSON) and only asks for a delta. Roughly half
//   the cost, faster, and only does the work the new evidence actually informs.
//
// Streaming/SSE: this endpoint emits the same 5 phase events as /api/assess so
// the frontend modal walks the same 5 steps the user is used to. The phases
// here are mapped onto the deep-assessment work:
//   phase 0 (populating)    — input validation done, about to call Anthropic
//   phase 1 (mint)          — first text token from Anthropic
//   phase 2 (pq)            — model has reached the inspection output stage
//   phase 3 (grading)       — model has emitted updated grade
//   phase 4 (confirming)    — model has emitted revised roboGrade
//
// =============================================================================
import { ROBOGRADE_VERSION } from '../lib/version.js';
import { anthropicWithRetry } from '../lib/anthropic_retry.js';
import { computePhotograderPM, mergePhotograder, PHOTOGRADER_RUBRIC_CLOSEUP } from '../lib/photograder.js';

export default async function handler(req, res) {
  // CORS: the iOS Capacitor app calls this cross-origin (local file origin →
  // robograder.app) and preflights with OPTIONS + custom headers. PWA is
  // same-origin and never preflights. Answer the preflight before the POST gate.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-client-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // ── SSE setup (mirrors api/assess.js v3.99c) ────────────────────────────────
  const acceptHeader = (req.headers['accept'] || req.headers['Accept'] || '').toLowerCase();
  const wantsSSE = acceptHeader.includes('text/event-stream');
  let sseInitialized = false;
  function sseEvent(type, dataObj) {
    if (!wantsSSE) return;
    if (!sseInitialized) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      sseInitialized = true;
    }
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(dataObj)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (e) {}
  }
  function sseError(status, payload) {
    if (wantsSSE) {
      sseEvent('error', { status, ...payload });
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(status).json(payload);
  }

  // ── timing instrumentation ──────────────────────────────────────────────────
  const T0 = Date.now();
  const phaseTimings = {};
  function markPhase(name) { phaseTimings[name] = Date.now() - T0; }
  function phaseDelta(name, since) { phaseTimings[name] = Date.now() - since; }

  // ── lazy Firestore admin (timing record write) ──────────────────────────────
  async function getAdminDb() {
    try {
      if (!process.env.FIREBASE_SERVICE_ACCOUNT) return null;
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      }
      return getFirestore();
    } catch (e) {
      console.error('getAdminDb failed:', e?.message || e);
      return null;
    }
  }

  // ── input validation ────────────────────────────────────────────────────────
  const {
    initialAssessment = null,
    cornerMacros = [],           // [{type, source} blocks in Anthropic image format] or [data URLs]
    interiorCovers = [],         // S20 (#36): optional 2 images [Interior Front, Interior Back]. Raw books send 2; slabbed books (can't be opened) send 0. When present, Deep judges interior-cover CONDITION and may move the Interior sub-score (page quality stays frozen).
    frontCover = null,           // S19: optional full front-cover image (data URL or block) for grade-reference comparison
    title = '',
    issueNumber = '',
    // S15 May 30: Restoration Check mode. When mode==='restoration', this same
    // endpoint runs a restoration examination instead of a deep grade
    // refinement (folded in here rather than a 13th Vercel function — we're at
    // the 12/12 cap). It takes 4 restoration images in this order:
    //   [Interior Front, Interior Back, Interior Staple, UV Front]
    // and returns a carefully-worded restorationReport (never a verdict).
    mode = 'deep',
    restorationImages = []       // 4 images for restoration mode
  } = req.body || {};

  const isRestoration = mode === 'restoration';

  if (!initialAssessment || typeof initialAssessment !== 'object') {
    return sseError(400, { error: 'initialAssessment required' });
  }

  // Mode-specific image validation.
  function toImageBlock(item) {
    if (item && typeof item === 'object' && item.type === 'image') return item;
    if (typeof item === 'string' && item.startsWith('data:')) {
      const m = item.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!m) return null;
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    return null;
  }

  let imageInputBlocks;   // the blocks sent to Anthropic (macros or restoration images)
  if (isRestoration) {
    if (!Array.isArray(restorationImages) || restorationImages.length !== 8) {
      return sseError(400, { error: 'restorationImages must be an array of 8 (UV Front, UV Back, Ext Top Staple, Ext Bottom Staple, Outer Edge, Interior Front, Interior Back, Interior Staples)' });
    }
    imageInputBlocks = restorationImages.map(toImageBlock);
    if (imageInputBlocks.some(b => !b)) {
      return sseError(400, { error: 'restorationImages: each entry must be a base64 data URL or Anthropic image block' });
    }
  } else {
    if (!Array.isArray(cornerMacros) || cornerMacros.length !== 4) {
      return sseError(400, { error: 'cornerMacros must be an array of 4 (TL, TR, BL, BR)' });
    }
    imageInputBlocks = cornerMacros.map(toImageBlock);
    if (imageInputBlocks.some(b => !b)) {
      return sseError(400, { error: 'cornerMacros: each entry must be a base64 data URL or Anthropic image block' });
    }
  }

  // S20 (#36): interior-cover photos (raw books only). When exactly 2 are sent,
  // Deep also judges interior-cover condition. When 0 (slabbed, or older clients),
  // Deep behaves exactly as before — interior stays frozen.
  let interiorCoverBlocks = [];
  const hasInteriorCovers = !isRestoration && Array.isArray(interiorCovers) && interiorCovers.length === 2;
  if (!isRestoration && Array.isArray(interiorCovers) && interiorCovers.length && interiorCovers.length !== 2) {
    return sseError(400, { error: 'interiorCovers, when provided, must be exactly 2 (Interior Front, Interior Back)' });
  }
  if (hasInteriorCovers) {
    interiorCoverBlocks = interiorCovers.map(toImageBlock);
    if (interiorCoverBlocks.some(b => !b)) {
      return sseError(400, { error: 'interiorCovers: each entry must be a base64 data URL or Anthropic image block' });
    }
  }
  const macroBlocks = imageInputBlocks;  // alias kept for the downstream message assembly

  // S20 (#44): when the client sends the Main front-cover image, Deep verifies
  // the corner macros belong to the SAME physical book before grading. A
  // high-confidence mismatch returns an IMAGE_MISMATCH gate and no grade — the
  // client charges no credit for a non-COMIC gate. If the anchor is absent
  // (older clients / no front cover), verification is skipped and the book is
  // always graded, so the feature can never block a legitimate assessment.
  const hasFrontCover = !isRestoration && !!frontCover && !!toImageBlock(frontCover);

  // ── canonical CGC tier reference (copied from assess.js v3.99c) ─────────────
  const CGC_GRADE_TIERS = `
10.0 GEM MINT: Perfect. No stress lines on spine. Razor-sharp corners. Cover flat. Staples clean, tight, centered. Full gloss, vibrant color, no fading. Practically nonexistent before 1975.
9.9 MINT: One small non-color-breaking cover bend OR one non-color-breaking spine stress line allowed. Perfectly cut, well-centered cover. No edge or corner wear.
9.8 NEAR MINT/MINT: One or two handling defects allowed: very small color-breaking spine stress line, or a couple of light cover bends. Tiny wear allowed on one corner or around a staple.
9.6 NEAR MINT+: A handful of very small defects (no more than one or two at once): a few very small color-breaking spine stress lines; very small wear to one or two corners; a tiny edge-only crease; a very small edge or staple tear; very light cover tanning.
9.4 NEAR MINT: Light handling defects begin to appear, only one or a few at once. Allowable: a very small spine split, one or two small color-breaking corner or edge creases, a very small chip-out, a very slight spine roll.
9.2 NEAR MINT-: Regular handling defects more apparent; eye appeal still strong. Accumulation of several tiny defects OR one significant defect (crease, tear, missing piece, stain, tanning).
9.0 VERY FINE/NEAR MINT: Color-breaking defects more evident, particularly creases and spine stress lines — still small and few, but countable. Minor fraying OR a small (~1/4") missing piece allowed.
8.5 VERY FINE+: Resembles a 9.0 but falls short — one or two defects barely exceeding 9.0 limits. Light corner fraying or color-breaking edge wear may be present.
8.0 VERY FINE: Threshold grade. High-end aesthetic with notable defect accumulation (or a couple of moderate defects). 1"-2" color-breaking corner or edge crease; spine split up to ~1/2"; ~1/2"x1/2" missing cover piece OR small corner chews.
7.5 VERY FINE-: One or two defects, or accumulation barely exceeding 8.0 limits. Still high-grade.
7.0 FINE/VERY FINE: Longer cover tears possible. Color discoloration, fading, light soiling, light stains. Cover may be detached at one staple.
6.5 FINE+: Significant accumulation of wear. Some structural defects begin to appear.
6.0 FINE: Multiple defects: longer tears, soiling, fading.
5.5 FINE-: Substantial wear. Cover gloss significantly reduced.
5.0 VERY GOOD/FINE: Moderate-to-substantial defect accumulation.
4.5 VERY GOOD+: Major defects beginning: larger tears, heavy creases, abrasions, severe stains, possible faded cover inks.
4.0 VERY GOOD: Same as 4.5 with more severity/accumulation.
3.5 GOOD/VERY GOOD: Between 4.0 and 3.0.
3.0 GOOD+: One major cover defect OR large accumulation. Spine split(s) totaling up to 5"; 6" cover tear; cover piece-out totals up to 3"x3".
2.5 GOOD+: Often worn and tattered. Moderate-to-heavy creasing, tears, staining, pieces out. Tape often present.
2.0 GOOD: Same defect range as 2.5 but slightly more severe or numerous.
1.8 GOOD-: Most common path: fully split spine, relatively clean, little/no missing paper along spine.
1.5 FAIR/GOOD: Same pattern as 1.8 but more severe. Defects often repaired with tape.
1.0 FAIR: Considerably worn. Heavy cover damage. Up to 1/4 of cover missing.
0.5 POOR: Extensive defect accumulation, significant missing cover or interior, or both.
`;
  function gradeTierContext(gradeStr) {
    const allTiers = CGC_GRADE_TIERS.trim().split('\n').filter(l => l.trim());
    const g = gradeStr != null ? parseFloat(gradeStr) : NaN;
    if (isNaN(g)) return allTiers.join('\n');
    const tierGrades = [10.0, 9.9, 9.8, 9.6, 9.4, 9.2, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.8, 1.5, 1.0, 0.5];
    let idx = tierGrades.findIndex(t => g >= t);
    if (idx === -1) idx = tierGrades.length - 1;
    const lo = Math.max(0, idx - 1);
    const hi = Math.min(tierGrades.length - 1, idx + 1);
    const relevant = new Set(tierGrades.slice(lo, hi + 1).map(t => t.toFixed(1)));
    return allTiers.filter(line => {
      const m = line.match(/^(\d+\.?\d*)\s/);
      return m && relevant.has(parseFloat(m[1]).toFixed(1));
    }).join('\n');
  }

  // ── focused system prompt ───────────────────────────────────────────────────
  // The initial assessment already established identification, page quality,
  // back-cover defects, spine defects from the wide spine shot, and an initial
  // RG and CGC grade. The deep call ONLY revisits the front cover and the
  // spine-adjacent inner corners using the 4 corner macros.
  //
  // Phases (mapped onto modal step names for SSE):
  //   Phase 0 (populating)  : validate inputs (server-side, no model call)
  //   Phase 1 (mint)        : compare TL+TR macros against the initial Front observations
  //   Phase 2 (pq)          : compare BL+BR macros (also assess inner-corner-at-spine details)
  //   Phase 3 (grading)     : apply any new defects to Front (and Spine if inner-corner damage seen)
  //   Phase 4 (confirming)  : verify revised grade against tier definitions ±1
  //
  // Output: the SAME JSON shape as a standard assessment, with:
  //   - Back and Interior sub-scores CARRIED FORWARD unchanged
  //   - Front and Spine sub-scores possibly adjusted
  //   - Any new defects tagged with deepAddition: true
  //   - confidenceRange narrowed (more evidence in hand)
  //   - aiAssessment notes the revision if grade changed
  const initialGrade = initialAssessment.grade || initialAssessment?.roboGrade?.predictedGrade || '';
  const initialRG = initialAssessment.roboGrade || {};
  const systemPrompt = `You are performing a DEEP ASSESSMENT — a focused refinement of an existing comic book grade using 4 high-resolution corner macros of the front cover${hasInteriorCovers ? ' plus 2 interior-cover photos (inside front cover/first page and last page/inside back cover)' : ''}.

The INITIAL ASSESSMENT is provided below. You are NOT re-grading from scratch. You are answering: do the corner macros reveal anything that changes the FRONT or SPINE sub-scores${hasInteriorCovers ? ', and do the two interior-cover photos reveal any interior-cover CONDITION (tanning, foxing, stains, tears) that changes the INTERIOR sub-score' : ''}?

INITIAL ASSESSMENT (authoritative — preserve all fields unless the macros provide explicit reason to change):
${JSON.stringify({
  title: initialAssessment.title,
  issue: initialAssessment.issue,
  publisher: initialAssessment.publisher,
  printing: initialAssessment.printing,
  pageQuality: initialAssessment.pageQuality,
  grade: initialAssessment.grade,
  aiAssessment: initialAssessment.aiAssessment,
  roboGrade: {
    score: initialRG.score,
    frontScore: initialRG.frontScore,
    backScore: initialRG.backScore,
    spineScore: initialRG.spineScore,
    interiorScore: initialRG.interiorScore,
    pageQuality: initialRG.pageQuality,
    defects: initialRG.defects
  }
}, null, 2)}

## PHASE 0 — INPUT VALIDATION (already done server-side; do not re-validate)

${hasFrontCover ? `## PHASE 0.5 — SAME-BOOK VERIFICATION (do this FIRST, before any grading)
You are given the FULL FRONT COVER of the book that was originally assessed (labeled "FULL FRONT COVER of the book being graded"). The 4 corner macros must be close-ups of THIS SAME physical book's four corners. Before grading, confirm they belong together:
  • Compare each corner macro against the CORRESPONDING corner region of that front cover — Top-Left macro vs the cover's top-left, Top-Right vs top-right, and so on.
  • The artwork, colors, border treatment, and any logo/title/text fragments visible in a macro must be reconcilable with that region of the front cover — allowing for the fact that a macro is an extreme close-up crop and shows only a small area.
  • Set "sameBook": false ONLY if you are HIGHLY CONFIDENT that one or more macros are a DIFFERENT comic — e.g. clearly different cover artwork, a different title logo, or colors that plainly cannot belong to that region of the front cover. When you set it false, write a single buyer-facing sentence in "mismatchReason" and STOP — do not fabricate a grade or defects.
  • DEFAULT TO "sameBook": true. If a macro is too tight or too plain to identify (e.g. a blank white-border corner), if the macro is merely blurry or low quality, or if you are at all uncertain, treat the book as the SAME and proceed to grade normally. Do NOT flag a mismatch on ambiguity — only on clear, confident evidence of a genuinely different book. A false mismatch wrongly blocks a paying customer, so the bar is high.

` : ''}## PHASE 1 — INSPECT TOP CORNER MACROS (TL, TR)
Look at the Top-Left and Top-Right corner macros provided. Compare against the initial defect catalogue for those corners. Look specifically for:
  • Color-breaking creases visible at macro resolution that wouldn't appear in the wide shot
  • Small chip-outs, piece losses, or paper losses
  • Spine ticks at the top of the spine (TL macro shows them best — they are 1-3mm white marks along the spine edge where ink is stressed)
  • Edge wear, edge tears, or small color breaks along the top edge
  • Foxing, rust marks, or staining not previously catalogued

STRUCTURAL DAMAGE SCAN — DO FIRST on each macro before color-break analysis.
The corner macros are the highest-resolution view you have; structural
defects that escaped the wide shots are most likely to appear here.

  CHECK 1 — TAPE. THE DECISIVE TEST IS GEOMETRY: tape has STRAIGHT, PARALLEL, MACHINE-CUT edges; damage does not. In the macros, look at the inner edge (spine side) and any portion of the spine visible at the corner. A band bounded by a ruler-straight line, running continuously, with a smoother surface than surrounding paper — TAPE, not stress lines, not creases, not soiling. Aged tape may also show regular horizontal cracks. Straight edge overrides every other interpretation.

  CHECK 2 — PAPER LOSS / MISSING PIECE. Three tells, any one confirms it: (a) the cover silhouette is broken — a chunk of the corner outline is absent, with a jagged torn edge; (b) within the cover, printed artwork ends at a hard ragged line and beyond it a mismatched field is visible (interior page showing through a hole); (c) BROKEN PRINTED SHAPES — a known regular shape on the cover is no longer regular, OR a printed letter is incomplete (a circle with a jagged bite, a logo with a ragged interruption, an H missing its right vertical). Comics are printed mechanically; any irregular interruption of a regular printed shape is paper that has torn off. Not blunting, not edge wear, not soiling.

  CHECK 3 — TEARS, especially at the inner-corner-at-spine and along the spine edge visible in the macro. A tear is a discontinuity where paper is split but not yet missing — sides still attached at one end. Thin dark line, visible split, section angled differently from the surrounding flat area. Tears > 1/2" are HIGH severity.

  CHECK 4 — RUST. Orange-brown staining originating at a staple and bleeding into surrounding paper, OR a staple that is brown rather than silver. Even light rust is named "rust" (never "oxidation") and is a Spine-category defect.

If any CHECK finds something not in the initial catalogue, add it as a deepAddition defect in Phase 3 with appropriate severity. Do not let pattern-matching to common defect categories (creases, edge wear, stress lines, soiling) obscure these structural defects.

Color-break detection technique: a color break is a small region — often only a few pixels wide — where ink that normally covers the page is absent, exposing white/grey paper beneath. Scan dark saturated areas (deep colors) for small white or grey patches that interrupt the color.

## PHASE 2 — INSPECT BOTTOM CORNER MACROS (BL, BR)
Same inspection on Bottom-Left and Bottom-Right corner macros. The BL macro also shows the bottom of the spine — examine for spine ticks at the bottom third.

${hasInteriorCovers ? `## PHASE 2.5 — INSPECT INTERIOR COVERS (Interior Front, Interior Back)
Two interior-cover photos are provided: the inside front cover + first page, and the last page + inside back cover. Examine them ONLY for interior-cover CONDITION:
  • Tanning / toning of the inside covers and the first/last pages (browning of the paper)
  • Foxing (small brown spots), stains, or moisture marks
  • Tears, chips, or writing on the inside covers / first-last pages
Report only what is actually visible. If the interior covers are clean, say nothing and leave the Interior sub-score unchanged. Do NOT judge page quality here — page quality is FIXED from the initial assessment and must not change. Staples are NOT interior — any staple observation stays in the Spine category.

` : ''}## PHASE 3 — APPLY DELTAS TO FRONT${hasInteriorCovers ? ', SPINE, AND INTERIOR' : ' AND SPINE'}
For each new defect observed that was NOT in the initial catalogue, add a defect entry tagged with deepAddition: true. Adjust scores accordingly:
  • Front sub-score: deduct for new front-cover defects (corner damage, color breaks on cover, etc.)
  • Spine sub-score: deduct for new spine ticks (1 point per non-color-breaking, 2 per color-breaking) or inner-corner-at-spine damage
  • BACK sub-score: FROZEN. Do not change. No new back-cover evidence.
  • ${hasInteriorCovers ? 'INTERIOR sub-score: adjust ONLY for interior-cover CONDITION actually visible in the two interior-cover photos (tanning, foxing, stains, tears). Deduct for genuine interior defects; if the interior covers are clean, leave it unchanged. Do NOT change page quality — it is fixed from the initial assessment.' : 'INTERIOR sub-score: FROZEN. Do not change. No new interior evidence.'}

If the macros REVEAL a new defect not in the initial catalogue (corner damage, spine ticks, tape, color breaks visible only at macro scale), add defect entries with deepAddition: true and adjust Front and Spine sub-scores downward accordingly. The revised grade may go BELOW the initial when new defects are found.

If the macros CONFIRM the initial assessment — meaning everything visible was already catalogued — then consider whether the corners support the current score or suggest the book is at the HIGH or LOW end of its initial precision range. The initial assessment had a wide precision range (±6 to ±12). You now have close-up evidence of all four corners. If the corners are CLEANER than expected for the initial grade — crisp, tight, no hidden defects — the Front sub-score may be RAISED by 1–3 points. If the corners are WORSE than implied by the initial catalogue — e.g. soft with rounding not visible at full scale — the Front sub-score may be LOWERED by 1–3 points (tag the observation as deepAddition: true). If they're exactly as expected, leave scores unchanged.

The confidenceRange for a Deep assessment is the integer 3 (representing ±3 on the 0-100 score scale). Do not narrow below 3; the score ceiling of 97 already encodes the residual uncertainty.

${PHOTOGRADER_RUBRIC_CLOSEUP}

## PHASE 4 — CONFIRM THE REVISED GRADE AGAINST GRADE-REFERENCE IMAGES
Recompute the RoboGrade score (Front + Back + Spine + Interior) and map it to a CGC grade. You are also given a set of GRADE-REFERENCE IMAGES — real graded comics bracketing the initial grade, each labeled with its CGC grade and a one-line condition note, in ascending order. Use them as a calibrated yardstick:
  • Find the reference whose OVERALL cover condition the book being graded most closely matches.
  • The predicted grade may move UP or DOWN by up to 2 grade positions from the initial, based on that comparison. Downward movement is the more common outcome when the macros surfaced new defects; upward movement requires the cover to clearly match a cleaner reference.
  • Also read the candidate grade's tier definition plus one grade above and one below to confirm the fit.
  • NEVER name, number, identify, or describe any specific reference comic in your output. The references are an internal yardstick only. If the grade is revised, aiAssessment may say it was "compared against reference copies at the same grade and revised" — nothing more specific.

CGC TIER REFERENCE (candidate ±1, focused on initial grade):
${gradeTierContext(initialGrade)}

PAGE QUALITY SEVERITY — HARD RULE: any defect entry whose type is "Page quality" (or which describes page color, tanning designation, or paper tone) gets severity="" (empty string). Page quality is a descriptive observation, NOT a defect. Low/Med/High severity tags apply ONLY to actual defects.

INTERIOR CATEGORY SCOPE — HARD RULE: the Interior category is for PAGE CONDITION ONLY — page quality, interior printing, interior tears, interior tanning, foxing on pages. Staples are NOT Interior. Staple condition, staple rust, staple-area tears, and any staple observation go in the SPINE category. Do not put staple entries in Interior. Do not include "staples appear intact" or any other non-defect observation; if there is no staple defect, say nothing about staples.

## RESPONSE FORMAT — STRICT
Your entire response must be a JSON object and nothing else. The first character of your response must be the literal opening curly brace. The last character must be the literal closing curly brace. Do not write any text before the JSON. The phases above are your internal process; they do not appear in the response.

JSON shape (same as initial assessment, with deepAddition tags on new defects):
{
  "gateResult": "COMIC",
  "sameBook": true,
  "mismatchReason": "",
  "title": "${initialAssessment.title || ''}",
  "issue": "${initialAssessment.issue || ''}",
  "issueDate": "${initialAssessment.issueDate || ''}",
  "publisher": "${initialAssessment.publisher || ''}",
  "printing": "${initialAssessment.printing || ''}",
  "pageQuality": "${initialAssessment.pageQuality || ''}",
  "grade": "revised CGC grade",
  "aiAssessment": ${JSON.stringify(initialAssessment.aiAssessment || '')},
  "deepAssessment": "<S20: a SEPARATE, concise buyer-facing write-up of ONLY what THIS Deep Assessment observed — from the corner macros, the interior-cover photos (if provided), and the grade-reference comparison. Cover: any new corner/edge/spine defects found at macro scale; interior-cover condition (tanning/foxing/stains) if covers were provided; and whether the grade was confirmed or revised and why. 2-4 sentences. Do NOT repeat the initial Condition Assessment text above — only the new Deep observations. If the close-ups simply confirmed the initial grade, say that plainly.>",
  "labelNotes": "${initialAssessment.labelNotes || ''}",
  "keyInfo": "${initialAssessment.keyInfo || ''}",
  "enhance": ${initialAssessment.enhance == null ? 'null' : JSON.stringify(initialAssessment.enhance)},
  "labelDetected": ${initialAssessment.labelDetected ? 'true' : 'false'},
  "deepAssessmentRan": true,
  "roboGrade": {
    "version": "${ROBOGRADE_VERSION}",
    "score": 0,
    "confidenceRange": 3,
    "frontScore": 0,
    "backScore": ${initialRG.backScore == null ? 'null' : initialRG.backScore},
    "spineScore": 0,
    "interiorScore": ${hasInteriorCovers ? 0 : (initialRG.interiorScore == null ? 'null' : initialRG.interiorScore)},
    "pageQuality": "${initialRG.pageQuality || ''}",
    "defects": [
      {"type":"","location":"","measurement":"","severity":"Med","colorBreaking":false,"category":"Front","deepAddition":false}
    ]
  },
  "photograder": { "focus": "A", "lighting": "A", "flags": [ {"category":"focus","image":"Top-Left Corner","note":"blurry"} ] }
}

HARD OUTPUT LIMITS:
  • defects array: MAX 10 entries (initial + new deep additions combined)
  • aiAssessment: preserved initial text + exactly ONE appended confirm/alter sentence
`;

  // ── S16: Restoration Check prompt (mode==='restoration') ────────────────────
  // Examines 7 images for restoration indicators. 6 are shared with Full
  // Assessment; UV Front is unique. Each image has specific examination focus
  // distinct from the Full Assessment prompt (which mentions restoration only
  // when signs are apparent; Restoration Check states either way).
  const restorationPrompt = `You are performing a RESTORATION CHECK on a vintage comic book. You are NOT grading it. You are examining 7 photos for physical indicators that the book may have been restored, and reporting them with care. No conclusive determination can be made from photos alone, but you should note visible indications that are consistent with restoration, or note the absence of such indications.

You are given exactly 8 images, in this order:
1. UV FRONT — the FRONT COVER photographed under ULTRAVIOLET (blacklight) illumination in a dark room.
2. UV BACK — the BACK COVER photographed under ULTRAVIOLET (blacklight) illumination in a dark room.
3. EXTERIOR TOP STAPLE — close-up of the top staple from OUTSIDE the spine.
4. EXTERIOR BOTTOM STAPLE — close-up of the bottom staple from OUTSIDE the spine.
5. OUTER EDGE — the outer edge of the book (opposite the spine).
6. INTERIOR FRONT — inside front cover and first page (2-page spread).
7. INTERIOR BACK — last page and inside back cover (2-page spread).
8. INTERIOR STAPLES — both staples from INSIDE the centerfold.

WHAT TO EXAMINE IN EACH IMAGE:

UV FRONT & UV BACK (Images 1-2):
CRITICAL — UV VERIFICATION FIRST: Before evaluating for color touch, confirm EACH UV image was ACTUALLY taken under UV light in a DARK environment with NO ambient room lighting. Genuine UV photos have ALL of these characteristics: (1) a deep blue-violet cast over the entire image, (2) fluorescing bright spots where optical brighteners glow vivid white-blue (modern paper, CGC/PSA labels, and case plastic fluoresce strongly), (3) dark surroundings with no warm/white ambient light visible, and (4) original period inks showing muted, relatively uniform fluorescence while any added modern materials fluoresce at a distinctly different intensity or color.
- If EITHER image is NOT under UV light (normal daylight/indoor color, no blue-violet cast, or significant ambient light visible): set "uvLightPresent": false for that image. Continue examining the other images, but note that color touch cannot be evaluated on the affected cover because the image is inadequate.
- If it IS under UV light in a dark environment: set "uvLightPresent": true. Under UV, ADDED INK (color touch, over-painting) typically FLUORESCES DIFFERENTLY from the original printing — it appears as patches with distinctly different intensity or color from surrounding original ink. If no signs of color touch are apparent, say so. If there are patches of color touch apparent, indicate where they are.
- Examine both front AND back covers for color touch. Restoration is sometimes performed on back covers as well as fronts.

EXTERIOR TOP STAPLE & EXTERIOR BOTTOM STAPLE (Images 3-4):
Look specifically for signs that the staples have been REMOVED and REPLACED — this is a common step in professional restoration where the book is disassembled for cleaning, leaf-casting, or pressing, then re-assembled with new staples. Signs include: staples that look too clean/shiny for the book's age, wrong gauge or style for the era, additional staple holes visible near the current ones, bent legs that show tool marks rather than original factory crimping, or staple crowns that sit differently from original placement. State whether there IS or IS NOT indication of staple replacement or removal.

OUTER EDGE (Image 5):
Look specifically for signs of TRIMMING — where the edge has been cut to remove wear, fraying, or foxing. Signs include: an unnaturally clean or straight edge, fresh-cut appearance on old paper, reduced page margins compared to what's expected for the title/era, or edges that are suspiciously uniform when the rest of the book shows wear. Trimming is difficult to detect reliably — only mention it with reasonable confidence. State whether there IS or IS NOT indication of trimming.

INTERIOR FRONT & INTERIOR BACK (Images 6-7):
Look for LEAF-CASTING (added paper pulp filling losses — visible as patches with different paper texture or thickness), REINFORCEMENT (added backing material, glue sheen, visible fibers that don't match the original paper), or COLOR TOUCH bleed-through (ink or pigment visible from the back of the cover paper indicating color was added to the front). State whether there IS or IS NOT indication of these restoration techniques.

INTERIOR STAPLES (Image 8):
Look for the same staple replacement/removal signs as Images 3-4, but from the inside. Interior views often reveal: re-bent staple legs with tool marks, evidence of staple holes that have been punched through rather than pressed through during original assembly, or staple-crown-to-paper contact patterns inconsistent with factory production. State whether there IS or IS NOT indication of staple replacement or removal.

OVERALL APPROACH:
- For each area examined, STATE either way whether restoration indicators are or are not apparent.
- Tread carefully — no conclusive determination. Phrase findings as observations: "Visible indications consistent with..." or "No visible indications suggesting..."
- If indicators are observed with HIGH CONFIDENCE (clear color touch under UV, clear reinforcement, clear staple replacement), set "indicatorsObserved": true and "highConfidence": true.
- If indicators are observed but with lower confidence, set "indicatorsObserved": true and "highConfidence": false.
- If no indicators are observed in any area, set "indicatorsObserved": false.

## RESPONSE FORMAT — STRICT
Your entire response must be a JSON object and nothing else.

JSON shape:
{
  "restorationCheckRan": true,
  "uvLightPresent": true | false,
  "uvCheckFailed": true | false,
  "indicatorsObserved": true | false,
  "highConfidence": true | false,
  "restorationReport": "<concise summary, ≤120 words — state UV result, then one sentence per area examined (staples, edge, interior, interior staples). End with overall conclusion. Do NOT describe what each image type is for or what you looked for — only state what you found or did not find.>",
  "findings": [
    { "area": "uv_front | uv_back | exterior_top_staple | exterior_bottom_staple | outer_edge | interior_front | interior_back | interior_staple", "observation": "<concise, ≤25 words>", "indicatorPresent": true | false }
  ]
}

Rules:
- If uvLightPresent is false for either UV image, set uvCheckFailed true for that image. Still examine all other images and report findings.
- Include a finding entry for EVERY area examined (all 8 if both UVs are good, fewer only if UV images are inadequate).
- NEVER assert a definitive restoration verdict. Report observations and visible indications only.
- Do not mention internal references or priors. Report only what these images show.
`;

  const activePrompt = isRestoration ? restorationPrompt : systemPrompt;

  try {
    markPhase('promptAssemblyAtMs');
    const _primaryStart = Date.now();

    // SSE phase 0: input validation done, about to call Anthropic.
    sseEvent('phase', { phase: 0, name: 'populating' });

    // ── S19: GRADE-REFERENCE COMPARISON (deep mode only) ──────────────────────
    // Fetch the reference images bracketing the initial predicted grade (±2
    // positions on the CGC scale) and pair each with its condition caption, so
    // the model confirms or revises the grade against real graded examples.
    // Reference book identities are NEVER named in output. Non-fatal: if refs
    // can't be built, Deep still runs on the macros alone.
    let gradeRefBlocks = [];   // ascending-grade [text label, image, text label, image, ...]
    let frontCoverBlock = null;
    if (!isRestoration) {
      try {
        const { CGC_GRADE_SCALE, GRADE_DEFINITIONS } = await import('../lib/grade_definitions.js');
        const gNum = parseFloat((String(initialGrade).match(/\d+(\.\d+)?/) || [])[0]);
        if (Number.isFinite(gNum)) {
          let idx = 0, best = Infinity;
          CGC_GRADE_SCALE.forEach((g, i) => {
            const d = Math.abs(parseFloat(g) - gNum);
            if (d < best) { best = d; idx = i; }
          });
          const lo = Math.max(0, idx - 2), hi = Math.min(CGC_GRADE_SCALE.length - 1, idx + 2);
          const windowGrades = CGC_GRADE_SCALE.slice(lo, hi + 1);  // up to 5, ascending
          const baseUrl = process.env.APP_URL || 'https://robograder.app';
          const fetched = await Promise.all(windowGrades.map(async (g) => {
            const def = GRADE_DEFINITIONS[g] || {};
            const file = def.file || (g.replace('.', '_') + '.jpg');
            try {
              const r = await fetch(`${baseUrl}/Grade_Reference/${file}`);
              if (!r.ok) return null;
              const data = Buffer.from(await r.arrayBuffer()).toString('base64');
              return { g, def, data };
            } catch { return null; }
          }));
          for (const f of fetched) {
            if (!f) continue;
            const parts = [`CGC ${f.g}${f.def.name ? ' — ' + f.def.name : ''}`];
            if (f.def.definition) parts.push(f.def.definition);
            if (f.def.caption) parts.push(`Reference example shown: ${f.def.caption}`);
            gradeRefBlocks.push({ type: 'text', text: parts.join(' ') });
            gradeRefBlocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
          }
        }
      } catch { gradeRefBlocks = []; }
      if (frontCover) { const fb = toImageBlock(frontCover); if (fb) frontCoverBlock = fb; }
    }
    const hasGradeRefs = gradeRefBlocks.length > 0;

    const _antBody = {
      model: 'claude-opus-4-8',
      // S15 May 29: effort=medium via output_config + adaptive thinking
      // enabled. See assess.js for full rationale comments — same setup here.
      // Thinking helps the calibration step (defects → grade); medium scopes
      // its depth. Parser at line ~456 handles thinking blocks correctly.
      output_config: { effort: 'medium' },
      thinking: { type: 'adaptive' },
      // S15 May 29: bumped 2048 → 8192. Thinking tokens count toward
      // max_tokens. Deep's JSON output is smaller than initial (it's a
      // refinement, not a full assessment), so 8k headroom is appropriate.
      max_tokens: 8192,
      system: activePrompt,
      messages: [{
        role: 'user',
        content: isRestoration
          ? [
              { type: 'text', text: 'RESTORATION CHECK IMAGES in order: (1) UV Front, (2) UV Back, (3) Exterior Top Staple, (4) Exterior Bottom Staple, (5) Outer Edge, (6) Interior Front, (7) Interior Back, (8) Interior Staples.' },
              ...macroBlocks,
              { type: 'text', text: 'First verify Images 1 and 2 are genuinely under UV light. Then examine all 8 images for restoration indicators. For each area, state whether indicators are or are not present. Return the JSON.' }
            ]
          : [
              { type: 'text', text: 'CORNER MACROS in order: Top-Left, Top-Right, Bottom-Left, Bottom-Right of the front cover.' },
              ...macroBlocks,
              ...(hasInteriorCovers ? [{ type: 'text', text: 'INTERIOR COVER PHOTOS in order: (1) Interior Front — inside front cover + first page; (2) Interior Back — last page + inside back cover. Examine ONLY for interior-cover condition (tanning, foxing, stains, tears) per PHASE 2.5. Do not re-judge page quality.' }, ...interiorCoverBlocks] : []),
              ...(frontCoverBlock ? [{ type: 'text', text: 'FULL FRONT COVER of the book being graded:' }, frontCoverBlock] : []),
              ...(hasGradeRefs ? [{ type: 'text', text: 'GRADE-REFERENCE IMAGES follow — real graded comics bracketing the initial grade, each labeled with its CGC grade and condition note, in ascending grade order. Compare the book above against these examples (PHASE 4).' }, ...gradeRefBlocks] : []),
              { type: 'text', text: 'Perform the deep assessment. If the macros reveal new defects, the grade may go down — tag them deepAddition: true. If the corners are cleaner than expected for the initial grade, the Front sub-score may rise by 1–3 points. Compare the book against the grade-reference images and confirm or revise the predicted grade per PHASE 4. Return the JSON.' }
            ]
      }]
    };

    let text;
    let _inputTokens = null, _outputTokens = null, _cacheReadInputTokens = null;
    let _cacheCreationInputTokens = null, _stopReason = null, _responseModel = null;

    if (wantsSSE) {
      _antBody.stream = true;
      const ctrl = new AbortController();
      const _streamTimeout = setTimeout(() => ctrl.abort(), 55000);

      let streamResponse;
      try {
        streamResponse = await anthropicWithRetry(
          () => fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(_antBody),
            signal: ctrl.signal
          }),
          { deadlineMs: 55000, maxAttempts: 3, label: 'deep-stream' }
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

      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      const phasesEmitted = new Set();
      let firstTokenSeen = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
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
              if (!phasesEmitted.has(1)) { sseEvent('phase', { phase: 1, name: 'mint' }); phasesEmitted.add(1); }
            }
            accumulated += chunk;
            // Field markers: same scan as standard assess.js
            if (!phasesEmitted.has(2) && accumulated.includes('"pageQuality"')) {
              sseEvent('phase', { phase: 2, name: 'pq' }); phasesEmitted.add(2);
            }
            if (!phasesEmitted.has(3) && accumulated.includes('"grade"')) {
              sseEvent('phase', { phase: 3, name: 'grading' }); phasesEmitted.add(3);
            }
            if (!phasesEmitted.has(4) && accumulated.includes('"roboGrade"')) {
              sseEvent('phase', { phase: 4, name: 'confirming' }); phasesEmitted.add(4);
            }
          } else if (t === 'message_start' && parsedEvt.message) {
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

      // Safety net: emit any unfired phases before close so the modal can complete.
      for (const [p, n] of [[1,'mint'],[2,'pq'],[3,'grading'],[4,'confirming']]) {
        if (!phasesEmitted.has(p)) { sseEvent('phase', { phase: p, name: n }); phasesEmitted.add(p); }
      }
    } else {
      // Non-streaming branch: single-shot
      const ctrl = new AbortController();
      const _to = setTimeout(() => ctrl.abort(), 55000);
      let response;
      try {
        response = await anthropicWithRetry(
          () => fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(_antBody),
            signal: ctrl.signal
          }),
          { deadlineMs: 55000, maxAttempts: 3, label: 'deep' }
        );
      } finally {
        clearTimeout(_to);
      }
      phaseDelta('primaryCallMs', _primaryStart);
      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: 'Anthropic API error: ' + err, _diagnostics: { phaseTimings, primaryNotOk: true } });
      }
      const data = await response.json();
      const _usage = (data && data.usage) || {};
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

    let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const _fb = clean.indexOf('{'), _lb = clean.lastIndexOf('}');
    if (_fb !== -1 && _lb !== -1 && (_fb > 0 || _lb < clean.length - 1)) clean = clean.slice(_fb, _lb + 1);

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) {
      if (wantsSSE) {
        sseEvent('error', { error: 'Failed to parse deep response: ' + (text || '').slice(0, 500), _diagnostics: { phaseTimings, parseError: true } });
        try { res.end(); } catch (err) {}
        return;
      }
      return res.status(500).json({ error: 'Failed to parse deep response: ' + text, _diagnostics: { phaseTimings, parseError: true } });
    }
    phaseDelta('primaryParseMs', _primaryParseStart);

    // ── S20 (#44): SAME-BOOK GATE ────────────────────────────────────────────
    // Only when the client supplied the Main front-cover anchor AND the model is
    // highly confident the corner macros are a DIFFERENT book. Returns a gate
    // (not a grade), so assessHighGrade() charges no credit and shows the "+1"
    // refund preview. Excluded from abuse strikes client-side (innocent mix-up).
    if (!isRestoration && hasFrontCover && parsed && parsed.sameBook === false) {
      const mismatch = {
        gateResult: 'IMAGE_MISMATCH',
        gateReason: (typeof parsed.mismatchReason === 'string' && parsed.mismatchReason.trim())
          ? parsed.mismatchReason.trim()
          : "The Deep Assessment close-ups don't appear to be the same comic as the one you assessed. Re-take the corner and interior photos of that book and try again.",
        _diagnostics: { deepAssessment: true, imageMismatch: true, initialGrade: initialAssessment.grade || null, phaseTimings }
      };
      phaseTimings.totalMs = Date.now() - T0;
      try {
        const db = await getAdminDb();
        if (db) {
          const key = `deep_mismatch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          await db.collection('assessment_timings').doc(key).set({
            createdAt: new Date().toISOString(),
            totalMs: phaseTimings.totalMs,
            phases: phaseTimings,
            version: ROBOGRADE_VERSION,
            model: 'claude-opus-4-8',
            deepAssessment: true,
            gateResult: 'IMAGE_MISMATCH',
            imageMismatch: true,
            costUsd: 0,
            inputTokens: _inputTokens,
            outputTokens: _outputTokens,
            title: parsed.title || title || null,
            issue: parsed.issue || issueNumber || null,
            timedOut: false
          });
        }
      } catch (e) { console.error('deep mismatch timing write failed (non-fatal):', e); }
      if (wantsSSE) { sseEvent('result', mismatch); try { res.end(); } catch (e) {} return; }
      return res.status(200).json(mismatch);
    }

    // Normalize grade format
    if (parsed.grade && !String(parsed.grade).includes('.')) {
      parsed.grade = parseFloat(parsed.grade).toFixed(1);
    }

    // Carry-forward enforcement: Back and Interior sub-scores must equal initial values.
    if (parsed.roboGrade) {
      if (initialRG.backScore != null) parsed.roboGrade.backScore = initialRG.backScore;
      if (initialRG.interiorScore != null) parsed.roboGrade.interiorScore = initialRG.interiorScore;
      // Recompute total score from components, in case the model didn't.
      // Clamp each to its valid range first — the Deep model occasionally emits
      // an over-range component (e.g. front 51) which would inflate the sum.
      const _cl = (n, hi) => Math.max(0, Math.min(hi, Math.round(Number(n) || 0)));
      const f = _cl(parsed.roboGrade.frontScore, 50);
      const b = _cl(parsed.roboGrade.backScore, 20);
      const s = _cl(parsed.roboGrade.spineScore, 20);
      const i = _cl(parsed.roboGrade.interiorScore, 10);
      parsed.roboGrade.frontScore = f;
      parsed.roboGrade.backScore = b;
      parsed.roboGrade.spineScore = s;
      parsed.roboGrade.interiorScore = i;
      parsed.roboGrade.score = f + b + s + i;
      parsed.roboGrade.version = ROBOGRADE_VERSION;
      // S21: the score ceiling is now 100 − PM (applied below after Photograder
      // is computed), replacing the old fixed 97. Photo quality drives it.
    }

    // S15 May 30: the floor rule and grade-stamp logic below are DEEP-only.
    // Restoration mode produces a restorationReport, not a grade, so skip them.
    if (!isRestoration) {
      // FLOOR RULE: revised grade may not go BELOW the initial unless the model
      // explicitly flagged a new defect. If no defect entry has deepAddition: true
      // and the revised grade is lower, restore the initial grade and sub-scores.
      const hasDeepAddition = Array.isArray(parsed.roboGrade?.defects)
        && parsed.roboGrade.defects.some(d => d && d.deepAddition === true);
      if (!hasDeepAddition && initialRG && initialRG.score != null && parsed.roboGrade) {
        if ((Number(parsed.roboGrade.score) || 0) < Number(initialRG.score)) {
          parsed.roboGrade.score = initialRG.score;
          parsed.roboGrade.frontScore = initialRG.frontScore;
          parsed.roboGrade.spineScore = initialRG.spineScore;
          parsed.grade = initialAssessment.grade || parsed.grade;
        }
      }
      // S21 Photograder: merge this pass's Focus/Lighting into the running record
      // (Cropping/Angle carry from Main), compute the PM with the monotonic clamp
      // against the prior tier's PM, and use it for the ± and the score ceiling.
      const _priorPG = initialAssessment.photograder || null;
      const _priorPM = (initialRG && typeof initialRG.confidenceRange === 'number') ? initialRG.confidenceRange : null;
      const _mergedPG = mergePhotograder(_priorPG, parsed.photograder);
      const _deepPM = computePhotograderPM(_mergedPG, 'deep', !!initialAssessment.labelDetected, _priorPM);
      _mergedPG.pm = _deepPM;
      _mergedPG.tier = 'deep';
      parsed.photograder = _mergedPG;
      if (parsed.roboGrade) {
        const _ceil = 100 - _deepPM;
        if (typeof parsed.roboGrade.score === 'number' && parsed.roboGrade.score > _ceil) parsed.roboGrade.score = _ceil;
        parsed.roboGrade.confidenceRange = _deepPM;
      }
      parsed.deepAssessmentRan = true;
    } else {
      parsed.restorationCheckRan = true;
    }
    parsed._diagnostics = {
      deepAssessment: !isRestoration,
      restorationCheck: isRestoration,
      initialGrade: initialAssessment.grade || null,
      revisedGrade: parsed.grade || null,
      gradeChanged: (initialAssessment.grade || null) !== (parsed.grade || null),
      phaseTimings: phaseTimings
    };

    phaseTimings.totalMs = Date.now() - T0;
    parsed._diagnostics.phaseTimings = phaseTimings;

    // Fire-and-forget timing record
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `deep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // S20 (#33): return the log's doc key so the client persists it on the
        // item (assessmentTimingKeys) — the bridge for admin Logs → open item.
        parsed._diagnostics.timingKey = key;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          model: 'claude-opus-4-8',
          deepAssessment: true,
          gateResult: parsed.gateResult || 'COMIC',
          predictedGrade: parsed.grade || null,
          initialGrade: initialAssessment.grade || null,
          gradeChanged: (initialAssessment.grade || null) !== (parsed.grade || null),
          inputTokens: _inputTokens,
          outputTokens: _outputTokens,
          cacheReadInputTokens: _cacheReadInputTokens,
          cacheCreationInputTokens: _cacheCreationInputTokens,
          // S15 May 28: per-assessment dollar cost (Opus 4.8). Same rate
          // block as assess.js — if model changes, update both.
          costUsd: (function(){
            const RATE_IN  = 5  / 1e6;
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
          defectCount: Array.isArray(parsed.roboGrade?.defects) ? parsed.roboGrade.defects.length : null,
          imageCount: macroBlocks.length,
          title: parsed.title || title || null,
          issue: parsed.issue || issueNumber || null,
          rawText: typeof text === 'string' ? text.slice(0, 8000) : null,
          timedOut: false
        });
      }
    } catch (e) {
      console.error('deep timing write failed (non-fatal):', e);
    }

    if (wantsSSE) {
      sseEvent('result', parsed);
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(200).json(parsed);
  } catch (err) {
    phaseTimings.totalMs = Date.now() - T0;
    phaseTimings.errorAtMs = phaseTimings.totalMs;
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `deep_err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          model: 'claude-opus-4-8',
          deepAssessment: true,
          imageCount: macroBlocks.length,
          costUsd: 0,
          errorMessage: String(err.message || err).slice(0, 500),
          timedOut: /timeout|abort/i.test(String(err.message || err))
        });
      }
    } catch (e) {
      console.error('deep err timing write failed (non-fatal):', e);
    }
    if (wantsSSE) {
      sseEvent('error', { error: err.message, _diagnostics: { phaseTimings } });
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(500).json({ error: err.message, _diagnostics: { phaseTimings } });
  }
}
