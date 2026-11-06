// api/transfer_resolve.js  (deploy path → /api/transfer_resolve)
// ============================================================================
// S14 Phase 3 — receive side, part 2. THE consequential endpoint: this is
// where cross-account mutation, the cert re-point, and the chunked/
// resumable accept happen. Read TRANSFER_FEATURE_DESIGN.md decision #1
// before modifying.
//
// Caller = recipient (User B). Auth: their own Firebase ID token.
// Body: { transferIds: [..], action: 'accept' | 'decline' }
//   - transferIds is the WHOLE batch from one sender (Matt Q4: one
//     Confirm accepts that sender's entire batch). Each transfer is
//     processed INDEPENDENTLY so a 150-book batch is resumable: the
//     per-transfer `status` is the unit of progress. If this call dies
//     at book 90, books 1..90 are 'accepted' and a retry skips them
//     (idempotent) and finishes 91..150.
//
// Per-transfer guards:
//   - transfer must exist, t.toUid === caller (only the recipient can
//     resolve), and t.status === 'pending'. A non-pending transfer is
//     SKIPPED as already-done (idempotent — double-tap / resumed retry
//     returns success without duplicating).
//
// ACCEPT ordering (failure-safe; commit point = registry re-point):
//   (1) copy each image object A→B in Cloud Storage (server-side copy,
//       no byte download). Build B's rewritten image URL list.
//   (2) write B's new item doc: ownership 'Owned', public true, carrying
//       the ORIGINAL roboGradeId, images → B's copies.
//   (3) re-point robograde_ids/{originalId} → B  [[ COMMIT POINT ]]
//       (.comicId=B item, .userId=B uid, .public=true). If the source
//       had no roboGradeId, instead MINT a fresh one for B's public
//       copy (Scenario 2: recipient copy is Owned+Public always).
//       Edge 8b: if the original registry doc is gone (A deleted source
//       between send and accept), RE-CREATE it pointing at B.
//   (4) re-ID A's retained copy: generate a NEW roboGradeId, write its
//       (private) registry doc, set A's item that new id + ownership
//       Watching (or Sold if it was Sold) + public false. A's item may
//       have been deleted by A in the meantime — that's fine, skip (4),
//       the invariant still holds (exactly one item owns the original
//       cert: B's).
//   (5) mark transfer status 'accepted', resolvedAt set.
// Anything failing before (3) → that transfer left 'pending', abort it,
// surface partial progress; B retries, no in-the-wild cert moved yet.
// (4) failing after (3) committed → cert is already correctly B's;
// retry is deterministic (A's new id derived from transferId so a
// resumed retry doesn't double-mint).
//
// DECLINE: status 'declined', resolvedAt set. No account writes, snapshot
// discarded (left on the doc but unused; Phase 4 sweep can purge).
// ============================================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

function parseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var not set');
  if (raw.indexOf('\\"') !== -1) {
    raw = raw.split('\\"').join('"');
    raw = raw.split('\\\\').join('\\');
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed');
    }
  }
}

const ID_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTVWXYZ';
const STORAGE_BUCKET = 'ai-comic-grader.firebasestorage.app';

// Deterministic-ish id helper. For A's new roboGradeId we want a value
// that is STABLE across resumed retries of the same transfer (so a retry
// after a crash at step 4 doesn't mint a second id and leave an orphan
// registry doc). Derive it from the transferId by hashing into the
// alphabet. Not cryptographic — just a stable, collision-safe-enough
// 6-char projection (32^6 space; the transferId is already unique so
// the projection is effectively unique per transfer).
function deterministicRoboId(seed) {
  // FNV-1a over the seed, expanded to 6 chars of ID_ALPHABET.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ID_ALPHABET[h % ID_ALPHABET.length];
    h = (h * 0x01000193 + 0x9e3779b9) >>> 0;
  }
  return out;
}

