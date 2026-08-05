// admin/api/fmv_bake.js — Fold manual FMV overrides (fmv_dashboard/comics) into the
// static fmv_comics.json and return the merged index for download, so manual dashboard
// prices become part of the git-tracked file. Comics only for now. Admin-gated like set_fmv.js.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) { raw = raw.split('\\"').join('"'); raw = raw.split('\\\\').join('\\'); }
  return JSON.parse(raw);
}
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });
    const authHeader = req.headers.authorization || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes((decoded.email || '').toLowerCase())) return res.status(403).json({ error: 'Not an admin' });

    const r = await fetch('https://robograder.app/fmv_comics.json', { cache: 'no-store' });
    if (!r.ok) return res.status(502).json({ error: 'Could not fetch fmv_comics.json (' + r.status + ')' });
    const base = await r.json();
    base.books = base.books || {};

    const db = getFirestore();
    const snap = await db.doc('fmv_dashboard/comics').get();
    const ov = snap.exists ? (snap.data() || {}) : {};
    let merged = 0;
    for (const k of Object.keys(ov)) {
      const breaks = ov[k];
      if (Array.isArray(breaks) && breaks.length) { base.books[k] = breaks; merged++; }
    }
    base.manualMerged = merged;
    return res.status(200).json({ comics: base, merged });
  } catch (e) {
    console.error('[fmv_bake] error:', e);
    return res.status(500).json({ error: 'FMV bake failed' });
  }
}
