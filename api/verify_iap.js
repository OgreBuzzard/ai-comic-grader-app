// api/verify_iap.js — iOS StoreKit 2 receipt validation + credit fulfillment.
//
// The iOS app sends the StoreKit 2 `jwsRepresentation` from a completed
// purchase. We verify it with app-store-server-api's decodeTransaction, which
// checks the JWS signature AND validates the certificate chain — pinning the
// chain's root to Apple's Root CA G3 SHA-256 fingerprint. That means NO root
// certificate file or env var is needed (an earlier env-var approach kept
// getting truncated on paste). Then we read productId + transactionId from the
// VERIFIED payload, map the product to a credit count, and grant credits
// idempotently keyed on the Apple transactionId — mirroring webhook.js (Stripe)
// so the admin dashboard sees all purchases in one place.
//
// Imports MUST stay at the very top (no statement before them) — a top-level
// statement before ESM imports breaks Vercel's ESM detection (OPT_500, S17).
// A static import is also REQUIRED for Vercel to detect this file as ESM at all;
// without one it's parsed as CommonJS, `export default` throws at load, and the
// function dies before setting CORS — surfacing as an opaque "network error" on
// the cross-origin iOS client. So we keep a zero-risk Node built-in import here
// and load the pure-ESM app-store-server-api dynamically inside the handler.
// (Imported `process` is genuinely used below for process.env, so the bundler
// can't drop it and ESM detection holds.)
import process from 'node:process';

const BUNDLE_ID = 'app.robograder';

// Product ID → credits granted. Keep in sync with App Store Connect AND
// checkout.js (Stripe) so iOS and PWA grant the same.
const PRODUCT_CREDITS = {
  'app.robograder.credits.stack': 10,
  'app.robograder.credits.wall': 35,
  'app.robograder.credits.shortbox': 125,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 1. Authenticate the user from their Firebase ID token (never trust a
    //    client-sent uid).
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Missing auth token' });

    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // 2. Verify + decode the StoreKit 2 JWS (signature + cert chain pinned to
    //    Apple's Root CA G3 fingerprint).
    const { jws } = req.body || {};
    if (!jws) return res.status(400).json({ error: 'Missing jws' });

    let tx;
    try {
      const { decodeTransaction } = await import('app-store-server-api');
      tx = await decodeTransaction(jws);
    } catch (e) {
      return res.status(400).json({ error: 'Receipt verification failed: ' + ((e && e.message) || e) });
    }

    if (tx.bundleId && tx.bundleId !== BUNDLE_ID) {
      return res.status(400).json({ error: 'Bundle mismatch' });
    }
    const credits = PRODUCT_CREDITS[tx.productId];
    if (!credits) return res.status(400).json({ error: 'Unknown product: ' + tx.productId });
    const transactionId = String(tx.transactionId);
    const envName = tx.environment || 'Production';

    // 3. Grant credits idempotently, keyed on the Apple transactionId.
    const db = getFirestore();
    const purchaseRef = db.collection('purchases').doc('iap_' + transactionId);
    const userRef = db.collection('users').doc(uid);
    let alreadyProcessed = false;
    await db.runTransaction(async (t) => {
      const existing = await t.get(purchaseRef);
      if (existing.exists) { alreadyProcessed = true; return; }
      const userSnap = await t.get(userRef);
      if (userSnap.exists) {
        t.update(userRef, {
          assessmentCredits: FieldValue.increment(credits),
          totalPurchased: FieldValue.increment(credits),
        });
      } else {
        t.set(userRef, { assessmentCredits: credits, totalPurchased: credits }, { merge: true });
      }
      t.set(purchaseRef, {
        userId: uid,
        credits,
        productId: tx.productId,
        transactionId,
        originalTransactionId: tx.originalTransactionId ? String(tx.originalTransactionId) : null,
        source: 'ios_iap',
        environment: envName,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    console.log(`[verify_iap] ${alreadyProcessed ? 'already-processed' : 'credited'} ${credits} to ${uid} (tx ${transactionId}, ${envName})`);
    return res.status(200).json({ ok: true, credits, alreadyProcessed });
  } catch (e) {
    console.error('[verify_iap]', e && (e.stack || e.message || e));
    return res.status(400).json({ error: (e && e.message) || 'Validation failed' });
  }
}
