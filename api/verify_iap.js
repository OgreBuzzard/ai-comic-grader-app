// api/verify_iap.js — iOS StoreKit 2 receipt validation + credit fulfillment.
//
// The iOS app sends the StoreKit 2 `jwsRepresentation` from a completed
// purchase. We verify the JWS against Apple's certificate chain (so it can't be
// forged), read the productId + transactionId from the VERIFIED payload, map
// the product to a credit count, and grant credits to the signed-in user —
// idempotently, keyed on the Apple transactionId. Mirrors the crediting shape
// of webhook.js (Stripe) so the admin dashboard sees all purchases in one place.
//
// Imports MUST stay at the very top (no statement before them) — a top-level
// statement before ESM imports breaks Vercel's ESM detection (OPT_500, S17).
import { SignedDataVerifier, Environment } from '@apple/app-store-server-library';
import { X509Certificate } from 'crypto';

const BUNDLE_ID = 'app.robograder';

// Product ID → credits granted. Keep in sync with the App Store Connect
// consumables AND with checkout.js (Stripe) so iOS and PWA grant the same.
const PRODUCT_CREDITS = {
  'app.robograder.credits.stack': 10,
  'app.robograder.credits.wall': 35,
  'app.robograder.credits.shortbox': 125,
};

// Apple Root CA - G3 (base64-encoded DER), supplied via env so we don't bundle a
// binary cert into the serverless function. Set APPLE_ROOT_CA_G3 in Vercel to the
// base64 of AppleRootCA-G3.cer (from https://www.apple.com/certificateauthority/).
function loadAppleRootCAs() {
  let raw = process.env.APPLE_ROOT_CA_G3;
  if (!raw) throw new Error('APPLE_ROOT_CA_G3 env var not set');
  raw = raw.trim();
  // Accept either PEM text or base64-encoded DER. Strip whitespace/line-wrapping
  // from base64 — a wrapped/truncated paste was the original failure mode.
  let der;
  if (raw.indexOf('BEGIN CERTIFICATE') !== -1) {
    der = Buffer.from(raw, 'utf8'); // PEM — X509Certificate parses it directly
  } else {
    der = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
  }
  // Validate now with a clear message; otherwise the library throws an opaque
  // OpenSSL "PEM routines: no start line" when the bytes aren't a real cert.
  try {
    new X509Certificate(der);
  } catch (e) {
    throw new Error('APPLE_ROOT_CA_G3 is not a valid certificate (decoded ' + der.length + ' bytes). Re-set it from AppleRootCA-G3.cer. Underlying: ' + e.message);
  }
  return [der];
}

// Peek the environment ("Sandbox"/"Production") from the UNVERIFIED JWS payload
// purely to pick the right verifier config. Trust still comes from
// verifyAndDecodeTransaction below — this peek grants nothing on its own.
function peekEnvironment(jws) {
  const seg = String(jws).split('.')[1];
  if (!seg) throw new Error('Malformed JWS');
  const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  return payload.environment; // "Sandbox" | "Production"
}

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
    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // 2. Verify the StoreKit 2 JWS against Apple's cert chain.
    const { jws } = req.body || {};
    if (!jws) return res.status(400).json({ error: 'Missing jws' });

    const envName = peekEnvironment(jws);
    const environment = envName === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;
    let appAppleId;
    if (environment === Environment.PRODUCTION) {
      appAppleId = Number(process.env.APPLE_APP_APPLE_ID);
      if (!appAppleId) return res.status(500).json({ error: 'APPLE_APP_APPLE_ID not configured' });
    }

    // enableOnlineChecks = false: skip OCSP/network revocation checks (keeps the
    // serverless call fast/offline; signature + chain + expiry are still verified).
    const verifier = new SignedDataVerifier(loadAppleRootCAs(), false, environment, BUNDLE_ID, appAppleId);
    const tx = await verifier.verifyAndDecodeTransaction(jws);

    if (tx.bundleId && tx.bundleId !== BUNDLE_ID) {
      return res.status(400).json({ error: 'Bundle mismatch' });
    }
    const credits = PRODUCT_CREDITS[tx.productId];
    if (!credits) return res.status(400).json({ error: 'Unknown product: ' + tx.productId });
    const transactionId = String(tx.transactionId);

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
        t.set(userRef, {
          assessmentCredits: credits,
          totalPurchased: credits,
        }, { merge: true });
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
