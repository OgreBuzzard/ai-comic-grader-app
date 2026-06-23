// /api/items.js
// All-items list across all users for the admin dashboard. Supports
// alphabetical sort (by title) and chronological sort (by upload/assessment
// date). Paginated 50 per page.
//
// Query params:
//   sort   — 'title' | 'date' (default: 'date')
//   dir    — 'asc' or 'desc' (default: desc for date, asc for title)
//   limit  — page size (default 50, max 200)
//   offset — number of items to skip (for pagination)
//
// Returns: { items: [...], total: N, hasMore: bool }
//
// Note: collection group query across every user's items. Sorted in memory
// because we need to attach displayName, and Firestore can't join across
// collections. Fine at current scale; revisit at ~5000+ items if list
// rendering becomes slow.
//
// Auth: same admin-email gate as the other endpoints.

// Helper: unescape if env var was double-escaped during paste.
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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(parseServiceAccount()) });
    }

    // ── Auth gate ────────────────────────────────────────────────────────────
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try { decoded = await getAuth().verifyIdToken(m[1]); }
    catch { return res.status(401).json({ error: 'Unauthorized' }); }

    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const callerEmail = (decoded.email || '').toLowerCase();
    if (!callerEmail || !adminEmails.includes(callerEmail)) {
      console.warn(`[admin-items] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const sort = (req.query.sort || 'date').toString();
    const validSorts = ['title', 'date', 'robograde'];
    if (!validSorts.includes(sort)) {
      return res.status(400).json({ error: `sort must be one of: ${validSorts.join(', ')}` });
    }
    const dir = (req.query.dir
      || (sort === 'title' ? 'asc' : 'desc')).toString().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const query = (req.query.q || '').toString().trim().toLowerCase();

    const db = getFirestore();

    // ── Build a uid → displayName map ────────────────────────────────────────
    // Done once up-front so we don't do per-item user lookups.
    const usersSnap = await db.collection('users').get();
    const userNames = {};
    for (const doc of usersSnap.docs) {
      const d = doc.data();
      userNames[doc.id] = d.displayName || d.email || '(no name)';
    }

    // ── Fetch all items via collection group ─────────────────────────────────
    const itemsSnap = await db.collectionGroup('items').get();
    let allItems = itemsSnap.docs.map(d => {
      const raw = d.data();
      const flat = (raw.schemaVersion === 3)
        ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
        : raw;
      // The item ref path looks like users/{uid}/items/{itemId}. Pull uid
      // from the parent of the parent of the doc ref.
      const uid = d.ref.parent.parent.id;
      // High-grade signal: any corner image present.
      const cornerArr = Array.isArray(raw.cornerImages) ? raw.cornerImages : [];
      const highGradeAssessed = cornerArr.filter(e =>
        typeof e === 'string' ? e : (e && e.url)
      ).length > 0;
      // First image URL for thumbnail (front cover by convention).
      let thumbUrl = null;
      const imgs = Array.isArray(raw.images) ? raw.images : [];
      if (imgs.length > 0) {
        const first = imgs[0];
        thumbUrl = typeof first === 'string' ? first : (first && first.url) || null;
      }
      // Inline thumbnail (base64) takes priority if present — instant render.
      const inlineThumb = flat.thumbnail || raw.thumbnail || null;
      return {
        id: d.id,
        uid,
        userName: userNames[uid] || '(unknown user)',
        title: flat.title || '(untitled)',
        issue: flat.issue || '',
        roboGradeDate: flat.roboGradeDate || null,
        roboGradeId: flat.roboGradeId || '',
        score: flat.roboGrade?.score ?? null,
        assessedCGCGrade: flat.assessedCGCGrade ?? null,
        publicListing: !!flat.publicListing,
        highGradeAssessed,
        thumbUrl,
        inlineThumb,
      };
    });

    // ── Search filter (if q is provided) ─────────────────────────────────────
    // Substring match against title + issue + userName + Grade ID, case-insensitive.
    if (query) {
      allItems = allItems.filter(it => {
        const hay = `${it.title} ${it.issue} ${it.userName} ${it.roboGradeId}`.toLowerCase();
        return hay.includes(query);
      });
    }

    // ── Sort ─────────────────────────────────────────────────────────────────
    const cmp = (a, b) => {
      let cmpResult = 0;
      if (sort === 'title') {
        cmpResult = String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' });
        if (cmpResult === 0) {
          // Secondary sort by issue number when titles match.
          const ai = parseInt(a.issue) || 0;
          const bi = parseInt(b.issue) || 0;
          cmpResult = ai - bi;
        }
      } else if (sort === 'robograde') {
        // Items with no score (ungraded) sort to the bottom regardless of
        // direction — they have no place in either end of a score ranking.
        const aHas = typeof a.score === 'number';
        const bHas = typeof b.score === 'number';
        if (!aHas && !bHas) cmpResult = 0;
        else if (!aHas) cmpResult = dir === 'desc' ? 1 : -1; // a goes after b on desc
        else if (!bHas) cmpResult = dir === 'desc' ? -1 : 1;
        else cmpResult = a.score - b.score;
        // For the missing-score branches we've already accounted for direction,
        // so return early to avoid the flip below.
        if (!aHas || !bHas) return cmpResult;
      } else { // 'date'
        const am = Date.parse(a.roboGradeDate || '') || 0;
        const bm = Date.parse(b.roboGradeDate || '') || 0;
        cmpResult = am - bm;
      }
      return dir === 'desc' ? -cmpResult : cmpResult;
    };
    allItems.sort(cmp);

    const total = allItems.length;
    const page = allItems.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return res.status(200).json({
      items: page,
      total,
      hasMore,
      offset,
      limit,
      sort,
      dir,
      query,
    });

  } catch (e) {
    console.error('[admin-items] error:', e);
    return res.status(500).json({ error: 'Items list failed' });
  }
}
