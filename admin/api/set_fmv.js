// admin/api/set_fmv.js — Admin endpoint to write manual FMV tier curves to Firestore.
// POST { type: 'comic'|'card', key, breaks }  breaks = [[grade,tier],...] ascending, or null to clear.
// Writes fmv_dashboard/comics (or /cards) as a map { [key]: breaks }. The app merges
// these over the static fmv_comics.json / fmv_pokemon.json at load. Admin-gated like set_state.js.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) { raw = raw.split('\\"').join('"'); raw = raw.split('\\\\').join('\\'); }
  return JSON.parse(raw);
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ credential: cert(parseServiceAccount()) });
    const authHeader = req.headers.authorization || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });
    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes((decoded.email || '').toLowerCase())) return res.status(403).json({ error: 'Not an admin' });
    const { type, key, breaks } = req.body || {};
    if (!key || typeof key !== 'string') return res.status(400).json({ error: 'Missing key' });
    const docId = (type === 'card') ? 'cards' : 'comics';
    let value;
    if (breaks == null) {
      value = FieldValue.delete();
    } else {
      const ok = Array.isArray(breaks) && breaks.every(b => Array.isArray(b) && b.length === 2 && isFinite(b[0]) && Number.isInteger(b[1]) && b[1] >= 1 && b[1] <= 13);
      if (!ok) return res.status(400).json({ error: 'Invalid breaks' });
      value = breaks;
    }
    const db = getFirestore();
    await db.doc('fmv_dashboard/' + docId).set({ [key]: value }, { merge: true });
    return res.status(200).json({ ok: true, docId, key });
  } catch (e) {
    console.error('[set_fmv] error:', e);
    return res.status(500).json({ error: 'FMV write failed' });
  }
}
