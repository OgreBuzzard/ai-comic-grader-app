// test-transfer-images.mjs — v6.39
//
// The accept path's image copy, tested without Firebase. copyEntryImages
// takes a bucket object, so a fake one that records calls is the whole
// harness. Run: node test-transfer-images.mjs
//
// What is being protected: a transfer used to copy the four main covers and
// nothing else, and since schemaVersion 3 it copied nothing at all, because
// v3 stores images as objects and the old code only understood strings. The
// cases below are the ones that would have caught both, plus the verification
// regression they hid.

const BUCKET = 'ai-comic-grader.firebasestorage.app';
const url = (p, t) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media&token=${t || 'x'}`;

function fakeBucket(opts = {}) {
  const missing = new Set(opts.missing || []);
  const copies = [];
  const tokens = [];
  return {
    copies, tokens,
    file(path) {
      return {
        async copy(dest) {
          if (missing.has(path)) {
            const e = new Error('No such object: ' + path);
            e.code = 404;
            throw e;
          }
          copies.push([path, dest.__path]);
        },
        async setMetadata(m) {
          tokens.push([path, m.metadata.firebaseStorageDownloadTokens]);
        },
        __path: path,
      };
    },
  };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '\n        ' + extra : '')); }
};

// The endpoint imports firebase-admin, which is not installed here and has no
// business being installed to test three pure functions. So the functions are
// SLICED OUT of the real file and loaded on their own - the same approach
// check-index-syntax.mjs takes with index.html's inline blocks. The test
// therefore runs against the shipping source, not a copy of it, which is the
// only version of this that is worth having.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./api/transfer_resolve.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  if (i === -1 || j === -1) {
    throw new Error('test-transfer-images: could not find ' + JSON.stringify(from)
      + ' in api/transfer_resolve.js - the functions it tests have been renamed '
      + 'or moved, and this test is now checking nothing. Fix the slice.');
  }
  return src.slice(i, j);
};
const mod =
  "const STORAGE_BUCKET = '" + BUCKET + "';\n"
  + slice('function objectPathFromUrl(url) {', '// Exported for test-transfer-images.mjs')
  + slice('export function _storagePathOf(url) {', '\nexport default async function handler')
      .split('export function ').join('function ')
      .split('export async function ').join('async function ')
  + '\nexport { _storagePathOf, _walkStrings, copyEntryImages };\n';
const { _storagePathOf, _walkStrings, copyEntryImages } =
  await import('data:text/javascript;base64,' + Buffer.from(mod).toString('base64'));

// ── _storagePathOf ────────────────────────────────────────────────────────
ok('a storage URL yields its object path',
  _storagePathOf(url('users/A/items/i1/0.jpg')) === 'users/A/items/i1/0.jpg');
ok('a non-string is not a path', _storagePathOf({ url: 'x' }) === null);
ok('a ComicVine reference scan is left alone',
  _storagePathOf('https://comicvine.gamespot.com/a/uploads/scale_large/1.jpg') === null);
ok('a data: URL is not a path', _storagePathOf('data:image/jpeg;base64,AAAA') === null);
ok('another bucket is not ours',
  _storagePathOf('https://firebasestorage.googleapis.com/v0/b/someone-else/o/x?alt=media') === null);

// ── _walkStrings ──────────────────────────────────────────────────────────
{
  const tree = { a: 'x', b: ['y', { c: 'z' }], d: 1, e: null };
  _walkStrings(tree, (s) => s.toUpperCase());
  ok('every string in the tree is visited',
    JSON.stringify(tree) === JSON.stringify({ a: 'X', b: ['Y', { c: 'Z' }], d: 1, e: null }));
}
{
  class Stamp { constructor() { this.seconds = 1; this.note = 'leave me'; } }
  const tree = { t: new Stamp(), s: 'hit' };
  _walkStrings(tree, (s) => 'CHANGED');
  ok('an object with its own prototype is not rewritten (Firestore Timestamp)',
    tree.t.note === 'leave me' && tree.s === 'CHANGED');
}

// ── copyEntryImages: the v3 object shape ──────────────────────────────────
{
  const snap = {
    schemaVersion: 3,
    images: [
      { url: url('users/A/items/i1/0.jpg'), source: 'camera', capturedAt: '2026-01-01', hash: 'h0' },
      { url: url('users/A/items/i1/1.jpg'), source: 'camera', capturedAt: '2026-01-01', hash: 'h1' },
    ],
    cornerImages: [
      { url: url('users/A/items/i1/c0.jpg'), source: 'camera', capturedAt: '2026-01-01', hash: null },
    ],
    interiorCoverImages: [url('users/A/items/i1/ic0.jpg')],
    comicData: {
      title: 'Weird Science',
      interiorCoverMeta: [{ source: 'camera', capturedAt: '2026-01-01' }],
      couponImages: [url('users/A/items/i1/cp0.jpg')],
      referenceImageUrl: 'https://comicvine.gamespot.com/a/uploads/scale_large/9.jpg',
    },
    thumbnails: [url('users/A/items/i1/t0.jpg')],
  };
  const bucket = fakeBucket();
  const r = await copyEntryImages({ bucket, snapItem: snap, toUid: 'B', bItemId: 'xfer_T1', tid: 'T1' });

  ok('every slot is copied, not just the four covers', r.copied === 6,
    'copied ' + r.copied + ' (expected 6: 2 main, 1 corner, 1 interior cover, 1 coupon, 1 thumbnail)');
  ok('every URL in the document is rewritten', r.rewritten === 6, 'rewritten ' + r.rewritten);
  ok('the ComicVine reference scan is untouched',
    snap.comicData.referenceImageUrl.indexOf('comicvine') !== -1);
  ok('v3 image objects keep source / capturedAt / hash — A VERIFIED BOOK STAYS VERIFIED',
    snap.images.every(i => i.source === 'camera' && i.capturedAt === '2026-01-01')
    && snap.images[0].hash === 'h0' && snap.images[1].hash === 'h1');
  ok('images are still objects, not bare strings',
    snap.images.every(i => typeof i === 'object' && typeof i.url === 'string'));
  ok('every rewritten URL points into B\'s folder',
    bucket.copies.every(([, dest]) => dest.indexOf('users/B/items/xfer_T1/') === 0));
  ok('the corner macro did not overwrite a cover (unique destinations)',
    new Set(bucket.copies.map(c => c[1])).size === bucket.copies.length);
  ok('every copy got a download token',
    bucket.tokens.length === bucket.copies.length);
  ok('no URL still points at A',
    JSON.stringify(snap).indexOf('users%2FA%2F') === -1);
}

// ── the pre-v3 string shape, which is where the verification bug lived ────
{
  const snap = {
    images: [url('users/A/items/i1/0.jpg')],
    imagesMeta: [{ source: 'camera', capturedAt: '2026-01-01' }],
  };
  const bucket = fakeBucket();
  await copyEntryImages({ bucket, snapItem: snap, toUid: 'B', bItemId: 'xfer_T2', tid: 'T2' });
  ok('a legacy string array is copied and rewritten in place',
    typeof snap.images[0] === 'string' && snap.images[0].indexOf('users%2FB%2F') !== -1);
  ok('its separate meta array is untouched', snap.imagesMeta[0].source === 'camera');
}

// ── idempotence ───────────────────────────────────────────────────────────
{
  const build = () => ({ images: [
    { url: url('users/A/items/i1/0.jpg'), source: 'camera' },
    { url: url('users/A/items/i1/1.jpg'), source: 'camera' },
  ] });
  const a = build(), b = build();
  const b1 = fakeBucket(), b2 = fakeBucket();
  await copyEntryImages({ bucket: b1, snapItem: a, toUid: 'B', bItemId: 'xfer_T3', tid: 'T3' });
  await copyEntryImages({ bucket: b2, snapItem: b, toUid: 'B', bItemId: 'xfer_T3', tid: 'T3' });
  ok('a resumed retry copies to the SAME destinations',
    JSON.stringify(b1.copies) === JSON.stringify(b2.copies));
  ok('a resumed retry produces the same URLs', JSON.stringify(a) === JSON.stringify(b));
}

// ── already B's: a re-run over a rewritten snapshot copies nothing ────────
{
  const snap = { images: [{ url: url('users/B/items/xfer_T4/0-0.jpg', 'T4-0'), source: 'camera' }] };
  const bucket = fakeBucket();
  const r = await copyEntryImages({ bucket, snapItem: snap, toUid: 'B', bItemId: 'xfer_T4', tid: 'T4' });
  ok('a file already in B\'s folder is not re-copied', r.copied === 0 && bucket.copies.length === 0);
}

// ── a source file A deleted between send and accept ───────────────────────
{
  const snap = { images: [
    { url: url('users/A/items/i1/0.jpg'), source: 'camera' },
    { url: url('users/A/items/i1/1.jpg'), source: 'camera' },
  ] };
  const gone = 'users/A/items/i1/1.jpg';
  const bucket = fakeBucket({ missing: [gone] });
  const r = await copyEntryImages({ bucket, snapItem: snap, toUid: 'B', bItemId: 'xfer_T5', tid: 'T5' });
  ok('a deleted source does not fail the whole transfer',
    r.copied === 1 && r.missing.length === 1 && r.missing[0] === gone);
  ok('the surviving photo is still copied and rewritten',
    snap.images[0].url.indexOf('users%2FB%2F') !== -1);
  ok('the missing one is left pointing where it pointed',
    snap.images[1].url.indexOf('users%2FA%2F') !== -1);
}

// ── a real failure must still abort pre-commit ────────────────────────────
{
  const snap = { images: [{ url: url('users/A/items/i1/0.jpg'), source: 'camera' }] };
  const bucket = {
    file() { return { async copy() { throw new Error('permission denied'); }, __path: 'x' }; },
  };
  let threw = false;
  try {
    await copyEntryImages({ bucket, snapItem: snap, toUid: 'B', bItemId: 'xfer_T6', tid: 'T6' });
  } catch (e) { threw = /permission denied/.test(e.message); }
  ok('a non-404 copy failure throws, leaving the transfer pending', threw);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
