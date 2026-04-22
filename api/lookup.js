export default async function handler(req, res) {
  // Allow unauthenticated GET requests from any origin (public endpoint)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id || !/^[0-9A-NP-Z]{6}$/.test(id.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  const gradeId = id.toUpperCase();

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');

    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }

    const db = getFirestore();

    // Step 1: look up the registry entry
    const idDoc = await db.collection('robograde_ids').doc(gradeId).get();
    if (!idDoc.exists) {
      return res.status(404).json({ error: 'Assessment ID not found' });
    }

    const registry = idDoc.data();
    if (!registry.public) {
      return res.status(403).json({ error: 'This assessment is private' });
    }

    const { comicId, userId } = registry;
    if (!comicId || !userId) {
      return res.status(404).json({ error: 'Assessment record missing' });
    }

    // Step 2: fetch the comic record from the owner's collection
    const comicDoc = await db
      .collection('users').doc(userId)
      .collection('comics').doc(comicId)
      .get();

    if (!comicDoc.exists) {
      return res.status(404).json({ error: 'Assessment record not found' });
    }

    const comic = comicDoc.data();

    // Step 3: verify the record is still marked public and IDs match
    if (!comic.publicListing || comic.roboGradeId !== gradeId) {
      return res.status(403).json({ error: 'This assessment is private' });
    }

    // Step 4: return only public-safe fields — never prices, notes, or personal data
    const publicRecord = {
      roboGradeId:   comic.roboGradeId,
      roboGradeDate: comic.roboGradeDate,
      roboGrade:     comic.roboGrade || null,
      title:         comic.title || '',
      issue:         comic.issue || '',
      issueDate:     comic.issueDate || '',
      printing:      comic.printing || null,
      images:        comic.images || [],
      // Page quality is condition info, not personal — include it
      pageQuality:   comic.pageQuality || '',
    };

    return res.status(200).json(publicRecord);

  } catch (e) {
    console.error('Lookup error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
