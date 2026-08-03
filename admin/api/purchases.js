// /api/purchases.js  (admin project)
// Unified purchase ledger for the Sales tab. Reads the `purchases` collection —
// which BOTH the Stripe webhook (web) and verify_iap (iOS) write to — and joins
// each purchase with the buyer's name, 4-char transferCode, current credit
// balance, and total book count. Returns reverse-chronological rows plus
// web / iOS / combined totals.
//
// Purchase-doc shapes:
//   web (webhook.js):     { userId, credits, amountCents, createdAt (ISO), createdAtMs }
//   iOS (verify_iap.js):  { userId, credits, productId, source:'ios_iap', createdAt (Timestamp) }
// iOS docs carry no dollar amount, so we map productId → list price.

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

// "What you keep" after the platform's cut.
//   Apple: standard 30% commission → you keep 70%. CHANGE TO 0.85 once the App
//   Store Small Business Program enrollment takes effect (drops it to 15%).
//   Stripe: US standard 2.9% + $0.30 per transaction.
const APPLE_KEEP = 0.70;
const GOOGLE_KEEP = 0.85;   // Play small-business tier (15% cut). Set to 0.70 if still at 30%.
const STRIPE_PCT = 0.029;
const STRIPE_FIXED = 0.30;
const netOf = (amount, platform) =>
  platform === 'ios' ? +(amount * APPLE_KEEP).toFixed(2)
  : platform === 'android' ? +(amount * GOOGLE_KEEP).toFixed(2)
  : +Math.max(0, amount - (amount * STRIPE_PCT + STRIPE_FIXED)).toFixed(2);

// Normalize the mixed createdAt (Firestore Timestamp on iOS, ISO string on web).
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
      console.warn(`[admin-purchases] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const db = getFirestore();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    // User info (name / code / current credit balance) + per-user book counts.
    const [usersSnap, itemsSnap, purchSnap] = await Promise.all([
      db.collection('users').get(),
      db.collectionGroup('items').get(),
      db.collection('purchases').get(),
    ]);
    const uinfo = {};
    usersSnap.forEach(doc => {
      const d = doc.data();
      uinfo[doc.id] = { name: d.displayName || d.email || '(no name)', code: d.transferCode || '', credits: d.assessmentCredits ?? null };
    });
    const bookCounts = {};
    itemsSnap.forEach(d => {
      const uid = d.ref.parent.parent.id;
      bookCounts[uid] = (bookCounts[uid] || 0) + 1;
    });

    const totals = { web: { count: 0, amount: 0, net: 0 }, ios: { count: 0, amount: 0, net: 0 }, android: { count: 0, amount: 0, net: 0 } };
    let rows = purchSnap.docs.map(doc => {
      const p = doc.data();
      const uid = p.userId || '';
      const platform = p.source === 'ios_iap' ? 'ios'
        : p.source === 'android_play' ? 'android'
        : 'web';
      const isTest = !!(p.environment && p.environment !== 'Production');
      // iOS Sandbox buys are hidden entirely (legacy behavior). Android test buys
      // are KEPT so they stay visible for verification, but flagged and worth $0 so
      // they never inflate revenue.
      if (platform === 'ios' && isTest) return null;
      const listAmount = (platform === 'ios' || platform === 'android')
        ? (IOS_PRICE[p.productId] || 0)         // store buys carry productId, not amountCents
        : ((p.amountCents || 0) / 100);
      const amount = isTest ? 0 : listAmount;
      const net = isTest ? 0 : netOf(listAmount, platform);
      const u = uinfo[uid] || {};
      // Only real (non-test) purchases count toward the revenue totals.
      if (!isTest) {
        const t = totals[platform];
        t.count++; t.amount = +(t.amount + amount).toFixed(2); t.net = +(t.net + net).toFixed(2);
      }
      return {
        id: doc.id,
        platform,
        isTest,
        environment: p.environment || null,
        amount,
        net,
        credits: p.credits ?? null,
        userId: uid,
        userName: u.name || '(unknown user)',
        transferCode: u.code || '',
        userCredits: u.credits ?? null,   // current balance
        bookCount: bookCounts[uid] || 0,
        ts: tsMs(p),
      };
    });
    rows = rows.filter(Boolean);             // drop skipped Sandbox rows
    rows.sort((a, b) => b.ts - a.ts);        // reverse chronological
    rows = rows.slice(0, limit);

    const combined = {
      count: totals.web.count + totals.ios.count + totals.android.count,
      amount: +(totals.web.amount + totals.ios.amount + totals.android.amount).toFixed(2),
      net: +(totals.web.net + totals.ios.net + totals.android.net).toFixed(2),
    };

    return res.status(200).json({
      purchases: rows,
      totals: { web: totals.web, ios: totals.ios, android: totals.android, combined },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin-purchases] error:', e);
    return res.status(500).json({ error: e.message || 'purchases fetch failed' });
  }
}
