// api/cachewarm.js — PROMPT-CACHE TTL PROBE, and the future keep-warm ping.
//
// WHY THIS EXISTS (v5.41, Matt + Claude, 2026-10-03)
//
// Measured on the 7-day export: 12.6% of Mains run COLD (excluding deploy days,
// which run 91% cold because a changed prompt is a new cache key). A cold Main
// costs $0.3148 against $0.0925 warm, so cold calls are an eighth of the volume
// and ~40% of Main prompt spend.
//
// The fix on the table is a traffic-gated keep-warm ping: after 55 minutes of
// silence, send one minimal request carrying the cached prefix so the entry
// never expires. Modelled against 60 days of real timestamps it is worth about
// $22/month on Main and $5/month on Deep, and — counter-intuitively — it is
// worth MOST during the dead overnight hours, because an isolated assessment is
// exactly the one that would have been cold (03:00-05:00 ET run 47-52% cold
// against 9-11% at the 19:00 peak).
//
// ── THE WHOLE PLAN RESTS ON ONE UNVERIFIED ASSUMPTION ───────────────────────
// That READING a cached prefix RESETS its TTL. If a read does not refresh, the
// entry dies 1h after it was WRITTEN no matter how often it is read, pings
// cannot hold it open, and the entire idea is worthless. Claude believes reads
// refresh but has NOT verified it and will not assert it. This endpoint settles
// it for about three cents.
//
// ── THE TEST, AND WHY IT IS SHAPED THIS WAY ────────────────────────────────
//   call 1  t=0       expect cache_creation  (cold write)
//   call 2  t=+45min  expect cache_read      (inside the original 1h either way)
//   call 3  t=+90min  ???  <- THE ANSWER
//
// Call 3 is the only one that discriminates. It sits 90 minutes after the write,
// so the original 1h window has passed:
//   cache_read     -> call 2's read REFRESHED the TTL. The ping works. Build it.
//   cache_creation -> reads do NOT refresh. The ping is dead. Do not build it.
//
// Call 2 at +45min is not decorative: it is the refresh under test. A test with
// only calls 1 and 3 cannot tell a refreshed entry from one that never expired.
//
// ── WHY A SYNTHETIC BLOCK AND NOT THE REAL PROMPT ──────────────────────────
// Two reasons, both load-bearing.
//
// 1. ISOLATION. Any real robograder.app traffic hitting the real Main prefix
//    during the 90 minutes would refresh that entry itself and we would record
//    production's refresh as ours. The block below is a deterministic filler
//    plus a per-run NONCE, so the cache key belongs to this test alone and
//    nothing else on earth can touch it.
// 2. COST. TTL behaviour does not depend on prefix size, so there is no reason
//    to pay for 15,562 tokens. ~2,100 tokens clears the 1024-token minimum
//    cacheable prefix with room to spare and costs $0.02 to write, $0.001 to
//    read. Whole test: about $0.03.
//
// WHAT THIS DOES NOT TEST: whether the real Main prefix is byte-stable in
// production. That is already answered by the data — 83.4% of Mains hit warm,
// which cannot happen unless the prefix is stable.
//
// ── BECOMING THE PRODUCTION PING ───────────────────────────────────────────
// If call 3 reads, this endpoint is most of the ping already. The missing piece
// is real: `api/assess.js` builds its prompt INSIDE the handler and does not
// export it, so there is no way to send the genuine prefix from here. Shipping
// the ping needs that prompt builder lifted into a module both files import,
// byte-identical — a pure refactor, but a real one, and a cache-key change if
// it is got wrong by a single character. Same for `api/assess_deep.js`.
//
// Deep needs no conditional refactor: 98.4% of 572 Deeps over 60 days take ONE
// branch (hasInteriorCovers && hasFrontCover), so pinging that single variant
// covers nearly all of them and the 1.6% minority can pay cold.
//
// Signed-in users only, same bar as /api/assess. Costs no credits. Writes nothing.
//
//   POST /api/cachewarm
//   { nonce: 'run1-call1', tokens: 2100, model: 'claude-opus-5', ttl: '1h' }
//   GET  /api/cachewarm   -> whoami, no model call, no spend
import process from 'node:process';
import { PRIMARY_MODEL } from '../lib/model.js';
import { ROBOGRADE_VERSION } from '../lib/version.js';

