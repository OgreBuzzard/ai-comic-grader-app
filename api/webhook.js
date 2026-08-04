import Stripe from 'stripe';
import { shortBoxBonusForNext, nextBonusAfter, shortBoxTimes, tierOf } from '../lib/repeat_bonus.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Required to parse raw body for Stripe signature verification
export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Tier identification by credit count (matches api/referral.js). 5/20/100.
const REFUND_TIER_BY_CREDITS = { 5: 'comic_stack', 20: 'comic_wall', 100: 'short_box' };

// Referral clawback. Called after a refund reverses base credits. If the
// refunding account (the referral ISSUER) no longer owns any production,
// non-refunded purchase of `tier`, the referral that tier seeded is unbacked:
// reverse both the referrer's tier bonus and the issuer's +3, and mark the
// audit row reversed. Idempotent via the audit `reversed` flag. Credit
// decrements clamp at 0 (matches the base-refund philosophy). referralGiven is
// deliberately left set — per spec a consumed tier does not re-enable on rebuy.
//
// NOTE: this only runs for Stripe/web refunds — the only automated refund path
// that exists. iOS/Android have no refund webhook, so their referral clawback
// (and even base-credit reversal) is manual until those endpoints are built;
// this helper is written to be reused by them when they are.
async function clawbackReferralIfUnbacked(db, FieldValue, issuerUid, tier) {
  const snap = await db.collection('purchases').where('userId', '==', issuerUid).get();
  let stillOwns = false;
  snap.forEach(d => {
    const pd = d.data() || {};
    if (pd.refunded) return;
    if (pd.environment && pd.environment !== 'Production') return;
    if (tierOf(pd) === tier) stillOwns = true;
  });
  if (stillOwns) return;

  const auditRef = db.collection('referrals').doc(`${issuerUid}_${tier}`);
  await db.runTransaction(async (tx) => {
    const a = await tx.get(auditRef);
    if (!a.exists) return;
    const audit = a.data() || {};
    if (audit.reversed) return;
    const issuerRef = db.collection('users').doc(audit.issuerUid);
    const recipientRef = db.collection('users').doc(audit.recipientUid);
    const iSnap = await tx.get(issuerRef);
    const rSnap = await tx.get(recipientRef);
    const referrerCredits = audit.referrerCredits || 0;
    const issuerCredits = audit.issuerCredits || 0;
    const nowIso = new Date().toISOString();

    // If either party already SPENT the bonus (balance can't cover the reversal),
    // we take the loss on the unrecoverable part. Policy (Matt, Session 21): any
    // account that leaves us short this way is flagged `referralBlocked` so it can
    // neither give nor receive future referrals — one-and-done exploit, contained.
    let shortfall = 0;

    if (iSnap.exists) {
      const cur = (iSnap.data() || {}).assessmentCredits || 0;
      shortfall += Math.max(0, issuerCredits - cur);
    }
    if (rSnap.exists) {
      const cur = (rSnap.data() || {}).assessmentCredits || 0;
      shortfall += Math.max(0, referrerCredits - cur);
    }
    const block = shortfall > 0;

    if (iSnap.exists) {
      const cur = (iSnap.data() || {}).assessmentCredits || 0;
      const fields = {
        assessmentCredits: Math.max(0, cur - issuerCredits),
        totalReferralIssued: FieldValue.increment(-issuerCredits),
        referralClawbackCount: FieldValue.increment(1),
        lastReferralClawbackAt: nowIso,
      };
      if (block) { fields.referralBlocked = true; fields.referralBlockedAt = nowIso; fields.referralBlockedReason = 'refund_after_spend'; }
      tx.set(issuerRef, fields, { merge: true });
    }
    if (rSnap.exists) {
      const cur = (rSnap.data() || {}).assessmentCredits || 0;
      const fields = {
        assessmentCredits: Math.max(0, cur - referrerCredits),
        totalReferralReceived: FieldValue.increment(-referrerCredits),
        referralClawbackCount: FieldValue.increment(1),
        lastReferralClawbackAt: nowIso,
      };
      if (block) { fields.referralBlocked = true; fields.referralBlockedAt = nowIso; fields.referralBlockedReason = 'refund_after_spend'; }
      tx.set(recipientRef, fields, { merge: true });
    }
    tx.set(auditRef, {
      reversed: true,
      reversedAt: nowIso,
      reversedReason: 'issuer_refund',
      unrecoveredCredits: shortfall,
      accountsBlocked: block,
    }, { merge: true });
  });
  console.log(`[refund] Referral clawback: tier ${tier}, issuer ${issuerUid} (audit ${issuerUid}_${tier}).`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, credits, package: pkg } = session.metadata;

    if (!userId || !credits) {
      console.error('Missing metadata in checkout session:', session.id);
      return res.status(400).json({ error: 'Missing metadata' });
    }

    try {
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

      if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      }

      const db = getFirestore();
      const userRef = db.collection('users').doc(userId);
      const purchaseRef = db.collection('purchases').doc(session.id);

      // Amount in cents from Stripe. amount_total is preferred (includes tax);
      // fall back to amount_subtotal for older payloads. Both are ints in cents.
      const amountCents = session.amount_total ?? session.amount_subtotal ?? 0;

      const baseCredits = parseInt(credits);
      const tier = tierOf({ tier: pkg, credits: baseCredits });

      // Repeat-Purchase Discount (Short Box only): escalating bonus from prior
      // production, non-refunded Short Box purchases. Price is unchanged; only
      // the granted credit count grows. Computed before the txn.
      let bonusCredits = 0, nextShortBoxBonus = 0, lastShortBoxAt = null;
      if (tier === 'short_box') {
        const nowMs = Date.now();
        const priorSnap = await db.collection('purchases').where('userId', '==', userId).get();
        const priorTimes = shortBoxTimes(priorSnap.docs.map(d => d.data()));
        bonusCredits = shortBoxBonusForNext(priorTimes, nowMs);
        lastShortBoxAt = new Date(nowMs).toISOString();
        nextShortBoxBonus = nextBonusAfter([...priorTimes, nowMs], nowMs);
      }
      const grant = baseCredits + bonusCredits;   // total granted

      let alreadyCredited = false;
      await db.runTransaction(async (tx) => {
        // Idempotency guard (S21 fix): Stripe retries the webhook on any non-2xx,
        // so without this a retry would credit the account a second time. If the
        // ledger doc for this session already exists, the purchase was fulfilled —
        // do nothing. (All reads must precede writes in a Firestore txn.)
        const existing = await tx.get(purchaseRef);
        const userDoc = await tx.get(userRef);
        if (existing.exists) { alreadyCredited = true; return; }
        const common = {
          everPurchased: true,
          lastPurchaseDate: new Date().toISOString(),
        };
        if (tier === 'short_box') { common.lastShortBoxAt = lastShortBoxAt; common.nextShortBoxBonus = nextShortBoxBonus; }
        if (userDoc.exists) {
          tx.update(userRef, {
            ...common,
            assessmentCredits: FieldValue.increment(grant),
            totalPurchased: FieldValue.increment(grant),
          });
        } else {
          tx.set(userRef, {
            ...common,
            assessmentCredits: grant,
            totalPurchased: grant,
            createdAt: new Date().toISOString(),
          });
        }
        // Per-purchase ledger entry for the admin dashboard, keyed by
        // session.id. The exists-check above makes both the credit grant and
        // this ledger write idempotent across Stripe retries.
        // Refunds reverse credits on the user doc but DO NOT touch this ledger.
        tx.set(purchaseRef, {
          userId,
          credits: grant,
          baseCredits,
          bonusCredits,
          tier,
          amountCents,
          sessionId: session.id,
          createdAt: new Date().toISOString(),
          createdAtMs: Date.now(),
        });
      });

      console.log(alreadyCredited
        ? `[webhook] session ${session.id} already credited — skipped (retry).`
        : `Credited ${grant} assessments (base ${baseCredits}+bonus ${bonusCredits}) to user ${userId}`);
    } catch (e) {
      console.error('Failed to credit user:', e);
      return res.status(500).json({ error: 'Failed to credit user' });
    }
  }

  // ── charge.refunded handler (S12, May 5) ─────────────────────────────────
  // When Stripe processes a refund (initiated by Matt from the Dashboard or
  // via API), we reverse the credits that were granted by the original
  // purchase. The tricky lookup: charge.refunded events don't contain the
  // userId/credits metadata directly — that lived on the original
  // checkout.session. We resolve via:
  //   charge.payment_intent → list checkout.sessions filtered by that PI
  //   → grab session.metadata.userId and session.metadata.credits
  //
  // Refund handling rules:
  //   - Full refund (charge.amount_refunded === charge.amount): reverse
  //     all credits, decrement totalPurchased, log
  //   - Partial refund: log and skip. Partial refunds are rare and the
  //     credit-to-dollars ratio for a partial doesn't have a clean answer
  //     ("you bought 10 credits for $10 and got $3 back — you have 7
  //     credits now? but maybe you used 4 already?"). Defer to manual
  //     handling via Stripe Dashboard + manual Firestore edit if needed.
  //   - Credits decrement clamps at 0 — never goes negative even if the
  //     user has already used some. (User got value from those credits;
  //     we don't claw back more than they have on hand.)
  //   - totalPurchased can go negative — it's an audit-only field tracking
  //     net lifetime purchases, so going negative on a refund is correct
  //     accounting.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const isFullRefund = charge.amount_refunded === charge.amount;

    if (!isFullRefund) {
      console.log(`[refund] Partial refund on charge ${charge.id} (${charge.amount_refunded}/${charge.amount}). Skipping automatic credit reversal — handle manually if needed.`);
      return res.status(200).json({ received: true, skipped: 'partial_refund' });
    }

    if (!charge.payment_intent) {
      console.error(`[refund] Charge ${charge.id} has no payment_intent — cannot resolve userId.`);
      return res.status(200).json({ received: true, skipped: 'no_payment_intent' });
    }

    let userId, credits, sessionId;
    try {
      // Look up the original checkout session via payment_intent. There
      // should be exactly one session per PI in our flow.
      const sessions = await stripe.checkout.sessions.list({
        payment_intent: charge.payment_intent,
        limit: 1,
      });
      if (!sessions.data.length) {
        console.error(`[refund] No checkout session found for payment_intent ${charge.payment_intent}.`);
        return res.status(200).json({ received: true, skipped: 'no_session' });
      }
      const session = sessions.data[0];
      userId = session.metadata?.userId;
      credits = session.metadata?.credits;
      sessionId = session.id;
      if (!userId || !credits) {
        console.error(`[refund] Session ${session.id} missing userId/credits metadata.`);
        return res.status(200).json({ received: true, skipped: 'no_metadata' });
      }
    } catch (e) {
      console.error('[refund] Failed to look up checkout session:', e);
      return res.status(500).json({ error: 'Failed to resolve refund metadata' });
    }

    try {
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

      if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      }

      const db = getFirestore();
      const userRef = db.collection('users').doc(userId);

      await db.runTransaction(async (tx) => {
        const userDoc = await tx.get(userRef);
        if (!userDoc.exists) {
          console.error(`[refund] User ${userId} not found in Firestore.`);
          return;
        }
        const data = userDoc.data();
        const currentCredits = data.assessmentCredits || 0;
        const refundCredits = parseInt(credits);
        // Clamp credits at 0 — don't go negative if user already used some.
        const newCredits = Math.max(0, currentCredits - refundCredits);
        tx.update(userRef, {
          assessmentCredits: newCredits,
          // totalPurchased can go negative — audit field only.
          totalPurchased: FieldValue.increment(-refundCredits),
          lastRefundDate: new Date().toISOString(),
        });
      });

      console.log(`[refund] Reversed ${credits} credits for user ${userId} (charge ${charge.id}).`);

      // Mark the ledger doc refunded so tier-ownership checks exclude it.
      if (sessionId) {
        try {
          await db.collection('purchases').doc(sessionId).set(
            { refunded: true, refundedAt: new Date().toISOString() }, { merge: true }
          );
        } catch (e) { console.error('[refund] Could not mark purchase refunded:', e); }
      }

      // Referral clawback (see helper). Best-effort; never fail the webhook on it.
      const refundedTier = REFUND_TIER_BY_CREDITS[parseInt(credits)];
      if (refundedTier) {
        try {
          await clawbackReferralIfUnbacked(db, FieldValue, userId, refundedTier);
        } catch (e) { console.error('[refund] Referral clawback failed:', e); }
      }
    } catch (e) {
      console.error('[refund] Failed to reverse credits:', e);
      return res.status(500).json({ error: 'Failed to reverse credits' });
    }
  }

  res.status(200).json({ received: true });
}
