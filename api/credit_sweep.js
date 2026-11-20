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

    // v6.73 CIRCUIT BREAKER. From 7 to 17 Nov 2026 this sweep refunded almost
    // every native assessment, because the apps' settle call never arrived (a
    // CORS preflight the endpoint refused - see api/credit_settle.js and
    // check-cors.mjs). It did exactly what it was built to do, and nothing
    // noticed for ten days. A genuine orphan is RARE - the app dying between
    // a good result and the save - so when refunds outnumber confirmed saves
    // over the last 24 hours, the settle path is broken, not the users' apps.
    // Then refund NOTHING, leave the rows pending, and say so loudly. Nothing
    // is lost: the rows stay creditSettled:false, and once the 24h ratio
    // recovers a later run refunds them exactly as it would have - the old
    // behaviour, delayed until a person has had the chance to look.
    // NOTE: right after the 6.73 fix the previous day's refunds still count,
    // so the breaker will hold for up to 24 hours. That is expected.
    if (snap.size) {
      try {
        const since = Date.now() - 24 * 3600 * 1000;
        const col = db.collection('assessment_timings');
        const [r, ok] = await Promise.all([
          col.where('creditSettled', '==', 'refunded').where('creditPendingAt', '>', since).count().get(),
          col.where('creditSettled', '==', true).where('creditPendingAt', '>', since).count().get()
        ]);
        const nRef = r.data().count, nOk = ok.data().count;
        const pending = snap.size;
        if (nRef + pending >= 10 && (nRef + pending) > nOk) {
          console.error(`[credit_sweep] CIRCUIT BREAKER: last 24h refunded ${nRef}, settled ${nOk}, ${pending} more pending. `
            + 'Refunds now outnumber confirmed saves - the settle path is probably broken (check /api/credit_settle from the native apps). Refunding nothing.');
          return res.status(200).json({ scanned: pending, refunded: 0, skipped: 0, breaker: true, last24h: { refunded: nRef, settled: nOk } });
        }
      } catch (e) {
        // A failed count must not stop real orphans being refunded.
        console.warn('[credit_sweep] breaker count failed, proceeding:', e && e.message);
      }
    }

    let refunded = 0, skipped = 0, found = 0;
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const uid = d.creditPendingUid;
      const cost = Number(d.creditPendingCost || 0);
      if (!uid || !(cost > 0)) { skipped++; await doc.ref.set({ creditSettled: 'skipped' }, { merge: true }); continue; }
      // v6.78 - LOOK FOR THE SAVED BOOK BEFORE REFUNDING.
      // The settle call only exists in clients from v5.80 on. iOS 1.13 (v5.63)
      // already sends serverCredits:true, so the server charges it, but it never
      // settles - so every grade it made was refunded 15 minutes later. Found
      // 2026-11-20: one 1.13 user had 59 grades refunded in two days, every book
      // safely in his library. So the settle call is no longer the only proof:
      // if the user's library has a save of the same issue after the charge, the
      // book landed and the credit stays. Version-proof, needs no app update.
      try {
        if (await _bookLanded(db, uid, d)) {
          await doc.ref.set({ creditSettled: true, creditSettledAt: Date.now(), creditSettledBy: 'sweep:item-found' }, { merge: true });
          found++;
          continue;
        }
      } catch (e) {
        // A failed lookup falls through to the refund: the deliberate bias.
        console.warn(`[credit_sweep] item lookup failed for ${doc.id}, refunding:`, e && e.message);
      }
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
    console.log(`[credit_sweep] scanned ${snap.size} orphan candidate(s): ${refunded} refunded, ${found} kept (book found in library), ${skipped} skipped`);
    return res.status(200).json({ scanned: snap.size, refunded, kept: found, skipped });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // v6.49 - A MISSING INDEX MUST SAY WHERE TO CREATE IT.
    // Firestore's FAILED_PRECONDITION message carries a one-click console URL
    // that builds the exact composite index, fields and order already filled
    // in. The old `.slice(0, 200)` cut that URL in half, so the one piece of
    // information the error existed to deliver was the piece thrown away -
    // and this endpoint has been failing on every 10-minute cron run since,
    // with nothing anywhere saying what to click.
    // Logged in full and returned as its own field.
    const indexUrl = (msg.match(/https:\/\/console\.firebase\.google\.com\/\S+/) || [null])[0];
    if (indexUrl) {
      console.error('[credit_sweep] MISSING FIRESTORE INDEX. Create it here:\n' + indexUrl);
    }
    console.error('[credit_sweep]', msg);
    return res.status(500).json({
      error: 'sweep failed',
      detail: msg.slice(0, 900),
      ...(indexUrl ? { indexUrl } : {}),
    });
  }
}

// v6.78 - Did the graded book reach the user's library?
// Every client version stamps clientSavedAt (ISO string) on each save. Look for
// a save of the SAME ISSUE between the charge and two hours after it. Issue
// must match exactly (after stripping '#', spaces, leading zeros); title only
// has to share its first real word, because Main can correct a typed title
// ('G.I. Joe, A Real...' vs 'G.I. Joe: A Real...'). A save of a different book
// in the same window does not count.
async function _bookLanded(db, uid, d) {
  const at = Number(d.creditPendingAt || 0);
  if (!at) return false;
  const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const iss = (x) => norm(x).replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  const firstWord = (x) => (norm(x).split(' ').find((w) => w.length > 1 && !['the', 'a', 'an'].includes(w)) || '');
  const wantIssue = iss(d.issue);
  const wantWord = firstWord(d.title);
  if (!wantIssue && !wantWord) return false;
  const lo = new Date(at).toISOString();
  const hi = new Date(at + 2 * 3600 * 1000).toISOString();
  const snap = await db.collection('users').doc(uid).collection('items')
    .where('clientSavedAt', '>=', lo)
    .where('clientSavedAt', '<=', hi)
    .limit(50)
    .get();
  for (const it of snap.docs) {
    const v = it.data() || {};
    if (iss(v.issue) !== wantIssue) continue;
    if (wantWord && firstWord(v.title) !== wantWord) continue;
    return true;
  }
  return false;
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
