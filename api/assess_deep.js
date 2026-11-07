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
import { ROBOGRADE_VERSION, GRADING_EPOCH } from '../lib/version.js';
import { PRIMARY_MODEL, ratesFor, costOf } from '../lib/model.js';
import { anthropicWithRetry } from '../lib/anthropic_retry.js';
import { computeScoreCeilingPenalty, mergePhotograder, PHOTOGRADER_RUBRIC_CLOSEUP } from '../lib/photograder.js';
import { enforceCgcGrade } from '../lib/grade_definitions.js';
import { buildDeepPrefix, deepVariantName } from '../lib/deep_prompt.js';
import { createHash as _deepCreateHash } from 'crypto';
import { getAdminDb as getCreditDb, verifyUidFromAuthHeader } from '../lib/batch_common.js';
import { reserveCredit, refundCredit, insufficientCreditsPayload } from '../lib/credits.js';

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
  // S22: the same config/caching doc api/assess.js and api/cachewarm.js read.
  // `types.deep` is a separate chip from `types.main` — Main's caching is proven
  // and should not be hostage to a Deep experiment, and vice versa. Fails OPEN
  // to OFF: if the read throws, Deep behaves exactly as it did before S22.
  async function readDeepCachingCfg() {
    const out = { deepOn: false, ttl: '1h', source: 'default-off' };
    try {
      const _db = await getAdminDb();
      if (!_db) return out;
      const snap = await _db.collection('config').doc('caching').get();
      if (!snap.exists) return { ...out, source: 'no-doc' };
      const d = snap.data() || {};
      const t = d.types;
      out.deepOn = !!(t && t.deep === true);
      out.ttl = d.ttl === '5m' ? '5m' : '1h';
      out.source = 'config/caching';
    } catch (e) {
      out.source = 'read-failed: ' + String(e && e.message || e);
    }
    return out;
  }

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
    // S22: UV CHECK mode (mode==='restoration', name kept so stored fields and
    // old clients keep working). Folded into this endpoint rather than a 13th
    // Vercel function — we are at the 12/12 cap.
    //
    // It now takes exactly TWO images: [UV Front, UV Back] — the two the old
    // Restoration Check already required a blacklight for — and answers ONE
    // question: is there ink on these covers that fluoresces differently from
    // the rest of the ink? That is color touch, and it is the only restoration
    // indicator no other pass can see. The other SIX images that check took
    // were ordinary-light shots (exterior staples x2, outer edge, interior
    // front/back, interior staples), all already examined by Main / Deep /
    // Full, which flag restoration on their own at no charge.
    //
    // The UV Check is FREE to the user, so this prompt is deliberately short.
    mode = 'deep',
    restorationImages = [],      // 2 images for UV Check mode: UV Front, UV Back
    itemId = '',                 // S22: the book, so the UV allowance can be checked server-side
    // S22: the ComicVine cover URL already stored on the item by the Main pass.
    // Used ONLY as a fallback when this issue has no curated reference_covers/
    // entry (<10% of books have one). Costs no lookup — Main already resolved it.
    referenceImageUrl = null
  } = req.body || {};

  const isRestoration = mode === 'restoration';

  if (!initialAssessment || typeof initialAssessment !== 'object') {
    return sseError(400, { error: 'initialAssessment required' });
  }

  // ── AUTH + SERVER-SIDE CREDIT FLOOR (S22, note 9646) ─────────────────────
  // Until S22 this endpoint did not verify the caller AT ALL. It accepted
  // Authorization in the CORS header list and then never read it, so anyone who
  // could POST here got a paid Opus Deep with no account and no balance. Both
  // halves are fixed now: identify the caller, then check they can pay.
  //
  // The UV Check (mode 'restoration') is FREE, so it still requires a signed-in
  // user but costs nothing. Batch passes are pre-paid by assess_batch_start.js,
  // which already took 3 credits in a transaction — charging again here would
  // bill a batch twice, so they are exempt.
  const _isBatchPass = (req.body && req.body.cacheProfile) === 'batch';
  const _CREDIT_COST = (isRestoration || _isBatchPass) ? 0 : 1;
  const _deepUid = await verifyUidFromAuthHeader(req);
  if (!_deepUid) return sseError(401, { error: 'auth required' });
  // ── S22: UV CHECK ALLOWANCE, SERVER-SIDE ────────────────────────────────
  // Three free UV Checks per book, reset by any paid assessment on it. The
  // client hides the button at zero, but the whole reason this tier is free is
  // that it costs the user nothing to call — so a client-only limit is not a
  // limit. Counted from the STORED item, never from the number the client sends.
  //
  // Fails OPEN when the item cannot be read: a book assessed but not yet saved
  // has no doc to count against, and refusing there would block the first
  // legitimate UV Check on a brand-new book. The window is small and the call is
  // the cheapest in the app (2 images, short prompt).
  if (isRestoration) {
    const UV_CHECK_LIMIT = 3;
    try {
      const _db = await getCreditDb();
      if (_db && itemId) {
        const _snap = await _db.collection('users').doc(_deepUid)
                               .collection('items').doc(String(itemId)).get();
        if (_snap.exists) {
          const _used = Number((_snap.data() || {}).uvCheckRuns);
          if (Number.isFinite(_used) && _used >= UV_CHECK_LIMIT) {
            return sseError(429, {
              error: 'uv_check_limit',
              limit: UV_CHECK_LIMIT,
              used: _used,
              message: `You have used all ${UV_CHECK_LIMIT} free UV Checks on this book. Running another assessment on it resets them.`
            });
          }
        }
      }
    } catch (e) {
      console.error('[uvcheck] FAIL-OPEN: allowance lookup failed —', (e && e.message) || e);
    }
  }

  let _creditDebited = false;
  let _creditsRemaining = null;
  try {
    const _r = await reserveCredit(await getCreditDb(), _deepUid, {
      cost: _CREDIT_COST,
      debit: req.body && req.body.serverCredits === true,
      label: isRestoration ? 'uvcheck' : (_isBatchPass ? 'batchpass' : 'deep')
    });
    _creditDebited = _r.debited;
    _creditsRemaining = _r.remaining;
  } catch (e) {
    if (e && e.code === 'insufficient_credits') {
      return sseError(402, insufficientCreditsPayload(e, _CREDIT_COST));
    }
    console.error('[credits:deep] unexpected reserve failure (continuing):', e);
  }
  async function _refundIfDebited(why) {
    if (!_creditDebited) return;
    _creditDebited = false;
    console.log('[credits:deep] refunding —', why);
    try { await refundCredit(await getCreditDb(), _deepUid, _CREDIT_COST, 'deep'); }
    catch (e) { console.error('[credits:deep] refund threw:', e && e.message); }
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
    if (!Array.isArray(restorationImages) || restorationImages.length !== 2) {
      return sseError(400, { error: 'restorationImages must be an array of 2 (UV Front, UV Back)' });
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
  // S22: the cached half now comes from lib/deep_prompt.js, so the keep-warm
  // ping in api/cachewarm.js and this endpoint build it from ONE source. Two
  // copies of a cached prefix is how Main's ping spent three weeks warming an
  // entry no assessment read. Verified byte-identical to the previous inline
  // template across all four hasFrontCover x hasInteriorCovers combinations
  // before the swap; lib/deep_prompt_check.mjs re-checks the wiring.
  const systemPrompt = buildDeepPrefix({ hasFrontCover, hasInteriorCovers }) + `§§CACHE_SPLIT§§INITIAL ASSESSMENT (authoritative — preserve all fields unless the macros provide explicit reason to change):
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
  "gradeRevisionReason": "<v5.29: a NOTE, not a write-up. MAX 2 SENTENCES and MAX 35 WORDS. Name what moved the grade and which way, nothing else \u2014 no re-listing the defects, no grade arithmetic, no preamble. The user already sees the defect list and the score boxes; this answers only 'why did the number change'. Empty string if it did not move.>",
  "title": "${initialAssessment.title || ''}",
  "issue": "${initialAssessment.issue || ''}",
  "issueDate": "${initialAssessment.issueDate || ''}",
  "publisher": "${initialAssessment.publisher || ''}",
  "printing": "${initialAssessment.printing || ''}",
  "pageQuality": "${initialAssessment.pageQuality || ''}",
  "grade": "revised CGC grade. ONE OF THESE EXACT VALUES AND NOTHING ELSE: 0.5, 1.0, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.2, 9.4, 9.6, 9.8, 9.9, 10.0. This is the complete CGC/PSA scale; there are no values between them. 9.1, 9.3, 9.5 and 9.7 ARE NOT GRADES and no service issues them — above 9.0 the scale steps 9.0, 9.2, 9.4, 9.6, 9.8. If the book sits between two positions, you must choose one; choose the lower unless the evidence clearly supports the higher. DO NOT COPY THE v3 RoboGrade VALUE INTO THIS FIELD. v3 is a different scale — half-points from 0 to 10, where 9.5 is legal. This field is not that scale. Derive it from the defects you observed by grading down from a perfect copy, then state the ladder position that result lands on.",
  "deepAssessment": "<S20: a SEPARATE, concise buyer-facing write-up of ONLY what THIS Deep Assessment observed — from the corner macros, the interior-cover photos (if provided), and the grade-reference comparison. Cover: any new corner/edge/spine defects found at macro scale; interior-cover condition (tanning/foxing/stains) if covers were provided; and whether the grade was confirmed or revised and why. MAX 3 sentences (≤60 words) — be terse. Do NOT repeat the initial Condition Assessment text above — only the new Deep observations. WRITE ONLY WHAT YOU OBSERVED AND WHAT CHANGED: never enumerate what is absent or clean (no "no chips, tears or tape", no "with no color break or staple rust", no "no foxing, stains or tears"). Never describe point deductions or score math in words (no "costing a single interior point", no "minus half a point") — the numbers show in the score boxes. State a removed defect plainly, naming the defect and where the close-ups contradicted it — in your own words, not a stock clause. If the close-ups simply confirmed the initial grade, say that plainly. If you cite a grade, make it the concrete PREDICTED CGC number (e.g. a predicted CGC 9.0) — never a bare number that could read as the 0-10 RoboGrade, and never a vague band like "VF/NM" without the CGC number.>",
  "labelNotes": "${initialAssessment.labelNotes || ''}",
  "keyInfo": "${initialAssessment.keyInfo || ''}",
  "enhance": ${initialAssessment.enhance == null ? 'null' : JSON.stringify(initialAssessment.enhance)},
  "labelDetected": ${initialAssessment.labelDetected ? 'true' : 'false'},
  "deepAssessmentRan": true,
  "roboGrade": {
    "version": "${ROBOGRADE_VERSION}",
    "score": 0,
    "frontScore": 0,
    "backScore": ${initialRG.backScore == null ? 'null' : initialRG.backScore},
    "spineScore": 0,
    "interiorScore": ${hasInteriorCovers ? 0 : (initialRG.interiorScore == null ? 'null' : initialRG.interiorScore)},
    "pageQuality": "${initialRG.pageQuality || ''}",
    "defects": [
      {"type":"","location":"","measurement":"","severity":"Med","colorBreaking":false,"category":"Front","deepAddition":false,"revisionReason":""}
    ],
    "restorationFlags": ${JSON.stringify(Array.isArray(initialRG.restorationFlags) ? initialRG.restorationFlags : [])}
  },
  "photograder": { "focus": "A", "lighting": "A", "flags": [ {"category":"focus","image":"Top-Left Corner","note":"blurry"} ] }
}

RESTORATION (v5.27): restoration is a property of the BOOK, not of any one pass, and the Deep photos see things the cover shots cannot. Carry forward every entry already in restorationFlags above — never drop one — and APPEND anything this pass supports. What a Deep is placed to catch: LEAF CASTING or paper-pulp fill and ADDED/REPLACED PIECES visible from the interior cover (a filled area reads as a patch of paper whose tone, fibre or thickness differs from the sheet around it, often with a visible boundary the printing does not explain); reinforcement or backing material; amber/brown adhesive; an interior cover implausibly clean or bright against genuine age elsewhere. Name the technique when the evidence supports one ("leaf casting, lower front corner", "piece added, back cover spine-side"). Flag ONLY when you are confident — and NEVER state or imply that a book is UNrestored. Absence of visible restoration in these photos is not evidence of absence: much restoration is invisible in ordinary light, and a clean Deep says nothing either way. An empty array means "nothing seen here", never "nothing there".

HARD OUTPUT LIMITS:
  • defects array: MAX 13 entries (initial + new deep additions combined). v5.29: this
    was 10 while the Main pass allows 13, so on a heavily-defected book Deep had to
    silently DROP three findings the Main pass had already made — which is how a
    real defect disappears between passes. Matched to Main. Beyond 13, do NOT discard
    the extras: consolidate them into severity-bearing summary entries, exactly as the
    Main prompt instructs. NEVER drop a structural defect (tape, missing piece, tear,
    spine split, water damage, rust migration) to make room — consolidate cosmetic
    wear instead.
  • restorationFlags: MAX 8 entries, each a short phrase naming what and where
  • aiAssessment: OMIT this field entirely — do NOT output it. The first-pass write-up is preserved unchanged by the client; regenerating it wastes tokens and risks altering the frozen record. ALL Deep observations and the confirm/revise note go in deepAssessment ONLY.
`;

  // ── S22: UV CHECK prompt (mode==='restoration') ─────────────────────
  // Was an 8-image Restoration Check: 2 UV shots plus 6 ordinary-light ones
  // covering staples, trimming, leaf-casting and married covers. Those six are
  // all visible in ordinary light, and Main / Deep / Full now report them on
  // their own. What survives is the pair that always needed the blacklight,
  // for the one thing a normal photo cannot show: COLOR TOUCH — ink added to a
  // cover, which fluoresces differently from the original printing under UV.
  //
  // Two images, one question, free to the user. Keep this prompt short: it is
  // the whole reason the tier can be given away.
  const restorationPrompt = `You are performing a UV CHECK on a comic book. You are NOT grading it. You are looking at two photographs — the front cover and the back cover, each shot under an ultraviolet (blacklight) flashlight in a dark room — and answering one question: is there ink on this cover that does not match the rest of the ink?

THIS BOOK: ${initialAssessment.title || 'Unknown'} ${initialAssessment.issue || ''}.

STEP 1 — IS THIS ACTUALLY A UV PHOTO?
A genuine UV photo has a deep blue-violet cast across the whole frame, dark surroundings with no warm room light, and bright blue-white fluorescence wherever optical brighteners are present (modern paper, CGC/PSA labels, case plastic). A normal indoor or daylight photo has none of that.
• Image under UV in a dark room → "uvLightPresent": true for that image.
• Not under UV, or heavy ambient light → "uvLightPresent": false for that image, and do not judge color touch on that cover. Say so plainly.
• If EITHER image fails, set "uvCheckFailed": true.

STEP 2 — DOES ANY INK NOT MATCH?
Original period printing fluoresces fairly uniformly across a cover. ADDED ink — color touch, over-painting, a filled-in spine tick, a re-blackened logo — fluoresces at a DIFFERENT intensity or a different hue from the ink around it, and it usually sits exactly where wear would be expected: spine edges, corners, fold lines, chip edges, the outer border.
• If you see a patch, line or spot whose fluorescence differs from the surrounding ink, say WHERE it is and WHAT it looks like.
• If everything fluoresces consistently, say so.
• Do NOT report ordinary wear, soiling, tape, stains, glue, staples, trimming, edge damage or anything else you can see in normal light. Those are graded elsewhere. This check reports ink mismatch under UV and nothing else.
• Do NOT guess. Uneven glare, a fingerprint, a gloss difference and a fold shadow are not color touch. If you are unsure, report it as uncertain rather than asserting it.

CONFIDENCE
• Clear, localized, obviously-different fluorescence → "indicatorsObserved": true, "highConfidence": true.
• Something that may be added ink but could be glare or surface texture → "indicatorsObserved": true, "highConfidence": false.
• Nothing that differs → "indicatorsObserved": false, "highConfidence": false.

NEVER assert a verdict. This is an observation, not a determination: only a physical examination can confirm restoration.

## RESPONSE FORMAT — STRICT
Your entire response must be a JSON object and nothing else.

{
  "restorationCheckRan": true,
  "uvLightPresent": true | false,
  "uvCheckFailed": true | false,
  "indicatorsObserved": true | false,
  "highConfidence": true | false,
  "restorationReport": "<≤60 words. One sentence on whether the photos were usable UV photos, then one sentence per cover on what the ink looked like, then the conclusion. State only what you saw. Do not explain what UV light does or what you were looking for.>",
  "findings": [
    { "area": "uv_front | uv_back", "observation": "<≤25 words>", "indicatorPresent": true | false }
  ]
}

Include exactly one findings entry for uv_front and one for uv_back. An image that was not under UV still gets an entry, with indicatorPresent false and an observation saying it was not a UV photo.
`;

  // ── S22: BATCH TERSE OUTPUT (passes 2-N only) ───────────────────────────────
  // In a Batch the client keeps NOTHING a Deep writes except the numbers:
  // roboGrade subscores, grade, pageQuality and confidenceRange. deepAssessment
  // and the defect list from passes 2-N are read for a count and thrown away —
  // the book keeps the write-up and defect list from its own real Deep (see the
  // "APPLY THE BATCH" block in index.html). So we stop paying to write them.
  //
  // Pass 1 is deliberately NOT terse: its defect list still feeds the deepAdded
  // telemetry and it is the pass whose output most resembles a real Deep, which
  // is what makes the batch comparable to a normal run.
  //
  // CACHE SAFETY: this text is appended AFTER the §§CACHE_SPLIT§§ marker, so it
  // lands in the per-pass half and the cached prefix is byte-identical to a
  // non-terse pass. Putting it before the marker would invalidate the cache on
  // every batch and cost far more than it saves.
  //
  // EXPECTED SAVING IS SMALL. Working back from Matt's own per-call costs
  // (pass 1 $0.183 vs passes 2-5 ~$0.101 at Opus 5 $5/$25 per M), a non-first
  // Deep is roughly 85-90% input — the per-pass grade-reference images that sit
  // outside the cached prefix on purpose, because they are what produces the
  // variance. Output is only ~450-500 tokens (~$0.012). Expect ~$0.01 a pass,
  // ~$0.04 a batch. This is not a big lever; the big lever would be caching the
  // grade-reference images, which requires a fixed bracket, which flattened
  // every Deep to the same PG and was rejected.
  const BATCH_TERSE = !isRestoration
                   && ((req.body && req.body.cacheProfile) === 'batch')
                   && (req.body && req.body.batchTerse === true);
  const terseBlock = BATCH_TERSE ? `

## BATCH PASS — NO WRITE-UP (overrides the RESPONSE FORMAT above)
This is a repeat scoring pass. The narrative is discarded unread, so do not write one.
  • "deepAssessment": output an EMPTY STRING. Write no prose at all.
  • "roboGrade.defects": STILL REQUIRED, in full, exactly as specified above. S22: the batch adopts the defect list from whichever pass lands closest to the batch average, so the list must match the grade THIS pass gave. A list that does not justify this pass's subscores is worse than no list at all.
  • Everything else (grade, pageQuality, roboGrade scores, confidenceRange, photograder, gateResult, sameBook) is REQUIRED exactly as specified above.
` : '';

  const activePrompt = (isRestoration ? restorationPrompt : systemPrompt) + terseBlock;

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
    const GRADE_REF_SPAN = 1;   // ±1 position → 3 reference images. See note at the slice below.
    let gradeRefBlocks = [];   // ascending-grade [text label, image, text label, image, ...]
    let frontCoverBlock = null;
    let refCoverBlocks = [];   // local pristine reference_covers (front[+back]) of this exact issue, for defect ID
    let cvCoverBlock = null;   // ComicVine cover — weaker fallback, only when there is no curated cover
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
          // BRACKET WIDTH (v5.80, Matt). Was hardcoded at ±2 — five images, ~1,475
          // input tokens each, ~7,375 per Deep. They sit AFTER the cache breakpoint
          // by design (see the note at the second breakpoint below), so they bill
          // in FULL on every pass including all five passes of a Batch — roughly
          // 30% of a Deep's input and the single largest never-reused cost in the
          // call. Narrowed to ±1 (three images).
          // The references are a yardstick, not a permission slip: PHASE 4 lets the
          // grade move outside the range they span, and the structural exception
          // above removes the cap entirely. Fewer of them should cost calibration,
          // not reach.
          // Override per request to A/B it: span 2 = 5 images, 1 = 3, 0 = 1 (the
          // initial grade alone, no context above or below).
          const _spanRaw = (req.body && req.body.gradeRefSpan);
          const _span = Number.isFinite(Number(_spanRaw)) ? Math.max(0, Math.min(2, Number(_spanRaw))) : GRADE_REF_SPAN;
          const lo = Math.max(0, idx - _span), hi = Math.min(CGC_GRADE_SCALE.length - 1, idx + _span);
          const windowGrades = CGC_GRADE_SCALE.slice(lo, hi + 1);  // 2*_span+1, ascending
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
      // Local pristine reference covers (front[+back]) of THIS exact issue, for
      // defect identification (printed art vs damage). Free here: the book is
      // already identified from the initial assessment, so no extra model call is
      // needed — just the two images. Local reference_covers only; ComicVine stays
      // in the Main assessment path.
      try {
        const _rt = initialAssessment.title || title || '';
        const _ri = initialAssessment.issue != null ? String(initialAssessment.issue) : (issueNumber || '');
        if (_rt && String(_ri).trim()) {
          const _bu = process.env.APP_URL || 'https://robograder.app';
          // S22: same alias folding as assess.js (see REF_TITLE_ALIASES there).
          // Without it Deep missed uncanny-x-men_1_1963 for exactly the same reason
          // Main did — the 1963 book identifies as "The X-Men" -> x-men.
          const _slug = x => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          const _ALI = [['x-men','uncanny-x-men'],['incredible-hulk','hulk'],['invincible-iron-man','iron-man'],
                        ['mighty-thor','thor'],['journey-into-mystery','thor'],['amazing-spider-man','spider-man']];
          const _sl = (() => {
            const out = new Set();
            [_slug(String(_rt).replace(/^the\s+/i, '')), _slug(_rt)].filter(Boolean).forEach(sd => {
              out.add(sd);
              for (const [a, b] of _ALI) { if (sd === a) out.add(b); else if (sd === b) out.add(a); }
            });
            return [...out];
          })();
          const _is = String(_ri).replace(/^#/, '').replace(/^0+(\d)/, '$1').trim();
          const _yr = (() => { const _m = String(initialAssessment.issueDate || '').match(/(?:19|20)\d{2}/); return _m ? _m[0] : null; })();
          const _cands = []; for (const _s of _sl) { if (_yr) _cands.push(`${_s}_${_is}_${_yr}`); _cands.push(`${_s}_${_is}`); }
          for (const _b of _cands) {
            const _fr = await fetch(`${_bu}/reference_covers/${_b}_front.jpg`);
            if (!_fr.ok) continue;
            const _fd = Buffer.from(await _fr.arrayBuffer()).toString('base64');
            const _blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: _fd } }];
            try { const _br = await fetch(`${_bu}/reference_covers/${_b}_back.jpg`); if (_br.ok) { const _bd = Buffer.from(await _br.arrayBuffer()).toString('base64'); _blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: _bd } }); } } catch (e) {}
            refCoverBlocks = _blocks;
            break;
          }
        }
      } catch (e) { refCoverBlocks = []; }

      // FALLBACK: no curated cover for this issue. Use the ComicVine cover the
      // Main pass already resolved. It is a WEAKER reference and gets its own,
      // much more cautious instruction block (see cvCoverNote below) — it is a
      // digital reproduction, it may itself be a mid-grade copy, and it is
      // sometimes the wrong book entirely.
      if (!refCoverBlocks.length && referenceImageUrl) {
        try {
          const _cv = await fetch(referenceImageUrl);
          if (_cv.ok) {
            const _ct = (_cv.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
            const _mt = /^image\/(jpeg|png|gif|webp)$/.test(_ct) ? _ct : 'image/jpeg';
            const _cd = Buffer.from(await _cv.arrayBuffer()).toString('base64');
            cvCoverBlock = { type: 'image', source: { type: 'base64', media_type: _mt, data: _cd } };
          }
        } catch (e) { cvCoverBlock = null; }
      }
    }
    const hasGradeRefs = gradeRefBlocks.length > 0;

    // Deep prompt caching — AVAILABLE BUT OFF (Matt, S22g). Individual Deep
    // volume isn't high enough to warrant it yet; flip this to true to enable
    // caching on all Deep assessments. (Batch will get its caching from the
    // dedicated batch flow, not from this per-call path.)
    // S22: opt-in per request. Individual Deeps stay uncached (Matt's call — the
    // volume doesn't justify it). A batch worker sends cacheProfile:'batch' to
    // turn it on for that call. NOTE: caching only pays when the prefix repeats,
    // so with per-pass grade brackets (BATCH_FIXED_BRACKET=false) the system
    // prompt differs per pass and this will NOT hit. Kept wired so the
    // cost-vs-variance trade can be measured both ways rather than argued.
    // ── DEEP CACHING: ON FOR EVERY DEEP SINCE 2026-10-12 ────────────────────
    // This was gated to Batch passes only, and the reasoning was sound at the
    // time: caching pays when the prefix REPEATS, which it does across the five
    // passes of a Batch and does not on a standalone Deep. A lone Deep would
    // have paid a 2x cache WRITE and never read it back. Pure loss.
    // What changed: /api/cachewarm now keeps the prefix alive between calls, so
    // a standalone Deep arrives to a WARM entry instead of writing a cold one.
    // The prefix is warmable because it varies on exactly two booleans,
    // hasInteriorCovers and hasFrontCover — no grade-dependent text, the
    // per-pass bracket lives after §§CACHE_SPLIT§§ — and 98.4% of 572 Deeps
    // over 60 days took the single hasInteriorCovers && hasFrontCover branch.
    // One warm entry covers nearly all of them; the 1.6% minority pays cold,
    // exactly as before.
    // IF THE PING IS EVER TURNED OFF, PUT THIS BACK TO BATCH-ONLY. Without a
    // ping, caching a standalone Deep costs more than it saves.
    // STILL BATCH-ONLY, AND THE ORDER MATTERS. Turning this on before the ping
    // can warm the Deep prefix makes things WORSE, not better: a standalone Deep
    // would pay a 2x cache WRITE on ~5,300 tokens of system text plus the nine
    // invariant images behind the second breakpoint, and never read any of it
    // back. At ~446 Deeps a month that is roughly -$27/month, which is more than
    // the whole feature is worth. Claude flipped this to `true` on 2026-10-12
    // and reverted it within the minute on working the arithmetic out.
    // THE CORRECT ORDER: (1) hoist this prompt's cached prefix into its own
    // module the way lib/main_prompt.js was hoisted, with a byte-identity check;
    // (2) teach /api/cachewarm to ping the hasInteriorCovers && hasFrontCover
    // variant, which covers 98.4% of 572 Deeps over 60 days; (3) confirm the
    // ping reports a cache READ; (4) only then set this to true.
    // S22 — DEEP CACHING IS NOW SWITCHABLE FROM config/caching.
    // Until now this was `cacheProfile === 'batch'` and nothing else, and that
    // flag is only sent by assess_batch_run.js. Every app-initiated Deep sent
    // its system prompt as a PLAIN STRING with no cache_control: no entry to
    // warm, nothing that would read one. That is why Deep warming could not be
    // built, not a decision about frequency.
    //
    // DEFAULTS ON once the chip exists, OFF if the doc has no `deep` key, so
    // nothing changes until Matt switches it. Turning it on is not free — a
    // cache WRITE bills at 2x input — so the first day is the test: if Deeps
    // are reading, it pays for itself many times over; if every Deep is still
    // a WRITE, the prefix is varying per book and the chip comes back off.
    // deepPrefixSha on the timing record below is how that is read, from
    // production rather than from reading the template.
    const _deepCacheCfg = await readDeepCachingCfg();
    const DEEP_CACHE_ENABLED =
      ((req.body && req.body.cacheProfile) === 'batch') || _deepCacheCfg.deepOn;
    const _deepTtl = _deepCacheCfg.ttl;
    const _deepCacheCtl = _deepTtl === '5m'
      ? { type: 'ephemeral' }
      : { type: 'ephemeral', ttl: '1h' };

    // Split the prompt once: static half stays in `system` (cacheable), per-pass
    // half is injected into the user turn after the invariant images.
    // Instruction text for the ComicVine fallback cover. Deliberately far more
    // guarded than the curated-cover wording: Matt's own reference_covers/ scans
    // are near-mint 9.8 ink-on-paper images of the verified correct book, and
    // can be trusted. A ComicVine cover cannot.
    const cvCoverNote = 'STOCK COVER IMAGE of this issue follows. It is a WEAK reference — read these limits before using it:\n'
      + '  (a) It is usually a DIGITAL REPRODUCTION, not a photograph of ink on paper. Its colours are cleaner and more saturated than any physical copy. NEVER treat a colour or tone difference against it as a defect.\n'
      + '  (b) It is NOT guaranteed to be a high-grade copy. It is often a mid-grade scan carrying its own wear, so a mark present on it does NOT prove the mark is printed art.\n'
      + '  (c) It is sometimes THE WRONG BOOK — a different volume, or a different series sharing the title (e.g. the Golden Age Daredevil vs the Marvel one). Before using it at all, confirm the cover artwork, logo and trade dress match the book being graded. If they do not match, DISCARD it entirely, ignore it for the rest of this assessment, and grade from the photos alone.\n'
      + 'Given those limits, use it ONLY for STRUCTURAL comparison — to spot a MISSING PIECE, a tear, tape, or an area of the design that is absent or interrupted on the graded copy. Do NOT use it to judge colour, gloss, tone, foxing or general wear, and do NOT conclude a mark is printed art because it appears here. When this image and the photos disagree, the photos win.';

    const _deepParts = activePrompt.split('\u00a7\u00a7CACHE_SPLIT\u00a7\u00a7');
    const _deepStatic = _deepParts[0];
    const _deepPerPass = (_deepParts.length > 1) ? (_deepParts[1] || '') : '';

    const _antBody = {
      model: PRIMARY_MODEL,
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
      // System prompt: cached (1h TTL) only when DEEP_CACHE_ENABLED; otherwise a
      // plain string exactly as before (no caching, current default).
      // S22: cache the STATIC PREFIX ONLY, exactly as api/assess.js does.
      // Previously this cached `activePrompt` WHOLE — and that prompt has the
      // book's title, issue and gradeTierContext(initialGrade) interpolated into
      // it. So the cache key changed with every book AND every grade, and the
      // cache could essentially never hit — not across passes, not even across
      // users. That was an implementation gap, not a limit of caching: Main has
      // split static-from-variable at §§CACHE_SPLIT§§ for months, which is why a
      // Main on one book gets a cache hit from a Main on a completely different
      // book. Deep now does the same, so per-pass grades no longer matter.
      // S22 IMAGE-CACHE REORDER. The system prompt now carries ONLY the static
      // half. Everything per-book/per-pass (the INITIAL ASSESSMENT, the ±1 tier
      // reference, the JSON schema) is emitted as a user block AFTER the
      // invariant images, so the cache breakpoint below can cover system + all
      // 9 invariant images. Previously the per-pass text sat between the static
      // system and the images, which poisoned the prefix and made the
      // image breakpoint miss on every pass — the images billed at full price
      // five times over.
      system: DEEP_CACHE_ENABLED
        ? [{ type: 'text', text: _deepStatic, cache_control: _deepCacheCtl }]
        : activePrompt.split('\u00a7\u00a7CACHE_SPLIT\u00a7\u00a7').join(''),
      messages: [{
        role: 'user',
        content: isRestoration
          ? [
              { type: 'text', text: 'UV CHECK IMAGES in order: (1) UV Front cover, (2) UV Back cover.' },
              ...macroBlocks,
              { type: 'text', text: 'First verify each image is genuinely under UV light. Then look for ink that fluoresces differently from the surrounding ink. Return the JSON.' }
            ]
          : [
              { type: 'text', text: 'CORNER MACROS in order: Top-Left, Top-Right, Bottom-Left, Bottom-Right of the front cover.' },
              ...macroBlocks,
              ...(hasInteriorCovers ? [{ type: 'text', text: 'INTERIOR COVER PHOTOS in order: (1) Interior Front — inside front cover + first page; (2) Interior Back — last page + inside back cover. Examine ONLY for interior-cover condition (tanning, foxing, stains, tears) per PHASE 2.5. Do not re-judge page quality.' }, ...interiorCoverBlocks] : []),
              ...(frontCoverBlock ? [{ type: 'text', text: 'FULL FRONT COVER of the book being graded:' }, frontCoverBlock] : []),
              ...(refCoverBlocks.length ? [{ type: 'text', text: 'PRISTINE REFERENCE COVERS of this exact issue follow (near-mint FRONT' + (refCoverBlocks.length > 1 ? ' and BACK' : '') + '). Use them FIRST to separate printed art from damage: any mark that ALSO appears on the reference is PRINTED ART and is NOT a defect; only marks ABSENT from the reference are real defects. Apply this while re-examining the macros for corner/edge/spine defects, BEFORE the grade-reference comparison below.' }, ...refCoverBlocks] : []),
              // Fallback reference, used only when no curated cover exists.
              ...(!refCoverBlocks.length && cvCoverBlock ? [{ type: 'text', text: cvCoverNote }, cvCoverBlock] : []),
              // ── everything ABOVE this line is identical on every pass of a
              // batch and is what the cache breakpoint covers. Everything BELOW
              // varies per pass and must stay outside the cached prefix. ──
              ...(_deepPerPass ? [{ type: 'text', text: _deepPerPass }] : []),
              ...(hasGradeRefs ? [{ type: 'text', text: 'GRADE-REFERENCE IMAGES follow — real graded comics bracketing the initial grade, each labeled with its CGC grade and condition note, in ascending grade order. Compare the book above against these examples (PHASE 4).' }, ...gradeRefBlocks] : []),
              { type: 'text', text: 'Perform the deep assessment. If the macros reveal new defects, the grade may go down — tag them deepAddition: true. If the corners are cleaner than expected for the initial grade, the Front sub-score may rise by 1–3 points. Compare the book against the grade-reference images and confirm or revise the predicted grade per PHASE 4. Return the JSON.' }
            ]
      }]
    };

    // Second cache breakpoint on the LAST INVARIANT IMAGE, so the cached prefix
    // is system + corner macros + interior covers + front cover + reference
    // covers — 9 images that are byte-identical on every pass of a batch.
    // It used to sit on the last corner macro, which left the interior covers,
    // the front cover and the reference covers outside the prefix (billed in
    // full every pass) — and it missed anyway, because the per-pass text was
    // still upstream of it in the system prompt.
    // NOT included, deliberately: the grade-reference bracket images. Those are
    // chosen from each pass's OWN Main grade, which is what produces the
    // pass-to-pass variance Batch exists to show. They stay after the
    // breakpoint and bill in full.
    //
    // S22 — AND IT ONLY PAYS IN A BATCH. "Byte-identical on every pass of a
    // BATCH" is exactly right, and it is also the whole catch: on an ordinary
    // single Deep there is no second pass. These images are this one book's
    // corners, interior covers and cover. Nothing will ever read the entry.
    // A cache WRITE bills at 1.25x base, so an unread write is a 25% surcharge
    // on everything it covers, paid on every single-book Deep.
    // Measured on a real call (deep_1793747569602_li61uo, FF #121):
    //   cacheReadInputTokens      8302   <- the system prefix. Working.
    //   cacheCreationInputTokens  8817   <- this breakpoint. Written, never read.
    // 8,817 tokens at the 0.25x premium is about $0.03 on a $0.134 call.
    // So the breakpoint is set only for a batch pass, where four later passes
    // read it back. A single Deep lets those images bill at base rate.
    if (DEEP_CACHE_ENABLED && _isBatchPass) {
      try {
        const _lastInvariant =
          (refCoverBlocks.length ? refCoverBlocks[refCoverBlocks.length - 1] : null) ||
          cvCoverBlock ||
          frontCoverBlock ||
          (interiorCoverBlocks.length ? interiorCoverBlocks[interiorCoverBlocks.length - 1] : null) ||
          (macroBlocks.length ? macroBlocks[macroBlocks.length - 1] : null);
        if (_lastInvariant) _lastInvariant.cache_control = _deepCacheCtl;
      } catch (e) {}
    }

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
              'anthropic-version': '2023-06-01',
              ...(DEEP_CACHE_ENABLED ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } : {})
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
              'anthropic-version': '2023-06-01',
              ...(DEEP_CACHE_ENABLED ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } : {})
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
        _diagnostics: { deepAssessment: true, imageMismatch: true, initialGrade: initialAssessment.grade || null,
          // S22: log the Deep's own RG, subscores and PQ on EVERY run, not just
          // when they move. Matt reads the admin LOGS tab to compare passes, and
          // a Deep that left them unchanged previously logged nothing at all —
          // indistinguishable from a Deep that never produced them.
          rgScore: (parsed && parsed.roboGrade && parsed.roboGrade.score != null) ? parsed.roboGrade.score : null,
          precisionMod: (parsed && parsed.roboGrade && parsed.roboGrade.confidenceRange) ?? null,
          frontScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.frontScore ?? null : null,
          backScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.backScore ?? null : null,
          spineScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.spineScore ?? null : null,
          interiorScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.interiorScore ?? null : null,
          pageQuality: (parsed && parsed.roboGrade && parsed.roboGrade.pageQuality) || (parsed && parsed.pageQuality) || null, phaseTimings }
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
            epoch: GRADING_EPOCH,   // pool by THIS, not by version - see lib/version.js
            model: PRIMARY_MODEL,
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
      // Not a graded book — the user keeps their credit.
      await _refundIfDebited('IMAGE_MISMATCH');
      if (wantsSSE) { sseEvent('result', mismatch); try { res.end(); } catch (e) {} return; }
      return res.status(200).json(mismatch);
    }

    // Normalize grade format, then snap onto the CGC/PSA ladder — see the
    // matching block in assess.js. Deep can revise the PG, so it needs the
    // same membership check the Main pass gets.
    if (parsed.grade != null && String(parsed.grade).trim() !== '') {
      const _g = enforceCgcGrade(parsed.grade, 'deep');
      if (_g) parsed.grade = _g;
    }

    // Carry-forward enforcement: Back and Interior sub-scores must equal initial values.
    if (parsed.roboGrade) {
      if (initialRG.backScore != null) parsed.roboGrade.backScore = initialRG.backScore;
      // S22: Interior/PQ. No interior covers -> Interior frozen (no new interior
      // evidence). WITH interior covers, Deep may RARELY refine page quality from
      // the first/last interior-wrap pages (PHASE 2.5); keep PQ and Interior 1:1.
      const _pqToInterior = (pq) => {
        const M = { 'white':10,'off-white to white':9,'ow/w':9,'off-white':8,'ow':8,'cream to off-white':7,'c/ow':7,'cream':6,'light tan to cream':5,'lt/c':5,'light tan':4,'lt':4,'tan':3,'brown':2,'brown/brittle':1,'brittle':0 };
        const k = String(pq || '').trim().toLowerCase();
        return (k in M) ? M[k] : null;
      };
      if (!hasInteriorCovers) {
        if (initialRG.interiorScore != null) parsed.roboGrade.interiorScore = initialRG.interiorScore;
      } else {
        const _newPQ = String((parsed.roboGrade && parsed.roboGrade.pageQuality) || parsed.pageQuality || '').trim();
        const _initPQ = String(initialRG.pageQuality || '').trim();
        const _mappedI = _pqToInterior(_newPQ);
        if (_newPQ && _newPQ.toLowerCase() !== _initPQ.toLowerCase() && _mappedI != null) {
          parsed.roboGrade.pageQuality = _newPQ;
          parsed.pageQuality = _newPQ;
          parsed.roboGrade.interiorScore = _mappedI;   // keep Interior 1:1 with PQ
        } else {
          if (initialRG.interiorScore != null) parsed.roboGrade.interiorScore = initialRG.interiorScore;
          parsed.roboGrade.pageQuality = initialRG.pageQuality || parsed.roboGrade.pageQuality;
          if (initialAssessment.pageQuality) parsed.pageQuality = initialAssessment.pageQuality;
        }
      }
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
      // FLOOR RULE — WIDENED. A revised grade may not go BELOW the initial
      // unless Deep can NAME A REASON. It used to accept exactly one reason: a
      // defect tagged deepAddition: true.
      //
      // That was too narrow, and it fought the prompt. PHASE 4 explicitly invites
      // Deep to move the grade up to two positions in either direction based on
      // the grade-reference comparison — and this rule then deleted every
      // downward move of that kind, because "this cover matches the 2.0
      // reference, not the 3.0" is not a defect entry. A page-quality exemption
      // had already been bolted on for the same reason. Two exemptions to a rule
      // is the rule being wrong.
      //
      // It is now: an EXPLAINED drop stands, an UNEXPLAINED drop is reverted.
      // Four things count as an explanation:
      //   1. a new defect (deepAddition: true)          - as before
      //   2. a page-quality refinement                   - as before
      //   3. a CORRECTED defect (revisionReason)         - new
      //   4. a stated grade-reference comparison         - new
      //
      // (3) matters because of the interior cross-reference added to PHASE 2.5:
      // re-naming a "Tear" as a "Piece out" is not a NEW defect, it is the same
      // defect correctly identified as the more serious one, and it must be able
      // to lower the grade.
      //
      // The rule is kept, not removed, and the reason is behavioural rather than
      // technical: Deep has to be as likely to raise a grade as to lower it. A
      // second look always finds something, so without a floor Deep would ratchet
      // downward on every book, and a revision pass users learn to distrust is
      // worse than no revision pass. The floor is what keeps it a genuine
      // correction rather than a penalty.
      const _defs = Array.isArray(parsed.roboGrade?.defects) ? parsed.roboGrade.defects : [];
      const hasDeepAddition = _defs.some(d => d && d.deepAddition === true);
      // A defect the model re-classified rather than newly found.
      const hasRevision = _defs.some(d => d && typeof d.revisionReason === 'string' && d.revisionReason.trim().length > 3);
      // A stated reference comparison. Requires actual prose - an empty string or
      // a bare "confirmed" is not a reason to move a grade.
      const _revText = String(parsed.gradeRevisionReason || '').trim();
      const hasStatedComparison = _revText.length >= 12;
      // S22: a genuine page-quality refinement (interior covers) may move the grade
      // in either direction — treat it like a deepAddition so the floor rule below
      // doesn't undo a legitimate PQ-driven decrease.
      const _pqRefined = hasInteriorCovers
        && String((parsed.roboGrade && parsed.roboGrade.pageQuality) || '').trim().toLowerCase()
           !== String(initialRG.pageQuality || '').trim().toLowerCase();
      const _explained = hasDeepAddition || _pqRefined || hasRevision || hasStatedComparison;
      if (!_explained && initialRG && initialRG.score != null && parsed.roboGrade) {
        if ((Number(parsed.roboGrade.score) || 0) < Number(initialRG.score)) {
          parsed.roboGrade.score = initialRG.score;
          parsed.roboGrade.frontScore = initialRG.frontScore;
          parsed.roboGrade.spineScore = initialRG.spineScore;
          parsed.grade = initialAssessment.grade || parsed.grade;
          parsed.roboGrade._floorReverted = true;   // logged so the rate is measurable
          console.log('[deep-floor] unexplained drop reverted');
        }
      } else if (!hasDeepAddition && !_pqRefined && (hasRevision || hasStatedComparison)) {
        console.log('[deep-floor] drop allowed: ' + (hasRevision ? 'corrected defect' : 'reference comparison'));
      }

      // S22 (Matt): PAGE QUALITY MUST NOT MOVE THE PREDICTED GRADE.
      // CGC assigns page quality independently of overall condition, so a PQ
      // revision is not a reason for the predicted CGC grade to move. Robograder
      // is different by design — our Interior sub-score IS driven by PQ, so a PQ
      // change legitimately moves RG. The two must not be conflated.
      // Observed on Uncanny X-Men #35: all five Deeps read the interior covers a
      // notch more cream than Main and every one of them dropped PG 4.5 -> 4.0.
      // That drop was page quality leaking into the predicted grade.
      // So: when the ONLY thing Deep changed is page quality — no new defect
      // flagged, nothing disproven — restore the initial predicted grade and let
      // the PQ change express itself through Interior/RG alone.
      const _initDefN = Array.isArray(initialRG.defects) ? initialRG.defects.length : null;
      const _newDefN = Array.isArray(parsed.roboGrade && parsed.roboGrade.defects) ? parsed.roboGrade.defects.length : null;
      const _defectsUnchanged = (_initDefN != null && _newDefN != null && _newDefN >= _initDefN);
      if (_pqRefined && !hasDeepAddition && _defectsUnchanged && initialAssessment.grade) {
        if (String(parsed.grade || '') !== String(initialAssessment.grade)) {
          console.log(`[deep] PQ-only change — holding PG at ${initialAssessment.grade} (model said ${parsed.grade})`);
          parsed.grade = initialAssessment.grade;
        }
      }
      // S21 Photograder: merge this pass's Focus/Lighting into the running record
      // (Cropping/Angle carry from Main), compute the PM with the monotonic clamp
      // against the prior tier's PM, and use it for the ± and the score ceiling.
      const _priorPG = initialAssessment.photograder || null;
      // Prefer the honest key; fall back to the legacy one for records written
      // before the rename.
      const _priorPM = (initialRG && typeof initialRG.scoreCeilingPenalty === 'number') ? initialRG.scoreCeilingPenalty
        : ((initialRG && typeof initialRG.confidenceRange === 'number') ? initialRG.confidenceRange : null);
      const _mergedPG = mergePhotograder(_priorPG, parsed.photograder);
      const _deepPM = computeScoreCeilingPenalty(_mergedPG, 'deep', !!initialAssessment.labelDetected, _priorPM);
      _mergedPG.pm = _deepPM;
      _mergedPG.tier = 'deep';
      parsed.photograder = _mergedPG;
      if (parsed.roboGrade) {
        const _ceil = 100 - _deepPM;
        if (typeof parsed.roboGrade.score === 'number' && parsed.roboGrade.score > _ceil) parsed.roboGrade.score = _ceil;
        parsed.roboGrade.scoreCeilingPenalty = _deepPM;
      parsed.roboGrade.confidenceRange = _deepPM;   // legacy alias
      }
      parsed.deepAssessmentRan = true;
    } else {
      parsed.restorationCheckRan = true;
    }
    // Final ladder guard. Between the normalize above and here, parsed.grade
    // can be overwritten with initialAssessment.grade (the PQ-only hold and the
    // revision-reason rollback), which is client-supplied and therefore not
    // guaranteed to be a real grade. Snap once more so nothing off-ladder can
    // leave this endpoint by that route.
    if (parsed.grade != null && String(parsed.grade).trim() !== '') {
      const _g2 = enforceCgcGrade(parsed.grade, 'deep-final');
      if (_g2) parsed.grade = _g2;
    }
    // ── DEEP CEILING: 9.6 ────────────────────────────────────────────────
    // A Deep sees the corner macros and interior covers; it does not see the
    // staples, page edges or structure. 9.8+ is earned by a Full, which does.
    // api/assess.js has advertised a 9.6 Deep ceiling since S21, but this
    // endpoint had no server ceiling at all and its PHASE 4 text invited 9.8 --
    // which is how RG-ID 77H9H6 took a 9.8 off a Deep with no Full.
    // NEVER LOWER A GRADE THAT ARRIVED ABOVE THE CEILING: a Deep re-run on a
    // book whose Full already awarded 9.8 must not claw it back, so the cap is
    // the HIGHER of 9.6 and the incoming grade.
    {
      const DEEP_PG_CEILING = 9.6;
      const _in  = parseFloat(initialAssessment && initialAssessment.grade);
      const _out = parseFloat(parsed.grade);
      const _cap = Math.max(DEEP_PG_CEILING, Number.isFinite(_in) ? _in : DEEP_PG_CEILING);
      if (Number.isFinite(_out) && _out > _cap) {
        console.log(`[deep-ceiling] model returned ${parsed.grade}; Deep caps at ${_cap.toFixed(1)} (Full is required above 9.6)`);
        parsed.grade = enforceCgcGrade(_cap, 'deep-ceiling');
      }
      // gradeAtCeiling drives the "(+)" the app shows beside the grade: this
      // pass went as high as it is allowed to go, the next tier can go higher,
      // and nothing worse than a LOW-severity defect remains. Same two-part
      // test as the Main -- see the comment in api/assess.js. A 9.6 with a Med
      // defect still on it is not a book we are telling the user could be 9.8.
      const _deepDefects = Array.isArray(parsed.defects) ? parsed.defects : [];
      const _deepHasRealDefect = _deepDefects.some(d => {
        const sev = String((d && d.severity) || '').trim().toLowerCase();
        return sev === 'high' || sev === 'med' || sev === 'medium';
      });
      parsed.gradeAtCeiling =
        parseFloat(parsed.grade) === DEEP_PG_CEILING && !_deepHasRealDefect;
    }
    parsed._diagnostics = {
      deepAssessment: !isRestoration,
      restorationCheck: isRestoration,
      initialGrade: initialAssessment.grade || null,
          // S22: log the Deep's own RG, subscores and PQ on EVERY run, not just
          // when they move. Matt reads the admin LOGS tab to compare passes, and
          // a Deep that left them unchanged previously logged nothing at all —
          // indistinguishable from a Deep that never produced them.
          rgScore: (parsed && parsed.roboGrade && parsed.roboGrade.score != null) ? parsed.roboGrade.score : null,
          precisionMod: (parsed && parsed.roboGrade && parsed.roboGrade.confidenceRange) ?? null,
          frontScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.frontScore ?? null : null,
          backScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.backScore ?? null : null,
          spineScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.spineScore ?? null : null,
          interiorScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.interiorScore ?? null : null,
          pageQuality: (parsed && parsed.roboGrade && parsed.roboGrade.pageQuality) || (parsed && parsed.pageQuality) || null,
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
          // v6.50 - DEEP/FULL ORPHANS WERE INVISIBLE TO THE SWEEP.
          // api/assess.js has written these three fields since the Punisher 1
          // incident: a charged assessment is PENDING until the client calls
          // /api/credit_settle on save, and whatever is still pending after the
          // grace period is refunded by the cron. Only Main ever wrote them.
          // So a Deep or a Full that was charged and whose client never saved -
          // app killed, signal lost, or the ReferenceError that broke every
          // Deep in 6.41 - took the credit and was unsweepable. That is why
          // the sweep has been reporting "scanned 0" while Matt was losing
          // credits to the 6.41 bug: it could not see them.
          // SAFE TO ADD HERE AND ONLY HERE. This is the SUCCESS row, and its
          // key is the one returned in _diagnostics.timingKey, which
          // _recordTimingKey() stashes on the item and _settleCredits() hands
          // to /api/credit_settle. The error rows have already refunded, so
          // they must stay absent - a pending stamp on top of a refund is a
          // double refund.
          // NOT ADDED to assess_clean or the batch runner: neither records a
          // timing key on the item, so nothing would ever settle them and
          // every successful run would be refunded 15 minutes later. Wiring
          // _recordTimingKey through those flows comes first.
          ...(_creditDebited ? {
            creditSettled: false,
            creditPendingUid: _deepUid || null,
            creditPendingCost: _CREDIT_COST,
            creditPendingLabel: 'deep',
            creditPendingAt: Date.now()
          } : {}),
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          epoch: GRADING_EPOCH,   // pool by THIS, not by version - see lib/version.js
          model: PRIMARY_MODEL,
          deepAssessment: true,
          // S22 — THE FIELDS THAT MAKE DEEP WARMING BUILDABLE AND CHECKABLE.
          // deepVariant: which of the three cache entries this Deep used. A
          //   keep-warm ping can hold only one alive, so the distribution here
          //   decides which one is worth the money.
          // deepPrefixSha: compare against prefixSha from
          //   /api/cachewarm?mode=status. EQUAL means the ping and this
          //   endpoint are on the same text; DIFFERENT means they have drifted
          //   and the ping is warming nothing. That one comparison is what took
          //   three weeks to make for Main.
          deepVariant: deepVariantName({ isRestoration, hasInteriorCovers }),
          deepPrefixSha: (() => {
            try {
              return _deepCreateHash('sha256')
                .update(buildDeepPrefix({ hasFrontCover, hasInteriorCovers }))
                .digest('hex').slice(0, 16);
            } catch { return null; }
          })(),
          deepCacheEnabled: !!DEEP_CACHE_ENABLED,
          deepCacheSource: ((req.body && req.body.cacheProfile) === 'batch')
            ? 'batch-profile' : _deepCacheCfg.source,
          gateResult: parsed.gateResult || 'COMIC',
          predictedGrade: parsed.grade || null,
          initialGrade: initialAssessment.grade || null,
          // S22: log the Deep's own RG, subscores and PQ on EVERY run, not just
          // when they move. Matt reads the admin LOGS tab to compare passes, and
          // a Deep that left them unchanged previously logged nothing at all —
          // indistinguishable from a Deep that never produced them.
          rgScore: (parsed && parsed.roboGrade && parsed.roboGrade.score != null) ? parsed.roboGrade.score : null,
          precisionMod: (parsed && parsed.roboGrade && parsed.roboGrade.confidenceRange) ?? null,
          frontScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.frontScore ?? null : null,
          backScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.backScore ?? null : null,
          spineScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.spineScore ?? null : null,
          interiorScore: (parsed && parsed.roboGrade) ? parsed.roboGrade.interiorScore ?? null : null,
          pageQuality: (parsed && parsed.roboGrade && parsed.roboGrade.pageQuality) || (parsed && parsed.pageQuality) || null,
          gradeChanged: (initialAssessment.grade || null) !== (parsed.grade || null),
          // ── REVISION TRACKING (v5.26) ───────────────────────────────────
          // Deep must be as likely to RAISE a grade as to lower it. If users work
          // out that it almost always moves one way, the pass stops being a
          // correction and becomes a tax (or a giveaway), so the up/down/unchanged
          // ratio AND the size of each move are what say whether it is working.
          // Logged on every run from 5.26. Do NOT pool with earlier versions —
          // the floor rule changed in 5.26.
          //
          // WHY NO RG NUMBER IS LOGGED HERE. The displayed RoboGrade is v3:
          // half-points 0-10, the sum of Front 0-5 / Back 0-2 / Spine 0-2 /
          // Interior 0/0.5/1, produced by lib/roboscore_v3.js from these raw
          // 0-100 subscores. v1's 0-100 is the internal engine and is never
          // surfaced. Two reasons not to log a delta on it:
          //   1. A raw delta is in the wrong unit. -8 raw is about -0.5 to -1.0
          //      in v3, and anyone reading the field would have to know that.
          //   2. It would MISS the revisions that matter most. v3 caps the
          //      displayed grade by depth - Main 9.0, Deep 9.5, Full 10 - so a
          //      Deep on a clean book raises the SHOWN grade 9.0 -> 9.5 with the
          //      raw score completely flat. A raw delta reads that as "no
          //      change", which is exactly the high-grade population being
          //      tracked. (Same trap the v3 refund check had to fix; see
          //      SCORING_V3_SPEC.md 14.)
          // So: log the raw subscores on BOTH sides plus the depth, and derive v3
          // for each side offline with the real module. That stays exact, keeps
          // the ceilings correct, and avoids a fifth inlined copy of the
          // transform drifting from lib/roboscore_v3.js.
          //
          // PG needs no transform - it is already on the CGC scale - so its
          // signed delta is logged directly and is the field to reach for first.
          ...(function revisionStats() {
            const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
            const rd = (a, b) => (a == null || b == null) ? null : Math.round((b - a) * 100) / 100;
            const pgFrom = num(initialAssessment.grade), pgTo = num(parsed.grade);
            const _rg = parsed.roboGrade || {};
            const _defs = Array.isArray(_rg.defects) ? _rg.defects : [];
            return {
              // PG, CGC scale. Signed: positive = revised UP.
              pgFrom, pgTo, pgDelta: rd(pgFrom, pgTo),
              // RAW v1 0-100 engine numbers, named so they cannot be mistaken for
              // the v3 grade. Derive v3 from the subscores + depth, not from these.
              rgRaw100From: num(initialRG && initialRG.score),
              rgRaw100To:   num(_rg.score),
              rawSubscoresFrom: initialRG ? {
                front: num(initialRG.frontScore), back: num(initialRG.backScore),
                spine: num(initialRG.spineScore), interior: num(initialRG.interiorScore),
                pageQuality: initialRG.pageQuality || null,
              } : null,
              // The depth on each side is what sets the v3 ceiling (9.0 -> 9.5).
              depthFrom: 'main',
              depthTo: 'deep',
              slabbed: !!initialAssessment.labelDetected,
              gradeRevisionReason: String(parsed.gradeRevisionReason || '').slice(0, 300) || null,
              revisedDefectCount: _defs.filter(d => d && typeof d.revisionReason === 'string' && d.revisionReason.trim().length > 3).length,
              deepAdditionCount: _defs.filter(d => d && d.deepAddition === true).length,
              floorReverted: !!_rg._floorReverted,
              // The high-grade population, which is governed by the depth ceilings
              // rather than by defect evidence and must be analysed separately.
              // PG >= 9.0 is the reliable test here; the RG v3 >= 9.0 equivalent
              // is derived offline from rawSubscoresFrom + depthFrom.
              highGradeTrack: (pgFrom != null && pgFrom >= 9.0),
            };
          })(),
          inputTokens: _inputTokens,
          outputTokens: _outputTokens,
          cacheReadInputTokens: _cacheReadInputTokens,
          cacheCreationInputTokens: _cacheCreationInputTokens,
          // S15 May 28: per-assessment dollar cost (Opus 4.8). Same rate
          // block as assess.js — if model changes, update both.
          // S22 2026-10-11: this block used to hardcode the cache-read
          // multiplier at 0.05, while api/assess.js hardcoded 0.10. Exactly one
          // of them was right at any moment, and the Opus 5.5 cut-over flipped
          // which. Both now call the one helper in lib/model.js, which carries
          // the multiplier PER MODEL. Deep does not currently send
          // CORRECTION 2026-10-12: an earlier version of this comment claimed
          // Deep "does not currently send cache_control at all". Wrong. Deep
          // splits its prompt at §§CACHE_SPLIT§§ and puts a 1h ephemeral
          // cache_control on the static half, and the breakpoint covers the
          // system text plus all 9 invariant images. What is true is that it is
          // GATED: DEEP_CACHE_ENABLED is (cacheProfile === 'batch'), so only
          // Batch passes cache and an ordinary user Deep never does. The cache
          // terms below are therefore zero on a standalone Deep and non-zero
          // inside a Batch.
          costUsd: costOf({
            input_tokens: _inputTokens || 0,
            output_tokens: _outputTokens || 0,
            cache_read_input_tokens: _cacheReadInputTokens || 0,
            cache_creation_input_tokens: _cacheCreationInputTokens || 0
          }, PRIMARY_MODEL, '1h'),
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

    // S22 — THE DOUBLE-CHARGE BUG. This stamp used to sit INSIDE the wantsSSE
    // branch below, so the plain-JSON return shipped a Deep result with no
    // creditsRemaining on it. The client's applyServerCredits() keys on exactly
    // that field: no field means "the server did not take the credit", so
    // onAssessmentSuccess() falls through to decrementCredit() and takes a
    // SECOND one — after this endpoint already debited. Every non-streaming
    // Deep charged twice.
    // That is the reported symptom exactly: a new account with 3 free credits
    // runs one Main (-1, synced correctly, because api/assess.js has always
    // stamped this ABOVE its own wantsSSE branch) and then one Deep (-1 here,
    // -1 again on the client) and lands on 0 instead of 1.
    // Streaming clients were unaffected, which is why it survived: the desktop
    // PWA streams. A WebView that cannot read the stream falls back to plain
    // JSON — and the native builds are the ones in users' hands.
    // The stamp now sits above the branch, identical to api/assess.js. Keep
    // these two shaped the same; the asymmetry WAS the bug.
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
    // The Deep failed, so the user keeps their credit.
    await _refundIfDebited('deep error: ' + String((err && err.message) || err).slice(0, 120));
    phaseTimings.totalMs = Date.now() - T0;
    phaseTimings.errorAtMs = phaseTimings.totalMs;
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `deep_err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.collection('assessment_timings').doc(key).set({
          // S22: what this assessment COST THE USER in credits. Nothing recorded
          // this before, so the admin's "cost per credit" was really cost per
          // ASSESSMENT — a lower, different number. Gross: a later refund is
          // subtracted from the ledger / the item's refund stamp, not from here.
          creditsCharged: (typeof _CREDIT_COST === 'number') ? _CREDIT_COST : null,
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          epoch: GRADING_EPOCH,   // pool by THIS, not by version - see lib/version.js
          model: PRIMARY_MODEL,
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
