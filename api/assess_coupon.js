// =============================================================================
// api/assess_coupon.js — Coupon / Marvel Value Stamp / pin-up check
// =============================================================================
//
// A FREE, lean assessment. Runs AFTER the Main assessment, only for books on the
// coupon index, once the user has added the two photos:
//   IMAGE 1 = the interior page that should carry the coupon/stamp/pin-up — is it
//             present, or has it been cut/torn out (whole page removed)?
//   IMAGE 2 = the book opened to that page with the front or back cover visible
//             (same-book confirmation).
// Optional IMAGE 3 = the Main front-cover photo, used as the same-book anchor.
//
// No credit is charged. Returns a small JSON finding the client stores in
// `couponFinding` and displays. Any grade effect (CGC "Qualified" / Interior
// penalty) is intentionally left to the Deep/Full refinement pass.
// =============================================================================
import { anthropicWithRetry } from '../lib/anthropic_retry.js';
import { couponEntry } from '../lib/coupon_list.js';

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
  if (imgBlocks.length < 2) return res.status(400).json({ error: 'Two coupon photos are required' });
  // S23: server-side read of the SAME curated coupon list the client matches
  // against (kept in sync by make-indexes.mjs). Non-blocking; logs a mismatch so
  // drift/abuse is visible, and echoes it back for the client/admin.
  const _onIndex = !!couponEntry(title, issueNumber);
  if (title && issueNumber && !_onIndex) console.warn(`[assess_coupon] not on coupon index: ${title} #${issueNumber}`);
  const frontBlock = toImageBlock(frontCover);

  const piece = (entry && entry.item) ? entry.item : (entry && entry.kind === 'stamp' ? 'Marvel Value Stamp' : 'coupon / pin-up');
  const desc = (entry && entry.desc) ? entry.desc : piece;
  const page = (entry && entry.page != null) ? `page ${entry.page}` : 'the relevant interior page';

  const content = [];
  content.push({ type: 'text', text: `IMAGE 1 — a close-up of ${page}, which should carry: ${desc}` });
  content.push(imgBlocks[0]);
  content.push({ type: 'text', text: 'IMAGE 2 — the book opened to that page with the front or back cover also visible (same-book confirmation):' });
  content.push(imgBlocks[1]);
  if (frontBlock) {
    content.push({ type: 'text', text: 'IMAGE 3 — the reference front cover of the book being graded (from its Main assessment). Use it only to confirm IMAGE 2 is the same book.' });
    content.push(frontBlock);
  }
  const label = [title, issueNumber].filter(Boolean).join(' #');
  const prompt = `You are checking whether a removable collectible has been CUT or REMOVED from a comic book${label ? ` (${label})` : ''}.

The removable piece for this issue is: ${desc}. This may be a Marvel Value Stamp (a small stamp cut from a page), a coupon, or a full pin-up/feature page that collectors remove.

Answer these two questions from the images:
1. present — In IMAGE 1, does the ${piece} appear INTACT and present? true if it is clearly present/uncut; false if there is evidence it was cut out (a rectangular hole, a stub, a cut/torn edge) or that an entire page was removed. If genuinely ambiguous, prefer true but say so in the note.
2. sameBook — Does IMAGE 2 confirm this is the SAME comic being graded — i.e., a front or back cover is visible${frontBlock ? ' and matches the reference cover in IMAGE 3' : ''}? true if confirmed, false if it looks like a different book, null if you cannot tell.

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
      { deadlineMs: 45000, maxAttempts: 3, label: 'coupon' }
    );
  } catch (e) {
    clearTimeout(_to);
    return res.status(500).json({ error: 'Coupon check failed: ' + (e.message || e) });
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
  catch (e) { return res.status(500).json({ error: 'Failed to parse coupon response: ' + text.slice(0, 300) }); }

  return res.status(200).json({
    kind: 'coupon',
    piece,
    present: parsed.present === true,
    sameBook: (parsed.sameBook === true || parsed.sameBook === false) ? parsed.sameBook : null,
    note: typeof parsed.note === 'string' ? parsed.note : '',
    onIndex: _onIndex,
    ranAt: null
  });
}
