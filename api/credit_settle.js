// api/credit_settle.js — "the book actually landed in the library, keep the credit."
//
// THE PROBLEM THIS CLOSES (Punisher 1, 2026-10-21, user PL8vgOeo...).
// /api/assess debits the credit BEFORE it calls Anthropic, and hands it back on
// every path it can see failing: a gate termination, a thrown error, a 402. What
// it cannot see is the client dying AFTER a perfectly good result. That user's
// timing record is clean — gate COMIC, grade 9.0, four defects, 12.9s,
// stopReason end_turn — and the assessment never reached his library, because
// the app froze between receiving the result and writing the item. The server
// had no way to know, so the credit stood and he had to email about it.
//
// THE FIX IS TWO HALVES AND THIS IS THE CHEAP ONE.
//   1. (here) The client calls this the moment saveItem() succeeds. It marks the
//      assessment SETTLED: the user got what they paid for, nothing more to do.
//   2. (api/credit_sweep.js) A cron refunds anything still unsettled after a
//      grace period. That half is what actually protects the user, because a
//      client that dies never gets to call this one.
//
// So this endpoint is not the safety net — it is the thing that stops the safety
// net from refunding the 99% of assessments that worked. If it fails or never
// fires, the user is refunded a credit they arguably owe. That is the correct
// direction to be wrong in, and it is why this is a best-effort call on the
// client with no retry and no error surfaced to the user.
//
// POST { timingKeys: ["t_...", ...] }   Authorization: Bearer <firebase id token>
// -> { settled: n }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'server misconfigured' });
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });

    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const uid = decoded.uid;
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const keys = Array.isArray(req.body && req.body.timingKeys)
      ? req.body.timingKeys.filter(k => typeof k === 'string' && k.length < 200).slice(0, 24)
      : [];
    if (!keys.length) return res.status(200).json({ settled: 0 });

    const db = getFirestore();
    let settled = 0;
    for (const k of keys) {
      try {
        const ref = db.collection('assessment_timings').doc(k);
        const snap = await ref.get();
        if (!snap.exists) continue;
        const d = snap.data() || {};
        // Only the user who was charged may settle their own assessment, and
        // only one that is actually pending. Both checks matter: without the uid
        // check any signed-in user could settle (and so suppress the refund of)
        // somebody else's orphaned assessment.
        if (d.creditPendingUid !== uid) continue;
        if (d.creditSettled !== false) continue;
        await ref.set({ creditSettled: true, creditSettledAt: Date.now() }, { merge: true });
        settled++;
      } catch (e) { /* per-key failure is not worth failing the batch over */ }
    }
    return res.status(200).json({ settled });
  } catch (e) {
    console.error('[credit_settle]', e && e.message);
    return res.status(500).json({ error: 'settle failed' });
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
