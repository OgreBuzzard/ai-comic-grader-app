// /api/admin/stats.js
// Returns top-level dashboard aggregates: accounts, items, revenue with
// day/week/month breakouts. All counts computed from Firestore.
//
// Auth: requires a Firebase ID token in the Authorization header AND the
// authenticated user's email must appear in the ADMIN_EMAILS env var
// (comma-separated allowlist). Both checks must pass or the endpoint 403s
// with no information leak.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }

    // ── Auth gate ────────────────────────────────────────────────────────────
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(m[1]);
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      // Log the attempt — if non-admin emails are hitting this, that's
      // signal worth seeing in Vercel logs.
      console.warn(`[admin-stats] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Time windows ─────────────────────────────────────────────────────────
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const cutoffs = { day: now - DAY, week: now - WEEK, month: now - MONTH };

    const db = getFirestore();

    // ── Accounts ─────────────────────────────────────────────────────────────
    // `users` doc has `createdAt` as ISO string. Stream and bucket. Firestore
    // count() aggregation would be cheaper but the date breakdowns need the
    // per-doc timestamp anyway, so we read once and bucket in memory.
    const usersSnap = await db.collection('users').get();
    const accounts = { total: usersSnap.size, day: 0, week: 0, month: 0 };
    for (const doc of usersSnap.docs) {
      const created = doc.data().createdAt;
      if (!created) continue;
      const ms = Date.parse(created);
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) accounts.day++;
      if (ms >= cutoffs.week) accounts.week++;
      if (ms >= cutoffs.month) accounts.month++;
    }

    // ── Items ────────────────────────────────────────────────────────────────
    // Collection group query across all users' `items` subcollections. Uses
    // roboGradeDate (ISO) as the timestamp because that's when the assessment
    // happened, which is the meaningful "new item" event. Items added without
    // assessment (rare) won't have roboGradeDate and won't bucket — fine.
    const itemsSnap = await db.collectionGroup('items').get();
    const items = { total: itemsSnap.size, day: 0, week: 0, month: 0 };
    for (const doc of itemsSnap.docs) {
      const d = doc.data();
      const stamp = d.roboGradeDate || d.dateAcquired || null;
      if (!stamp) continue;
      const ms = Date.parse(stamp);
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) items.day++;
      if (ms >= cutoffs.week) items.week++;
      if (ms >= cutoffs.month) items.month++;
    }

    // ── Revenue ──────────────────────────────────────────────────────────────
    // `purchases` collection holds per-transaction records (added in webhook
    // patch). Each doc has `createdAtMs` (number) and `amountCents` (int).
    // Refunds are NOT subtracted — this is gross revenue. Net could be added
    // later by also reading a `refunds` collection if needed.
    const purchasesSnap = await db.collection('purchases').get();
    const revenue = { totalCents: 0, dayCents: 0, weekCents: 0, monthCents: 0 };
    for (const doc of purchasesSnap.docs) {
      const d = doc.data();
      const amt = d.amountCents || 0;
      const ms = d.createdAtMs || Date.parse(d.createdAt || '');
      revenue.totalCents += amt;
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) revenue.dayCents += amt;
      if (ms >= cutoffs.week) revenue.weekCents += amt;
      if (ms >= cutoffs.month) revenue.monthCents += amt;
    }

    return res.status(200).json({
      accounts,
      items,
      revenue,
      generatedAt: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[admin-stats] error:', e);
    return res.status(500).json({ error: 'Stats computation failed' });
  }
}
