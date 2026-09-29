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
// Signed-in users only (same bar as /api/assess), costs no credits, writes nothing.
//
//   POST /api/probe
//   { question: 'tape', images: [{data,mediaType}…], perImage: false, label: '…' }
//
// perImage:true sends each image as its OWN call, so nothing competes spatially
// either — the strongest form of the question. That is arm C in the plan.
import process from 'node:process';
import { PRIMARY_MODEL } from '../lib/model.js';
import { ROBOGRADE_VERSION } from '../lib/version.js';


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
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET (whoami) or POST only' });

  // AUTH: a valid Firebase ID token, and nothing more. Same bar as /api/assess,
  // which is what the eval harness has always called. An earlier version of this
  // file added an ADMIN_EMAILS check; that variable only exists on the admin
  // deployment, so the gate could never pass here. Removed.
  let whoami;
  try {
    const m = (req.headers.authorization || req.headers.Authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'auth required', reason: 'no_bearer', detail: 'No Authorization: Bearer header on the request.' });
    const tok = m[1].trim();
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured', reason: 'no_service_account', detail: 'FIREBASE_SERVICE_ACCOUNT is not set on this deployment.' });

    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });

    let decoded;
    try { decoded = await getAuth().verifyIdToken(tok); }
    catch (e) {
      const msg = String(e && e.message || e);
      return res.status(401).json({
        error: 'auth failed',
        reason: /expired/i.test(msg) ? 'expired_token' : 'verify_failed',
        detail: /expired/i.test(msg) ? 'Token expired — they last about an hour. Get a fresh one.' : msg
      });
    }
    whoami = { email: String(decoded.email || ''), uid: decoded.uid };
  } catch (e) {
    return res.status(500).json({ error: 'auth check crashed', detail: String(e && e.message || e) });
  }

  // GET = whoami. Costs nothing and calls no model: use it to prove the token
  // and the admin gate before spending a round on them.
  if (req.method === 'GET') return res.status(200).json({ ok: true, ...whoami, version: ROBOGRADE_VERSION });

  // `effort` is a knob, not a constant, because of Fable. Claude Fable 5.1 has
  // adaptive thinking always on and a DEFAULT EFFORT OF HIGH; pinning it to the
  // 'low' that grading ships would be measuring a configuration Fable has never
  // run in, which is the opposite of reproducing what it saw. Pass
  // effort: null to send no override and let each model use its own default.
  const { question = 'tape', images = [], perImage = false, label = '', model = null, effort = 'low', maxTokens = 4096 } = req.body || {};
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
    // max_tokens is 4096, not the 1024 this started at. On a thinking model the
    // reasoning is drawn from the same budget, so a tight cap can burn the whole
    // allowance before a single character of the JSON is emitted — which arrives
    // here as an empty/unparsed result and reads like a refusal. The answer is
    // ~80 tokens; the headroom costs nothing unless it is used.
    const body = {
      model: useModel,
      max_tokens: maxTokens,
      messages: [ { role: 'user', content: [ ...imgs.map(block), { type: 'text', text: prompt } ] } ]
    };
    if (effort) body.output_config = { effort };
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
      stopReason: j.stop_reason || null,
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
    return res.status(200).json({ question, label, model: useModel, effort: effort || null, version: ROBOGRADE_VERSION, perImage, results });
  } catch (e) {
    return res.status(500).json({ error: 'probe failed', detail: String(e && e.message || e) });
  }
}
