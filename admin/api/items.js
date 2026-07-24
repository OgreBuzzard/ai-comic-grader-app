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

// ── FMV (S20): same port as admin/api/item.js so the list shows the same value
// the detail view computes. Index fetched once per request, cached in module
// scope for 10 min. matchFmv includes the 1991+ blanket rule.
let _fmvCache = null, _fmvAt = 0;
async function getFmvIndex() {
  if (_fmvCache && Date.now() - _fmvAt < 10 * 60 * 1000) return _fmvCache;
  try {
    const r = await fetch('https://robograder.app/fmv.json', { cache: 'no-store' });
    if (r.ok) { const data = await r.json(); if (data && data.books) { _fmvCache = data; _fmvAt = Date.now(); } }
  } catch (_) { /* keep stale cache */ }
  return _fmvCache;
}
const _nkTitle = s => !s ? '' : s.toString().trim().replace(/\s+/g, ' ').replace(/^The\s+/i, '').toLowerCase();
const _nkIssue = s => s == null ? '' : s.toString().trim().replace(/^#/, '').replace(/\.0$/, '').replace(/^0+(\d)/, '$1');
function matchFmv(idx, title, issue, grade, printing, year) {
  if (!idx || !idx.books) return null;
  if (printing && typeof printing === 'string') {
    const p = printing.toLowerCase();
    if (p.includes('facsimile') || p.includes('reprint')) return null;
  }
  const g = parseFloat(grade);
  if (!isFinite(g)) return null;
  let breaks = idx.books[_nkTitle(title) + '|' + _nkIssue(issue)];
  if (typeof breaks === 'number' && idx.curves) breaks = idx.curves[breaks];
  if (!Array.isArray(breaks) || !breaks.length) {
    const y = parseInt(year, 10);
    if (isFinite(y) && y >= 1991 && idx.tiers && idx.tiers['1']) {
      // The app's top grade (9.8) on a blanket book is worth more than the
      // $1-20 tier-1 floor; seat it at tier 2 ($20-50).
      const _bt = (g >= 9.8 && idx.tiers['2']) ? '2' : '1';
      const _bb = idx.tiers[_bt];
      return { tier: Number(_bt), low: _bb[0], high: _bb[1] };
    }
    return null;
  }
  let tier = breaks[0][1];
  for (const b of breaks) { if (g >= b[0]) tier = b[1]; else break; }
  const range = idx.tiers && idx.tiers[String(tier)];
  return range ? { tier, low: range[0], high: range[1] } : null;
}
const _fmvK = v => v == null ? '' : (v >= 1000 ? '$' + (v / 1000) + 'K' : '$' + v);
const fmtFmv = m => !m ? '' : (m.high == null ? _fmvK(m.low) + '+' : _fmvK(m.low) + '–' + _fmvK(m.high));

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
    const validSorts = ['title', 'date', 'uid', 'pg']; // S20: 'uid' = 4-char transferCode; 'pg' = predicted (assessedCGC) grade
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
    const userCodes = {}; // S20: 4-char transferCode used as the short User ID
    for (const doc of usersSnap.docs) {
      const d = doc.data();
      userNames[doc.id] = d.displayName || d.email || '(no name)';
      userCodes[doc.id] = d.transferCode || '';
    }

    // ── Fetch all items via collection group ─────────────────────────────────
    const itemsSnap = await db.collectionGroup('items').get();
    const fmvIdx = await getFmvIndex();   // S20: one fetch, reused for every row
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
        transferCode: userCodes[uid] || '',
        title: flat.title || '(untitled)',
        issue: flat.issue || '',
        roboGradeDate: flat.roboGradeDate || null,
        roboGradeId: flat.roboGradeId || '',
        // S20 (#33): assessment-log doc keys the client stored on this item, so
        // the admin Logs → tap resolves a log's doc key to the item entry.
        assessmentTimingKeys: Array.isArray(flat.assessmentTimingKeys) ? flat.assessmentTimingKeys : [],
        score: flat.roboGrade?.score ?? null,
        assessedCGCGrade: flat.assessedCGCGrade ?? null,
        publicListing: !!flat.publicListing,
        highGradeAssessed,
        // S20 tier for the 1/2/3-star list badge. Heuristic: Full = 8-slot
        // interior images present; Deep = high-grade/corner-macro pass; else Main.
        tier: (Array.isArray(raw.interiorImages) && raw.interiorImages.length) ? 3
              : ((highGradeAssessed || flat.highGradeTier === true) ? 2 : 1),
        thumbUrl,
        inlineThumb,
        // S20: FMV range at the graded/predicted grade (official CGC if present,
        // else predicted). Null when uncovered and not caught by the 1991+ rule.
        fmvRange: (() => {
          try {
            const g = (flat.cgcGrade || flat.assessedCGCGrade); // || not ?? — cgcGrade is often "" (empty), which ?? would keep
            const y = parseInt((String(flat.issueDate || '').match(/(19|20)\d\d/) || [])[0], 10);
            const mm = matchFmv(fmvIdx, flat.title, flat.issue, g, flat.printing, y);
            return mm ? fmtFmv(mm) : null;
          } catch (_) { return null; }
        })(),
      };
    });

    // ── Search filter (if q is provided) ─────────────────────────────────────
    // Substring match against title + issue + userName + Grade ID, case-insensitive.
    if (query) {
      allItems = allItems.filter(it => {
        const hay = `${it.title} ${it.issue} ${it.userName} ${it.transferCode} ${it.roboGradeId} ${(it.assessmentTimingKeys || []).join(' ')}`.toLowerCase();
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
      } else if (sort === 'uid') {
        // Sort by the 4-char transferCode; users with no code ('~') sort last.
        cmpResult = String(a.transferCode || '~').localeCompare(String(b.transferCode || '~'), undefined, { sensitivity: 'base' });
      } else if (sort === 'pg') {
        // Sort by predicted (assessedCGC) grade; ungraded books sort to the bottom.
        const ag = parseFloat(a.assessedCGCGrade), bg = parseFloat(b.assessedCGCGrade);
        const aHas = isFinite(ag), bHas = isFinite(bg);
        if (!aHas && !bHas) cmpResult = 0;
        else if (!aHas) return dir === 'desc' ? 1 : -1;
        else if (!bHas) return dir === 'desc' ? -1 : 1;
        else cmpResult = ag - bg;
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
