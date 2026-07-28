// api/verify_play.js — Google Play Billing purchase verification + credit fulfillment.
//
// The Android app (Capacitor + @capgo/native-purchases) completes a Google Play
// purchase and POSTs { purchaseToken, productId } here. On Android the plugin
// surfaces the Google Play purchaseToken as Transaction.transactionId.
//
// We authenticate the user from their Firebase ID token, then verify the
// purchase server-side against the Google Play Developer API
// (androidpublisher.purchases.products.get) using a service account. Only a
// VERIFIED purchaseState === 0 (purchased) grants credits. Crediting is
// idempotent, keyed on the Google orderId (falling back to the purchaseToken),
// and written to the same `purchases` collection + `users` credit fields as
// verify_iap.js (iOS) and webhook.js (Stripe), so the admin dashboard sees all
// purchases in one place.
//
// ESM detection (S17, OPT_500): imports MUST be at the very top with no
// preceding statement, and at least one STATIC import is required for Vercel to
// treat this file as ESM (without one, `export default` throws at load and the
// function dies before CORS is set — an opaque "network error" on the client).
// We keep a zero-risk Node built-in static import (process is genuinely used for
// process.env so the bundler can't drop it) and load googleapis + firebase-admin
// dynamically inside the handler.
import process from 'node:process';

const PACKAGE_NAME = 'app.robograder';

// Product ID → credits granted. Keep in sync with verify_iap.js (iOS),
// checkout.js (Stripe), AND the Play Console product definitions.
const PRODUCT_CREDITS = {
  'app.robograder.credits.stack': 5,
  'app.robograder.credits.wall': 20,
  'app.robograder.credits.shortbox': 100,
  'app.robograder.credits.shortbox2': 100,
};

// The Play service account JSON. Tolerates a raw-JSON or base64 paste (the
// base64 fallback avoids the newline/quote-truncation issues that plagued the
// other env vars — S17).
function parsePlayServiceAccount() {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT env var not set');
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT could not be parsed');
    }
  }
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

    const { purchaseToken, productId } = req.body || {};
    if (!purchaseToken) return res.status(400).json({ error: 'Missing purchaseToken' });
    if (!productId) return res.status(400).json({ error: 'Missing productId' });

    const credits = PRODUCT_CREDITS[productId];
    if (!credits) return res.status(400).json({ error: 'Unknown product: ' + productId });

    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    // 2. Verify the purchase against the Google Play Developer API using the
    //    service account. purchaseState: 0 = purchased, 1 = canceled, 2 = pending.
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: parsePlayServiceAccount(),
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const androidpublisher = google.androidpublisher({ version: 'v3', auth });

    let purchase;
    try {
      const resp = await androidpublisher.purchases.products.get({
        packageName: PACKAGE_NAME,
        productId,
        token: purchaseToken,
      });
      purchase = resp.data;
    } catch (e) {
      return res.status(400).json({ error: 'Play verification failed: ' + ((e && e.message) || e) });
    }

    if (purchase.purchaseState !== 0) {
      return res.status(400).json({ error: 'Purchase not in purchased state (state ' + purchase.purchaseState + ')' });
    }

    // orderId is the stable, unique id for the transaction (Google issues a new
    // one per consumable purchase). Fall back to the token if absent.
    const orderId = purchase.orderId
      ? String(purchase.orderId)
      : ('token_' + String(purchaseToken).slice(0, 40));

    // 3. Grant credits idempotently, keyed on the Google orderId.
    const db = getFirestore();
    const purchaseRef = db.collection('purchases').doc('play_' + orderId);
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
        productId,
        orderId,
        purchaseToken: String(purchaseToken),
        source: 'android_play',
        // purchaseType is present only for non-production purchases
        // (0 = Test, 1 = Promo, 2 = Rewarded); absent = real purchase.
        environment: purchase.purchaseType === 0 ? 'Test' : 'Production',
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    // 4. Acknowledge the purchase if not already acknowledged. Google auto-
    //    REFUNDS purchases left unacknowledged for 3 days. acknowledgementState:
    //    0 = not acknowledged, 1 = acknowledged.
    //    NOTE: consumption (which makes the consumable re-purchasable) is handled
    //    client-side by @capgo/native-purchases, and consuming also acknowledges.
    //    This server-side acknowledge is a safety net for the window before the
    //    client consumes; we only call it when acknowledgementState === 0 to
    //    avoid erroring on an already-acknowledged/consumed purchase, and treat
    //    any failure as non-fatal (the credits are already granted above).
    //    >>> Verify on first live sandbox purchase that repeat buys of the same
    //        product succeed. If they don't, the plugin isn't consuming and we
    //        must switch this to purchases.products.consume. <<<
    if (!alreadyProcessed && purchase.acknowledgementState === 0) {
      try {
        await androidpublisher.purchases.products.acknowledge({
          packageName: PACKAGE_NAME,
          productId,
          token: purchaseToken,
        });
      } catch (e) {
        console.warn('[verify_play] acknowledge skipped/failed:', (e && e.message) || e);
      }
    }

    console.log(`[verify_play] ${alreadyProcessed ? 'already-processed' : 'credited'} ${credits} to ${uid} (order ${orderId})`);
    return res.status(200).json({ ok: true, credits, alreadyProcessed });
  } catch (e) {
    console.error('[verify_play]', e && (e.stack || e.message || e));
    return res.status(400).json({ error: (e && e.message) || 'Validation failed' });
  }
}
