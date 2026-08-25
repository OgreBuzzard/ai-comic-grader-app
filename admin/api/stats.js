// /api/stats.js
// Top-level dashboard aggregates.

// Helper: unescape if env var was double-escaped during paste.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) {
    raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      console.warn(`[admin-stats] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const cutoffs = { day: now - DAY, week: now - 7 * DAY, month: now - 30 * DAY };
    const APPLE_CUTOFF_MS = Date.UTC(2026, 7, 14); // Aug 14 2026: Apple 30%->15% (small-business)
    const perCredit = { day: { net: 0, credits: 0 }, week: { net: 0, credits: 0 }, month: { net: 0, credits: 0 } };
    const assessCost = { day: { cents: 0, n: 0 }, week: { cents: 0, n: 0 }, month: { cents: 0, n: 0 } };

    const db = getFirestore();

    const usersSnap = await db.collection('users').get();
    const accounts = { total: usersSnap.size, day: 0, week: 0, month: 0 };
    let creditsOutstanding = 0; // total unused credits sitting in all user accounts
    for (const doc of usersSnap.docs) {
      const d = doc.data();
      creditsOutstanding += (d.assessmentCredits || 0);
      const ms = Date.parse(d.createdAt || '');
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) accounts.day++;
      if (ms >= cutoffs.week) accounts.week++;
      if (ms >= cutoffs.month) accounts.month++;
    }

    const itemsSnap = await db.collectionGroup('items').get();
    const items = { total: itemsSnap.size, day: 0, week: 0, month: 0 };
    // S21: assessment platform mix (iOS / Android / PWA-web) from the client stamp.
    // Only items saved since the stamp shipped carry clientPlatform; older ones are
    // simply not counted here (so this is a forward-looking ratio).
    const platforms = { ios:{day:0,week:0,month:0,total:0}, android:{day:0,week:0,month:0,total:0}, web:{day:0,week:0,month:0,total:0} };
    for (const doc of itemsSnap.docs) {
      const d = doc.data();
      const ms = Date.parse(d.roboGradeDate || d.dateAcquired || '');
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) items.day++;
      if (ms >= cutoffs.week) items.week++;
      if (ms >= cutoffs.month) items.month++;
      const cp = d.clientPlatform;
      const plat = (cp === 'ios' || cp === 'android') ? cp : (cp ? 'web' : null);
      if (plat) {
        platforms[plat].total++;
        if (ms >= cutoffs.day) platforms[plat].day++;
        if (ms >= cutoffs.week) platforms[plat].week++;
        if (ms >= cutoffs.month) platforms[plat].month++;
      }
    }

    // iOS purchase docs carry no dollar amount, so map productId → list price.
    const IOS_PRICE_CENTS = {
      'app.robograder.credits.stack': 999,
      'app.robograder.credits.wall': 2999,
      'app.robograder.credits.shortbox': 9999,
      'app.robograder.credits.shortbox2': 9999,
    };
    const purchasesSnap = await db.collection('purchases').get();
    const revenue = {
      totalCents: 0, webCents: 0, iosCents: 0, androidCents: 0, netCents: 0, webNetCents: 0, iosNetCents: 0, androidNetCents: 0, dayCents: 0, weekCents: 0, monthCents: 0,
      refundedCents: 0, refundedCount: 0,
      webDayCents: 0, webWeekCents: 0, webMonthCents: 0, iosDayCents: 0, iosWeekCents: 0, iosMonthCents: 0, androidDayCents: 0, androidWeekCents: 0, androidMonthCents: 0,
      webNetDayCents: 0, webNetWeekCents: 0, webNetMonthCents: 0, iosNetDayCents: 0, iosNetWeekCents: 0, iosNetMonthCents: 0, androidNetDayCents: 0, androidNetWeekCents: 0, androidNetMonthCents: 0,
    };
    const revByDay = {}; // net revenue per day (last 30d) for the chart
    for (const doc of purchasesSnap.docs) {
      const d = doc.data();
      // Refunded purchases earned $0 — exclude from every revenue total, tally
      // separately for visibility. (Stripe/web refunds flip this via webhook;
      // store refunds are marked manually in Firestore.)
      if (d.refunded) {
        const _rstore = d.source === 'ios_iap' || d.source === 'android_play';
        revenue.refundedCents += _rstore ? (IOS_PRICE_CENTS[d.productId] || 0) : (d.amountCents || 0);
        revenue.refundedCount++;
        continue;
      }
      const platform = d.source === 'ios_iap' ? 'ios'
        : d.source === 'android_play' ? 'android'
        : 'web';
      let amt;
      if (platform === 'ios' || platform === 'android') {
        // Skip Sandbox/test store buys — not real revenue.
        if (d.environment && d.environment !== 'Production') continue;
        amt = IOS_PRICE_CENTS[d.productId] || 0;   // list price (cents); same product IDs on both stores
        revenue[platform + 'Cents'] += amt;
      } else {
        amt = d.amountCents || 0;
        revenue.webCents += amt;
      }
      const c = d.createdAt;
      const ms = (c && typeof c.toMillis === 'function') ? c.toMillis() : (d.createdAtMs || Date.parse(c || ''));
      // Net = what you keep. Apple: 70% before Aug 14 2026, 85% (small-business) on/after.
      // Google (small-business tier) 85%; Stripe = amount − 2.9% − $0.30.
      const _iosKeep = (Number.isFinite(ms) && ms >= APPLE_CUTOFF_MS) ? 0.85 : 0.70;
      const netCents = platform === 'ios' ? Math.round(amt * _iosKeep)
        : platform === 'android' ? Math.round(amt * 0.85)
        : Math.max(0, Math.round(amt - (amt * 0.029 + 30)));
      revenue.totalCents += amt;
      revenue.netCents += netCents;
      revenue[platform + 'NetCents'] += netCents;
      if (Number.isNaN(ms)) continue;
      const pfx = platform;
      // S22: net earned per credit. `credits` already includes the repeat-shortbox
      // bonus (webhook/verify_iap write grant = base + bonus); web `amount` is
      // post-promo (Stripe amount_total). Signup + referral free credits aren't
      // purchases, so they never appear here.
      const _cr = +d.credits || 0;
      if (_cr > 0) {
        if (ms >= cutoffs.day) { perCredit.day.net += netCents; perCredit.day.credits += _cr; }
        if (ms >= cutoffs.week) { perCredit.week.net += netCents; perCredit.week.credits += _cr; }
        if (ms >= cutoffs.month) { perCredit.month.net += netCents; perCredit.month.credits += _cr; }
      }
      if (ms >= cutoffs.day) { revenue.dayCents += amt; revenue[pfx + 'DayCents'] += amt; revenue[pfx + 'NetDayCents'] += netCents; }
      if (ms >= cutoffs.week) { revenue.weekCents += amt; revenue[pfx + 'WeekCents'] += amt; revenue[pfx + 'NetWeekCents'] += netCents; }
      if (ms >= cutoffs.month) { revenue.monthCents += amt; revenue[pfx + 'MonthCents'] += amt; revenue[pfx + 'NetMonthCents'] += netCents; const k = new Date(ms).toISOString().slice(0, 10); revByDay[k] = (revByDay[k] || 0) + netCents; }
    }

    // Avg cost of the last ~100 REAL assessments (excludes slab-checks + errored
    // rows). One small indexed query (150 most-recent) — does not meaningfully
    // slow the dashboard. Used to estimate the liability of outstanding credits.
    // One bounded timings read (recent ~2500 ≈ last ~5 weeks at current volume)
    // powers three things at once: avg assessment cost, period spend, and the
    // daily spend series. Bounded so the dashboard stays fast — a true lifetime
    // spend total would want a daily rollup rather than re-summing every load.
    let avgAssessmentCost = 0;
    const spend = { dayCents: 0, weekCents: 0, monthCents: 0 };
    const spendByDay = {};
    let allTimeApiCents = 0, fetchedCount = 0;
    try {
      const tSnap = await db.collection('assessment_timings').orderBy('createdAt', 'desc').limit(2500).get();
      fetchedCount = tSnap.docs.length;
      const costs = [];
      for (const doc of tSnap.docs) {
        const t = doc.data();
        const cost = +t.costUsd || 0;
        const cents = Math.round(cost * 100);
        allTimeApiCents += cents;
        const c = t.createdAt;
        const ms = (c && typeof c.toMillis === 'function') ? c.toMillis() : Date.parse(c || '');
        if (!Number.isNaN(ms)) {
          if (ms >= cutoffs.day) spend.dayCents += cents;
          if (ms >= cutoffs.week) spend.weekCents += cents;
          if (ms >= cutoffs.month) { spend.monthCents += cents; const k = new Date(ms).toISOString().slice(0, 10); spendByDay[k] = (spendByDay[k] || 0) + cents; }
        }
        if (t.kind !== 'slabcheck' && cost > 0 && !Number.isNaN(ms)) {
          if (ms >= cutoffs.day) { assessCost.day.cents += cents; assessCost.day.n++; }
          if (ms >= cutoffs.week) { assessCost.week.cents += cents; assessCost.week.n++; }
          if (ms >= cutoffs.month) { assessCost.month.cents += cents; assessCost.month.n++; }
        }
        if (t.kind !== 'slabcheck' && cost > 0 && costs.length < 100) costs.push(cost);
      }
      if (costs.length) avgAssessmentCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    } catch (e) { console.warn('[admin-stats] timings read skipped:', e.message); }
    const creditLiability = +(creditsOutstanding * avgAssessmentCost).toFixed(2);

    // Infra cost estimates layered on top of the Anthropic API spend so the
    // dashboard reflects true burn. Tune these two constants as usage changes:
    // Firebase ~$1/day; Vercel $20/mo amortized to ~$0.66/day.
    const FIREBASE_DAILY_CENTS = 100, VERCEL_DAILY_CENTS = 66;
    const INFRA_DAILY = FIREBASE_DAILY_CENTS + VERCEL_DAILY_CENTS;
    spend.dayCents += INFRA_DAILY;
    spend.weekCents += INFRA_DAILY * 7;
    spend.monthCents += INFRA_DAILY * 30;

    // S22: EXACT all-time API cost via an append-only rollup. Timings are
    // immutable, so each load only sums the NEW timings since the last watermark
    // (count-delta, newest-first) and folds them into a persisted total. This
    // replaces the old avg×count tail ESTIMATE — the estimate re-priced ALL older
    // assessments whenever the recent-100 average moved (e.g. a post-deploy
    // cache-write at ~$0.29), which is what made all-time spend (and Profit) lurch
    // ~$80-100 on quiet days. `?rebuild=1` forces a full recompute.
    const LAUNCH_MS = Date.parse('2026-03-30');
    const _daysLive = Math.max(1, Math.round((now - LAUNCH_MS) / DAY));
    let allTimeApiCentsExact = allTimeApiCents; // fallback = the fetched-window sum
    try {
      const rollupRef = db.collection('admin_rollup').doc('apicost');
      const forceRebuild = !!(req.query && (req.query.rebuild === '1' || req.query.rebuild === 'true'));
      let _roll = null; try { const _rs = await rollupRef.get(); if (_rs.exists) _roll = _rs.data(); } catch (e) {}
      let totalTimings = 0; try { const _c = await db.collection('assessment_timings').count().get(); totalTimings = _c.data().count || 0; } catch (e) {}
      if (_roll && !forceRebuild && typeof _roll.apiCostCents === 'number' && typeof _roll.count === 'number' && _roll.count <= totalTimings) {
        allTimeApiCentsExact = _roll.apiCostCents;
        const newN = totalTimings - _roll.count;
        if (newN > 0) {
          const _ns = await db.collection('assessment_timings').orderBy('createdAt', 'desc').limit(newN).get();
          let add = 0; _ns.docs.forEach(d => { add += Math.round((+(d.data().costUsd) || 0) * 100); });
          allTimeApiCentsExact += add;
          try { await rollupRef.set({ apiCostCents: allTimeApiCentsExact, count: totalTimings, updatedAt: new Date().toISOString() }, { merge: true }); } catch (e) {}
        }
      } else {
        // Initialize / rebuild: paginate the whole collection ONCE and persist.
        let sum = 0, processed = 0, last = null;
        while (true) {
          let q = db.collection('assessment_timings').orderBy('createdAt', 'desc').limit(1000);
          if (last) q = q.startAfter(last);
          const snap = await q.get();
          if (snap.empty) break;
          snap.docs.forEach(d => { sum += Math.round((+(d.data().costUsd) || 0) * 100); });
          processed += snap.docs.length; last = snap.docs[snap.docs.length - 1];
          if (snap.docs.length < 1000) break;
        }
        allTimeApiCentsExact = sum;
        try { await rollupRef.set({ apiCostCents: sum, count: processed, updatedAt: new Date().toISOString() }, { merge: true }); } catch (e) {}
      }
    } catch (e) { console.warn('[admin-stats] apicost rollup failed; using window sum:', e.message); }
    spend.allTimeCents = allTimeApiCentsExact + INFRA_DAILY * _daysLive;

    // ── Claude Max (development) cost — factored into PROFIT ONLY, never into
    // Spending (Spending stays a pure reflection of per-assessment API cost).
    // Past charges are listed exactly; going forward a recurring $221.10 (Max 20x)
    // accrues on the 15th. Matt plans to drop to Max 5x after the Sep 15 charge —
    // when that happens, change CLAUDE_MAX_MONTHLY_CENTS (or add a rate-change row).
    const CLAUDE_MAX_PAST = [
      13.56, 11.30, 5.53, 11.06, 11.90, 11.31, 49.75, 31.01, // Mar–Apr dev ramp
      221.10, 221.10, 221.10, 221.10                          // May 15 – Aug 15 (20x)
    ];
    const CLAUDE_MAX_MONTHLY_CENTS = 22110;      // $221.10 (Max 20x)
    const CLAUDE_MAX_RECUR_START = '2026-09-15'; // first future recurring charge
    let devAllTimeCents = CLAUDE_MAX_PAST.reduce((a, v) => a + Math.round(v * 100), 0);
    try {
      let _d = new Date(CLAUDE_MAX_RECUR_START + 'T00:00:00Z');
      while (_d.getTime() <= now) { devAllTimeCents += CLAUDE_MAX_MONTHLY_CENTS; _d.setUTCMonth(_d.getUTCMonth() + 1); }
    } catch (e) {}
    // Amortize the CURRENT monthly rate across the period trios (so the day/week/
    // month Profit figures carry their share of the subscription).
    const _devDay = Math.round(CLAUDE_MAX_MONTHLY_CENTS / 30);
    const devCost = { allTimeCents: devAllTimeCents, dayCents: _devDay, weekCents: _devDay * 7, monthCents: CLAUDE_MAX_MONTHLY_CENTS };

    // 30-day daily series (net revenue vs total spend incl. infra) for the chart.
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const k = new Date(now - i * DAY).toISOString().slice(0, 10);
      series.push({ date: k.slice(5), revCents: revByDay[k] || 0, spendCents: (spendByDay[k] || 0) + INFRA_DAILY });
    }

    return res.status(200).json({
      accounts, items, platforms, revenue, spend, series, devCost,
      credits: { outstanding: creditsOutstanding, avgAssessmentCost: +avgAssessmentCost.toFixed(4), liability: creditLiability },
      perCredit: {
        day: perCredit.day.credits ? +(perCredit.day.net / 100 / perCredit.day.credits).toFixed(4) : null,
        week: perCredit.week.credits ? +(perCredit.week.net / 100 / perCredit.week.credits).toFixed(4) : null,
        month: perCredit.month.credits ? +(perCredit.month.net / 100 / perCredit.month.credits).toFixed(4) : null,
      },
      assessCost: {
        day: assessCost.day.n ? +(assessCost.day.cents / 100 / assessCost.day.n).toFixed(4) : null,
        week: assessCost.week.n ? +(assessCost.week.cents / 100 / assessCost.week.n).toFixed(4) : null,
        month: assessCost.month.n ? +(assessCost.month.cents / 100 / assessCost.month.n).toFixed(4) : null,
      },
      generatedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[admin-stats] error:', e);
    return res.status(500).json({ error: 'Stats computation failed' });
  }
}
