// =============================================================================
// api/assess_full.js — Full Assessment verification endpoint
// =============================================================================
//
// Architecture (v4.0, May 2026 — feature parked, wire up later):
//   Takes a list of interior 2-page-spread images for one of 12 hand-picked
//   high-value books. Does NOT regrade — the grade is locked from the initial
//   + deep assessment. This endpoint only VERIFIES that:
//     (a) the book qualifies (title+issue match the 12-book whitelist, raw)
//     (b) each provided image is an interior page (not a cover, selfie, or
//         unrelated image)
//     (c) the set has no obvious duplicates
//
// On pass: server returns { verified: true, fullAssessmentRan: true } and the
// client marks the book Gold across detail/list/label/public views. The credit
// charged on the client side is consumed.
//
// On reject: server returns { rejected: true, refund: true, reasons, imageIssues }
// and the client refunds the credit. The user is asked to fix the offending
// images and try again.
//
// Why "weak" verification (per Matt's Q1 answer May 26):
//   The owner of one of these 12 books is not going to risk fabricating
//   interior images. Anyone considering a purchase will scrutinize the photos
//   themselves; the threat of being caught is sufficient deterrent. The server
//   only needs to confirm each image is plausibly a comic interior page from
//   roughly the right era — not page-by-page sequence verification.
//
// Streaming/SSE: this endpoint supports SSE so the client modal can advance
// through the verification visibly. Three phases:
//   phase 0 (populating)   — eligibility check passed, about to call Anthropic
//   phase 1 (mint)         — first text token received
//   phase 2 (verifying)    — model has reached the verdict portion of output
//   phase 3 (confirming)   — verdict + reasons captured
//
// =============================================================================
import { ROBOGRADE_VERSION } from '../lib/version.js';
import { anthropicWithRetry } from '../lib/anthropic_retry.js';
import { computePhotograderPM, mergePhotograder, PHOTOGRADER_RUBRIC_CLOSEUP } from '../lib/photograder.js';

// ── S15 May 30: Full Assessment REDESIGN (8 fixed named slots) ───────────────
// The old design required 16/32 two-page-spread photos per book — impractical
// to shoot on a $10k+ book, expensive to store/assess, and a maintenance
// burden (per-book page-count tracking). The redesign uses 8 FIXED, NAMED,
// ACTUALLY-ASSESSED slots that represent the book's completeness far more
// practically. Each slot has a defined purpose and its own examination
// standard (see SLOT_SPECS + the prompt builder below).
//
// This endpoint now does a REAL (if lighter-than-initial) assessment, not just
// presence-verification. It examines the 6 images (S20 #36) by their per-slot
// standards and may adjust the grade. Page quality is FROZEN at the initial
// call (the interior covers that informed PQ moved to Deep). Precision
// modifier may go as low as 1 (or 0) — the 6 images give a near-complete view.
//
// GATE (widened): a book qualifies for Full Assessment if it is on the Deep
// Assessment list (the historic high-value set) OR it cleared a basic quality
// bar — RoboScore >= 30 OR predicted grade >= 3.0. The lighter imagery/storage
// demand makes a wider net practical. Slabbed books are still excluded (can't
// shoot the interior through a case).
// S20 (#36): Full drops to 6 slots. Interior Front / Interior Back moved to the
// Deep pass (interior-cover condition is now judged there). Full covers staples,
// page completeness, outer edge/trimming, and interior staples only.
const FULL_SLOT_COUNT = 6;