// Deterministic filler. Must be IDENTICAL across the three calls of a run or the
// cache key changes and the test silently measures nothing — which is exactly
// the failure mode that cost a round on /api/probe in September. Built from a
// fixed sentence repeated a fixed number of times; no dates, no randomness.
const FILLER_UNIT =
  'This paragraph exists only to occupy prompt-cache space for a time-to-live measurement. ' +
  'It carries no instructions, describes no comic book, and must never influence any grade. ' +
  'It is repeated verbatim so that the cached prefix is byte-identical between calls. ';

function buildBlock(nonce, approxTokens) {
  // ~3.8 chars/token. The nonce goes FIRST so it is inside the cached prefix and
  // therefore part of the cache key — that is what isolates a run.
  const head = 'CACHE TTL PROBE — run key: ' + nonce + '\n\n';
  const want = Math.max(1400, Math.min(40000, approxTokens | 0)) * 3.8;
  let s = head;
  while (s.length < want) s += FILLER_UNIT;
  return s;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET (whoami) or POST only' });

  // AUTH: a valid Firebase ID token and nothing more — same bar as /api/assess.
  // Deliberately NOT an ADMIN_EMAILS check: that variable exists only on the
  // admin deployment, so such a gate can never pass here. (Learned 2026-09-29.)
  let whoami;
  try {
    const m = (req.headers.authorization || req.headers.Authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'auth required', reason: 'no_bearer', detail: 'No Authorization: Bearer header on the request.' });
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured', reason: 'no_service_account' });
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1].trim()); }
    catch (e) {
      const msg = String(e && e.message || e);
      return res.status(401).json({ error: 'auth failed', reason: /expired/i.test(msg) ? 'expired_token' : 'verify_failed',
        detail: /expired/i.test(msg) ? 'Token expired — they last about an hour. Get a fresh one.' : msg });
    }
    whoami = { email: String(decoded.email || ''), uid: decoded.uid };
  } catch (e) {
    return res.status(500).json({ error: 'auth check crashed', detail: String(e && e.message || e) });
  }

  if (req.method === 'GET') return res.status(200).json({ ok: true, ...whoami, version: ROBOGRADE_VERSION });

  const { nonce = '', tokens = 2100, model = null, ttl = '1h', label = '' } = req.body || {};
  if (!nonce || typeof nonce !== 'string' || nonce.length < 4) {
    return res.status(400).json({ error: 'nonce required', detail: 'Pass a stable per-run string, e.g. "2026-10-03-run1". It goes inside the cached prefix and is what isolates this run from production traffic.' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'no ANTHROPIC_API_KEY' });

  const useModel = model || PRIMARY_MODEL;
  // Match production exactly: 1h ephemeral + the extended-TTL beta header.
  const cacheCtl = ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };
  const betaHdr  = ttl === '5m' ? {} : { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' };
  const block = buildBlock(nonce, tokens);

  const body = {
    model: useModel,
    max_tokens: 16,                       // the reply is irrelevant; keep output spend at zero
    system: [{ type: 'text', text: block, cache_control: cacheCtl }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ok' }] }]
  };

  const t0 = Date.now();
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...betaHdr },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'anthropic error', detail: j.error ? j.error.message : ('HTTP ' + r.status) });
    const u = j.usage || {};
    const created = u.cache_creation_input_tokens || 0;
    const read    = u.cache_read_input_tokens || 0;
    return res.status(200).json({
      ok: true, label, nonce, model: useModel, ttl, version: ROBOGRADE_VERSION,
      blockChars: block.length,
      ms: Date.now() - t0,
      // The whole answer is these two numbers.
      cacheCreationInputTokens: created,
      cacheReadInputTokens: read,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      verdict: read > 0 ? 'READ (cache hit)' : (created > 0 ? 'WRITE (cache miss)' : 'NEITHER — prefix may be under the minimum cacheable length'),
      usage: u
    });
  } catch (e) {
    return res.status(500).json({ error: 'cachewarm failed', detail: String(e && e.message || e) });
  }
}
