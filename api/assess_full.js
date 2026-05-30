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
const ROBOGRADE_VERSION = '4.15';

// ── S15 May 30: Full Assessment REDESIGN (8 fixed named slots) ───────────────
// The old design required 16/32 two-page-spread photos per book — impractical
// to shoot on a $10k+ book, expensive to store/assess, and a maintenance
// burden (per-book page-count tracking). The redesign uses 8 FIXED, NAMED,
// ACTUALLY-ASSESSED slots that represent the book's completeness far more
// practically. Each slot has a defined purpose and its own examination
// standard (see SLOT_SPECS + the prompt builder below).
//
// This endpoint now does a REAL (if lighter-than-initial) assessment, not just
// presence-verification. It examines the 8 images by their per-slot standards,
// may adjust the grade, and re-judges page quality up or down. Precision
// modifier may go as low as 1 (or 0) — the 8 images give a near-complete view.
//
// GATE (widened): a book qualifies for Full Assessment if it is on the Deep
// Assessment list (the historic high-value set) OR it cleared a basic quality
// bar — RoboScore >= 30 OR predicted grade >= 3.0. The lighter imagery/storage
// demand makes a wider net practical. Slabbed books are still excluded (can't
// shoot the interior through a case).
const FULL_SLOT_COUNT = 8;

// The 8 slots, in order. `key` is the storage slot name; `label` is the
// user-facing name; `exam` is what the model examines this image for.
const FULL_SLOTS = [
  { key: 'interior_front', label: 'Interior Front',
    exam: 'A 2-page spread of the inside front cover and first page. Examine for tanning, tears, foxing, stains, and other common interior defects. No cropping — the full spread should be visible.' },
  { key: 'interior_back', label: 'Interior Back',
    exam: 'A 2-page spread of the last page and inside back cover. Same examination as Interior Front: tanning, tears, foxing, stains, common interior defects.' },
  { key: 'exterior_staple', label: 'Exterior Staple',
    exam: 'Corner-macro zoom level, framing BOTH staples from the OUTSIDE of the book (the spine exterior). Examine closely for rust, discoloration, wear around the staple holes, and popped or missing staples.' },
  { key: 'interior_staple', label: 'Interior Staple',
    exam: 'Same close framing of both staples but from the INSIDE of the book (centerfold). Examine for rust, wear, popped staples, and any sign the staples were replaced or disturbed.' },
  { key: 'top_pages', label: 'Top Pages',
    exam: 'Looking down at the TOP of the book, showing the tops of all pages with the centerfold crease visible and a portion of the cover (to confirm it is the same book). Examine for tears, frays, and any sign that interior pages are missing or married (stuck/foreign pages).' },
  { key: 'bottom_pages', label: 'Bottom Pages',
    exam: 'Same as Top Pages but looking UP from the BOTTOM of the book. Together with Top Pages this confirms the interior pages are complete. Examine for tears, frays, missing or married pages.' },
  { key: 'outer_edge', label: 'Outer Edge',
    exam: 'A reversal of the Spine image — the OUTER edge of the book (opposite the spine) with the back cover shown in raking light. Examine for tears and frays, and for signs of TRIMMING (an unnaturally clean, straight, or fresh-cut edge; reduced page margins). Trimming is very difficult to detect reliably — only flag it when the evidence is clear, and phrase any trimming observation cautiously.' },
  { key: 'interior_spread', label: 'Interior Spread',
    exam: 'A 2-page spread of the SECOND and THIRD interior story pages. Examine the same way the initial Interior image was examined, and decide whether the initial page-quality assessment should remain, move up, or move down.' }
];


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

// S15 May 30 widened gate: eligible if on the Deep list OR meets a basic
// quality bar (RoboScore >= 30 OR predicted grade >= 3.0). roboScore is the
// 0-100 RG score; predictedGrade is the 0.5-10.0 CGC-scale grade.
// S15 May 30 gate (corrected): eligible if it is a Deep-list book AND has a
// RoboScore >= 30, OR (independently) has a predicted grade >= 3.0. Deep-list
// membership alone is NOT enough — a low-scoring copy of a key book doesn't
// warrant Full Assessment. The grade>=3.0 path lets any decent-condition book
// qualify regardless of list membership.
function isFullEligible({ title, issueNumber, roboScore, predictedGrade }) {
  const score = Number(roboScore);
  const grade = parseFloat(predictedGrade);
  if (isDeepListBook(title, issueNumber) && Number.isFinite(score) && score >= 30) {
    return { eligible: true, reason: 'deep-list+score>=30' };
  }
  if (Number.isFinite(grade) && grade >= 3.0) {
    return { eligible: true, reason: 'grade>=3.0' };
  }
  return { eligible: false, reason: 'below-threshold' };
}

