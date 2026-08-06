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

    const ALLOWED_CATS = ['comics', 'pokemon', 'magic', 'baseball'];
    const reqCat = (req.query && req.query.category) || (req.body && req.body.category) || 'comics';
    const cat = ALLOWED_CATS.includes(reqCat) ? reqCat : 'comics';
    const fileName = 'fmv_' + cat + '.json';

    // A category that has never been baked yet has no static file — start from an
    // empty skeleton so the first bake of pokemon/magic/baseball still works.
    const r = await fetch('https://robograder.app/' + fileName, { cache: 'no-store' });
    const base = r.ok ? await r.json() : { tiers: {}, curves: [], books: {}, volumeGuards: {} };
    base.books = base.books || {};

    const db = getFirestore();
    const snap = await db.doc('fmv_dashboard/' + cat).get();
    const ov = snap.exists ? (snap.data() || {}) : {};

    // Integrate each override the SAME compressed way the file already stores
    // curves: dedupe the curve into the shared `curves` table and point
    // books[key] at its index (reusing an existing identical curve when possible).
    base.curves = Array.isArray(base.curves) ? base.curves : [];
    const curveKey = c => JSON.stringify(c);
    const curveIndex = new Map(base.curves.map((c, i) => [curveKey(c), i]));
    let merged = 0;
    for (const k of Object.keys(ov)) {
      let breaks = ov[k];
      if (!Array.isArray(breaks) || !breaks.length) continue;
      breaks = breaks.map(o => Array.isArray(o) ? o : [o.g, o.t]);
      const ck = curveKey(breaks);
      let ci = curveIndex.get(ck);
      if (ci === undefined) { ci = base.curves.length; base.curves.push(breaks); curveIndex.set(ck, ci); }
      base.books[k] = ci;
      merged++;
    }
    // Keep the books map organized (sorted keys) so the file stays clean.
    const sortedBooks = {};
    for (const bk of Object.keys(base.books).sort()) sortedBooks[bk] = base.books[bk];
    base.books = sortedBooks;

    // `index` is the generic key; `comics` kept as a back-compat alias.
    return res.status(200).json({ index: base, comics: base, merged, category: cat, fileName });
  } catch (e) {
    console.error('[fmv_bake] error:', e);
    return res.status(500).json({ error: 'FMV bake failed' });
  }
}
