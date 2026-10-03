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
}`,

  // enumerate: THE SAME INVENTORY TASK, WITH NOTHING COMPETING (v5.40, 2026-10-03)
  //
  // Six prompt-text arms have moved Opus 5.5's grading by less than the drift of
  // changing nothing: R1, R2, R1+R2, A2, S1, and V3 (three Phase 1 deletions, 6
  // reps, +0.63 against an unchanged range of +0.58..+0.70). The gap is REPORTING
  // (at equal defect load 5.5 scores a face ~4 points LOWER than Opus 5, so the
  // scoring step is fine), and 5.5 reports a severity-weighted load of ~8.6
  // against Opus 5's ~11.0.
  //
  // Before a seventh clause edit, answer the question underneath all six:
  //   (a) 5.5 CAN inventory like Opus 5, but the finding loses to a 22,000-token
  //       grading prompt -> the fix is ARCHITECTURAL (a dedicated enumeration
  //       pass whose output feeds grading), not textual; or
  //   (b) 5.5 inventories less whatever you ask it -> no prompt fixes this, the
  //       ablation closes, and 5.5 does not ship for grading.
  //
  // This is the tape probe's method aimed at defect load instead of tape. That
  // probe settled an identical question in two rounds: Opus 5 found tape 3/3 with
  // the back cover ALONE and 0/3 with three other images beside it.
  //
  // DELIBERATELY MINIMAL. No grade, no rubric, no references, no book notes, no
  // calibration examples, no consolidation rules, no count anchor. Severity
  // definitions are included ONLY because load is not comparable without them.
  //
  // READ THE RESULT WITH THIS CAVEAT: this prompt also drops the book notes and
  // the reference comparison, which exist to SUPPRESS false positives. So part of
  // any load increase may be invention rather than detection. That is exactly why
  // OPUS 5 MUST BE IN EVERY RUN -- if both models rise by the same amount, the
  // rise is this prompt being permissive, not a 5.5 fix. And ASM 55 / ASM 64 are
  // the invention check, as in every arm.
  enumerate: `Look at these comic book photographs and do ONE thing: inventory every defect you can see.

For each defect, report what it is, which face it is on, and how severe it is.

SEVERITY - the same three labels the grader uses:
  - High: materially affects the book's condition. Tears, missing pieces, colour-breaking creases, tape, water damage, spine splits, staple tears.
  - Med: clearly visible, more than light handling. Multiple spine stress lines, blunted corners with colour loss, moderate soiling, a non-colour-breaking crease.
  - Low: light handling wear. Faint spine ticks, light corner wear, minor edge wear, light soiling, light tanning.

RULES:
  - Report only what you can SEE in these photographs. DO NOT report wear you cannot see, and do not list a defect because a book of this age "must have some". A short list on a clean book is the correct answer, not a failure.
  - There is no target number and no minimum. Never add a defect to reach a count.
  - There is no maximum either. Do not stop early because the list is getting long, and do not consolidate: nothing here is a summary for a reader, so list each defect separately even where several are the same kind on the same face.
  - DO NOT GRADE THE BOOK. No grade, no score, no condition label, no page quality. Inventory only.
  - Spine side is not a judgement call: on a FRONT cover it is the LEFT margin, on a BACK cover the RIGHT margin, every book, no exceptions.

Return ONLY this JSON, nothing else:
{
  "defects": [
    { "type": "<short name, e.g. 'spine stress lines'>", "face": "front" | "back" | "spine" | "interior", "severity": "High" | "Med" | "Low", "evidence": "<the visual cue that made you say so, max 15 words>" }
  ]
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
