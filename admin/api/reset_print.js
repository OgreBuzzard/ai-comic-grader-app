// admin/api/reset_print.js — Bulk-recover books stuck in the Print state.
// POST (no body). Admin-gated. Scans every item, flips ownership 'Print' → 'Owned'.
// Print is a transient label-printing flag that (post-fix) self-reverts; any book
// still sitting in Print is stranded and invisible to its owner. This resets them
// all in one shot instead of tap-cycling each. `ownership` is a top-level field in
// every schema version, so we write it flat.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  return JSON.parse(raw);
}

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

    const db = getFirestore();
    const snap = await db.collectionGroup('items').get();
    const stuck = snap.docs.filter(d => (d.data().ownership || '') === 'Print');

    let n = 0;
    for (let i = 0; i < stuck.length; i += 400) {
      const batch = db.batch();
      for (const d of stuck.slice(i, i + 400)) {
        batch.update(d.ref, {
          ownership: 'Owned',
          ownershipAdminSetAt: new Date().toISOString(),
          ownershipAdminSetBy: decoded.email,
          ownershipResetFromPrint: true,
        });
        n++;
      }
      await batch.commit();
    }

    return res.status(200).json({ success: true, reset: n, message: `Reset ${n} book(s) from Print to Owned` });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
