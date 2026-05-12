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

    const db = getFirestore();

    const usersSnap = await db.collection('users').get();
    const accounts = { total: usersSnap.size, day: 0, week: 0, month: 0 };
    for (const doc of usersSnap.docs) {
      const ms = Date.parse(doc.data().createdAt || '');
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) accounts.day++;
      if (ms >= cutoffs.week) accounts.week++;
      if (ms >= cutoffs.month) accounts.month++;
    }

    const itemsSnap = await db.collectionGroup('items').get();
    const items = { total: itemsSnap.size, day: 0, week: 0, month: 0 };
    for (const doc of itemsSnap.docs) {
      const d = doc.data();
      const ms = Date.parse(d.roboGradeDate || d.dateAcquired || '');
      if (Number.isNaN(ms)) continue;
      if (ms >= cutoffs.day) items.day++;
      if (ms >= cutoffs.week) items.week++;
      if (ms >= cutoffs.month) items.month++;
    }

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

    return res.status(200).json({ accounts, items, revenue, generatedAt: new Date().toISOString() });

  } catch (e) {
    console.error('[admin-stats] error:', e);
    return res.status(500).json({ error: 'Stats computation failed' });
  }
}
