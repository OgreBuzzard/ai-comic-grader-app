// /api/growth.js  (admin project)
// Ad-source funnel for the GROWTH panel. Groups the funnel — accounts →
// activation (≥1 assessment) → buyers → net revenue — by utmSource (the ad that
// produced each signup, stamped on the user doc at account creation).
//
// Lazy: only fetched when the GROWTH panel is opened, so it never touches the
// dashboard's load time. Reads users + items(refs only) + purchases once, the
// same reads the Sales tab already does. Revenue math mirrors purchases.js.
//
// Only NEW signups (post ad-source capture) carry a utmSource; everyone else
// buckets under "direct / none". Native store installs also land there until
// the Play Install Referrer is wired.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return JSON.parse(raw);
}

const IOS_PRICE = {
  'app.robograder.credits.stack': 9.99,
  'app.robograder.credits.wall': 29.99,
  'app.robograder.credits.shortbox': 99.99,
  'app.robograder.credits.shortbox2': 99.99,
};
const APPLE_KEEP = 0.70;
const APPLE_KEEP_SB = 0.85;
const APPLE_CUTOFF_MS = Date.UTC(2026, 7, 14); // Aug 14 2026: Apple 30%->15%
const GOOGLE_KEEP = 0.85;
const STRIPE_PCT = 0.029;
const STRIPE_FIXED = 0.30;
const netOf = (amount, platform, ms) =>
  platform === 'ios' ? +(amount * ((Number.isFinite(ms) && ms >= APPLE_CUTOFF_MS) ? APPLE_KEEP_SB : APPLE_KEEP)).toFixed(2)
  : platform === 'android' ? +(amount * GOOGLE_KEEP).toFixed(2)
  : +Math.max(0, amount - (amount * STRIPE_PCT + STRIPE_FIXED)).toFixed(2);

function tsMs(p) {
  const c = p.createdAt;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  if (typeof p.createdAtMs === 'number') return p.createdAtMs;
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
      console.warn(`[admin-growth] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const db = getFirestore();
    const [usersSnap, itemRefsSnap, purchSnap] = await Promise.all([
      db.collection('users').get(),
      db.collectionGroup('items').select().get(), // refs only — lightest full scan
      db.collection('purchases').get(),
    ]);

    const norm = s => (s && String(s).trim()) ? String(s).trim().toLowerCase() : 'direct / none';
    const bucket = {};
    const B = src => bucket[src] || (bucket[src] = {
      source: src, accounts: 0, activated: 0, buyers: 0, netRevenue: 0, _payers: new Set(),
    });

    // Accounts by source + uid→source map.
    const srcOf = {};
    usersSnap.forEach(doc => {
      const d = doc.data();
      const src = norm(d.utmSource);
      srcOf[doc.id] = src;
      B(src).accounts++;
    });

    // Activation: a user with >= 1 assessment.
    const activatedUids = new Set();
    itemRefsSnap.forEach(doc => {
      const uid = doc.ref.parent && doc.ref.parent.parent && doc.ref.parent.parent.id;
      if (uid) activatedUids.add(uid);
    });
    activatedUids.forEach(uid => { const src = srcOf[uid]; if (src) B(src).activated++; });

    // Buyers + net revenue by source (mirror purchases.js: skip refunds + tests).
    purchSnap.forEach(doc => {
      const p = doc.data();
      if (p.refunded) return;
      const uid = p.userId || '';
      const src = srcOf[uid];
      if (!src) return;
      const platform = p.source === 'ios_iap' ? 'ios' : p.source === 'android_play' ? 'android' : 'web';
      const isTest = !!(p.environment && p.environment !== 'Production');
      if (isTest) return;
      const listAmount = (platform === 'ios' || platform === 'android')
        ? (IOS_PRICE[p.productId] || 0)
        : ((p.amountCents || 0) / 100);
      const net = netOf(listAmount, platform, tsMs(p));
      const b = B(src);
      b.netRevenue = +(b.netRevenue + net).toFixed(2);
      b._payers.add(uid);
    });

    const rows = Object.values(bucket).map(b => {
      const buyers = b._payers.size;
      return {
        source: b.source,
        accounts: b.accounts,
        activated: b.activated,
        buyers,
        netRevenue: b.netRevenue,
        revPerAccount: b.accounts ? +(b.netRevenue / b.accounts).toFixed(2) : 0,
      };
    }).sort((a, b) => b.accounts - a.accounts);

    const totals = rows.reduce((t, r) => ({
      accounts: t.accounts + r.accounts,
      activated: t.activated + r.activated,
      buyers: t.buyers + r.buyers,
      netRevenue: +(t.netRevenue + r.netRevenue).toFixed(2),
    }), { accounts: 0, activated: 0, buyers: 0, netRevenue: 0 });

    return res.status(200).json({ rows, totals, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[admin-growth]', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
