// /api/failure_audit.js — ONE-TIME DIAGNOSTIC. How much are failed assessments
// costing us, how often do they happen, and why.
//
// WHY THIS EXISTS (S23, 2026-10-12)
// api/assess.js used to record `costUsd: 0` on every errored run, under the
// comment "the API never returned (no tokens billed)". That is true for a
// failure BEFORE the request goes out and false for a TIMEOUT, which is the
// case that actually happens: by the time we abort at 55s, Anthropic has taken
// the full prompt and all four images, processed them, written or read the
// cache, and started streaming. The money is already spent. So every timeout in
// the history of this collection is real spend recorded as free, and the
// dashboard has never counted it.
//
// This endpoint answers the question ONCE. It is not wired into the dashboard
// on purpose - Matt does not want another number on an already crowded screen,
// and this is a decision input, not a metric to watch.
//
//   GET /api/failure_audit            whole collection
//   GET /api/failure_audit?days=30    just the last 30 days
//
// HOW THE FAILURE COST IS ESTIMATED. Error rows carry no usage object, so we
// cannot measure them. Instead we price each failure at the observed mean cost
// of a COLD SUCCESSFUL assessment of the same kind from this same data - cold,
// because a failure pays the cache WRITE the same way a cold success does, and
// self-calibrating, because it uses this account's real numbers rather than a
// rate card. Where there is no cold sample to learn from, it falls back to the
// overall mean. Both the estimate and the sample it came from are returned, so
// the number can be argued with.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });

    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) return res.status(403).json({ error: 'Forbidden' });

    const db = getFirestore();
    const days = Math.max(0, parseInt(req.query.days, 10) || 0);
    const cutoff = days ? Date.now() - days * 86400000 : 0;

    // Page the whole collection. One-time call, so correctness beats speed.
    let last = null, scanned = 0, pages = 0;
    const KIND = r => (r.kind === 'slabcheck' ? 'slabcheck'
      : /^deep_/.test(r._id) ? 'deep' : (r.imageCount >= 8 ? 'deep' : 'main'));

    const tally = {};                 // kind -> counters
    const bump = (k) => (tally[k] = tally[k] || {
      ok: 0, failed: 0, timedOut: 0, okCost: 0,
      coldN: 0, coldCost: 0, warmN: 0, warmCost: 0
    });
    const reasons = {}, byVersion = {}, byImageCount = {};
    let oldestMs = null, newestMs = null;

    while (pages < 200) {
      let q = db.collection('assessment_timings').orderBy('createdAt', 'desc').limit(1000);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const r = doc.data(); r._id = doc.id;
        const ms = Date.parse(r.createdAt || '');
        if (!Number.isNaN(ms)) {
          if (newestMs === null || ms > newestMs) newestMs = ms;
          if (oldestMs === null || ms < oldestMs) oldestMs = ms;
          if (cutoff && ms < cutoff) { last = null; break; }
        }
        scanned++;
        const k = KIND(r), t = bump(k);
        const failed = !!r.errorMessage;
        if (failed) {
          t.failed++;
          if (r.timedOut) t.timedOut++;
          const why = r.timedOut ? 'timeout'
            : String(r.errorMessage || 'unknown').slice(0, 60).replace(/\s+/g, ' ');
          reasons[why] = (reasons[why] || 0) + 1;
          byVersion[r.version || '?'] = (byVersion[r.version || '?'] || 0) + 1;
          const ic = r.imageCount == null ? '?' : String(r.imageCount);
          byImageCount[ic] = (byImageCount[ic] || 0) + 1;
        } else {
          const c = +r.costUsd || 0;
          t.ok++; t.okCost += c;
          if ((r.cacheCreationInputTokens || 0) > 0) { t.coldN++; t.coldCost += c; }
          else if ((r.cacheReadInputTokens || 0) > 0) { t.warmN++; t.warmCost += c; }
        }
      }
      pages++;
      last = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < 1000) break;
      if (cutoff) {
        const lc = Date.parse(last.data().createdAt || '');
        if (!Number.isNaN(lc) && lc < cutoff) break;
      }
    }

    const out = { scope: days ? `last ${days} days` : 'all time', rowsScanned: scanned, pages,
      oldest: oldestMs ? new Date(oldestMs).toISOString() : null,
      newest: newestMs ? new Date(newestMs).toISOString() : null, kinds: {} };
    let totalFailed = 0, totalFailCost = 0, totalOkCost = 0;
    for (const [k, t] of Object.entries(tally)) {
      const meanCold = t.coldN ? t.coldCost / t.coldN : null;
      const meanAny  = t.ok ? t.okCost / t.ok : 0;
      const unit = meanCold != null ? meanCold : meanAny;
      const est = t.failed * unit;
      totalFailed += t.failed; totalFailCost += est; totalOkCost += t.okCost;
      out.kinds[k] = {
        ok: t.ok, failed: t.failed, timedOut: t.timedOut,
        failureRatePct: t.ok + t.failed ? +(100 * t.failed / (t.ok + t.failed)).toFixed(1) : 0,
        meanColdCost: meanCold != null ? +meanCold.toFixed(4) : null, coldSamples: t.coldN,
        meanWarmCost: t.warmN ? +(t.warmCost / t.warmN).toFixed(4) : null, warmSamples: t.warmN,
        loggedCostOfSuccesses: +t.okCost.toFixed(2),
        estimatedCostOfFailures: +est.toFixed(2)
      };
    }
    out.totals = {
      loggedCost: +totalOkCost.toFixed(2),
      estimatedFailureCost: +totalFailCost.toFixed(2),
      trueCostEstimate: +(totalOkCost + totalFailCost).toFixed(2),
      failuresUndercountPct: totalOkCost ? +(100 * totalFailCost / totalOkCost).toFixed(1) : null,
      failedRows: totalFailed
    };
    out.whyTheyFailed = Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 15));
    out.failuresByVersion = byVersion;
    out.failuresByImageCount = byImageCount;
    out.note = 'Failure cost is an ESTIMATE: each failure priced at the mean cost of a COLD successful run of the same kind, measured from this same data. Error rows carry no usage object, so this cannot be measured directly.';
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
