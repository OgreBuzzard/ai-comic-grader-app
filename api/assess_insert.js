// =============================================================================
// api/assess_insert.js — Insert (Mark Jewelers / Diamond Sales) check
// =============================================================================
//
// A FREE, lean assessment. It runs AFTER the Main assessment, only for books on
// the insert index, once the user has added the two insert photos:
//   IMAGE 1 = the centerfold spread (does it contain an advertising insert?)
//   IMAGE 2 = the closed book's top edge showing the front cover + the insert
//             protruding above the pages (does the cover match this book?)
// Optional IMAGE 3 = the Main front-cover photo, used as the same-book anchor.
//
// No credit is charged. No grade change. Returns a small JSON finding the client
// stores in `insertFinding` and displays.
// =============================================================================
import { anthropicWithRetry } from '../lib/anthropic_retry.js';
import { insertEntry } from '../lib/insert_list.js';

function normalizeMediaType(t) {
  const s = (t || '').toLowerCase();
  if (s.includes('png')) return 'image/png';
  if (s.includes('webp')) return 'image/webp';
  if (s.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}
function toImageBlock(img) {
  if (!img) return null;
  if (typeof img === 'string' && img.startsWith('data:')) {
    const [header, data] = img.split(',');
    const rawType = (header.match(/data:(.*);base64/) || [])[1];
    return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(rawType), data } };
  }
  if (img && img.data) {
    return { type: 'image', source: { type: 'base64', media_type: normalizeMediaType(img.mediaType || img.media_type), data: img.data } };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-client-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { images = [], frontCover = null, title = '', issueNumber = '', entry = null } = req.body || {};
  const imgBlocks = (images || []).map(toImageBlock).filter(Boolean);
  if (imgBlocks.length < 2) return res.status(400).json({ error: 'Two insert photos are required' });
  // S23: server-side read of the SAME curated list the client matches against
  // (kept in sync by make-indexes.mjs). Non-blocking — a candidate-era book is a
  // legitimate check even without a confirmed hit — but we log a mismatch so
  // drift/abuse is visible, and echo it back for the client/admin.
  const _onIndex = !!insertEntry(title, issueNumber, entry && entry.vol);
  if (title && issueNumber && !_onIndex) console.warn(`[assess_insert] not on confirmed insert index: ${title} #${issueNumber}`);
  const frontBlock = toImageBlock(frontCover);

  const content = [];
  content.push({ type: 'text', text: 'IMAGE 1 — the centerfold spread of the comic:' });
  content.push(imgBlocks[0]);
  content.push({ type: 'text', text: 'IMAGE 2 — the closed book\'s top edge, showing the front cover and any insert protruding above the interior pages:' });
  content.push(imgBlocks[1]);
  if (frontBlock) {
    content.push({ type: 'text', text: 'IMAGE 3 — the reference front cover of the book being graded (from its Main assessment). Use it only to confirm IMAGE 2 is the same book.' });
    content.push(frontBlock);
  }
  const label = [title, issueNumber].filter(Boolean).join(' #');
  const prompt = `You are verifying whether a Mark Jewelers (or Diamond Sales) advertising INSERT is present in a comic book${label ? ` (${label})` : ''}.

A Mark Jewelers / Diamond Sales insert is a thin advertising card/leaf bound into the CENTER (centerfold) of PX/commissary copies. It is a separate glossy or newsprint ad, distinct from the comic's own story pages.

Answer these two questions from the images:
1. present — Does IMAGE 1 (the centerfold) contain a bound-in advertising insert (typically a Mark Jewelers or Diamond Sales jewelry/mail-order ad)? true if an insert is clearly present, false if the centerfold shows only normal story pages with no insert.
2. sameBook — Does the front cover visible in IMAGE 2${frontBlock ? ', compared to the reference front cover in IMAGE 3,' : ''} appear to be the SAME comic (same title/issue/copy) as the book with the insert? true if it matches, false if it is clearly a different book, null if you cannot tell.

Respond with STRICT JSON only, no prose:
{"present": true|false, "sameBook": true|false|null, "note": "one or two sentences explaining what you see"}`;
  content.push({ type: 'text', text: prompt });

  const antBody = {
    model: 'claude-opus-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content }]
  };

  const ctrl = new AbortController();
  const _to = setTimeout(() => ctrl.abort(), 45000);
  let response;
  try {
    response = await anthropicWithRetry(
      () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(antBody),
        signal: ctrl.signal
      }),
      { deadlineMs: 45000, maxAttempts: 3, label: 'insert' }
    );
  } catch (e) {
    clearTimeout(_to);
    return res.status(500).json({ error: 'Insert check failed: ' + (e.message || e) });
  }
  clearTimeout(_to);
  if (!response.ok) {
    const err = await response.text();
    return res.status(500).json({ error: 'Anthropic API error: ' + err });
  }
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b && b.type === 'text');
  let text = (textBlock ? textBlock.text : '').trim();
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const fb = clean.indexOf('{'), lb = clean.lastIndexOf('}');
  if (fb !== -1 && lb !== -1) clean = clean.slice(fb, lb + 1);
  let parsed;
  try { parsed = JSON.parse(clean); }
  catch (e) { return res.status(500).json({ error: 'Failed to parse insert response: ' + text.slice(0, 300) }); }

  return res.status(200).json({
    kind: 'insert',
    present: parsed.present === true,
    sameBook: (parsed.sameBook === true || parsed.sameBook === false) ? parsed.sameBook : null,
    note: typeof parsed.note === 'string' ? parsed.note : '',
    onIndex: _onIndex,
    ranAt: null
  });
}
