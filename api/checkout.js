import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Credit packages
const PACKAGES = {
  starter: { credits: 10,  amount: 500,  label: '10 assessments' },   // $5.00 ($0.50 each)
  pro:     { credits: 200, amount: 5000, label: '200 assessments' },  // $50.00 ($0.25 each)
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
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `AI Comic Grader — ${selected.label}`,
            description: `${selected.credits} AI comic book assessments`,
          },
          unit_amount: selected.amount,
        },
        quantity: 1,
      }],
      metadata: {
        userId,
        credits: selected.credits,
        package: pkg,
      },
      success_url: `${process.env.APP_URL || 'https://ai-comic-grader-app.vercel.app'}/?payment=success&credits=${selected.credits}`,
      cancel_url: `${process.env.APP_URL || 'https://ai-comic-grader-app.vercel.app'}/?payment=cancelled`,
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
