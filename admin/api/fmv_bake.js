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

    // S22: ?keys=1 returns ONLY the set of keys that have a curve — the static
    // index's books + volumes, unioned with the manual fmv_dashboard overrides.
    // The catalogue's "FMV A-Z" / "FMV Ranked" sorts are worklists of books with
    // NO curve, and this is the cheapest way to answer that (a few thousand short
    // strings) without a per-item lookup or a new serverless function — the admin
    // project is near its function cap, so this rides on the existing FMV endpoint.
    //
    // NOTE: a key being absent is what "no FMV set" means. fmv_comics.json also has
    // a blanket rule (1991+ books fall back to tier 1/2 at every grade), but that is
    // a default, not a set value — those books still need a real curve, so they must
    // stay in the worklist.
    if ((req.query && req.query.keys === '1') || (req.body && req.body.keys === 1)) {
      const kr = await fetch('https://robograder.app/' + fileName, { cache: 'no-store' });
      const kbase = kr.ok ? await kr.json() : {};
      const kdb = getFirestore();
      const ksnap = await kdb.doc('fmv_dashboard/' + cat).get();
      const kov = ksnap.exists ? (ksnap.data() || {}) : {};
      const keys = new Set([
        ...Object.keys(kbase.books || {}),
        ...Object.keys(kbase.volumes || {}),
        ...Object.keys(kov),
      ]);
      return res.status(200).json({ category: cat, keys: [...keys], manual: Object.keys(kov).length });
    }

    // A category that has never been baked yet has no static file — start from an
    // empty skeleton so the first bake of pokemon/magic/baseball still works.
    const r = await fetch('https://robograder.app/' + fileName, { cache: 'no-store' });
    // SAFETY: comics MUST bake onto its existing file. If that fetch fails, abort
    // rather than fall back to an empty skeleton (which would silently drop every
    // volumeGuard, tier, and book). The empty skeleton is only for a category
    // that has never been baked (pokemon/magic/baseball).
    if (!r.ok && cat === 'comics') {
      return res.status(502).json({ error: 'Could not fetch the live ' + fileName + ' to bake onto (HTTP ' + r.status + '). Aborting so the file is not rebuilt from an empty base — try again in a moment.' });
    }
    const base = r.ok ? await r.json() : { tiers: {}, curves: [], books: {}, volumeGuards: {} };
    base.books = base.books || {};
    base.volumes = base.volumes || {}; // carry the volume/year model through untouched

    const db = getFirestore();
    const snap = await db.doc('fmv_dashboard/' + cat).get();
    const ov = snap.exists ? (snap.data() || {}) : {};

    // Integrate each override the SAME compressed way the file already stores
    // curves: dedupe the curve into the shared `curves` table and point
    // books[key] at its index (reusing an existing identical curve when possible).
    base.curves = Array.isArray(base.curves) ? base.curves : [];
    const curveKey = c => JSON.stringify(c);
    const curveIndex = new Map(base.curves.map((c, i) => [curveKey(c), i]));
    // Self-heal: fold any legacy inline-array books in the BASE file into the
    // shared curves table too, so a bake always emits a fully compact file.
    for (const bk of Object.keys(base.books)) {
      const bv = base.books[bk];
      if (Array.isArray(bv)) {
        const bck = curveKey(bv);
        let bci = curveIndex.get(bck);
        if (bci === undefined) { bci = base.curves.length; base.curves.push(bv); curveIndex.set(bck, bci); }
        base.books[bk] = bci;
      }
    }
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
    // Garbage-collect orphaned curves: keep only curves a book still points at,
    // and reindex. Without this, re-pricing a book leaves its old curve behind
    // forever, so the curves table grows every bake even when no book was added.
    {
      const remap = new Map();   // oldIndex -> newIndex
      const liveCurves = [];
      for (const bk of Object.keys(base.books)) {
        const oi = base.books[bk];
        if (typeof oi !== 'number' || oi < 0 || oi >= base.curves.length) continue;
        if (!remap.has(oi)) { remap.set(oi, liveCurves.length); liveCurves.push(base.curves[oi]); }
        base.books[bk] = remap.get(oi);
      }
      base.curves = liveCurves;
    }

    // SAFETY: never emit a gutted comics file (base must carry its guards + tiers).
    if (cat === 'comics' && (!base.volumeGuards || !Object.keys(base.volumeGuards).length || !base.tiers || !Object.keys(base.tiers).length)) {
      return res.status(500).json({ error: 'Bake aborted: base file is missing volumeGuards/tiers — refusing to emit a gutted comics file.' });
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
