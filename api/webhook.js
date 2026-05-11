import Stripe from 'stripe';

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
    const { userId, credits } = session.metadata;

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

      await db.runTransaction(async (tx) => {
        const userDoc = await tx.get(userRef);
        if (userDoc.exists) {
          tx.update(userRef, {
            assessmentCredits: FieldValue.increment(parseInt(credits)),
            everPurchased: true,
            lastPurchaseDate: new Date().toISOString(),
            totalPurchased: FieldValue.increment(parseInt(credits)),
          });
        } else {
          tx.set(userRef, {
            assessmentCredits: parseInt(credits),
            everPurchased: true,
            lastPurchaseDate: new Date().toISOString(),
            totalPurchased: parseInt(credits),
            createdAt: new Date().toISOString(),
          });
        }
        // Per-purchase ledger entry for the admin dashboard. Keyed by
        // session.id for natural idempotency: if Stripe retries the webhook
        // (which it does on 5xx), the second write is a no-op overwrite of
        // identical data. Refunds reverse credits on the user doc but DO NOT
        // touch this ledger — the ledger reflects gross revenue.
        tx.set(purchaseRef, {
          userId,
          credits: parseInt(credits),
          amountCents,
          sessionId: session.id,
          createdAt: new Date().toISOString(),
          // Indexed timestamp for range queries; same value as createdAt but
          // typed so Firestore can sort/filter without string-comparing ISO.
          createdAtMs: Date.now(),
        });
      });

      console.log(`Credited ${credits} assessments to user ${userId}`);
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

    let userId, credits;
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
    } catch (e) {
      console.error('[refund] Failed to reverse credits:', e);
      return res.status(500).json({ error: 'Failed to reverse credits' });
    }
  }

  res.status(200).json({ received: true });
}
