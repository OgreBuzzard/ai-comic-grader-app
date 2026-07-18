// /api/admin/users.js
// Paginated user list for the admin dashboard.
//
// Query params:
//   sort   — one of: displayName | assessmentCredits | itemCount | lastAssessment
//   dir    — 'asc' or 'desc' (default depends on sort: name=asc, others=desc)
//   limit  — page size (default 50, max 200)
//   offset — number of users to skip (for pagination)
//
// Returns: { users: [...], total: N, hasMore: bool }
//
// Note: itemCount and lastAssessment require iterating each user's items
// subcollection, so a full sorted list is computed in memory rather than via
// Firestore orderBy. For ~30-500 users this is well under 1s and well under
// any read-quota concern. Past ~5000 users we'd switch to denormalized fields
// on the user doc.
//
// Auth: same admin-email gate as /api/admin/stats.




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
      console.warn(`[admin-users] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const sort = (req.query.sort || 'displayName').toString();
    const validSorts = ['displayName', 'assessmentCredits', 'itemCount', 'lastAssessment', 'createdAt'];
    if (!validSorts.includes(sort)) {
      return res.status(400).json({ error: `sort must be one of: ${validSorts.join(', ')}` });
    }

    // Default direction: alphabetical name ascends; quantity-based sorts descend.
    const dir = (req.query.dir
      || (sort === 'displayName' ? 'asc' : 'desc')).toString().toLowerCase();

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const query = (req.query.q || '').toString().trim().toLowerCase();

    // ── Fetch ────────────────────────────────────────────────────────────────
    const db = getFirestore();
    const usersSnap = await db.collection('users').get();

    // For each user, also fetch their items subcollection to compute itemCount
    // and lastAssessment. Done in parallel for speed.
    const userRows = await Promise.all(
      usersSnap.docs.map(async (doc) => {
        const u = doc.data();
        let itemCount = 0;
        let lastAssessmentMs = 0;
        try {
          const itemsSnap = await doc.ref.collection('items').get();
          itemCount = itemsSnap.size;
          for (const it of itemsSnap.docs) {
            const stamp = it.data().roboGradeDate || null;
            if (!stamp) continue;
            const ms = Date.parse(stamp);
            if (!Number.isNaN(ms) && ms > lastAssessmentMs) lastAssessmentMs = ms;
          }
        } catch (e) {
          console.warn(`[admin-users] items fetch failed for ${doc.id}:`, e?.message);
        }
        return {
          uid: doc.id,
          displayName: u.displayName || u.email || '(no name)',
          email: u.email || '',
          transferCode: u.transferCode || '',
          assessmentCredits: u.assessmentCredits || 0,
          totalPurchased: u.totalPurchased || 0,
          itemCount,
          lastAssessment: lastAssessmentMs ? new Date(lastAssessmentMs).toISOString() : null,
          lastAssessmentMs,
          createdAt: u.createdAt || null,
        };
      })
    );

    // ── Sort ─────────────────────────────────────────────────────────────────
    const cmp = (a, b) => {
      let cmpResult = 0;
      if (sort === 'displayName') {
        cmpResult = String(a.displayName).localeCompare(String(b.displayName), undefined, { sensitivity: 'base' });
      } else if (sort === 'assessmentCredits') {
        cmpResult = (a.assessmentCredits || 0) - (b.assessmentCredits || 0);
      } else if (sort === 'itemCount') {
        cmpResult = (a.itemCount || 0) - (b.itemCount || 0);
      } else if (sort === 'lastAssessment') {
        cmpResult = (a.lastAssessmentMs || 0) - (b.lastAssessmentMs || 0);
      } else if (sort === 'createdAt') {
        // Users without a createdAt timestamp (legacy accounts) sort to
        // the bottom regardless of direction.
        const am = Date.parse(a.createdAt || '') || 0;
        const bm = Date.parse(b.createdAt || '') || 0;
        if (!am && !bm) cmpResult = 0;
        else if (!am) { return dir === 'desc' ? 1 : -1; }
        else if (!bm) { return dir === 'desc' ? -1 : 1; }
        else cmpResult = am - bm;
      }
      return dir === 'desc' ? -cmpResult : cmpResult;
    };
    // Search filter (q): substring match against name + email, case-insensitive.
    const matched = query
      ? userRows.filter(u => `${u.displayName} ${u.email} ${u.transferCode}`.toLowerCase().includes(query))
      : userRows;
    matched.sort(cmp);

    const total = matched.length;
    const page = matched.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return res.status(200).json({ users: page, total, hasMore, offset, limit, sort, dir });

  } catch (e) {
    console.error('[admin-users] error:', e);
    return res.status(500).json({ error: 'User list failed' });
  }
}
