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
    const validSorts = ['displayName', 'assessmentCredits', 'itemCount', 'lastAssessment', 'createdAt', 'referralIssued', 'referralReceived'];
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

    // Build one user row. Fetches that user's items subcollection for itemCount
    // and lastAssessment. Hoisted out of the full scan so the User ID fast path
    // below can build the same row shape for one account.
    const buildRow = async (doc) => {
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
          referralIssued: u.totalReferralIssued || 0,     // credits given away as issuer (+3 each)
          referralReceived: u.totalReferralReceived || 0, // credits received as referrer (tier bonus)
          referralBlocked: !!u.referralBlocked,
        };
    };

    // ── User ID fast path (S24) ──────────────────────────────────────────────
    // WHY. The generic search below loads EVERY user doc and then every one of
    // their items subcollections just to filter on a substring. At the booth,
    // with someone standing there reading a 4-character code off their phone,
    // that scan is the whole latency budget and it grows with signups - the
    // exact moment it is worst is a convention, when signups spike.
    //
    // A code is exact and unique, so it never needed the scan. This is one
    // indexed equality query plus one items read. It also fixes the real
    // failure mode: when the full scan exceeds the function's time limit the
    // request dies and the account "doesn't come up", which reads as the search
    // being broken rather than slow.
    //
    // Codes are stored uppercase in the system alphabet (0/1/O/U excluded), and
    // the search box lowercases, so match on the uppercased query. Anything not
    // shaped like a code falls through to the normal search untouched.
    if (/^[A-Za-z0-9]{4}$/.test(query)) {
      const code = query.toUpperCase();
      let hitDocs = [];
      try {
        const exact = await db.collection('users').where('transferCode', '==', code).limit(10).get();
        hitDocs = exact.docs;
      } catch (e) {
        console.warn('[admin-users] code lookup failed, falling back to scan:', e?.message);
      }
      // Reverse index fallback: transfer_codes/{CODE} -> { uid }. Covers an
      // account whose users doc somehow lacks the field but claimed the code.
      if (!hitDocs.length) {
        try {
          const idx = await db.collection('transfer_codes').doc(code).get();
          const uid = idx.exists ? (idx.data() || {}).uid : null;
          if (uid) {
            const uDoc = await db.collection('users').doc(uid).get();
            if (uDoc.exists) hitDocs = [uDoc];
          }
        } catch (e) {
          console.warn('[admin-users] transfer_codes lookup failed:', e?.message);
        }
      }
      if (hitDocs.length) {
        const rows = await Promise.all(hitDocs.map(buildRow));
        return res.status(200).json({
          users: rows, total: rows.length, hasMore: false,
          offset: 0, limit: rows.length, sort, dir, matchedBy: 'transferCode',
        });
      }
      // No code match - fall through. A 4-character string can also be part of
      // a name or email ("Rick", "Matt"), and that search should still work.
    }

    const usersSnap = await db.collection('users').get();
    // For each user, also fetch their items subcollection to compute itemCount
    // and lastAssessment. Done in parallel for speed.
    const userRows = await Promise.all(usersSnap.docs.map(buildRow));

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
      } else if (sort === 'referralIssued') {
        cmpResult = (a.referralIssued || 0) - (b.referralIssued || 0);
      } else if (sort === 'referralReceived') {
        cmpResult = (a.referralReceived || 0) - (b.referralReceived || 0);
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
    // Search filter (q): substring match against name, email and the 4-char
    // User ID (stored as transferCode), case-insensitive.
    //
    // S22: deliberately NOT the Firebase uid. It was added here briefly and
    // taken back out — Matt looks people up by the short code, and a 28-char
    // uid in the haystack only creates accidental substring hits.
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