// The 6 slots, in order. `key` is the storage slot name; `label` is the
// user-facing name; `exam` is what the model examines this image for.
const FULL_SLOTS = [
  { key: 'exterior_top_staple', label: 'Exterior Top Staple',
    exam: 'Close-up of the TOP staple from the OUTSIDE of the spine. Macro zoom. Examine for rust, discoloration, wear around the staple hole, popped or missing staple.' },
  { key: 'exterior_bottom_staple', label: 'Exterior Bottom Staple',
    exam: 'Close-up of the BOTTOM staple from the OUTSIDE of the spine. Macro zoom. Examine for rust, discoloration, wear around the staple hole, popped or missing staple.' },
  { key: 'top_pages', label: 'Top Pages',
    exam: 'Looking down at the TOP of the book, showing the tops of all pages with the centerfold crease visible and a portion of the cover (to confirm it is the same book). Examine for tears, frays, and any sign that interior pages are missing or married (stuck/foreign pages).' },
  { key: 'bottom_pages', label: 'Bottom Pages',
    exam: 'Same as Top Pages but looking UP from the BOTTOM of the book. Together with Top Pages this confirms the interior pages are complete. Examine for tears, frays, missing or married pages.' },
  { key: 'outer_edge', label: 'Outer Edge',
    exam: 'The OUTER edge of the book (opposite the spine) with the back cover shown in raking light. Examine for tears and frays, and for signs of TRIMMING (an unnaturally clean, straight, or fresh-cut edge; reduced page margins). Trimming is very difficult to detect reliably — only flag it when the evidence is clear, and phrase any trimming observation cautiously.' },
  { key: 'interior_staple', label: 'Interior Staples',
    exam: 'Same close framing of both staples but from the INSIDE of the book (centerfold). Examine for rust, wear, popped staples, and any sign the staples were replaced or disturbed.' }
];
const SPEC_BY_KEY = Object.fromEntries(FULL_SLOTS.map(s => [ s.key, s ]));


// The historic high-value "Deep Assessment list" — these always qualify for
// Full Assessment regardless of score. Kept as a title/issue set so the
// server can recognize them. (The client mirrors this list for Deep
// eligibility; keep in sync if it changes.)
const DEEP_LIST_BOOKS = [
  { title: 'action comics', issue: '1' },
  { title: 'superman', issue: '1' },
  { title: 'detective comics', issue: '27' },
  { title: 'batman', issue: '1' },
  { title: 'all-star comics', issue: '8' },
  { title: 'marvel comics', issue: '1' },
  { title: 'captain america comics', issue: '1' },
  { title: 'amazing fantasy', issue: '15' },
  { title: 'fantastic four', issue: '1' },
  { title: 'incredible hulk', issue: '1' },
  { title: 'x-men', issue: '1' },
  { title: 'uncanny x-men', issue: '1' },
  { title: 'tales of suspense', issue: '39' }
];

// Server-side title normalization. MUST stay aligned with the client's
// normalizeTitle() — keep this in sync if the client normalizer changes.
function normalizeTitleServer(t) {
  if (!t) return '';
  let s = String(t).trim().toLowerCase();
  s = s.replace(/^the\s+/i, '');     // strip leading "the"
  s = s.replace(/\s+/g, ' ');         // collapse whitespace
  return s;
}

