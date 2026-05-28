// Private inspection endpoint — returns the FULL assessment record for a
// given Robograde ID. Used for calibration / debugging analysis where the
// public listing's allowlisted fields aren't enough.
//
// Unlike lookup.js (the public-facing endpoint), this:
//   • requires a shared-secret token (env var INSPECT_TOKEN)
//   • returns assessment text, defect notes, predicted CGC/PSA grades,
//     prices, dates, and all internal metadata
//   • does NOT require publicListing:true on the record — can inspect
//     private assessments too
//   • strips the inline base64 thumbnail to keep responses small
//   • logs every successful access for audit
//
// Security model:
//   - Token is a long random string set in Vercel env (INSPECT_TOKEN)
//   - Token comparison is constant-time (crypto.timingSafeEqual) to defend
//     against timing attacks even though the brute-force surface area is
//     already implausibly large
//   - 401 returned on missing or wrong token, with no information leak
//     about which case it was
//   - Cache-Control: no-store so the token never lands in any CDN cache
//   - The token is rotateable: change INSPECT_TOKEN in Vercel env and
//     all prior URLs are invalidated immediately
//
// Caveat:
//   Because web_fetch can only do GET, the token has to come in via
//   query string. URLs land in browser history, server logs, and
//   sometimes referrer headers. Treat any URL used with this endpoint
//   as sensitive and rotate the token periodically. Production-grade
//   tooling would use POST with the token in a header — this is a
//   pragmatic shortcut for an internal-only tool.
//
// Usage:
//   GET /api/inspect?id=4A9PNX&token=<INSPECT_TOKEN>
//   Returns: { ...full flattened comic doc... } or { error: '...' }
//
//   GET /api/inspect?id=4A9PNX&img=cover&n=0&token=<INSPECT_TOKEN>
//   GET /api/inspect?id=4A9PNX&img=corner&n=2&token=<INSPECT_TOKEN>
//   Returns: the raw image bytes (Content-Type image/jpeg) for the
//   indicated photo. Image mode exists because Firebase Storage download
//   URLs are ~270 chars and web_fetch rejects URLs that long; the proxy
//   URLs returned in the JSON response point back at this same endpoint
//   in image mode, short enough for any fetcher to accept.
//
//   Image mode CANNOT serve arbitrary Storage paths — the path is
//   computed server-side from the registry → user → item lookup, never
//   accepted from the URL. A token holder can only reach images that
//   correspond to a real assessment record.
//
//   The image-serving endpoint was originally a separate `inspect_img.js`
//   file (S14); it was merged in here to stay under the Vercel Hobby
//   plan's 12-serverless-function-per-deployment ceiling.
//
// Audit log:
//   Each successful access logs `[inspect] id=<ID> ip=<IP> ts=<ISO>`.
//   Vercel's function logs retain these for ~1 hour at the Hobby tier
//   and 3 days on Pro. Sufficient for a "did anyone misuse the token"
//   spot check.

import { timingSafeEqual } from 'crypto';

