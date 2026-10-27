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
import { PRIMARY_MODEL, costOf } from '../lib/model.js';
import { ROBOGRADE_VERSION } from '../lib/version.js';
import { buildMainPrefix } from '../lib/main_prompt.js';
import { getAdminDb } from '../lib/batch_common.js';

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

// ── THE LIVE CACHING CONFIG (S23, 2026-10-18) ──────────────────────────────
// api/assess.js decides at request time whether to send cache_control AT ALL,
// and with which TTL, by reading config/caching from the admin dashboard. The
// ping did neither: it always sent a 1h ephemeral block with the extended-TTL
// beta header, no matter what production was doing. That made two silent
// failures possible, and BOTH of them look identical from the outside —
// "cache warming still isn't working":
//
//   1. MAIN CACHING SWITCHED OFF. The chip that does this sits in the admin
//      header and has been hit by a mis-tap before (the admin's own comment
//      records Mains going from ~$0.09 to ~$0.21 for a day). With it off,
//      assess.js sends the system prompt as a PLAIN STRING with no
//      cache_control, so there is no entry to warm and no assessment will ever
//      read one. The ping kept firing anyway, paying to create an entry that
//      nothing on earth would read — and the first ping after each expiry pays
//      the WRITE price, $0.2331. That is the shape of a bill that is larger
//      than the model predicted while the feature does nothing.
//
//   2. TTL SET TO 5m. Then assessments write FIVE-MINUTE entries while the ping
//      writes sixty-minute ones. The cron fires every 15 minutes, so a
//      5-minute entry is already dead at every single fire: every ping is a
//      WRITE, every assessment is cold, and the cost is ~40x the modelled one.
//      A 15-minute cron cannot hold a 5-minute entry open. Nothing can.
//
// Mirrors assess.js's resolution exactly, including the legacy `enabled` flag
// for docs written before the per-type chips existed. Fails OPEN (assume on,
// 1h) so a Firestore blip never stops the ping.
async function readCachingCfg(db) {
  const out = { mainOn: true, ttl: '1h', source: 'default' };
  if (!db) return out;
  try {
    const snap = await db.collection('config').doc('caching').get();
    if (!snap.exists) return { ...out, source: 'no-doc' };
    const d = snap.data() || {};
    const t = d.types;
    out.mainOn = t ? (t.main !== false) : (d.enabled !== false);
    out.ttl = d.ttl === '5m' ? '5m' : '1h';
    out.source = 'config/caching';
  } catch (e) {
    out.source = 'read-failed: ' + String(e && e.message || e);
  }
  return out;
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
  // CRON PATH (v5.48). Vercel Cron cannot hold a Firebase ID token, so the
  // scheduled keep-warm ping authenticates with a shared secret instead. It is
  // accepted ONLY for mode:'warm', which spends about a cent, writes nothing,
  // and returns no user data — so the blast radius of a leaked secret is a
  // stranger keeping our prompt cache warm for us. Everything else still needs
  // a real signed-in user.
  // Vercel Cron issues a GET, so the mode arrives as a query parameter rather
  // than a body field. Accept both.
  // Declared below, used here: see the cron-credential block. A credentialed
  // cron hit with NO mode at all is the keep-warm ping. The cron path used to
  // carry `?mode=warm`, which made the entire feature depend on a query string
  // surviving the trip from vercel.json into the function — and if it ever did
  // not, the request fell through to the Firebase branch and 401'd silently,
  // with nothing in the admin to show the ping had stopped. The path is now
  // bare and the mode is inferred.
  const _cronSecretEarly = (process.env.CRON_SECRET || '').trim();
  const _bearerEarly = (req.headers.authorization || req.headers.Authorization || '').replace(/^Bearer\s+/, '').trim();
  const _cronCredentialed =
    (_cronSecretEarly && _bearerEarly === _cronSecretEarly) ||
    /vercel-cron/i.test(String(req.headers['user-agent'] || ''));
  const _wantMode = ((req.body || {}).mode) || ((req.query || {}).mode) ||
    (_cronCredentialed ? 'warm' : null);

  // ── HOW THE CRON AUTHENTICATES, AND WHY IT IS DELIBERATELY WEAK ───────────
  // CRON_SECRET is OPTIONAL and you do not need to set it. Vercel rejects an
  // environment variable with leading or trailing whitespace at BUILD time, and
  // an invisible newline from a copy-paste failed three deploys in a row for a
  // variable guarding an endpoint that spends one cent and writes nothing. That
  // is a bad trade, so the secret is no longer required and both sides of the
  // comparison are trimmed if you do set one.
  //
  // The fallback is Vercel's own cron user-agent. That is spoofable, and it
  // does not matter: the worst a stranger can do with this endpoint is keep our
  // prompt cache warm at our expense, roughly a cent a go, rate-limited by the
  // 50-minute traffic gate below. It returns no user data, writes nothing but
  // its own timestamp, and debits no credits. Everything else on this endpoint
  // still requires a real signed-in Firebase user.
  const _isCron = _wantMode === 'warm' && _cronCredentialed;
  // mode:'status' IS NOW OPEN (2026-10-27). It was behind a Firebase ID token,
  // which meant the only way to see whether the keep-warm ping had been running
  // was to mint a token by hand — so for weeks "cache warming isn't working"
  // could not be told apart from "warming is fine and something else is cold".
  // An endpoint whose whole job is to make a silent failure visible must not
  // itself be hard to reach.
  // WHAT IT DISCLOSES: ping timestamps, token counts, costs in cents, and the
  // app version. No user data, no comic data, no credits, no spend, no writes —
  // the same reasoning that already let the cron in without a Firebase token.
  // TO CLOSE IT AGAIN: delete the `|| _isOpenStatus` below. Nothing else
  // depends on it.
  const _isOpenStatus = _wantMode === 'status';
  if (_isCron || _isOpenStatus) {
    whoami = { email: _isCron ? 'vercel-cron' : 'anon-status', uid: _isCron ? 'cron' : 'anon' };
  } else
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

  // whoami. A GET asking for mode=warm is the cron and falls through to it.
  // A GET asking for mode=warm is the cron; mode=status is the read-only ping
  // log. Anything else is a whoami. (5.57 shipped without 'status' in this
  // list, so mode=status returned the whoami payload and the status block was
  // unreachable.)
  if (req.method === 'GET' && _wantMode !== 'warm' && _wantMode !== 'status') {
    return res.status(200).json({ ok: true, ...whoami, version: ROBOGRADE_VERSION });
  }

  const _src = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
  const { nonce = '', tokens = 2100, model = null, ttl = '1h', label = '' } = _src;
  const mode = _wantMode;
  // 40, NOT 50, AND THE NUMBER MATTERS. The cron fires every 15 minutes, so the
  // only achievable ping intervals are multiples of 15. With the gate at 50 the
  // T+45 fire is turned away (45 < 50) and the first one that passes is T+60 --
  // which is exactly the cache TTL, so every ping was racing the expiry and
  // losing about half the time. Measured 2026-10-12: minutesSinceLastPing came
  // back at 56, and a real assessment 1h25m after the previous one still paid
  // the full cold price of $0.296.
  // At 40 the T+45 fire passes, giving a 45-minute ping interval and 15 minutes
  // of headroom inside the hour. If the cron interval ever changes, re-derive
  // this: it must sit strictly between one cron tick and the TTL minus a tick.
  const quietMinutes = Number(_src.quietMinutes) > 0 ? Number(_src.quietMinutes) : 40;
  const force = _src.force === true || _src.force === 'true';

  // ── mode:'status' — READ-ONLY PING HISTORY ────────────────────────────────
  // There was no way to see whether the keep-warm ping was actually running.
  // The only signal was `minutesSinceLastPing` on a gate skip, which is a
  // single number and says nothing about cadence — so "cache warming isn't
  // working" could not be told apart from "cache warming is working and a
  // different prefix is going cold". This returns the cache_warm/main doc:
  // all-time totals plus the 30-day per-ping log the warm path writes.
  // Spends nothing and calls no model.
  if (mode === 'status') {
    let sdb = null;
    try { sdb = await getAdminDb(); } catch (e) {
      return res.status(500).json({ error: 'no db', detail: String(e && e.message || e) });
    }
    if (!sdb) return res.status(500).json({ error: 'no db' });
    try {
      const d = (await sdb.doc('cache_warm/main').get()).data() || {};
      // THE THREE THINGS THAT WERE NOT VISIBLE, and without which "is cache
      // warming working" could not be answered from outside the Firestore
      // console. Each is free.
      //   caching    — is Main caching even switched on, and at which TTL
      //   prefixSha  — what the ping is sending, so drift shows without the repo
      //   recentMains— what the last real Mains BILLED. This is the answer:
      //                read  => warming is working
      //                write => every Main is paying to create the entry
      //                neither => caching is off; there is no entry at all
      const caching = await readCachingCfg(sdb);
      let prefixSha = null;
      try {
        const { createHash } = await import('node:crypto');
        prefixSha = createHash('sha256').update(buildMainPrefix(null)).digest('hex').slice(0, 16);
      } catch (e) { /* non-fatal */ }
      let recentMains = [], mainTally = { read: 0, write: 0, uncached: 0 };
      try {
        const snap = await sdb.collection('assessment_timings')
          .orderBy('createdAt', 'desc').limit(60).get();
        for (const doc of snap.docs) {
          const r = doc.data() || {};
          if (r.kind && r.kind !== 'main' && r.kind !== 'assessment') {
            if (r.warmedPrefix !== 'main') continue;
          }
          const rd = r.cacheReadInputTokens || 0, cr = r.cacheCreationInputTokens || 0;
          const isBigPrefix = rd > 20000 || cr > 20000;
          if (r.warmedPrefix !== 'main' && !isBigPrefix && r.kind !== 'main') continue;
          const verdict = rd > 0 ? 'read' : cr > 0 ? 'write' : 'uncached';
          mainTally[verdict]++;
          if (recentMains.length < 25) {
            recentMains.push({ at: r.createdAt || null, verdict,
              cacheRead: rd, cacheCreate: cr,
              costUsd: r.costUsd != null ? Number(r.costUsd) : null,
              warmedPrefix: r.warmedPrefix || null, version: r.version || null });
          }
        }
      } catch (e) { recentMains = [{ error: String(e && e.message || e) }]; }
      const recent = (d.recent || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
      // Gaps between consecutive paid pings, newest first. A healthy cron at
      // */15 with quietMinutes 40 produces 45-minute gaps on a quiet stretch
      // and longer ones when real Mains were keeping the entry alive anyway.
      const gapsMin = [];
      for (let i = 0; i + 1 < recent.length && i < 48; i++) {
        const a = Date.parse(recent[i].at), b = Date.parse(recent[i + 1].at);
        if (!isNaN(a) && !isNaN(b)) gapsMin.push(Math.round((a - b) / 60000));
      }
      return res.status(200).json({
        ok: true, mode: 'status', version: ROBOGRADE_VERSION,
        lastWarmAt: d.lastWarmAt || null,
        minutesSinceLastPing: d.lastWarmAt ? Math.round((Date.now() - Date.parse(d.lastWarmAt)) / 60000) : null,
        totalPings: d.totalPings || 0,
        totalReads: d.totalReads || 0,
        totalWrites: d.totalWrites || 0,
        totalCostUsd: Number((d.totalCostUsd || 0).toFixed(4)),
        // Failures. A long gap in gapsMin means EITHER the cron did not fire OR
        // the ping fired and failed; these three fields are what tell them
        // apart without opening the Vercel dashboard.
        totalFailures: d.totalFailures || 0,
        lastErrorAt: d.lastErrorAt || null,
        lastError: d.lastError || null,
        lastErrorMs: d.lastErrorMs || null,
        recentCount: recent.length,
        gapsMin,
        // THE DIAGNOSIS, in three fields. Read them in this order.
        caching,          // mainOn:false => nothing is cached; the ping is pointless
        prefixSha,        // must match what api/assess.js sends
        mainTally,        // read / write / uncached across the last 60 rows
        recentMains,
        verdict: !caching.mainOn
          ? 'MAIN CACHING IS OFF in config/caching. No assessment is caching anything, so there is no entry to keep warm. Switch the Comic chip back on in the admin header; the ping now refuses to spend while it is off.'
          : caching.ttl === '5m'
            ? 'TTL IS 5m. The cron fires every 15 minutes, so a 5-minute entry is always dead by the next fire: every ping pays the WRITE price and every assessment runs cold. Set the TTL to 1h in the admin header.'
            : mainTally.write > mainTally.read
              ? 'Mains are mostly WRITES. The prefix the ping sends and the one assess.js sends have come apart, or deploys are frequent enough to reset the key. Compare prefixSha against lib/main_prompt_check.mjs.'
              : mainTally.read > 0
                ? 'Mains are reading the cache. Warming is working.'
                : 'No Main rows in the last 60 timings — nothing to judge yet.',
        recent: recent.slice(0, 60)
      });
    } catch (e) {
      return res.status(500).json({ error: 'status read failed', detail: String(e && e.message || e) });
    }
  }

  // ── mode:'warm' — THE PRODUCTION KEEP-WARM PING (v5.48) ────────────────────
  // Sends the REAL Main cached prefix (lib/main_prompt.js, the _ki === null
  // variant that every ordinary Main produces) so the live cache entry's TTL is
  // refreshed before it expires. Reads refresh the TTL — verified 2026-10-05 by
  // the three-call probe below, with call 3 landing 8 minutes into a 5-minute
  // TTL and still reading.
  //
  // TRAFFIC-GATED. If a Main ran in the last `quietMinutes`, the entry is
  // already warm and this returns without calling the model at all. Only an
  // actually-quiet hour costs anything. Modelled on 60 days of timestamps this
  // is worth ~$27/month, and it is worth MOST overnight: 03:00-05:00 ET run
  // 47-52% cold against 9-11% at the 19:00 peak. DO NOT make it sleep at night.
  //
  // ACCEPTANCE TEST, and it is not optional after any prompt edit:
  //   a warm ping must report cacheReadInputTokens around 31,400 and cost ~$0.006.
  //   (19,800 was the v5.48 figure; the prefix has grown since. Measured
  //   2026-10-27 against production 5.83: 31,402 read, $0.00633, verdict READ.)
  //   If it reports cacheCreation instead, the prefix no longer matches what
  //   /api/assess sends and the ping is burning money for nothing.
  if (mode === 'warm') {
    const apiKeyW = process.env.ANTHROPIC_API_KEY;
    if (!apiKeyW) return res.status(500).json({ error: 'no ANTHROPIC_API_KEY' });

    // ── THE GATE ───────────────────────────────────────────────────────────
    // The entry dies one hour after it was last TOUCHED, and both a real
    // assessment and a ping count as a touch. So the gate asks one question:
    // how long since ANYTHING touched it? If that is under quietMinutes the
    // entry is still comfortably alive and this call returns free.
    //
    // THE BUG THIS FIXES (caught before it ever ran): gating on real traffic
    // alone meant that on a quiet night EVERY cron fire would see "no traffic
    // in 50 minutes" and pay, because a ping does not write to
    // assessment_timings. At a 15-minute cron that is four paid pings an hour
    // instead of one. The ping now records its own timestamp and the gate takes
    // the LATER of the two, which is what makes the cron frequency harmless:
    // fire every 15 minutes, pay roughly once an hour, and if one fire fails
    // the next one is 15 minutes away instead of an hour.
    //
    // A read failure must NOT block the ping — a missed ping costs ~$0.22 on
    // the next cold assessment and a wasted one costs $0.01 — so it fails OPEN.
    let lastMainMs = null, lastPingMs = null, gateNote = '';
    const WARM_DOC = 'cache_warm/main';
    let db = null;
    try { db = await getAdminDb(); }
    catch (e) { gateNote = 'no db, warming anyway: ' + String(e && e.message || e); }

    // ── DO NOT SPEND WHEN SPENDING CANNOT HELP ──────────────────────────────
    // Read the same config/caching doc api/assess.js reads. See readCachingCfg
    // above for why each of these two states produces a bill with nothing to
    // show for it. This check comes BEFORE the traffic gate because it is
    // cheaper and more decisive: if Main caching is off there is no entry in
    // the world to keep warm, and the correct number of dollars to spend is
    // zero.
    const _cfg = await readCachingCfg(db);
    if (!force && !_cfg.mainOn) {
      return res.status(200).json({
        ok: true, mode: 'warm', skipped: true, version: ROBOGRADE_VERSION, costUsd: 0,
        reason: 'Main prompt caching is OFF in config/caching — api/assess.js is sending no cache_control, so there is no cache entry to keep warm. Not spending.',
        action: 'Switch the Comic chip back on in the admin header, or leave it off and accept full-price Mains.',
        caching: _cfg
      });
    }

    if (!force && db) {
      try {
        // ONLY A MAIN THAT CACHED COUNTS AS A TOUCH. This read used to take the
        // single most recent row of any kind, which was wrong: a Deep, a Card
        // assessment, a slab-check or a Batch pass all write rows here and none
        // of them warms the MAIN prefix. Measured 2026-10-16 — three Card
        // assessments at 08:37 suppressed the ping, and the Main entry died;
        // the next Main at 10:03 paid a full cold $0.301, and another at 13:17
        // paid $0.285.
        // Scanned client-side over a small window so no composite index is
        // needed. `warmedPrefix` is stamped by api/assess.js; rows written
        // before 2026-10-16 do not have it, so fall back to the cache-token
        // counts, which only a cached Main carries at this size.
        const snap = await db.collection('assessment_timings')
          .orderBy('createdAt', 'desc').limit(40).get();
        for (const doc of snap.docs) {
          const d = doc.data() || {};
          // Exactly the ordinary Main prefix. 'main_ki' is the Batch variant
          // and is a DIFFERENT cache entry — counting it here would suppress
          // the ping for an entry that nothing warmed.
          // The token-count fallback exists only for rows written before
          // 2026-10-16, which carry no warmedPrefix at all; it must not apply
          // to a row that HAS the field, or it would re-admit 'main_ki'.
          const isMainWarm = d.warmedPrefix === 'main'
            || (d.warmedPrefix == null
                && ((d.cacheReadInputTokens || 0) > 20000 || (d.cacheCreationInputTokens || 0) > 20000));
          if (!isMainWarm) continue;
          const t = Date.parse(d.createdAt || '');
          if (!isNaN(t)) lastMainMs = Date.now() - t;
          break;
        }
        const w = await db.doc(WARM_DOC).get();
        if (w.exists) {
          const t = Date.parse((w.data() || {}).lastWarmAt || '');
          if (!isNaN(t)) lastPingMs = Date.now() - t;
        }
      } catch (e) { gateNote = 'gate read failed, warming anyway: ' + String(e && e.message || e); }

      // The most recent touch of either kind.
      const sinceTouch = Math.min(
        lastMainMs == null ? Infinity : lastMainMs,
        lastPingMs == null ? Infinity : lastPingMs
      );
      if (sinceTouch < quietMinutes * 60 * 1000) {
        return res.status(200).json({
          ok: true, mode: 'warm', skipped: true, version: ROBOGRADE_VERSION,
          reason: 'Main prefix touched recently — still warm',
          minutesSinceLastMainCacheTouch: lastMainMs == null ? null : Math.round(lastMainMs / 60000),
          minutesSinceLastPing: lastPingMs == null ? null : Math.round(lastPingMs / 60000),
          quietMinutes, costUsd: 0
        });
      }
    }

    const prefix = buildMainPrefix(null);
    const modelW = model || PRIMARY_MODEL;
    // MATCH PRODUCTION'S TTL. This used to be hardcoded to 1h while
    // api/assess.js took its TTL from config/caching, so with the dashboard set
    // to 5m the ping wrote hour-long entries that five-minute assessments then
    // shortened, and every ping after that paid the write price. The beta
    // header is only valid for the 1h variant, exactly as in assess.js.
    const _ttlW = (ttl === '5m' || _cfg.ttl === '5m') ? '5m' : '1h';
    const _ctlW = _ttlW === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    const _betaW = _ttlW === '1h' ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' } : {};
    const t0w = Date.now();
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKeyW, 'anthropic-version': '2023-06-01', ..._betaW },
        body: JSON.stringify({
          model: modelW,
          max_tokens: 1,                 // output spend is zero; we want the cache touch, not an answer
          system: [{ type: 'text', text: prefix, cache_control: _ctlW }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }]
        })
      });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'anthropic error', detail: j.error ? j.error.message : ('HTTP ' + r.status) });
      const u = j.usage || {};
      const created = u.cache_creation_input_tokens || 0;
      const read    = u.cache_read_input_tokens || 0;
      // One helper, one rate table. The cache-read multiplier is per-model
      // (0.05 on Opus 5.5, 0.10 on Opus 5) and this used to hardcode 0.10.
      const costUsd = costOf(u, modelW, _ttlW);
      // Record the touch so the next cron fire sees it and returns free.
      // Best-effort: a failed write makes the next fire pay again, which is a
      // cent, not an outage.
      // Record the touch AND accumulate what the ping has cost. The ping spends
      // real money and writes no assessment_timings row, so without this running
      // total it is invisible to every cost figure in the admin — a cent at a
      // time, forever, with nothing to show for it on the dashboard. Matt asked
      // for it as its own line under API spend, which is right: the saving is
      // only worth claiming if the cost of claiming it is visible beside it.
      if (db) {
        try {
          const { FieldValue } = await import('firebase-admin/firestore');
          await db.doc(WARM_DOC).set({
            lastWarmAt: new Date().toISOString(),
            version: ROBOGRADE_VERSION, model: modelW,
            cacheReadInputTokens: read, cacheCreationInputTokens: created,
            costUsd: Number(costUsd.toFixed(5)),
            // running totals, all time
            totalCostUsd: FieldValue.increment(Number(costUsd.toFixed(6))),
            totalPings: FieldValue.increment(1),
            totalReads: FieldValue.increment(read > 0 ? 1 : 0),
            totalWrites: FieldValue.increment(created > 0 ? 1 : 0),
            // a 30-day rolling log, one entry per paid ping, trimmed below
            recent: FieldValue.arrayUnion({ at: new Date().toISOString(), costUsd: Number(costUsd.toFixed(5)), read, created })
          }, { merge: true });
          // Trim `recent` to the last 30 days so the doc cannot grow without
          // bound. Best-effort; a failed trim costs a slightly larger document.
          try {
            const cur = (await db.doc(WARM_DOC).get()).data() || {};
            const cutoff = Date.now() - 30 * 86400000;
            const keep = (cur.recent || []).filter(x => Date.parse(x.at || '') >= cutoff);
            if (keep.length !== (cur.recent || []).length) await db.doc(WARM_DOC).set({ recent: keep }, { merge: true });
          } catch (e) { /* non-fatal */ }
        } catch (e) { /* non-fatal */ }
      }
      return res.status(200).json({
        ok: true, mode: 'warm', skipped: false, version: ROBOGRADE_VERSION,
        model: modelW, prefixChars: prefix.length, ms: Date.now() - t0w,
        minutesSinceLastAssessment: lastMainMs == null ? null : Math.round(lastMainMs / 60000),
        cacheCreationInputTokens: created,
        cacheReadInputTokens: read,
        costUsd: Number(costUsd.toFixed(5)),
        // READ is the healthy answer. WRITE on every ping means the prefix this
        // endpoint sends no longer matches what /api/assess sends — stop the
        // cron and diff lib/main_prompt.js against the prompt assess.js builds.
        ttl: _ttlW,
        caching: _cfg,
        verdict: read > 0 ? 'READ — cache refreshed, ping is working'
               : created > 0 ? (_ttlW === '5m'
                   ? 'WRITE — and it will be a write EVERY TIME. The TTL is 5m and the cron fires every 15 minutes, so the entry is always dead before the next ping. Set the TTL to 1h in the admin header or turn the cron off.'
                   : 'WRITE — prefix did NOT match the live cache entry. Investigate before leaving the cron on.')
               : 'NEITHER — unexpected; prefix may be under the minimum cacheable length',
        gateNote: gateNote || undefined
      });
    } catch (e) {
      // ── RECORD THE FAILURE (S24, 2026-10-19) ─────────────────────────────
      // Until now a failed ping returned 500 and wrote NOTHING. `lastWarmAt`
      // only moves on success, so a run of failures and a cron that never fired
      // produce an identical trace: a long gap in `gapsMin` and nothing else.
      // That ambiguity is why four rounds of this investigation needed the
      // Vercel dashboard to get any further. Now the doc says which it was.
      const _msg = String(e && e.message || e);
      if (db) {
        try {
          const { FieldValue } = await import('firebase-admin/firestore');
          await db.doc(WARM_DOC).set({
            lastErrorAt: new Date().toISOString(),
            lastError: _msg.slice(0, 300),
            lastErrorMs: Date.now() - t0w,
            totalFailures: FieldValue.increment(1)
          }, { merge: true });
        } catch (e2) { /* non-fatal */ }
      }
      return res.status(500).json({ error: 'warm ping failed', detail: _msg, ms: Date.now() - t0w });
    }
  }

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