// Parse the Cloud Storage object path out of a Firebase HTTPS download
// URL. Firebase URLs look like:
//   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<ENC_PATH>?alt=media&token=...
// where ENC_PATH is the URL-encoded object path (slashes as %2F). This
// approach copies WHATEVER path the URL points at, so it correctly
// handles legacy `users/{uid}/comics/...` objects as well as the current
// `users/{uid}/items/...` layout (we don't reconstruct paths, we read
// the actual one). Returns null if it's not a parseable Firebase URL
// (e.g. a data: URL that somehow leaked into the manifest) so the caller
// can skip it rather than crash the whole batch.
function objectPathFromUrl(url) {
  if (typeof url !== 'string') return null;
  const marker = '/o/';
  const i = url.indexOf(marker);
  if (i === -1) return null;
  let rest = url.slice(i + marker.length);
  const q = rest.indexOf('?');
  if (q !== -1) rest = rest.slice(0, q);
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

// ── v6.39 — A TRANSFER USED TO COPY FOUR PHOTOS AND MISS THE REST ─────────
// The accept copied exactly `imageManifest`, which transfer_recv builds from
// `item.images` alone. Two things were wrong with that, and the second one
// hid the first.
//
//   1. It only ever covered the four MAIN covers. Corner macros, interior
//      covers, Full's six structure slots, signature, restoration, insert,
//      coupon, the user's own defect photos, the Cleaning Compare before and
//      after sets, thumbnails - none of them were copied. B's entry pointed
//      at files sitting in A's Storage folder. They still RENDER, because
//      these are download-token URLs and tokens bypass the Storage rules, so
//      nothing looked broken; but B's book was one "delete" by A away from
//      losing most of its photographs, and the deletion that does it is a
//      perfectly ordinary thing for A to do with an entry they no longer own.
//
//   2. Since schemaVersion 3, it copied NOTHING. v3 stores images as
//      { url, source, capturedAt, hash } objects, so `imageManifest` became
//      an array of OBJECTS, and objectPathFromUrl returns null for anything
//      that is not a string. Every entry fell through the
//      `if (!srcPath) { newImages.push(url); continue; }` branch, which was
//      written for an unparseable legacy URL and quietly became the only
//      path. No file was copied at all.
//
//      That same object-vs-string split is where the verification bug lived.
//      On the pre-v3 string path the copy worked and B's images were written
//      back as bare STRINGS, which splitImageArray maps to
//      source:"upload" - so a book the sender had shot entirely in-app
//      arrived at the recipient permanently "Unverified: photos taken
//      outside of app". The v3 regression masked it by not copying anything.
//
// So: stop using the manifest. WALK the snapshot instead and copy every file
// the entry refers to, wherever in the document it is written. A walk cannot
// miss a field, including a field added after this code was written - which
// is the failure mode above, exactly.
//
// The image OBJECTS are left intact and only their `url` is rewritten, so
// source / capturedAt / hash cross with the photo and a verified book stays
// verified. That is the whole fix for the reported bug; the rest is the
// larger one found underneath it.

// Exported for test-transfer-images.mjs. Vercel dispatches on the DEFAULT
// export, so named exports beside it change nothing about how this runs.
export function _storagePathOf(url) {
  if (typeof url !== 'string') return null;
  if (url.indexOf('firebasestorage.googleapis.com') === -1) return null;
  if (url.indexOf('/b/' + STORAGE_BUCKET + '/o/') === -1) return null;
  return objectPathFromUrl(url);
}

// Visits every string in a plain object/array tree and replaces it with
// whatever fn returns (undefined = leave it).
// Anything with a prototype of its own - a Firestore Timestamp, a GeoPoint -
// is left strictly alone rather than having its internals rewritten.
// Depth-capped: a Firestore document cannot contain a cycle, but a malformed
// snapshot must not be able to hang an accept.
export function _walkStrings(node, fn, depth) {
  depth = depth || 0;
  if (depth > 12 || node == null) return node;
  if (typeof node === 'string') {
    const out = fn(node);
    return out === undefined ? node : out;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = _walkStrings(node[i], fn, depth + 1);
    return node;
  }
  if (typeof node === 'object') {
    if (Object.getPrototypeOf(node) !== Object.prototype) return node;
    for (const k of Object.keys(node)) node[k] = _walkStrings(node[k], fn, depth + 1);
    return node;
  }
  return node;
}

// Copies every file `snapItem` refers to into B's folder and rewrites the
// snapshot in place to point at the copies. MUTATES snapItem, which is a
// local read of the transfer doc and is never written back.
//
// Idempotent: destinations are derived from the SORTED list of source paths,
// so a resumed retry of the same transfer copies to the same places and
// overwrites rather than littering B's folder with duplicates.
export async function copyEntryImages({ bucket, snapItem, toUid, bItemId, tid }) {
  const srcPaths = new Set();
  _walkStrings(snapItem, (str) => {
    const path = _storagePathOf(str);
    // Already B's (a re-run, or a book transferred back) - nothing to do.
    if (path && path.indexOf('users/' + toUid + '/') !== 0) srcPaths.add(path);
    return undefined;
  });

  const ordered = Array.from(srcPaths).sort();
  const map = new Map();
  for (let n = 0; n < ordered.length; n++) {
    const srcPath = ordered[n];
    const rawBase = srcPath.split('/').pop() || 'image.jpg';
    const base = rawBase.replace(/[^A-Za-z0-9._-]/g, '_');
    // The n- prefix is not decoration. Two of these arrays can both hold a
    // file called "0.jpg", and without it the corner macro would overwrite
    // the front cover - a silent, unrecoverable mix-up inside the copy.
    const destPath = 'users/' + toUid + '/items/' + bItemId + '/' + n + '-' + base;
    const token = tid + '-' + n;
    map.set(srcPath, {
      destPath,
      token,
      url: 'https://firebasestorage.googleapis.com/v0/b/' + STORAGE_BUCKET
         + '/o/' + encodeURIComponent(destPath) + '?alt=media&token=' + token,
    });
  }

  const missing = [];
  for (const [srcPath, d] of map) {
    try {
      await bucket.file(srcPath).copy(bucket.file(d.destPath));
      await bucket.file(d.destPath).setMetadata({
        metadata: { firebaseStorageDownloadTokens: d.token },
      });
    } catch (copyErr) {
      const code = copyErr && (copyErr.code || copyErr.status);
      if (code === 404 || /no such object|not found/i.test(copyErr.message || '')) {
        // A deleted this photo between send and accept. Retrying will never
        // find it, so failing the transfer would strand the recipient on a
        // book they can never accept. Leave that one URL pointing where it
        // pointed, record it, and carry on with the rest.
        missing.push(srcPath);
        map.delete(srcPath);
        continue;
      }
      // Anything else is a real failure, and it is PRE-COMMIT: throwing here
      // leaves the transfer pending and safely retryable.
      throw new Error('image copy failed (' + srcPath + '): ' + copyErr.message);
    }
  }

  let rewritten = 0;
  _walkStrings(snapItem, (str) => {
    const path = _storagePathOf(str);
    if (!path) return undefined;
    const d = map.get(path);
    if (!d) return undefined;
    rewritten++;
    return d.url;
  });

  return { copied: map.size, rewritten, missing };
}

export default async function handler(req, res) {
  // CORS: native Capacitor apps call this cross-origin (WebView origin
  // https://localhost → robograder.app). The Authorization header + JSON body
  // trigger a preflight OPTIONS, which would hit the 405 gate below and fail
  // the browser's preflight check. Answer OPTIONS first. (Matches api/assess.js.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-client-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign-in required' });

    const sa = parseServiceAccount();
    if (!getApps().length) {
      initializeApp({ credential: cert(sa), storageBucket: STORAGE_BUCKET });
    }
    const auth = getAuth();
    const db = getFirestore();
    const bucket = getStorage().bucket();

    let decoded;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const uid = decoded.uid;

    const body = req.body || {};
    const action = body.action;
    let transferIds = body.transferIds;
    if (!Array.isArray(transferIds) && body.transferId) {
      transferIds = [body.transferId];   // tolerate single-id callers
    }
    if (!Array.isArray(transferIds) || transferIds.length === 0) {
      return res.status(400).json({ error: 'No transferIds provided' });
    }
    if (action !== 'accept' && action !== 'decline') {
      return res.status(400).json({ error: 'action must be accept or decline' });
    }

    const results = [];   // per-transfer outcome (for progress reporting)
    let accepted = 0, declined = 0, skipped = 0, failed = 0;

    for (const tid of transferIds) {
      try {
        const tRef = db.collection('transfers').doc(tid);
        const tSnap = await tRef.get();
        if (!tSnap.exists) {
          skipped++; results.push({ tid, outcome: 'skipped: not found' }); continue;
        }
        const t = tSnap.data() || {};
        if (t.toUid !== uid) {
          // Not this caller's transfer — never act on it.
          skipped++; results.push({ tid, outcome: 'skipped: not addressed to you' }); continue;
        }
        if (t.status !== 'pending') {
          // Idempotent: already resolved (double-tap, or a resumed retry
          // re-processing a book already done). Count as the outcome it
          // already has so the client total stays correct.
          if (t.status === 'accepted') accepted++;
          else if (t.status === 'declined') declined++;
          else skipped++;
          results.push({ tid, outcome: `already ${t.status}` });
          continue;
        }

        if (action === 'decline') {
          await tRef.update({ status: 'declined', resolvedAt: new Date().toISOString() });
          declined++; results.push({ tid, outcome: 'declined' });
          continue;
        }

        // ===== ACCEPT =====
        const fromUid = t.fromUid;
        const snapItem = t.itemSnapshot || {};
        const originalRoboGradeId = t.originalRoboGradeId || snapItem.roboGradeId || null;

        // Deterministic new item id for B (stable across resumed retries
        // of THIS transfer so a retry doesn't create a 2nd B item).
        const bItemId = `xfer_${tid}`;
        const bItemRef = db.collection('users').doc(uid)
          .collection('items').doc(bItemId);

        // (1) Copy EVERY file this entry refers to, A→B, and rewrite the
        // snapshot in place to point at the copies. See copyEntryImages:
        // this used to copy `imageManifest` (the four main covers only), and
        // since schemaVersion 3 it copied nothing at all. A pre-commit
        // failure throws, leaving the transfer pending and safely retryable.
        const _copy = await copyEntryImages({
          bucket, snapItem, toUid: uid, bItemId, tid,
        });
        if (_copy.missing.length) {
          console.warn('[transfer] ' + tid + ': ' + _copy.missing.length
            + ' source file(s) no longer exist, left pointing at the original:',
            _copy.missing);
        }

        // (2) Write B's item — Owned + Public, carrying ORIGINAL cert id
        // (or a freshly minted one if the source had none). B's public
        // cert id:
        const bRoboGradeId = originalRoboGradeId || deterministicRoboId(tid + ':b');
        const bItem = {
          ...snapItem,
          ownership: 'Owned',
          public: true,
          roboGradeId: bRoboGradeId,
          // images (and cornerImages, and every other slot) were rewritten in
          // place by copyEntryImages above. The image OBJECTS keep their
          // source / capturedAt / hash, so a book the sender shot in-app
          // arrives VERIFIED - which it did not before.
          // Provenance: a quiet marker (not user-facing) so support can
          // see this item arrived via transfer. Not used for any logic.
          _transferredFrom: fromUid,
          _transferId: tid,
        };
        // Don't carry A's sale fields onto B's Owned copy.
        delete bItem.dateSold;
        delete bItem.salePrice;
        await bItemRef.set(bItem);

        // (3) COMMIT POINT — point the public cert at B.
        const regRef = db.collection('robograde_ids').doc(bRoboGradeId);
        await regRef.set({
          comicId: bItemId,
          userId: uid,
          claimedAt: (snapItem.roboGradeDate || new Date().toISOString()),
          public: true,
        });   // set() (not update) re-creates it if A had deleted it (edge 8b)

        // (4) Re-ID A's retained copy (best-effort; A may have deleted it).
        try {
          const aItemRef = db.collection('users').doc(fromUid)
            .collection('items').doc(t.sourceItemId);
          const aSnap = await aItemRef.get();
          if (aSnap.exists) {
            const aData = aSnap.data() || {};
            const aNewId = deterministicRoboId(tid + ':a');
            const wasSold = (aData.ownership === 'Sold');
            await db.collection('robograde_ids').doc(aNewId).set({
              comicId: t.sourceItemId,
              userId: fromUid,
              claimedAt: new Date().toISOString(),
              public: false,
            });
            await aItemRef.update({
              roboGradeId: aNewId,
              ownership: wasSold ? 'Sold' : 'Watching',
              public: false,
            });
          }
        } catch (aErr) {
          // Post-commit, non-fatal. Cert is already correctly B's. Log
          // into the transfer doc for observability; do NOT fail the
          // accept (the recipient got their book).
          results.push({ tid, outcome: `accepted (A re-id deferred: ${aErr.message})` });
          await tRef.update({
            status: 'accepted',
            resolvedAt: new Date().toISOString(),
            bItemId,
            aReIdError: String(aErr.message || aErr),
          });
          accepted++;
          continue;
        }

        // (5) Mark accepted. The copy counts are recorded because the last
        // version of this endpoint copied nothing and nothing said so - a
        // transfer that silently copies zero files has to be visible from the
        // transfer doc alone.
        await tRef.update({
          status: 'accepted',
          resolvedAt: new Date().toISOString(),
          bItemId,
          imagesCopied: _copy.copied,
          imageUrlsRewritten: _copy.rewritten,
          imagesMissing: _copy.missing.length ? _copy.missing : null,
        });
        accepted++;
        results.push({ tid, outcome: 'accepted' });
      } catch (perItemErr) {
        // This transfer left 'pending' (we never marked it). Surface it;
        // the client can retry the batch — already-accepted ones in the
        // batch will be skipped idempotently.
        failed++;
        results.push({ tid, outcome: `failed: ${perItemErr.message}` });
      }
    }

    return res.status(200).json({
      ok: true,
      action,
      summary: { accepted, declined, skipped, failed, total: transferIds.length },
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'unknown error' });
  }
}
