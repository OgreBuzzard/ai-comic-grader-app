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

      await db.runTransaction(async (tx) => {
        const userDoc = await tx.get(userRef);
        if (userDoc.exists) {
          tx.update(userRef, {
            assessmentCredits: FieldValue.increment(parseInt(credits)),
            lastPurchaseDate: new Date().toISOString(),
            totalPurchased: FieldValue.increment(parseInt(credits)),
          });
        } else {
          tx.set(userRef, {
            assessmentCredits: parseInt(credits),
            lastPurchaseDate: new Date().toISOString(),
            totalPurchased: parseInt(credits),
            createdAt: new Date().toISOString(),
          });
        }
      });

      console.log(`Credited ${credits} assessments to user ${userId}`);
    } catch (e) {
      console.error('Failed to credit user:', e);
      return res.status(500).json({ error: 'Failed to credit user' });
    }
  }

  res.status(200).json({ received: true });
}
