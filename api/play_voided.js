// api/play_voided.js — Google Play refunds for UNLIMITED (v6.79)
//
// Google has no refund webhook for one-time products; its Voided Purchases
// API lists refunded/charged-back purchases instead. This cron reads the last
// 3 days every 4 hours and, for any voided Unlimited purchase, ends the week
// and blocks a repurchase (lib/unlimited.js). Credit packs are logged only -
// no change to how they work today.
//
// Uses the same service account as api/verify_play.js
// (GOOGLE_PLAY_SERVICE_ACCOUNT). Same cron auth as api/credit_sweep.js.
import process from 'node:process';
import { revokeUnlimited } from '../lib/unlimited.js';

const PACKAGE_NAME = 'app.robograder';

function playCreds() {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT not set');
  try { return JSON.parse(raw); } catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
}

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/, '').trim();
  const ok = (secret && bearer === secret) || /vercel-cron/i.test(String(req.headers['user-agent'] || ''));
  if (!ok) return res.status(401).json({ error: 'cron only' });
  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({ credentials: playCreds(), scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    const ap = google.androidpublisher({ version: 'v3', auth });
    const startTime = String(Date.now() - 3 * 24 * 3600 * 1000);
    const resp = await ap.purchases.voidedpurchases.list({ packageName: PACKAGE_NAME, startTime, maxResults: 1000 });
    const list = (resp.data && resp.data.voidedPurchases) || [];

    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const db = getFirestore();

    let revoked = 0, seen = 0;
    for (const v of list) {
      if (!v.orderId) continue;
      const pRef = db.collection('purchases').doc('play_' + v.orderId);
      const p = (await pRef.get()).data();
      if (!p) continue;
      seen++;
      if (p.refunded) continue;
      await pRef.set({ refunded: true, refundedAt: new Date().toISOString(), voidedReason: v.voidedReason ?? null }, { merge: true });
      if (p.tier === 'unlimited' && p.userId) {
        await revokeUnlimited(db, p.userId, 'play_' + v.orderId, 'play_refund');
        revoked++;
      } else {
        console.log('[play_voided] credit-pack refund logged (not reversed): order ' + v.orderId + ' user ' + p.userId);
      }
    }
    console.log(`[play_voided] ${list.length} voided, ${seen} ours, ${revoked} Unlimited revoked`);
    return res.status(200).json({ voided: list.length, matched: seen, revoked });
  } catch (e) {
    console.error('[play_voided]', e && (e.stack || e.message));
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