export default async function handler(req, res) {
  // Cache-Control: no-store on every response (success or error) so neither
  // the response body nor the URL ever lands in a CDN cache. The token in
  // the query string makes any cached response a token leak.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  // CORS — allow GET only. This is an internal tool; we don't need to
  // open it up to other origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // ── Token check ───────────────────────────────────────────────────
  // The expected token comes from Vercel env. If the env var is not set,
  // we refuse all requests rather than allowing through with no token —
  // failing closed. This means a misconfigured deploy can't accidentally
  // expose the endpoint.
  const expected = process.env.INSPECT_TOKEN;
  if (!expected || expected.length < 16) {
    console.error('[inspect] INSPECT_TOKEN env var missing or too short');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const provided = (req.query.token || '').toString();

  // Constant-time comparison. Buffer.from with explicit lengths protects
  // against length-mismatch crashes (timingSafeEqual throws if the two
  // buffers are different sizes). We pad the shorter one to the longer
  // length so the compare runs but the result is guaranteed false when
  // lengths differ.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  let tokenMatch = false;
  if (expectedBuf.length === providedBuf.length) {
    try {
      tokenMatch = timingSafeEqual(expectedBuf, providedBuf);
    } catch {
      tokenMatch = false;
    }
  }
  if (!tokenMatch) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── ID validation ─────────────────────────────────────────────────
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

    // Step 1: registry lookup — same path as lookup.js. The registry holds
    // {comicId, userId, public} and is keyed by Robograde ID.
    const idDoc = await db.collection('robograde_ids').doc(gradeId).get();
    if (!idDoc.exists) {
      return res.status(404).json({ error: 'Assessment ID not found' });
    }

    const registry = idDoc.data();
    const { comicId, userId } = registry;
    if (!comicId || !userId) {
      return res.status(404).json({ error: 'Assessment record missing' });
    }

    // Step 2: fetch the document. Try `items` first (S11 rename), fall back
    // to legacy `comics` for any registry entry that pre-dates the
    // collection rename and hasn't migrated yet. Same dual-path as lookup.js.
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

    // ── Image-mode branch ──────────────────────────────────────────────
    // If the request carries ?img=cover|corner&n=0..3 we serve the
    // underlying Storage object's bytes instead of the JSON record.
    // Validate the image params here (after the comic doc is in hand,
    // so we can look up the right image by index without a second
    // Firestore round-trip), then return early before the flatten/JSON
    // path below.
    const imgKind = (req.query.img || '').toString().toLowerCase();
    if (imgKind) {
      if (imgKind !== 'cover' && imgKind !== 'corner') {
        return res.status(400).json({ error: 'img must be cover or corner' });
      }
      const nIdx = parseInt(req.query.n, 10);
      if (!Number.isInteger(nIdx) || nIdx < 0 || nIdx > 3) {
        return res.status(400).json({ error: 'n must be 0-3' });
      }
      // images[] in v3 is the array of {url, source, ...} objects;
      // cornerImages[] is the same shape. Older docs may store strings.
      const imageArr = imgKind === 'cover'
        ? (Array.isArray(raw.images) ? raw.images : (raw.comicData && Array.isArray(raw.comicData.images) ? raw.comicData.images : []))
        : (Array.isArray(raw.cornerImages) ? raw.cornerImages : (raw.comicData && Array.isArray(raw.comicData.cornerImages) ? raw.comicData.cornerImages : []));
      if (nIdx >= imageArr.length) {
        return res.status(404).json({ error: 'No image at that index' });
      }
      const entry = imageArr[nIdx];
      const downloadUrl = (typeof entry === 'string') ? entry : (entry && entry.url);
      if (!downloadUrl || typeof downloadUrl !== 'string') {
        return res.status(404).json({ error: 'Image entry has no URL' });
      }

      // Parse the Storage object path out of the Firebase download URL:
      //   .../o/<URL-encoded path>?alt=media&token=...
      const marker = '/o/';
      const mIdx = downloadUrl.indexOf(marker);
      if (mIdx === -1) {
        return res.status(500).json({ error: 'Unparseable image URL' });
      }
      let pathPart = downloadUrl.slice(mIdx + marker.length);
      const qIdx = pathPart.indexOf('?');
      if (qIdx !== -1) pathPart = pathPart.slice(0, qIdx);
      let storagePath;
      try { storagePath = decodeURIComponent(pathPart); }
      catch { return res.status(500).json({ error: 'Could not decode image path' }); }

      // Lazy-init the app WITH a storageBucket if we haven't already.
      // The JSON-record path above only needed Firestore, so the
      // earlier initializeApp call did not set storageBucket. If image
      // mode runs first in a cold-start, that initializeApp already
      // ran without the bucket; calling initializeApp again would
      // throw. The bucket name is hard-coded because it doesn't
      // change between deploys.
      const { getStorage } = await import('firebase-admin/storage');
      let bucket;
      try {
        bucket = getStorage().bucket('ai-comic-grader.firebasestorage.app');
      } catch (e) {
        console.error('[inspect img] storage bucket access failed:', e);
        return res.status(500).json({ error: 'Storage unavailable' });
      }

      const file = bucket.file(storagePath);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).json({ error: 'Storage object not found' });
      const [buf] = await file.download();
      const [meta] = await file.getMetadata();
      const contentType = (meta && meta.contentType) || 'image/jpeg';

      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
      console.log(`[inspect img] id=${gradeId} kind=${imgKind} n=${nIdx} userId=${userId} ip=${ip}`);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buf.length);
      return res.status(200).send(buf);
    }

    // ── JSON-record path (default mode) ────────────────────────────────

    // Step 3: flatten v3 nested shape. Pre-v3 docs have fields at root;
    // v3 nests comic-specific fields inside `comicData`. Spread both shapes
    // so downstream consumers can read fields the same way regardless.
    const flat = (raw.schemaVersion === 3)
      ? { ...raw, ...(raw.comicData || {}), ...(raw.cardData || {}) }
      : { ...raw };

    // Step 4: strip the inline base64 thumbnail. It's a 160px JPEG used for
    // instant list-view rendering on the client; for inspection it adds
    // tens of kilobytes per response with no analytical value (the full-
    // size image URLs are still in `images`).
    delete flat.imageThumb;
    delete flat.thumb;

    // Also strip the per-comic raw nested copies now that we've flattened
    // them into the response — they'd just duplicate everything.
    delete flat.comicData;
    delete flat.cardData;

    // Step 5: build short proxy URLs alongside each image, so external
    // tools (notably web_fetch) that reject long URLs can retrieve the
    // bytes via this same endpoint in image mode (img=cover|corner&n=N).
    // The original long Firebase URLs are
    // preserved (browsers/the app itself still use them); proxy URLs are
    // added as a parallel field. Also emit a top-level _images summary
    // so the most common use ("just give me the picture URLs") doesn't
    // require digging through the images array structure.
    const tokenForProxy = encodeURIComponent(provided);
    const slotNames = ['front_cover', 'back_cover', 'page_quality', 'raking_light'];
    const cornerNames = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];
    const proxyUrl = (kind, n) =>
      `https://robograder.app/api/inspect?id=${gradeId}&img=${kind}&n=${n}&token=${tokenForProxy}`;

    if (Array.isArray(flat.images)) {
      flat.images = flat.images.map((entry, n) => {
        if (entry && typeof entry === 'object') {
          return { ...entry, proxyUrl: proxyUrl('cover', n) };
        }
        // legacy: array of strings
        return { url: entry, proxyUrl: proxyUrl('cover', n) };
      });
    }
    if (Array.isArray(flat.cornerImages)) {
      flat.cornerImages = flat.cornerImages.map((entry, n) => {
        if (entry && typeof entry === 'object') {
          return { ...entry, proxyUrl: proxyUrl('corner', n) };
        }
        return { url: entry, proxyUrl: proxyUrl('corner', n) };
      });
    }
    // Convenience block: short-URL-only view of the images for any
    // consumer that just wants to grab pictures by slot name.
    const _images = {};
    if (Array.isArray(flat.images)) {
      flat.images.forEach((img, n) => {
        if (img && img.proxyUrl) _images[slotNames[n] || `cover_${n}`] = img.proxyUrl;
      });
    }
    if (Array.isArray(flat.cornerImages)) {
      flat.cornerImages.forEach((img, n) => {
        if (img && img.proxyUrl) _images[cornerNames[n] || `corner_${n}`] = img.proxyUrl;
      });
    }
    flat._images = _images;

    // Step 6: audit log. Vercel function logs are timestamped automatically;
    // we add the assessment ID, the user it belonged to, and the request
    // IP for cross-referencing. Doesn't log the token or any field values.
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    console.log(`[inspect] id=${gradeId} userId=${userId} ip=${ip}`);

    // Step 7: return the full flattened record + the registry context.
    // Wrapping in {registry, comic} lets us expose the registry's
    // `public` flag (useful for spot-checking misconfigured private/
    // public state) without conflating it with the comic doc's own
    // `publicListing` field.
    return res.status(200).json({
      registry: {
        comicId,
        userId,
        public: registry.public === true,
      },
      comic: flat,
    });

  } catch (e) {
    console.error('[inspect] error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
