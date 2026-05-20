// api/inspect_img.js  (deploy path → /api/inspect_img)
// ============================================================================
// Companion to /api/inspect — returns the ACTUAL IMAGE BYTES for an
// assessment's photos, by short index, so external tools (Claude's
// web_fetch in particular) can retrieve them.
//
// THE PROBLEM THIS SOLVES:
//   Firebase Storage download URLs are ~270 chars due to URL-encoded
//   paths + GUID tokens. web_fetch refuses URLs that long. The inspect
//   endpoint returns those URLs in the record, but the URLs themselves
//   can't be fetched. This endpoint accepts a SHORT URL keyed by
//   {id, kind, n} and serves the underlying Storage object server-side.
//
// USAGE:
//   GET /api/inspect_img?id=VKAQPM&kind=cover&n=0&token=<INSPECT_TOKEN>
//   kind=cover  → images[n]        (front_cover, back_cover, page_quality, raking_light: n = 0..3)
//   kind=corner → cornerImages[n]  (TL, TR, BL, BR: n = 0..3)
//   Returns: the raw image bytes (Content-Type image/jpeg) with the
//   same INSPECT_TOKEN gate as the inspect endpoint.
//
// SECURITY:
//   Same model as inspect.js — INSPECT_TOKEN env var, constant-time
//   compare, no-store cache headers. The proxy CANNOT serve any image
//   path other than ones derived from a real assessment record (the
//   path is computed server-side from the registry → user → item lookup,
//   never accepted from the URL), so a holder of the token can only
//   reach images that correspond to a valid 6-char Robograde ID — they
//   can't supply arbitrary Storage paths.
// ============================================================================

import { timingSafeEqual } from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── Token check (mirrors inspect.js exactly) ────────────────────────
  const expected = process.env.INSPECT_TOKEN;
  if (!expected || expected.length < 16) {
    console.error('[inspect_img] INSPECT_TOKEN env var missing or too short');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const provided = (req.query.token || '').toString();
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  let tokenMatch = false;
  if (expectedBuf.length === providedBuf.length) {
    try { tokenMatch = timingSafeEqual(expectedBuf, providedBuf); }
    catch { tokenMatch = false; }
  }
  if (!tokenMatch) return res.status(401).json({ error: 'Unauthorized' });

  // ── Param validation ────────────────────────────────────────────────
  const { id, kind, n } = req.query;
  if (!id || !/^[0-9A-NP-Z]{6}$/.test(String(id).toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }
  const gradeId = String(id).toUpperCase();

  const kindStr = String(kind || 'cover').toLowerCase();
  if (kindStr !== 'cover' && kindStr !== 'corner') {
    return res.status(400).json({ error: 'kind must be cover or corner' });
  }
  const idx = parseInt(n, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
    return res.status(400).json({ error: 'n must be 0-3' });
  }

  try {
    const { initializeApp, getApps, cert } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const { getStorage } = await import('firebase-admin/storage');

    // initializeApp WITH a storageBucket since this endpoint actually reads
    // Storage objects (inspect.js doesn't need this).
    if (!getApps().length) {
      initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        storageBucket: 'ai-comic-grader.firebasestorage.app',
      });
    }
    const db = getFirestore();
    const bucket = getStorage().bucket();

    // Step 1: same registry → user → item lookup as inspect.js. The
    // image path is derived from a REAL record — the URL never carries
    // a raw Storage path, only the 6-char public ID, so a token holder
    // can only reach images attached to a real assessment.
    const idDoc = await db.collection('robograde_ids').doc(gradeId).get();
    if (!idDoc.exists) return res.status(404).json({ error: 'Assessment ID not found' });
    const { comicId, userId } = idDoc.data() || {};
    if (!comicId || !userId) return res.status(404).json({ error: 'Assessment record missing' });

    let comicDoc = await db
      .collection('users').doc(userId)
      .collection('items').doc(comicId)
      .get();
    if (!comicDoc.exists) {
      // Legacy collection name (pre-S11 rename) — mirror inspect.js fallback.
      comicDoc = await db
        .collection('users').doc(userId)
        .collection('comics').doc(comicId)
        .get();
    }
    if (!comicDoc.exists) return res.status(404).json({ error: 'Assessment record not found' });

    const raw = comicDoc.data() || {};

    // Step 2: find the right image URL by kind+n. We pull the Storage
    // OBJECT PATH out of the recorded download URL (same trick as
    // transfer_resolve uses) rather than trying to reconstruct it from
    // slot names — that handles legacy `comics/` paths correctly too.
    const imageArr = kindStr === 'cover'
      ? (Array.isArray(raw.images) ? raw.images : [])
      : (Array.isArray(raw.cornerImages) ? raw.cornerImages : []);
    if (idx >= imageArr.length) {
      return res.status(404).json({ error: 'No image at that index' });
    }
    const entry = imageArr[idx];
    // images[] is sometimes an array of strings (legacy) or array of
    // {url, ...} objects (schema v3). Handle both.
    const downloadUrl = (typeof entry === 'string') ? entry : (entry && entry.url);
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      return res.status(404).json({ error: 'Image entry has no URL' });
    }

    // Parse the object path out of the Firebase download URL:
    //   .../o/<URL-encoded path>?alt=media&token=...
    const marker = '/o/';
    const mIdx = downloadUrl.indexOf(marker);
    if (mIdx === -1) return res.status(500).json({ error: 'Unparseable image URL' });
    let pathPart = downloadUrl.slice(mIdx + marker.length);
    const qIdx = pathPart.indexOf('?');
    if (qIdx !== -1) pathPart = pathPart.slice(0, qIdx);
    let storagePath;
    try { storagePath = decodeURIComponent(pathPart); }
    catch { return res.status(500).json({ error: 'Could not decode image path' }); }

    // Step 3: stream the bytes back. Use a buffer rather than a stream
    // pipe — these are JPEGs in the low-MB range, simpler and avoids
    // half-streamed-response edge cases when web_fetch is the client.
    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'Storage object not found' });
    const [buf] = await file.download();
    const [meta] = await file.getMetadata();
    const contentType = (meta && meta.contentType) || 'image/jpeg';

    // Audit log (matches inspect.js's pattern but distinct prefix).
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    console.log(`[inspect_img] id=${gradeId} kind=${kindStr} n=${idx} userId=${userId} ip=${ip}`);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buf.length);
    return res.status(200).send(buf);
  } catch (e) {
    console.error('[inspect_img] error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