export default async function handler(req, res) {
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
    interiorImages = [],          // 8 images, ORDER MATCHES FULL_SLOTS
    labelDetected = false,
    initialAssessmentComplete = false,
    deepAssessmentComplete = false,
    roboScore = null,             // 0-100 RG score (for the widened gate)
    predictedGrade = null,        // 0.5-10.0 CGC-scale grade (for the widened gate)
    initialPageQuality = '',      // the initial PQ call, so the model can re-judge it
    initialAssessment = null      // optional: the initial assessment JSON for context
  } = req.body || {};

  // Eligibility check 1: widened gate (Deep-list OR score>=30 OR grade>=3.0).
  const elig = isFullEligible({ title, issueNumber, roboScore, predictedGrade });
  if (!elig.eligible) {
    return sseError(400, {
      error: 'INELIGIBLE_BOOK',
      message: 'Full Assessment requires a book on the high-value list, or a RoboScore of 30+ / a predicted grade of 3.0+.'
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

  // Eligibility check 4: exactly 8 images, in slot order.
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

  // ── S15 May 30: real 8-slot Full Assessment prompt ──────────────────────────
  // Each image maps to a named slot with its own examination standard. The
  // model examines all 8, may ADJUST the grade (interior/structural findings
  // can move it), and re-judges page quality up/down from the Interior Spread.
  // Precision modifier may go as low as 1 or 0 — the 8 images give a near-
  // complete view of the book's interior and structure.
  const slotList = FULL_SLOTS.map((s, i) =>
    `${i + 1}. ${s.label} (image ${i + 1}): ${s.exam}`
  ).join('\n');

  const initialContext = initialAssessment
    ? `\nINITIAL ASSESSMENT (for context — do not re-grade the cover from scratch; these 8 images are about the INTERIOR and STRUCTURE):\n${typeof initialAssessment === 'string' ? initialAssessment.slice(0, 4000) : JSON.stringify(initialAssessment).slice(0, 4000)}\n`
    : '';

  const systemPrompt = `You are performing a FULL ASSESSMENT of a vintage comic book — a deeper confirmation of an existing grade using 8 specific interior and structural images. You already have an initial grade (cover + corner macros). This pass examines the book's INTERIOR completeness and STRUCTURE, then settles on a final grade and page quality.

You will receive exactly 8 images, in this fixed order, each with its own purpose:
${slotList}
${initialContext}
HOW TO ASSESS:
- Examine each image by its specific standard above.
- The Interior Front/Back and Interior Spread images inform PAGE QUALITY and interior defect findings (tanning, tears, foxing, stains).
- The Exterior/Interior Staple images inform staple condition (rust, wear, replacement, popping).
- The Top Pages / Bottom Pages images confirm the interior is COMPLETE — look for missing or married pages, tears, frays.
- The Outer Edge image is for trimming detection (cautious — trimming is hard to detect; only flag with clear evidence) and edge defects.
- PAGE QUALITY: re-judge the initial page-quality call (${initialPageQuality || 'not provided'}) using the interior images. Decide whether it should stay, move up, or move down. The Interior Spread is your primary anchor.
- GRADE: you may ADJUST the grade based on what these interior/structural images reveal. A clean, complete interior with good staples supports the existing grade; discovered interior damage, missing pages, staple rust, or trimming evidence can lower it. Do not raise the grade above what the initial assessment supported on cover condition — interior findings confirm or reduce, they do not inflate.
- PRECISION MODIFIER: with 8 images covering the interior and structure, your view is near-complete. Set confidenceRange (the precision modifier) as low as you honestly can — 1 is appropriate for a clean, fully-documented book; 0 only if you are certain. Widen only for specific image-quality problems you can name (glare, blur, an angle that hides a needed detail).

## RESPONSE FORMAT — STRICT
Your entire response must be a JSON object and nothing else. First character an opening curly brace, last character a closing curly brace. No text before or after.

JSON shape:
{
  "grade": <number, final CGC-scale grade 0.5-10.0>,
  "pageQuality": "<final page quality designation, e.g. 'Off-White to White'>",
  "pageQualityChanged": "<'same' | 'up' | 'down'>",
  "confidenceRange": <number, precision modifier, 0-6 — go as low as 1 or 0 when warranted>,
  "fullAssessmentRan": true,
  "slotFindings": [
    { "slot": "interior_front", "observations": "<what you saw — concise>" }
  ],
  "interiorComplete": <true | false — false if Top/Bottom Pages suggest missing/married pages>,
  "trimmingSuspected": <true | false — only true with clear Outer Edge evidence>,
  "fullAssessmentNotes": "<2-4 sentence buyer-facing summary of the interior + structure findings and how they affected the grade>",
  "imageIssues": [
    { "index": <0-based>, "issue": "<≤15 words: image unusable / wrong subject / too blurred to assess>" }
  ]
}

Rules:
- Include a slotFindings entry for EACH of the 8 slots, in order, with brief observations.
- imageIssues ONLY for images that cannot be assessed (wrong subject, unusable). An empty array means all 8 were assessable. This does NOT block the grade — note what you could and flag the rest.
- Every "issue" and "observations" string concise. fullAssessmentNotes ≤ 4 sentences.
- Never mention internal references, census data, or grade priors. Report only what these 8 images show.
`;

  try {
    markPhase('promptAssemblyAtMs');
    const _primaryStart = Date.now();

    sseEvent('phase', { phase: 0, name: 'populating' });

    const _antBody = {
      model: 'claude-opus-4-8',
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
          { type: 'text', text: `8 FULL ASSESSMENT IMAGES, in slot order (${FULL_SLOTS.map(s => s.label).join(', ')}):` },
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
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(_antBody),
          signal: ctrl.signal
        });
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
    const grade = _num(parsed.grade, 0.5, 10.0, parseFloat(predictedGrade) || null);
    const confidenceRange = _num(parsed.confidenceRange, 0, 6, 1);
    const pageQuality = (typeof parsed.pageQuality === 'string' && parsed.pageQuality.trim())
      ? parsed.pageQuality.trim() : (initialPageQuality || '');
    const pageQualityChanged = ['same', 'up', 'down'].includes(parsed.pageQualityChanged)
      ? parsed.pageQualityChanged : 'same';
    const slotFindings = Array.isArray(parsed.slotFindings)
      ? parsed.slotFindings.filter(x => x && typeof x === 'object').slice(0, FULL_SLOT_COUNT) : [];
    const imageIssues = Array.isArray(parsed.imageIssues)
      ? parsed.imageIssues.filter(x => x && typeof x.index === 'number').slice(0, FULL_SLOT_COUNT) : [];
    const interiorComplete = parsed.interiorComplete !== false; // default true unless explicitly false
    const trimmingSuspected = parsed.trimmingSuspected === true;
    const fullAssessmentNotes = (typeof parsed.fullAssessmentNotes === 'string')
      ? parsed.fullAssessmentNotes.trim() : '';

    // A Full Assessment always "runs" (it produces a grade); there is no
    // refund/rejection path anymore. imageIssues simply note any unusable
    // images — they don't void the assessment.
    const result = {
      fullAssessmentRan: true,
      grade,
      pageQuality,
      pageQualityChanged,
      confidenceRange,
      slotFindings,
      interiorComplete,
      trimmingSuspected,
      fullAssessmentNotes,
      imageIssues,
      title: normalizeTitleServer(title),
      issue: normalizeIssueServer(issueNumber),
      slotCount: FULL_SLOT_COUNT,
      eligibility: elig.reason,
      _diagnostics: { phaseTimings }
    };

    phaseTimings.totalMs = Date.now() - T0;
    result._diagnostics.phaseTimings = phaseTimings;

    // Timing record for diagnostics
    try {
      const db = await getAdminDb();
      if (db) {
        const key = `full_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.collection('assessment_timings').doc(key).set({
          createdAt: new Date().toISOString(),
          totalMs: phaseTimings.totalMs,
          phases: phaseTimings,
          version: ROBOGRADE_VERSION,
          model: 'claude-opus-4-8',
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
          model: 'claude-opus-4-8',
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
