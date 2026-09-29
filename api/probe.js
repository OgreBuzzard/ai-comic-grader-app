// api/probe.js — SINGLE-QUESTION DIAGNOSTIC PASS. Not part of grading.
//
// WHY THIS EXISTS (v5.30, Matt + Claude, 2026-09-28)
// Tape is not being detected. ASM #11 has substantial tape and five separate
// assessments across 5.26-5.29 never listed it; ASM #1 has substantial tape that
// only Fable 5 has ever identified. The 5.26 tape rework (one edge not two, back
// cover first, mirrored covers, cracking means look deeper) did not change that.
//
// Before writing more prompt text we need to know WHICH of two things is true:
//   (a) the model cannot resolve tape in these images at all — a perception
//       limit, and tape belongs with foxing as a known limitation; or
//   (b) the model CAN see it, but the finding loses to everything else competing
//       for attention in a ~22,000-token grading prompt — in which case the fix
//       is attention, not vocabulary.
//
// This endpoint asks ONE question with nothing else in the context. If (b), it
// finds the tape. If (a), it does not, and no amount of CHECK 1 wording will.
//
// Deliberately separate from assess.js so a diagnostic can never break grading.
// Admin-only, costs no credits, writes nothing. Returns raw JSON.
//
//   POST /api/probe
//   { question: 'tape', images: [{data,mediaType}…], perImage: false, label: '…' }
//
// perImage:true sends each image as its OWN call, so nothing competes spatially
// either — the strongest form of the question. That is arm C in the plan.
import process from 'node:process';
import { PRIMARY_MODEL } from '../lib/model.js';
import { ROBOGRADE_VERSION } from '../lib/version.js';

const ADMINS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// The whole prompt. Everything the grading prompt says about tape, and nothing
// else at all — no grade, no other defect classes, no rubric, no references.
const QUESTIONS = {
  tape: `Look at these comic book photographs and answer ONE question: IS THERE TAPE ON THIS BOOK?

Tape on a comic is a strip of material laid over the paper, usually to hold a tear or a split spine together. What identifies it:
  - ONE straight edge, not two. A strip laid along an edge of the book has its outer edge flush with the book's own edge, so only the INNER edge is visible as a line. Do not require a parallel pair.
  - It is only as long as the damage it repairs. It is NOT necessarily a full-height band, and it is NOT necessarily on the spine — tape follows tears, and tears occur anywhere.
  - A different surface. Tape sits ON the paper: a change in gloss or sheen, a slightly different colour cast, trapped air bubbles, darkened or yellowed adhesive, printed art visible THROUGH a translucent film.
  - On the SPINE it wraps the fold, so it appears on BOTH covers at the spine margin of each. The spine side is on OPPOSITE sides of the front and back cover photos — locate it by the FOLD, never by assuming a side.
  - HORIZONTAL CRACKING across a strip is the paper splitting UNDERNEATH the tape, which is why the tape is there. Cracking is a reason to look harder, not evidence against.
  - The back cover usually shows it far more clearly than the front: light ad stock, less saturated art.

Do NOT confuse tape with TANNING — tanning has a soft, gradual boundary and is worst at the OUTER edge; tape has a hard edge and can be anywhere.

Answer honestly. If you do not see tape, say so plainly — a false positive is as much a failure as a miss.

Return ONLY this JSON, nothing else:
{
  "tapePresent": true | false,
  "confidence": "high" | "medium" | "low",
  "locations": ["<where, e.g. 'back cover, spine side, upper third'>"],
  "evidence": "<what in the image made you say so — the specific visual cue, not a restatement of the rule. Max 40 words.>",
  "ruledOut": "<if false: what you checked and what the candidate marks turned out to be. Max 30 words. Empty string if true.>"
}`
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Admin only. This spends model budget and is not a product feature.
  try {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'auth required' });
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const decoded = await getAuth().verifyIdToken(m[1]);
    const email = String(decoded.email || '').toLowerCase();
    if (!ADMINS.length || !ADMINS.includes(email)) return res.status(403).json({ error: 'admin only' });
  } catch (e) {
    return res.status(401).json({ error: 'auth failed', detail: String(e && e.message || e) });
  }

  const { question = 'tape', images = [], perImage = false, label = '', model = null } = req.body || {};
  const prompt = QUESTIONS[question];
  if (!prompt) return res.status(400).json({ error: 'unknown question', known: Object.keys(QUESTIONS) });
  if (!Array.isArray(images) || !images.length) return res.status(400).json({ error: 'no images' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'no ANTHROPIC_API_KEY' });
  const useModel = model || PRIMARY_MODEL;

  const block = (img) => ({
    type: 'image',
    source: { type: 'base64', media_type: (img.mediaType || 'image/jpeg'), data: String(img.data || '').replace(/^data:[^,]+,/, '') }
  });

  async function ask(imgs, tag) {
    const body = {
      model: useModel,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [ { role: 'user', content: [ ...imgs.map(block), { type: 'text', text: prompt } ] } ]
    };
    const t0 = Date.now();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) return { tag, error: j.error ? j.error.message : ('HTTP ' + r.status) };
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); }
    catch (_) { /* keep raw */ }
    return {
      tag,
      ms: Date.now() - t0,
      inputTokens: j.usage ? j.usage.input_tokens : null,
      outputTokens: j.usage ? j.usage.output_tokens : null,
      parsed,
      raw: parsed ? undefined : text.slice(0, 1200)
    };
  }

  try {
    const results = perImage
      ? await Promise.all(images.map((img, i) => ask([ img ], 'image' + (i + 1))))
      : [ await ask(images, 'all' + images.length) ];
    return res.status(200).json({ question, label, model: useModel, version: ROBOGRADE_VERSION, perImage, results });
  } catch (e) {
    return res.status(500).json({ error: 'probe failed', detail: String(e && e.message || e) });
  }
}
