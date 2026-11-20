// api/appstore_notify.js — App Store Server Notifications V2 (v6.79)
//
// Set this URL in App Store Connect -> App -> App Information -> App Store
// Server Notifications (Production AND Sandbox), Version 2:
//   https://robograder.app/api/appstore_notify
//
// Handles two notification types, for UNLIMITED only:
//   REFUND               Apple refunded an Unlimited purchase -> end the week
//                        now and block a repurchase (lib/unlimited.js).
//   CONSUMPTION_REQUEST  A buyer asked Apple for a refund and Apple asks how
//                        much was used. We answer with the real count of
//                        covered assessments, which Apple weighs. Needs an
//                        In-App Purchase API key: APPLE_IAP_KEY (the .p8
//                        file's text), APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID.
//                        Without them the request is logged, not answered.
//   NOTE: Apple documents CONSUMPTION_REQUEST for consumables and
//   auto-renewables. If Unlimited is a Non-Renewing Subscription, Apple may
//   never send one - the REFUND branch is the one that matters.
//
// Credit-pack refunds are LOGGED only; nothing is reversed for them (no
// change to how credit packs work today).
//
// The payload is verified by app-store-server-api (signature + Apple root
// certificate chain). An unverifiable payload is refused.
import process from 'node:process';
import { UNLIMITED_PRODUCT_ID, revokeUnlimited, unlimitedUsesFor } from '../lib/unlimited.js';

const BUNDLE_ID = 'app.robograder';

async function adminDb() {
  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return getFirestore();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let payload, tx;
  try {
    const { decodeNotificationPayload, decodeTransaction } = await import('app-store-server-api');
    const signed = req.body && req.body.signedPayload;
    if (!signed) return res.status(400).json({ error: 'missing signedPayload' });
    payload = await decodeNotificationPayload(signed);
    const sti = payload && payload.data && payload.data.signedTransactionInfo;
    tx = sti ? await decodeTransaction(sti) : null;
  } catch (e) {
    console.error('[appstore_notify] verification failed:', e && e.message);
    return res.status(400).json({ error: 'unverified' });
  }
  const type = payload.notificationType;
  if (!tx) { console.log('[appstore_notify] ' + type + ' with no transaction'); return res.status(200).json({ ok: true }); }
  if (tx.bundleId && tx.bundleId !== BUNDLE_ID) return res.status(200).json({ ok: true, ignored: 'bundle' });

  const transactionId = String(tx.transactionId);
  const isUnl = tx.productId === UNLIMITED_PRODUCT_ID;
  console.log(`[appstore_notify] ${type} ${tx.productId} tx ${transactionId}`);
  if (!isUnl) return res.status(200).json({ ok: true, logged: true });

  try {
    const db = await adminDb();
    const pRef = db.collection('purchases').doc('iap_' + transactionId);
    const p = (await pRef.get()).data();
    const uid = p && p.userId;
    if (!uid) { console.warn('[appstore_notify] no purchase record for tx ' + transactionId); return res.status(200).json({ ok: true, unknown: true }); }

    if (type === 'REFUND') {
      await revokeUnlimited(db, uid, 'iap_' + transactionId, 'apple_refund');
      await pRef.set({ refunded: true, refundedAt: new Date().toISOString() }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (type === 'CONSUMPTION_REQUEST') {
      const uses = await unlimitedUsesFor(db, uid, 'iap_' + transactionId);
      await pRef.set({ consumptionRequestedAt: new Date().toISOString(), usesAtRequest: uses }, { merge: true });
      const key = process.env.APPLE_IAP_KEY, keyId = process.env.APPLE_IAP_KEY_ID, issuer = process.env.APPLE_IAP_ISSUER_ID;
      if (!key || !keyId || !issuer) { console.warn('[appstore_notify] consumption request not answered: APPLE_IAP_* not set'); return res.status(200).json({ ok: true }); }
      const M = await import('app-store-server-api');
      const env = tx.environment === 'Sandbox' ? M.Environment.Sandbox : M.Environment.Production;
      const api = new M.AppStoreServerAPI(key.replace(/\\n/g, '\n'), keyId, issuer, BUNDLE_ID, env);
      await api.sendConsumptionInformation(transactionId, {
        // The Unlimited terms ask for this consent at purchase.
        customerConsented: true,
        consumptionStatus: uses > 0 ? M.ConsumptionStatus.PartiallyConsumed : M.ConsumptionStatus.NotConsumed,
        deliveryStatus: M.DeliveryStatus.DeliveredAndWorkingProperly,
        sampleContentProvided: true,
        accountTenure: M.AccountTenure.Undeclared,
        appAccountToken: '',
        lifetimeDollarsPurchased: M.LifetimeDollarsPurchased.Undeclared,
        lifetimeDollarsRefunded: M.LifetimeDollarsRefunded.Undeclared,
        platform: M.Platform.Apple,
        playTime: M.PlayTime.Undeclared,
        userStatus: M.UserStatus.AccountIsActive,
        refundPreference: uses > 0 ? M.RefundPreference.PreferAppleDeclinesRefund : M.RefundPreference.NoPreference
      });
      console.log(`[appstore_notify] consumption sent for ${uid}: ${uses} assessments`);
      return res.status(200).json({ ok: true });
    }
  } catch (e) {
    console.error('[appstore_notify] handling failed:', e && (e.stack || e.message));
    return res.status(500).json({ error: 'handling failed' });   // Apple retries
  }
  return res.status(200).json({ ok: true });
}
