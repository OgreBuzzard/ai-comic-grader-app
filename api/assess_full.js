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
const ROBOGRADE_VERSION = '4.0';

// ── Eligibility whitelist ────────────────────────────────────────────────────
// 12 books that qualify for Full Assessment, with their required interior
// 2-page-spread slot count. Titles match what normalizeTitle() (the client's
// canonical normalizer) produces: lowercase, "the" prefix stripped, trimmed,
// single-spaced. Issues are bare integers.
const FULL_ASSESSMENT_BOOKS = [
  { title: 'action comics',           issue: '1',  slots: 32 },
  { title: 'superman',                issue: '1',  slots: 32 },
  { title: 'detective comics',        issue: '27', slots: 32 },
  { title: 'batman',                  issue: '1',  slots: 32 },
  { title: 'all-star comics',         issue: '8',  slots: 32 },
  { title: 'marvel comics',           issue: '1',  slots: 32 },
  { title: 'captain america comics',  issue: '1',  slots: 32 },
  { title: 'amazing fantasy',         issue: '15', slots: 16 },
  { title: 'fantastic four',          issue: '1',  slots: 16 },
  { title: 'incredible hulk',         issue: '1',  slots: 16 },
  { title: 'x-men',                   issue: '1',  slots: 16 },
  { title: 'tales of suspense',       issue: '39', slots: 16 }
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
  // Match the bare-integer form. Strip leading zeros, drop "#" prefix, trim.
  let s = String(i).trim().replace(/^#/, '');
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s; // Annual, special, etc. — falls through (won't match whitelist).
}

function getEligibleBook(title, issue) {
  const t = normalizeTitleServer(title);
  const i = normalizeIssueServer(issue);
  return FULL_ASSESSMENT_BOOKS.find(b => b.title === t && b.issue === i) || null;
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
    interiorImages = [],          // [{type, source} blocks] or [data URLs]
    labelDetected = false,
    initialAssessmentComplete = false,
    deepAssessmentComplete = false
  } = req.body || {};

  // Eligibility check 1: title+issue must match the whitelist.
  const book = getEligibleBook(title, issueNumber);
  if (!book) {
    return sseError(400, {
      error: 'INELIGIBLE_BOOK',
      message: 'Full Assessment is only available for a curated list of high-value books. This book is not on the list.'
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

  // Eligibility check 4: slot count must match what the book requires.
  if (!Array.isArray(interiorImages) || interiorImages.length !== book.slots) {
    return sseError(400, {
      error: 'WRONG_SLOT_COUNT',
      message: `This book requires exactly ${book.slots} interior 2-page-spread images. Received ${Array.isArray(interiorImages) ? interiorImages.length : 0}.`,
      requiredSlots: book.slots
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

  // ── focused verification prompt ─────────────────────────────────────────────
  //
  // The model's only job here is to inspect each interior image and confirm it
  // is plausibly an interior page from this specific Golden / Silver Age book.
  // No grading. No defect cataloguing. Just: "is this an interior page from
  // this book, and are there any duplicates in the set?"
  //
  // Weak verification per spec: the owner of one of these 12 books has no
  // incentive to fabricate, and any prospective buyer will scrutinize the
  // photos themselves. The model only needs to flag obvious issues:
  //   - An image that is not a comic interior page at all (cover, selfie, blank)
  //   - An image clearly from a different book or wildly different era
  //   - Duplicate images in the set
  const systemPrompt = `You are verifying interior images for a Full Assessment of a high-value vintage comic book.

BOOK: ${book.title.replace(/\b\w/g, c => c.toUpperCase())} #${book.issue}
EXPECTED IMAGE COUNT: ${book.slots} interior 2-page spreads
ERA: ${book.slots === 32 ? 'Golden Age (late 1930s–early 1940s)' : 'Silver Age (early 1960s)'}

YOUR JOB:
Inspect each of the ${book.slots} provided images. For each image, determine whether it is plausibly an interior 2-page spread from this specific comic. Also flag any duplicates within the set.

You are NOT grading the book. You are NOT cataloguing defects. You are NOT evaluating the photographic quality. You are only verifying that the images appear to be real interior pages from this book.

ACCEPT each image as valid when:
- It shows an interior comic page or 2-page spread
- The art style, color palette, paper tone, and printing technique are consistent with the expected era
- It is not a duplicate of another image in the set

REJECT an image when:
- It is clearly not a comic interior page (cover, photograph of a person, blank, screenshot, unrelated artwork)
- It is from a clearly different era (modern offset printing, glossy modern paper, contemporary art style on a book that should be 1939-1962)
- It is a near-duplicate of another image in the set (same spread photographed twice)

When in doubt, ACCEPT. The owner of this book has no incentive to fabricate. We are catching obvious errors, not interrogating ambiguity.

## RESPONSE FORMAT — STRICT

Your entire response must be a JSON object and nothing else. The first character of your response must be the literal opening curly brace. The last character must be the literal closing curly brace. Do not write any text before the JSON — no phase headers, no narration.

JSON shape:
{
  "verified": true | false,
  "imageCount": ${book.slots},
  "reasons": ["short overall verdict"],
  "imageIssues": [
    { "index": 0, "issue": "short description of what's wrong" }
  ]
}

Rules:
- "verified": true when ALL images pass. false if any image is flagged.
- "imageIssues": ONLY include entries for images that fail. An empty array means all images passed. Indexes are 0-based.
- "reasons": 1-3 short sentences summarizing the verdict.
- Each "issue" string ≤ 15 words.

DEFAULT TO VERIFIED. The bar for rejection is OBVIOUS error.
`;

  try {
    markPhase('promptAssemblyAtMs');
    const _primaryStart = Date.now();

    sseEvent('phase', { phase: 0, name: 'populating' });

    const _antBody = {
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `INTERIOR IMAGES (${book.slots} total, in order):` },
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
      text = data.content[0].text.trim();
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

    // Normalize the verdict shape. The model should produce verified bool +
    // imageIssues array, but defensive normalization keeps the client contract
    // stable regardless of minor model output variation.
    const verified = parsed.verified === true && (!Array.isArray(parsed.imageIssues) || parsed.imageIssues.length === 0);
    const imageIssues = Array.isArray(parsed.imageIssues) ? parsed.imageIssues.filter(x => x && typeof x.index === 'number').slice(0, book.slots) : [];
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3) : [];

    const result = verified
      ? {
          verified: true,
          fullAssessmentRan: true,
          title: book.title,
          issue: book.issue,
          slotCount: book.slots,
          reasons,
          _diagnostics: { phaseTimings }
        }
      : {
          verified: false,
          rejected: true,
          refund: true,
          fullAssessmentRan: false,
          reasons,
          imageIssues,
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
          verified: verified,
          rejected: !verified,
          title: book.title,
          issue: book.issue,
          slotCount: book.slots,
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
