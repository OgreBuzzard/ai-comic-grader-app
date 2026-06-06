// Public listing lookup — resolves a Robograde ID to a public-safe record.
//
// Endpoint chain:
//   1. /robograde_ids/{ID}  → registry doc with {comicId, userId, public}
//   2. /users/{userId}/items/{comicId}  (S11) → falls back to /comics/{comicId} (legacy)
//   3. Tolerates both v3 (nested per-type) and pre-v3 (flat) document shapes
//   4. Whitelists fields and computes integrity badge state server-side
//
// What we DON'T return: prices, notes (any kind), seller, personal dates,
// purchase metadata, internal flags. Public listing is grade + condition +
// images + provenance signal — nothing that aids a doctored-image scam.

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

    // Step 2: fetch the record. Try `items` first (S11 rename), fall back to
    // `comics` for any registry entry that pre-dates the migration and hasn't
    // had the owner sign in to trigger their per-user comics→items migration.
    // Once every active user has signed in post-S11, the fallback path becomes
    // dead code — safe to remove in a future cleanup pass.
    let comicDoc = await db
      .collection('users').doc(userId)
      .collection('items').doc(comicId)
      .get();

    if (!comicDoc.exists) {
      comicDoc = await db
        .collection('users').doc(userId)
        .collection('comics').doc(comicId)
        .get();
    }

    if (!comicDoc.exists) {
      return res.status(404).json({ error: 'Assessment record not found' });
    }

    const raw = comicDoc.data();

    // Step 3: flatten v3 nested shape to a single object for downstream reads.
    // v3 has comic-specific fields inside `comicData`; pre-v3 has them flat at
    // root. Tolerate both.
    let comic = (raw.schemaVersion === 3)
      ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
      : raw;

    // Step 4: verify the record is still marked public and IDs match.
    // publicListing lives at the root in both shapes (it's universal metadata,
    // not type-specific), and roboGradeId likewise — so these reads work
    // regardless of the spread above.
    //
    // S15: if the live comic's roboGradeId doesn't match the requested ID,
    // the assessment has been superseded by a re-assessment. Fall back to
    // archived_assessments/{requestedId} which is written on every re-assess.
    // Public visibility still gated by the registry (step 1 above) AND the
    // archive's own publicListing flag (privacy mirror keeps these in sync).
    if (comic.roboGradeId !== gradeId) {
      const archDoc = await db.collection('archived_assessments').doc(gradeId).get();
      if (!archDoc.exists) {
        return res.status(403).json({ error: 'This assessment is private' });
      }
      const archRaw = archDoc.data();
      if (!archRaw.publicListing) {
        return res.status(403).json({ error: 'This assessment is private' });
      }
      // Archive is already stored flat (snapshot was flattened at write
      // time in index.html submitForm). Use it directly.
      comic = archRaw;
    } else if (!comic.publicListing) {
      return res.status(403).json({ error: 'This assessment is private' });
    }

    // Step 5: normalize image arrays to flat URL strings + compute integrity.
    // v3 stores images as [{url, source, capturedAt}]; pre-v3 stored them as
    // plain URL strings. The badge needs to know whether ALL assessed photos
    // (main + corner) were captured in-app. Pre-v3 records have no provenance
    // metadata at all and are treated as 'unverified' — accurate, since the
    // capture system didn't exist when those photos were taken.
    // Read from `comic` (which may be the live record OR an archive snapshot
    // per Step 4 fallback) — NOT `raw`, which is always the live doc.
    const mainEntries   = Array.isArray(comic.images)        ? comic.images        : [];
    const cornerEntries = Array.isArray(comic.cornerImages)  ? comic.cornerImages  : [];

    const flatImages = mainEntries
      .map(e => (typeof e === 'string' ? e : (e && e.url) || null))
      .filter(Boolean);

    // Corner macros — exposed on public surface so the high-grade 2×2 grid
    // can render. Same shape normalization as main images.
    const flatCornerImages = cornerEntries
      .map(e => (typeof e === 'string' ? e : (e && e.url) || null))
      .filter(Boolean);

    // Verification check — combines main + corner. Every assessed photo must
    // be source:'camera'. Any string entry (legacy, pre-metadata) counts as
    // upload. Empty arrays return 'empty' (rendered as nothing on the public
    // page).
    const allEntries = [...mainEntries, ...cornerEntries];
    let verificationState;
    if (allEntries.length === 0) {
      verificationState = 'empty';
    } else {
      const allCamera = allEntries.every(e =>
        e && typeof e === 'object' && e.source === 'camera'
      );
      verificationState = allCamera ? 'verified' : 'unverified';
    }

    // Step 6: return only public-safe fields — never prices, notes, or personal data
    const publicRecord = {
      roboGradeId:       comic.roboGradeId,
      roboGradeDate:     comic.roboGradeDate,
      roboGrade:         comic.roboGrade || null,
      title:             comic.title || '',
      issue:             comic.issue || '',
      issueDate:         comic.issueDate || '',
      publisher:         comic.publisher || '',
      printing:          comic.printing || null,
      images:            flatImages,
      cornerImages:      flatCornerImages,
      // Page quality is condition info, not personal — include it
      pageQuality:       comic.pageQuality || '',
      // S14 unification: predictedGrade is now a public field. New items
      // write it directly; legacy items have it synthesized from
      // assessedCGCGrade by the client-side flattener on save. Public
      // surface no longer names CGC — the legal-exposure tradeoff that
      // motivated the unification in the first place.
      predictedGrade:    comic.predictedGrade || comic.assessedCGCGrade || null,
      highGradeUnlocked: comic.highGradeUnlocked || false,
      // S16: Deep, Full, and Restoration assessment state
      deepAssessmentRan: !!(comic.roboGrade && comic.roboGrade.deepAssessmentRan),
      fullAssessmentRan: !!comic.fullAssessmentRan,
      restorationCheckRan: !!comic.restorationCheckRan,
      restorationFlag: !!comic.restorationFlag,
      restorationHighConfidence: !!comic.restorationHighConfidence,
      restorationReport: comic.restorationReport || null,
      // Integrity badge state (S12). 'verified' = all assessed photos were
      // captured in-app; 'unverified' = at least one was uploaded; 'empty' =
      // no images. public.html renders the corresponding pill.
      verificationState,
    };

    return res.status(200).json(publicRecord);

  } catch (e) {
    console.error('Lookup error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
