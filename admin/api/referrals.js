// /api/referrals.js  (admin project)
// Referral Bonus audit — reads the `referrals` collection (written by the main
// project's /api/referral), joins issuer/recipient names + 4-char codes from the
// users collection, and returns reverse-chronological rows plus totals. Each doc
// is keyed `${issuerUid}_${tier}` and looks like:
//   { issuerUid, recipientUid, tier, referrerCredits, issuerCredits,
//     reversed, reversedAt?, reversedReason?, createdAt (ISO) }

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return JSON.parse(raw);
}

const TIER_LABEL = { comic_stack: 'Comic Stack', comic_wall: 'Comic Wall', short_box: 'Short Box' };

function tsMs(r) {
  const c = r.createdAt;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  if (typeof c === 'string') return Date.parse(c) || 0;
  return 0;
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
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      console.warn(`[admin-referrals] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const db = getFirestore();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    const [usersSnap, refSnap, adjSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('referrals').get(),
      db.collection('credit_adjustments').get(),
    ]);
    const uinfo = {};
    usersSnap.forEach(doc => {
      const d = doc.data();
      uinfo[doc.id] = { name: d.displayName || d.email || '(no name)', code: d.transferCode || '' };
    });

    const totals = {
      count: 0, active: 0, reversed: 0,
      referrerCredits: 0, issuerCredits: 0,   // active only
    };
    let rows = refSnap.docs.map(doc => {
      const r = doc.data() || {};
      const iss = uinfo[r.issuerUid] || {};
      const rec = uinfo[r.recipientUid] || {};
      const reversed = !!r.reversed;
      const referrerCredits = r.referrerCredits || 0;
      const issuerCredits = r.issuerCredits || 0;
      totals.count++;
      if (reversed) totals.reversed++;
      else {
        totals.active++;
        totals.referrerCredits += referrerCredits;
        totals.issuerCredits += issuerCredits;
      }
      return {
        id: doc.id,
        tier: r.tier || '',
        tierLabel: TIER_LABEL[r.tier] || r.tier || '?',
        issuerUid: r.issuerUid || '',
        issuerName: iss.name || '(unknown)',
        issuerCode: iss.code || '',
        recipientUid: r.recipientUid || '',
        recipientName: rec.name || '(unknown)',
        recipientCode: rec.code || '',
        referrerCredits,
        issuerCredits,
        reversed,
        reversedReason: r.reversedReason || null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
        ts: tsMs(r),
      };
    });
    rows.sort((a, b) => b.ts - a.ts);
    rows = rows.slice(0, limit);

    // ── Gifts: admin credit grants (positive assessmentCredits deltas) from the
    // credit_adjustments audit collection. A gift is any adjustment that raised
    // a user's assessmentCredits — captured via the primaryDelta mirror, with a
    // fallback scan of the changes[] array for multi-field adjustments.
    const giftDelta = (a) => {
      if (a.primaryField === 'assessmentCredits' && typeof a.primaryDelta === 'number') return a.primaryDelta;
      const ch = Array.isArray(a.changes) ? a.changes.find(c => c.field === 'assessmentCredits') : null;
      return ch && typeof ch.delta === 'number' ? ch.delta : null;
    };
    const giftTotals = { count: 0, credits: 0 };
    let gifts = adjSnap.docs.map(doc => {
      const a = doc.data() || {};
      const delta = giftDelta(a);
      if (delta == null || delta <= 0) return null;
      const u = uinfo[a.userId] || {};
      const ts = (typeof a.atMs === 'number' ? a.atMs : (a.at ? Date.parse(a.at) : 0)) || 0;
      giftTotals.count++; giftTotals.credits += delta;
      return {
        id: doc.id,
        userId: a.userId || '',
        userName: u.name || '(unknown)',
        credits: delta,
        adminEmail: a.adminEmail || '',
        reason: a.reason || '',
        at: typeof a.at === 'string' ? a.at : null,
        ts,
      };
    }).filter(Boolean);
    gifts.sort((a, b) => b.ts - a.ts);
    gifts = gifts.slice(0, limit);

    return res.status(200).json({ referrals: rows, totals, gifts, giftTotals, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[admin-referrals] error:', e);
    return res.status(500).json({ error: e.message || 'referrals fetch failed' });
  }
}
