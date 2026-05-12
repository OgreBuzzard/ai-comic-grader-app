// /api/admin/user.js
// Single user profile with full items list.
//
// Query params:
//   uid — user UID (required)
//
// Returns: { user: {...}, items: [{id, title, issue, roboGradeDate, score, ...}] }
//
// Auth: same admin-email gate.




// Helper: unescape if env var was double-escaped during paste.
function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
    raw = raw.split('\\n').join('\n');
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
      console.warn(`[admin-user] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const uid = (req.query.uid || '').toString().trim();
    if (!uid) return res.status(400).json({ error: 'uid required' });

    // ── Fetch user ───────────────────────────────────────────────────────────
    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const u = userDoc.data();
    const user = {
      uid,
      displayName: u.displayName || u.email || '(no name)',
      email: u.email || '',
      assessmentCredits: u.assessmentCredits || 0,
      totalPurchased: u.totalPurchased || 0,
      everPurchased: !!u.everPurchased,
      createdAt: u.createdAt || null,
      lastPurchaseDate: u.lastPurchaseDate || null,
      termsAccepted: !!u.termsAccepted,
      termsVersion: u.termsVersion || null,
      trainingOptIn: u.trainingOptIn !== false, // default true
    };

    // ── Fetch items ──────────────────────────────────────────────────────────
    // Compact rows for the list — full per-item detail comes from /item.js.
    // Flatten nested comicData/cardData so the dashboard doesn't have to.
    const itemsSnap = await userRef.collection('items').get();
    const items = itemsSnap.docs.map(d => {
      const raw = d.data();
      const flat = (raw.schemaVersion === 3)
        ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
        : raw;
      return {
        id: d.id,
        title: flat.title || '(untitled)',
        issue: flat.issue || '',
        roboGradeDate: flat.roboGradeDate || null,
        roboGradeId: flat.roboGradeId || '',
        score: flat.roboGrade?.score ?? null,
        assessedCGCGrade: flat.assessedCGCGrade ?? null,
        publicListing: !!flat.publicListing,
      };
    });

    // Sort items by most recent assessment first by default.
    items.sort((a, b) => {
      const am = Date.parse(a.roboGradeDate || '') || 0;
      const bm = Date.parse(b.roboGradeDate || '') || 0;
      return bm - am;
    });

    return res.status(200).json({ user, items });

  } catch (e) {
    console.error('[admin-user] error:', e);
    return res.status(500).json({ error: 'User fetch failed' });
  }
}
