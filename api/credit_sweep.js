// api/credit_sweep.js — refund assessments that were charged but never landed.
//
// WHY. /api/assess takes the credit before it calls Anthropic and refunds on
// every failure it can observe: gate terminations, thrown errors, 402s. The one
// case it cannot observe is the client dying AFTER a good result — the server
// finished, the user was charged, and the book never reached their library. That
// happened to a real user on 2026-10-21 (Punisher 1): a clean 9.0 in 12.9s, app
// froze during the save, assessment gone, credit kept. He had to email about it.
//
// This is the half of the fix that actually protects the user. api/credit_settle
// marks an assessment settled when the client confirms the save; anything still
// unsettled after the grace period below never landed, and the credit goes back.
//
// THE BIAS IS DELIBERATE. A user whose save worked but whose settle call did NOT
// reach the server gets a credit refunded that they arguably owe. That is the
// direction to be wrong in: the alternative is silently keeping money for work
// the user never received, which is the exact failure this exists to end. The
// settle call is cheap and reliable enough that this should be rare, and the log
// line below makes the rate measurable rather than guessed at.
//
// IDEMPOTENT. A swept doc is stamped creditSettled:'refunded' in the same pass,
// and the query only matches creditSettled === false, so a double run cannot
// double-refund. refundCredit itself is also keyed per-call in lib/credits.js.
//
// SCHEDULE: vercel.json cron, every 10 minutes. GRACE_MS is 15 minutes, so the
// worst case a user waits for their credit back is ~25 minutes.
//
// AUTH: same deliberately-weak posture as api/cachewarm.js — CRON_SECRET if set,
// otherwise Vercel's cron user-agent. Spoofing it costs an attacker nothing and
// gains them nothing: it reads no user data, and the only thing it can do is
// hand credits back to the users who were already owed them.
import { refundCredit } from '../lib/credits.js';

const GRACE_MS = 15 * 60 * 1000;
const MAX_PER_RUN = 200;

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/, '').trim();
  const credentialed = (secret && bearer === secret) || /vercel-cron/i.test(String(req.headers['user-agent'] || ''));
  if (!credentialed) return res.status(401).json({ error: 'cron only' });

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured' });
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });
    const db = getFirestore();

    const cutoff = Date.now() - GRACE_MS;
    // creditSettled === false is the "charged, not yet confirmed" state written
    // by assess.js. Settled docs are true, already-swept ones are 'refunded',
    // and assessments that took no credit have the field absent — so none of
    // those three can match this query.
    const snap = await db.collection('assessment_timings')
      .where('creditSettled', '==', false)
      .where('creditPendingAt', '<', cutoff)
      .limit(MAX_PER_RUN)
      .get();

    let refunded = 0, skipped = 0;
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const uid = d.creditPendingUid;
      const cost = Number(d.creditPendingCost || 0);
      if (!uid || !(cost > 0)) { skipped++; await doc.ref.set({ creditSettled: 'skipped' }, { merge: true }); continue; }
      try {
        await refundCredit(db, uid, cost, d.creditPendingLabel || 'orphan');
        await doc.ref.set({ creditSettled: 'refunded', creditRefundedAt: Date.now() }, { merge: true });
        refunded++;
        console.log(`[credit_sweep] refunded ${cost} to ${uid} — assessment ${doc.id} never saved`);
      } catch (e) {
        // Leave it unsettled so the next run retries rather than losing it.
        console.error(`[credit_sweep] refund failed for ${doc.id}:`, e && e.message);
      }
    }
    // Printed every run, including zeroes, so the rate is visible in the logs
    // rather than inferred from support mail.
    console.log(`[credit_sweep] scanned ${snap.size} orphan candidate(s): ${refunded} refunded, ${skipped} skipped`);
    return res.status(200).json({ scanned: snap.size, refunded, skipped });
  } catch (e) {
    console.error('[credit_sweep]', e && e.message);
    return res.status(500).json({ error: 'sweep failed', detail: String(e && e.message).slice(0, 200) });
  }
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  try { return JSON.parse(raw); }
  catch (e) {
    try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed'); }
  }
}
