import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Credit packages — LIVE MODE price IDs from Stripe dashboard (S11)
// All three are one-time payments; webhook fulfills credits via metadata.credits
const PACKAGES = {
  comic_stack: { credits: 10,  priceId: 'price_1TRiZdAJVXkUtIkTabh9WbaK', name: 'Comic Stack' },  // $10  ($1.00 each)
  comic_wall:  { credits: 40,  priceId: 'price_1TRibUAJVXkUtIkTjFBhmBdJ', name: 'Comic Wall'  },  // $30  ($0.75 each)
  short_box:   { credits: 150, priceId: 'price_1TRibzAJVXkUtIkTiEgc7QCM', name: 'Short Box'   },  // $100 ($0.67 each)
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Firebase auth token
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.replace('Bearer ', '');
  if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

  let userId;
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const decoded = await getAuth().verifyIdToken(idToken);
    userId = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { package: pkg } = req.body;
  const selected = PACKAGES[pkg];
  if (!selected) return res.status(400).json({ error: 'Invalid package' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price: selected.priceId, quantity: 1 }],
      metadata: {
        userId,
        credits: selected.credits,
        package: pkg,
      },
      success_url: `${process.env.APP_URL || 'https://robograder.app'}/?payment=success&credits=${selected.credits}`,
      cancel_url: `${process.env.APP_URL || 'https://robograder.app'}/?payment=cancelled`,
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
