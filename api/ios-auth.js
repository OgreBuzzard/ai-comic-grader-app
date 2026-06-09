// /api/ios-auth.js — iOS auth bridge token exchange
// POST { idToken, session } → creates custom token, stores in Firestore
// GET ?session=XXX → returns stored custom token (polling endpoint)

export default async function handler(req, res) {
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
      initializeApp({
        credential: cert({
          projectId: sa.project_id,
          clientEmail: sa.client_email,
          privateKey: (sa.private_key || '').replace(/\\n/g, '\n'),
        }),
      });
    }

    const db = getFirestore();
    const auth = getAuth();

    // GET — poll for token
    if (req.method === 'GET') {
      const session = req.query.session;
      if (!session) return res.status(400).json({ error: 'Missing session' });

      const doc = await db.collection('_iosAuth').doc(session).get();
      if (!doc.exists || !doc.data().customToken) {
        return res.status(202).json({ pending: true });
      }

      // Return token and delete the doc (one-time use)
      const token = doc.data().customToken;
      await db.collection('_iosAuth').doc(session).delete();
      return res.status(200).json({ customToken: token });
    }

    // POST — create token and store
    if (req.method === 'POST') {
      const { idToken, session } = req.body || {};
      if (!idToken || !session) {
        return res.status(400).json({ error: 'Missing idToken or session' });
      }

      // Verify the Firebase ID token
      const decoded = await auth.verifyIdToken(idToken);

      // Create a custom token
      const customToken = await auth.createCustomToken(decoded.uid);

      // Store in Firestore for the polling endpoint to find
      await db.collection('_iosAuth').doc(session).set({
        customToken,
        uid: decoded.uid,
        createdAt: new Date().toISOString()
      });

      return res.status(200).json({ customToken, success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[ios-auth] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