function normalizeIssueServer(i) {
  if (i == null) return '';
  let s = String(i).trim().replace(/^#/, '');
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function isDeepListBook(title, issue) {
  const t = normalizeTitleServer(title);
  const i = normalizeIssueServer(issue);
  return DEEP_LIST_BOOKS.some(b => b.title === t && b.issue === i);
}

// S20 (#37): Full is gated CLIENT-SIDE on a completed Deep assessment AND FMV
// tier >= 7 ($1000+), and every run costs a credit. The old server score/grade
// floor is removed: it would wrongly reject legitimately-valuable LOW-grade keys
// (tier 7+ despite a low grade). The slabbed + prereq checks below still apply,
// so a book only reaches here after Main + Deep have run.
function isFullEligible({ title, issueNumber, fmvTier }) {
  // Historic mega-keys always qualify (server-authoritative list, independent
  // of the client).
  if (isDeepListBook(title, issueNumber)) return { eligible: true, reason: 'deep-list' };
  // Everything else must be FMV tier >= 7 ($1000+). The client computes fmvTier
  // (matchFMV) and sends it. A client from BEFORE the FMV-tier-7 gate (the old
  // grade/score gate that wrongly unlocked Full on high-grade low-value books)
  // omits fmvTier -> treated as ineligible here. This is the server backstop the
  // gate previously lacked (it used to trust the client entirely).
  const t = Number(fmvTier);
  if (Number.isFinite(t) && t >= 7) return { eligible: true, reason: 'fmv-tier7' };
  return { eligible: false, reason: 'fmv-below-tier7' };
}

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

  // ── SSE setup (mirrors assess.js / assess_deep.js v3.99c+) ──────────────────
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

  // ── lazy Firestore admin ────────────────────────────────────────────────────
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
    title = '',
    issueNumber = '',
    interiorImages = [],          // 6 images (S20 #36), ORDER MATCHES slotKeys (or default FULL_SLOTS)
    slotKeys = null,              // client's slot order for these images
    labelDetected = false,
    initialAssessmentComplete = false,
    deepAssessmentComplete = false,
    roboScore = null,             // 0-100 RG score (for the widened gate)
    predictedGrade = null,        // 0.5-10.0 CGC-scale grade (retained for context; no longer gates)
    fmvTier = null,               // S21: FMV tier (matchFMV) computed by the client; Full needs >= 7 ($1000+)
    initialPageQuality = '',      // the initial PQ call, so the model can re-judge it
    priorConditionAssessment = '',// the existing Condition Assessment text to integrate into
    priorDefectNotes = '',        // the existing Defect Notes (bullets), for context
    initialAssessment = null,     // optional: the initial assessment JSON for context
    photograder = null            // S21: the running Photograder record (prior tiers)
  } = req.body || {};

  // Eligibility check 1: FMV gate — Deep-list mega-key OR FMV tier >= 7 ($1000+).
  const elig = isFullEligible({ title, issueNumber, fmvTier });
  if (!elig.eligible) {
    return sseError(400, {
      error: 'INELIGIBLE_BOOK',
      message: 'Full Assessment requires an FMV of $1,000+ (tier 7) or a book on the high-value list. If your app is out of date, please update it and try again.'
    });
  }

  // Eligibility check 2: must be raw. Slabbed books can't be interior-photo'd.
  if (labelDetected === true) {
    return sseError(400, {
      error: 'INELIGIBLE_SLABBED',
      message: 'Full Assessment requires a raw book. Slabbed books cannot have interior photos.'
    });
  }

  // Eligibility check 3: both initial AND deep must be done first.
  if (!initialAssessmentComplete || !deepAssessmentComplete) {
    return sseError(400, {
      error: 'INELIGIBLE_PREREQ',
      message: 'Full Assessment unlocks only after both initial and Deep Assessments are complete.'
    });
  }

  // Eligibility check 4: exactly 6 images, in slot order.
  if (!Array.isArray(interiorImages) || interiorImages.length !== FULL_SLOT_COUNT) {
    return sseError(400, {
      error: 'WRONG_SLOT_COUNT',
      message: `Full Assessment requires exactly ${FULL_SLOT_COUNT} images (one per named slot). Received ${Array.isArray(interiorImages) ? interiorImages.length : 0}.`,
      requiredSlots: FULL_SLOT_COUNT
    });
  }

  // Normalize each interior image into an Anthropic image block. Accept either
  // raw base64-data-URL strings or pre-formed image blocks.
  function toImageBlock(item) {
    if (item && typeof item === 'object' && item.type === 'image') return item;
    if (typeof item === 'string' && item.startsWith('data:')) {
      const m = item.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!m) return null;
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    }
    return null;
  }
  const imageBlocks = interiorImages.map(toImageBlock);
  if (imageBlocks.some(b => !b)) {
    return sseError(400, {
      error: 'BAD_IMAGE_FORMAT',
      message: 'Each interior image must be a base64 data URL or Anthropic image block.'
    });
  }

  // ── S15 May 30 / S20 #36: real 6-slot Full Assessment prompt ────────────────
  // Each image maps to a named slot with its own examination standard. The
  // model examines all 6, may ADJUST the grade (structural findings can move it).
  // Page quality is FROZEN at the initial Main assessment's call (S20 #36: the
  // interior-cover photos that used to inform PQ moved to the Deep pass).
  // Precision modifier may go as low as 1 or 0 — the 6 images give a near-
  // complete view of the book's structure and page completeness.
  // Align the per-image examination specs to the order the client actually sent
  // (slotKeys). Falls back to the default FULL_SLOTS order. This keeps image i
  // mapped to the right slot guidance even if the client reorders capture/storage.
  const orderedSpecs = Array.isArray(slotKeys) && slotKeys.length === FULL_SLOT_COUNT && slotKeys.every(k => SPEC_BY_KEY[k]) ? slotKeys.map(k => SPEC_BY_KEY[k]) : FULL_SLOTS;
  const slotList = orderedSpecs.map((s, i) => `${i + 1}. ${s.label} (image ${i + 1}): ${s.exam}`).join('\n');

  const initialContext = initialAssessment ? `\nINITIAL ASSESSMENT (for context — do not re-grade the cover from scratch; these 6 images are about the book's STRUCTURE and page completeness):\n${typeof initialAssessment === 'string' ? initialAssessment.slice(0, 4000) : JSON.stringify(initialAssessment).slice(0, 4000)}\n` : '';

  const priorBlock = priorConditionAssessment && priorConditionAssessment.trim()
    ? `\nPRIOR CONDITION ASSESSMENT (the existing buyer-facing write-up you are UPDATING — integrate the new findings into this; keep its accurate observations, do not contradict the cover findings without cause):\n"""\n${String(priorConditionAssessment).slice(0, 2500)}\n"""\n`
    : '\n(No prior Condition Assessment text was provided — write a brief one from the interior/structure findings.)\n';
  const priorDefectBlock = priorDefectNotes && priorDefectNotes.trim()
    ? `\nPRIOR DEFECT NOTES (context only):\n${String(priorDefectNotes).slice(0, 1500)}\n`
    : '';

  const systemPrompt = `You are performing a FULL ASSESSMENT of a vintage comic book. The book already has a grade and a written Condition Assessment from the initial (cover + corner) passes. Your job is to examine 6 specific STRUCTURAL images and INTEGRATE what they reveal into the existing Condition Assessment — not to re-grade the book from scratch.

You will receive exactly 6 images, in this fixed order, each with its own purpose:
${slotList}
${initialContext}${priorBlock}${priorDefectBlock}
WHAT TO DO WITH EACH IMAGE GROUP:
- Staple condition: from the Exterior Top Staple, Exterior Bottom Staple, and Interior Staples photos — note rust, wear, popping, or replacement only if present.
- Page completeness: from the Top Pages and Bottom Pages photos — confirm the interior pages are complete; flag missing or married pages only if you actually see evidence.
- Outer edge / trimming: from the Outer Edge photo — note frays or clear trimming signs only if present.
- Page quality: DO NOT change page quality. It is fixed at the initial assessment's call (${initialPageQuality || 'not provided'}) and this pass does not re-judge it. (The interior-cover photos that used to inform page quality are now handled by the Deep pass.)

WRITING THE FULL-ASSESSMENT WRITE-UP (S20: a SEPARATE field "fullAssessment"):
- Do NOT touch, repeat, or rewrite the prior Condition Assessment. Return "aiAssessment" exactly as it was given.
- In the new field "fullAssessment", write ONLY the new findings from these 6 structure images: staple condition, page completeness (missing/married pages), and any outer-edge / trimming observation.
- Mention tears or defects ONLY if actually visible. If the structure is clean, say the staples, pages, and edges confirmed the grade — do not pad and do not repeat cover findings.
- Mention trimming ONLY in the very rare case of genuine, clear signs. Keep it buyer-facing, factual, and concise (2-4 sentences).

GRADE — IMPORTANT:
- It is UNLIKELY the grade changes. Default to keeping the existing grade.
- If it changes, it is almost always DOWNWARD, from newly discovered defects (staple damage, interior tanning, missing pages, trimming).
- Only in a very rare case may the grade go UP, and only if the new photos cause you to reconsider a SPECIFIC defect that was previously assigned (e.g. something counted against the cover that the interior shows was not actually a defect). A higher grade must be explainable that way; never inflate from a generally clean interior.

PAGE QUALITY: do NOT change it — return the initial page-quality call unchanged and set pageQualityChanged to "same".
PRECISION MODIFIER: with 6 images covering the structure and page completeness, your view is near-complete. Set confidenceRange as low as you honestly can — 1 for a clean, fully-documented book; 0 only if certain. Widen only for specific, nameable image-quality problems (glare, blur, hidden angle).

${PHOTOGRADER_RUBRIC_CLOSEUP}

## RESPONSE FORMAT — STRICT
Your entire response must be a JSON object and nothing else. First character an opening curly brace, last character a closing curly brace. No text before or after.

JSON shape:
{
  "grade": <number, final CGC-scale grade 0.5-9.9 — this should reflect the PRIOR defects already identified in the main assessment. The Full Assessment examines interior structure but the PREDICTED GRADE should be consistent with the defects found on the covers/spine. A book with ANY defect listed cannot be 9.8 or above. NEVER return 10.0. If the prior predicted grade seems correct given the defects, return it unchanged. Only LOWER the grade if interior examination reveals new problems (trimming, missing pages, detached centerfold). Do NOT raise the grade above the prior prediction unless you can specifically explain why a prior defect was overestimated.>,
  "gradeChanged": "<'same' | 'down' | 'up'>",
  "pageQuality": "<the initial page-quality designation, UNCHANGED — do not re-judge it>",
  "pageQualityChanged": "same",
  "confidenceRange": <number, precision modifier, 0-6 — go as low as 1 or 0 when warranted>,
  "photograder": { "focus": "A", "lighting": "A", "flags": [ {"category":"lighting","image":"Interior","note":"shadow across gutter"} ] },
  "fullAssessmentRan": true,
  "aiAssessment": ${JSON.stringify(typeof priorConditionAssessment === 'string' ? priorConditionAssessment : '')},
  "fullAssessment": "<ONLY the new Full-Assessment findings from the 6 structure images — staples, page completeness, outer edge / trimming. Do NOT repeat the prior Condition Assessment. 2-4 sentences; if the structure is clean, say it confirmed the grade.>",
  "slotFindings": [
    { "slot": "exterior_top_staple", "observations": "<what you saw — concise>" }
  ],
  "interiorComplete": <true | false — false only if Top/Bottom Pages show missing/married pages>,
  "trimmingSuspected": <true | false — only true with clear Outer Edge evidence>,
  "fullAssessmentNotes": "<1-3 sentence internal summary of what the interior/structure pass found and any grade/PQ effect>"
}

Rules:
- Include a slotFindings entry for EACH of the 6 slots, in order, with brief observations.
- Every "observations" string concise. fullAssessmentNotes ≤ 3 sentences.
- Never mention internal references, census data, or grade priors. Report only what these 6 images show, integrated with the prior assessment text.
`;

  try {
    markPhase('promptAssemblyAtMs');
    const _primaryStart = Date.now();

    sseEvent('phase', { phase: 0, name: 'populating' });

    const _antBody = {
      model: 'claude-opus-5',
      // S15 May 29: effort=medium via output_config + adaptive thinking
      // enabled. See assess.js for full rationale comments — same setup here.
      // Thinking helps the calibration step (defects → grade); medium scopes
      // its depth. Parser at line ~456 handles thinking blocks correctly.
      output_config: { effort: 'medium' },
      thinking: { type: 'adaptive' },
      // S15 May 29: bumped 2048 → 8192. Thinking tokens count toward
      // max_tokens. Full's per-image output is small (one issue note per image), so 4k
      // headroom is enough.
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `6 FULL ASSESSMENT IMAGES, in slot order (${FULL_SLOTS.map(s => s.label).join(', ')}):` },
          ...imageBlocks,
          { type: 'text', text: 'Verify these images and return the JSON.' }
        ]
      }]
    };

    let text;
    let _inputTokens = null, _outputTokens = null, _cacheReadInputTokens = null;
    let _cacheCreationInputTokens = null, _stopReason = null, _responseModel = null;

    if (wantsSSE) {
      _antBody.stream = true;
      const ctrl = new AbortController();
      // Verification is image-heavy (up to 32 images). Allow more time than
      // the standard 55s ceiling — Vercel kills functions at 60s anyway.
      const _streamTimeout = setTimeout(() => ctrl.abort(), 58000);

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
          { deadlineMs: 58000, maxAttempts: 3, label: 'full-stream' }
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
            // Phase 2 fires when the model has produced the verification verdict.
            // Phase 3 fires when imageIssues array appears (or stream ends).
            if (!phasesEmitted.has(2) && accumulated.includes('"verified"')) {
              sseEvent('phase', { phase: 2, name: 'verifying' });
              phasesEmitted.add(2);
            }
            if (!phasesEmitted.has(3) && accumulated.includes('"imageIssues"')) {
              sseEvent('phase', { phase: 3, name: 'confirming' });
              phasesEmitted.add(3);
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

      // Safety net for any unfired phases.
      for (const [p, n] of [[1,'mint'],[2,'verifying'],[3,'confirming']]) {
        if (!phasesEmitted.has(p)) { sseEvent('phase', { phase: p, name: n }); phasesEmitted.add(p); }
      }
    } else {
      // Non-streaming branch
      const ctrl = new AbortController();
      const _to = setTimeout(() => ctrl.abort(), 58000);
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
          { deadlineMs: 58000, maxAttempts: 3, label: 'full' }
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
      const errPayload = { error: 'Failed to parse verification response: ' + (text || '').slice(0, 500), _diagnostics: { phaseTimings, parseError: true } };
      if (wantsSSE) {
        sseEvent('error', errPayload);
        try { res.end(); } catch (err) {}
        return;
      }
      return res.status(500).json(errPayload);
    }
    phaseDelta('primaryParseMs', _primaryParseStart);

    // S15 May 30: parse the grade-bearing Full Assessment response. This is no
    // longer a verified/rejected verdict — it's an actual (lighter) assessment
    // that may adjust the grade and re-judge page quality. Defensive
    // normalization keeps the client contract stable across model variation.
    const _num = (v, lo, hi, dflt) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    };
    const grade = Math.min(_num(parsed.grade, 0.5, 10.0, parseFloat(predictedGrade) || null), 9.9);
    // S21 Photograder: Full sees close-up strips → grades Focus/Lighting only;
    // Cropping/Angle carry forward from Main via the merge. The PM is
    // monotonically clamped against the prior tier's PM (the Deep result), and
    // it becomes both the ± and the score ceiling (100 − PM). Full runs only on
    // raw books, so slabbed is always false here.
    // The client sends the running Photograder as a top-level `photograder`
    // param, and `initialAssessment` IS the prior roboGrade (so its
    // confidenceRange is the prior tier's PM).
    const _fullPriorPG = photograder || null;
    const _fullPriorPM = (initialAssessment && typeof initialAssessment === 'object' && typeof initialAssessment.confidenceRange === 'number')
      ? initialAssessment.confidenceRange : null;
    const _fullPG = mergePhotograder(_fullPriorPG, parsed.photograder);
    const confidenceRange = computePhotograderPM(_fullPG, 'full', false, _fullPriorPM);
    _fullPG.pm = confidenceRange;
    _fullPG.tier = 'full';
    // S20 (#36): page quality is FROZEN at the initial Main call. Full no longer
    // sees the interior-cover photos (moved to Deep), so it does not re-judge PQ.
    // Force the initial value when we have one; only fall back to the model's
    // value if no initial PQ was supplied.
    const pageQuality = (initialPageQuality && String(initialPageQuality).trim())
      ? String(initialPageQuality).trim()
      : ((typeof parsed.pageQuality === 'string' && parsed.pageQuality.trim()) ? parsed.pageQuality.trim() : '');
    const pageQualityChanged = 'same';
    const slotFindings = Array.isArray(parsed.slotFindings)
      ? parsed.slotFindings.filter(x => x && typeof x === 'object').slice(0, FULL_SLOT_COUNT) : [];
    const imageIssues = Array.isArray(parsed.imageIssues)
      ? parsed.imageIssues.filter(x => x && typeof x.index === 'number').slice(0, FULL_SLOT_COUNT) : [];
    const interiorComplete = parsed.interiorComplete !== false; // default true unless explicitly false
    const trimmingSuspected = parsed.trimmingSuspected === true;
    const fullAssessmentNotes = (typeof parsed.fullAssessmentNotes === 'string')
      ? parsed.fullAssessmentNotes.trim() : '';
    const aiAssessment = (typeof parsed.aiAssessment === 'string' && parsed.aiAssessment.trim())
      ? parsed.aiAssessment.trim() : '';
    // S20 (#53): Full observations live in their own field, not appended to aiAssessment.
    const fullAssessment = (typeof parsed.fullAssessment === 'string' && parsed.fullAssessment.trim())
      ? parsed.fullAssessment.trim() : '';
    const gradeChanged = ['same', 'up', 'down'].includes(parsed.gradeChanged) ? parsed.gradeChanged : 'same';

    // A Full Assessment always "runs" (it produces a grade); there is no
    // refund/rejection path anymore. imageIssues simply note any unusable
    // images — they don't void the assessment.
    const result = {
      fullAssessmentRan: true,
      grade,
      gradeChanged,
      pageQuality,
      pageQualityChanged,
      confidenceRange,
      aiAssessment,
      fullAssessment,
      slotFindings,
      interiorComplete,
      trimmingSuspected,
      fullAssessmentNotes,
      imageIssues,
      title: normalizeTitleServer(title),
      issue: normalizeIssueServer(issueNumber),
      slotCount: FULL_SLOT_COUNT,
      eligibility: elig.reason,
      // S16: Recompute the RoboScore from the revised CGC grade. With 8
      // interior/structure images on top of the main + corner photos, the
      // evidence is near-complete. The score ceiling is 100 - confidenceRange
      // (which can be 0 for a fully-documented, pristine book). This lets
      // the Full Assessment score exceed the Deep ceiling (97) when the
      // interior confirms a near-perfect book.
      // S16: RG score from Full Assessment. The 9.8 grade cap prevents 10.0,
      // and the prompt instructs consistency with prior defects, but the Full
      // Assessment CAN adjust the grade in either direction if justified.
      roboScore: Math.min(Math.round(grade * 10), 100 - confidenceRange),
      photograder: _fullPG,
      _diagnostics: { phaseTimings }
    };

    phaseTimings.totalMs = Date.now() - T0;
    result._diagnostics.phaseTimings = phaseTimings;

    // Timing record for diagnostics
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `full_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // S20 (#33): return the log's doc key so the client persists it on the
        // item (assessmentTimingKeys) — the bridge for admin Logs → open item.
        result._diagnostics.timingKey = key;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          model: 'claude-opus-5',
          fullAssessment: true,
          grade,
          pageQuality,
          pageQualityChanged,
          confidenceRange,
          interiorComplete,
          trimmingSuspected,
          title: normalizeTitleServer(title),
          issue: normalizeIssueServer(issueNumber),
          slotCount: FULL_SLOT_COUNT,
          issueCount: imageIssues.length,
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
          imageCount: imageBlocks.length,
          rawText: typeof text === 'string' ? text.slice(0, 8000) : null,
          timedOut: false
        });
      }
    } catch (e) {
      console.error('full timing write failed (non-fatal):', e);
    }

    if (wantsSSE) {
      sseEvent('result', result);
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(200).json(result);
  } catch (err) {
    phaseTimings.totalMs = Date.now() - T0;
    phaseTimings.errorAtMs = phaseTimings.totalMs;
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `full_err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          model: 'claude-opus-5',
          fullAssessment: true,
          imageCount: Array.isArray(imageBlocks) ? imageBlocks.length : 0,
          costUsd: 0,
          errorMessage: String(err.message || err).slice(0, 500),
          timedOut: /timeout|abort/i.test(String(err.message || err))
        });
      }
    } catch (e) {
      console.error('full err timing write failed (non-fatal):', e);
    }
    const errPayload = { error: err.message, _diagnostics: { phaseTimings } };
    if (wantsSSE) {
      sseEvent('error', errPayload);
      try { res.end(); } catch (e) {}
      return;
    }
    return res.status(500).json(errPayload);
  }
}
