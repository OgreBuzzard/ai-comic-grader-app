// admin/api/set_state.js — Admin endpoint to set an item's ownership state.
// POST { userId, itemId, ownership }  where ownership ∈ Owned | Sold | Watching | Print
//
// Purpose: recover books stranded in a bad state (e.g. stuck in Print after the
// print-flow bug) and correct ownership from the dashboard, without hand-editing
// Firestore. `ownership` is a top-level item field in every schema version, so
// unlike rescore.js (which nests grade fields under comicData for schema v3) we
// write it flat. Admin-gated identically to rescore.js.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  return JSON.parse(raw);
}

const VALID_STATES = ['Owned', 'Sold', 'Watching', 'Print'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // Auth gate (mirrors rescore.js)
    const authHeader = req.headers.authorization || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes((decoded.email || '').toLowerCase())) {
      return res.status(403).json({ error: 'Not an admin' });
    }

    const { userId, itemId, ownership } = req.body || {};
    if (!userId || !itemId || !VALID_STATES.includes(ownership)) {
      return res.status(400).json({ error: 'Missing/invalid userId, itemId, or ownership (Owned|Sold|Watching|Print)' });
    }

    const db = getFirestore();
    const itemRef = db.doc(`users/${userId}/items/${itemId}`);
    const snap = await itemRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Item not found' });

    const previous = snap.data().ownership || '';
    await itemRef.update({
      ownership,
      ownershipAdminSetAt: new Date().toISOString(),
      ownershipAdminSetBy: decoded.email
    });

    return res.status(200).json({
      success: true,
      ownership,
      previous,
      message: `State set to ${ownership}${previous ? ` (was ${previous})` : ''}`
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
