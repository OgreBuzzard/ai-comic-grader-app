// /api/timings.js
// Phase timing data from assess.js, written to `assessment_timings/{key}`.
// Used by the admin dashboard Timings tab to diagnose where time is being
// spent during assessments — especially on the timeout failure cases.
//
// Query params:
//   limit  — max rows to return (1–200, default 50)
//   offset — pagination cursor (default 0)
//   filter — 'all' | 'errors' | 'timeouts' | 'success' (default 'all')
//   version — filter by ROBOGRADE_VERSION (e.g. '3.4'); default no filter
//
// Returns: { timings: [...], hasMore, total } sorted newest first.

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  if (raw.includes('\\"')) {
    raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
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

    // Admin email gate
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
      console.warn(`[admin-timings] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Parse query
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const filter = String(req.query.filter || 'all');
    const versionFilter = req.query.version ? String(req.query.version) : null;

    const db = getFirestore();

    // Pull a reasonable window of recent docs and filter in-memory. The
    // collection is small (one doc per assessment) and we sort by createdAt
    // desc client-side. If this grows to many thousands of docs we'll need
    // a composite index and server-side filtering, but for diagnostic use
    // at current scale this is fine.
    //
    // Hard cap of 500 most-recent docs to bound memory + read cost.
    const snap = await db.collection('assessment_timings')
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();

    let rows = snap.docs.map(d => ({ key: d.id, ...d.data() }));

    // S20: slab-detection micro-calls (kind:'slabcheck') are sub-penny Haiku
    // pre-checks that clutter the Logs view and skew sorting. Drop them entirely
    // so the Logs tab shows only real assessments.
    rows = rows.filter(r => r.kind !== 'slabcheck');

    if (versionFilter) {
      rows = rows.filter(r => r.version === versionFilter);
    }
    if (filter === 'errors') {
      rows = rows.filter(r => !!r.errorMessage);
    } else if (filter === 'timeouts') {
      rows = rows.filter(r => r.timedOut === true);
    } else if (filter === 'success') {
      rows = rows.filter(r => !r.errorMessage);
    }

    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return res.status(200).json({
      timings: page,
      total,
      hasMore,
      generatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('[admin-timings] error:', e);
    return res.status(500).json({ error: 'Timings fetch failed: ' + e.message });
  }
}
