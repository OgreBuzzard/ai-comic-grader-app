// /api/admin/item.js
// Full record for a single item, including all fields the dashboard renders.
//
// Query params:
//   uid — user UID (required)
//   id  — item id (required)
//
// Returns: { item: { ...all fields per spec... } }
//
// Auth: same admin-email gate.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
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
      console.warn(`[admin-item] denied: ${callerEmail || '<no email>'}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // ── Params ───────────────────────────────────────────────────────────────
    const uid = (req.query.uid || '').toString().trim();
    const id = (req.query.id || '').toString().trim();
    if (!uid) return res.status(400).json({ error: 'uid required' });
    if (!id)  return res.status(400).json({ error: 'id required' });

    // ── Fetch ────────────────────────────────────────────────────────────────
    const db = getFirestore();
    const itemRef = db.collection('users').doc(uid).collection('items').doc(id);
    const itemDoc = await itemRef.get();
    if (!itemDoc.exists) return res.status(404).json({ error: 'Item not found' });

    const raw = itemDoc.data();
    // Flatten v3 nested shape — same pattern as lookup.js.
    const flat = (raw.schemaVersion === 3)
      ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
      : raw;

    // ── Normalize image arrays to flat URL strings ───────────────────────────
    // v3 stores as [{url, source, capturedAt}]; pre-v3 as plain strings.
    const normImages = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr
        .map(e => (typeof e === 'string' ? e : (e && e.url) || null))
        .filter(Boolean);
    };
    const images = normImages(raw.images);
    const cornerImages = normImages(raw.cornerImages);

    // ── Compose response per Matt's spec ─────────────────────────────────────
    // Roughly the union of fields shown in the app's detail view, plus a few
    // useful admin-only fields (publicListing, dateAcquired, fmv).
    const rg = flat.roboGrade || {};
    const item = {
      // Identification
      id,
      uid,
      title: flat.title || '(untitled)',
      issue: flat.issue || '',
      issueDate: flat.issueDate || '',
      publisher: flat.publisher || '',

      // Assessment metadata
      roboGradeDate: flat.roboGradeDate || null,
      roboGradeId: flat.roboGradeId || '',
      version: rg.version || null,

      // Grades
      assessedCGCGrade: flat.assessedCGCGrade ?? null,
      assessedCGCPSAGrade: flat.assessedPSAGrade ?? null,
      cgcAIGrade: flat.cgcAIGrade ?? rg.cgcGrade ?? null,
      psaAIGrade: flat.psaAIGrade ?? rg.psaGrade ?? null,
      score: rg.score ?? null,
      confidenceRange: rg.confidenceRange ?? null,
      frontScore: rg.frontScore ?? null,
      backScore: rg.backScore ?? null,
      spineScore: rg.spineScore ?? null,
      interiorScore: rg.interiorScore ?? null,
      pageQuality: rg.pageQuality || flat.pageQuality || null,

      // Notes
      aiGraderNotes: flat.aiGraderNotes || rg.graderNotes || '',
      aiAssessment: flat.aiAssessment || rg.aiAssessment || '',
      psaNotes: flat.psaNotes || rg.psaNotes || '',
      keyInfo: flat.keyInfo || '',

      // Images
      images,
      cornerImages,

      // Ownership / pricing (useful for admin context)
      ownership: flat.ownership || '',
      seller: flat.seller || '',
      purchasePrice: flat.purchasePrice ?? null,
      askingPrice: flat.askingPrice ?? null,
      fmv: flat.fmv ?? null,
      dateAcquired: flat.dateAcquired || null,
      publicListing: !!flat.publicListing,
      enhance: flat.enhance || null,
    };

    return res.status(200).json({ item });

  } catch (e) {
    console.error('[admin-item] error:', e);
    return res.status(500).json({ error: 'Item fetch failed' });
  }
}
