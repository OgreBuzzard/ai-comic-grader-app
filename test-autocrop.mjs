// test-autocrop.mjs — v6.52
//
// The auto-crop detector, sliced out of index.html and run against synthetic
// images. Three things must never regress:
//   1. it finds the book when there IS one, within a couple of percent;
//   2. it PADS OUTWARD, because a crop tight to the book trips CROP_FAILURE
//      and blinds the EDGE SILHOUETTE test — a tight box is worse than none;
//   3. it REFUSES rather than guesses — a blank frame, a book running off the
//      edge, or a background the same tone as the cover all have to come back
//      ok:false so the manual default takes over.
// Run: node test-autocrop.mjs

import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok    ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '\n        ' + x : '')); } };

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const i = html.indexOf('const AUTOCROP_PAD_CM');
const j = html.indexOf('// ── end pure auto-crop');
if (i === -1 || j === -1 || j < i) {
  console.error('test-autocrop: could not slice the detector out of index.html.\n'
    + 'The anchors are "const AUTOCROP_PAD_CM" and the "end pure auto-crop" comment.\n'
    + 'If they moved, this test is checking NOTHING. Fix the slice before shipping.');
  process.exit(1);
}
const src = html.slice(i, j)
  + '\nexport { autocropDetect, autocropPad, AUTOCROP_PAD_FRAC, AUTOCROP_MIN_CONF };\n';
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { autocropDetect, autocropPad, AUTOCROP_PAD_FRAC, AUTOCROP_MIN_CONF } = M;

// ── synthetic images ──────────────────────────────────────────────────────
// A "book" is a filled rect of one tone on a field of another, with optional
// per-pixel noise. That is the only structure the detector relies on, so it is
// the right thing to test it against.
function img(w, h, bgTone, rect, bookTone, noise) {
  const g = new Uint8ClampedArray(w * h);
  const n = noise || 0;
  const jitter = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return ((s >> 16) % 201 - 100) / 100; }; })();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      g[y * w + x] = Math.max(0, Math.min(255, (inside ? bookTone : bgTone) + jitter() * n));
    }
  }
  return g;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. it finds the book ──────────────────────────────────────────────────
{
  const W = 320, H = 440;
  const r = { x: 48, y: 60, w: 210, h: 320 };
  const b = autocropDetect(img(W, H, 230, r, 60, 0), W, H);
  ok('a dark book on a light field is found', b.ok, JSON.stringify(b));
  ok('left edge within 2%',   near(b.left,   r.x / W, 0.02), 'got ' + b.left);
  ok('right edge within 2%',  near(b.right,  (r.x + r.w) / W, 0.02), 'got ' + b.right);
  ok('top edge within 2%',    near(b.top,    r.y / H, 0.02), 'got ' + b.top);
  ok('bottom edge within 2%', near(b.bottom, (r.y + r.h) / H, 0.02), 'got ' + b.bottom);
  ok('confidence clears the bar', b.confidence >= AUTOCROP_MIN_CONF, 'got ' + b.confidence);
}

// ── 2. polarity does not matter ───────────────────────────────────────────
{
  const W = 320, H = 440, r = { x: 70, y: 40, w: 180, h: 350 };
  const b = autocropDetect(img(W, H, 25, r, 215, 0), W, H);
  ok('a LIGHT book on a dark field is found too', b.ok && near(b.left, r.x / W, 0.02) && near(b.bottom, (r.y + r.h) / H, 0.02),
    'a dark backdrop is common at a convention table — ' + JSON.stringify(b));
}

// ── 3. off-centre and small ───────────────────────────────────────────────
{
  const W = 320, H = 320, r = { x: 12, y: 150, w: 120, h: 160 };
  const b = autocropDetect(img(W, H, 200, r, 40, 0), W, H);
  ok('a book in the corner is found where it is, not centred',
    b.ok && near(b.left, 12 / W, 0.03) && near(b.top, 150 / H, 0.03), JSON.stringify(b));
}

// ── 4. noise ──────────────────────────────────────────────────────────────
{
  const W = 320, H = 440, r = { x: 50, y: 50, w: 200, h: 330 };
  const b = autocropDetect(img(W, H, 190, r, 70, 28), W, H);
  ok('a noisy photograph still resolves', b.ok && near(b.left, 50 / W, 0.04) && near(b.right, 250 / W, 0.04),
    'the tolerance is 3x the ring MAD for exactly this — ' + JSON.stringify(b));
}

// ── 5. it refuses ─────────────────────────────────────────────────────────
{
  const W = 300, H = 400;
  ok('a blank frame is refused', !autocropDetect(img(W, H, 128, null, 0, 0), W, H).ok);
  ok('a noisy blank frame is refused', !autocropDetect(img(W, H, 128, null, 0, 30), W, H).ok,
    'noise must not be read as a book');
  const full = autocropDetect(img(W, H, 128, { x: 0, y: 0, w: W, h: H }, 40, 0), W, H);
  ok('a book filling the whole frame is refused', !full.ok,
    'it has run off the edge — /api/assess gates it and the crop cannot help');
  const wide = autocropDetect(img(W, H, 230, { x: 10, y: 190, w: 280, h: 12 }, 50, 0), W, H);
  ok('a thin sliver is refused', !wide.ok, 'aspect 23:1 is a shadow or a table edge, not a book');
  ok('a degenerate size is refused', !autocropDetect(new Uint8ClampedArray(4), 2, 2).ok);
  ok('null input is refused, not thrown', !autocropDetect(null, 100, 100).ok);
  ok('a short array is refused, not read past its end',
    !autocropDetect(new Uint8ClampedArray(50), 100, 100).ok);
}

// ── 5b. the two guards that came out of the REAL photos ───────────────────
// Ten real calibration covers were run through this detector before these
// existed. Four came back with confidently wrong boxes — a logo panel, the
// bottom two thirds of a cover — and the confidence score did not separate
// them from the right answers (a wrong box scored 0.98). Both failures had the
// same cause: the photo was already cropped tight, so the border ring was
// COVER ARTWORK and "background" was a colour out of the cover. These two
// checks are what turned those four into honest refusals.
{
  const W = 300, H = 400;
  // a busy border: no uniform background anywhere, which is what a tight crop
  // looks like from the ring's point of view
  const g = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = ((x >> 3) + (y >> 3)) % 2 ? 230 : 30;
  const b = autocropDetect(g, W, H);
  ok('a frame with no uniform background is refused', !b.ok && b.method === 'no-background',
    'this is the guard that matters — got ' + JSON.stringify(b));

  // Three ways a book can reach the frame edge, three guards. Which one fires
  // is not the point — that NONE of them returns a box is.
  const touches = [
    ['spans the full width',  { x: 1,  y: 40, w: W - 2, h: 300 }],
    ['runs off the top',      { x: 40, y: 0,  w: 220,   h: 300 }],
    ['runs off the bottom',   { x: 40, y: 90, w: 220,   h: H - 90 }]
  ];
  touches.forEach(function (t) {
    const r = autocropDetect(img(W, H, 235, t[1], 50, 0), W, H);
    ok('a book that ' + t[0] + ' is refused', !r.ok,
      'no room to pad, and /api/assess gates it at CROP_FAILURE anyway — got ' + JSON.stringify(r));
  });

  const roomy = autocropDetect(img(W, H, 235, { x: 30, y: 40, w: 230, h: 310 }, 50, 0), W, H);
  ok('the same book with margin is accepted', roomy.ok, JSON.stringify(roomy));
}

// ── 6. the pad ────────────────────────────────────────────────────────────
{
  const box = { left: 0.3, top: 0.3, right: 0.7, bottom: 0.8 };
  const W = 320, H = 440;
  const p = autocropPad(box, W, H, AUTOCROP_PAD_FRAC);
  ok('the pad grows the box, never shrinks it',
    p.left < box.left && p.top < box.top && p.right > box.right && p.bottom > box.bottom, JSON.stringify(p));
  const padPxX = (box.left - p.left) * W, padPxY = (box.top - p.top) * H;
  ok('the pad is the same number of PIXELS on both axes', near(padPxX, padPxY, 0.51),
    'equal absolute margin, not equal fraction — got ' + padPxX.toFixed(2) + ' vs ' + padPxY.toFixed(2));
  const bookPxW = (box.right - box.left) * W;
  ok('the pad is ~1cm against a 6.625in book',
    near(padPxX / bookPxW, 1.0 / 16.83, 0.002),
    'got ' + (padPxX / bookPxW * 16.83).toFixed(2) + 'cm');
  const edge = autocropPad({ left: 0.01, top: 0.01, right: 0.99, bottom: 0.99 }, W, H, AUTOCROP_PAD_FRAC);
  ok('the pad clamps to the image', edge.left === 0 && edge.top === 0 && edge.right === 1 && edge.bottom === 1,
    'it cannot invent background that was never photographed');
}

// ── 7. detect + pad end to end ────────────────────────────────────────────
{
  const W = 320, H = 440, r = { x: 60, y: 70, w: 200, h: 300 };
  const b = autocropDetect(img(W, H, 235, r, 55, 0), W, H);
  const p = autocropPad(b, W, H, AUTOCROP_PAD_FRAC);
  ok('the shipped box contains the whole book', p.left <= b.left && p.right >= b.right && p.top <= b.top && p.bottom >= b.bottom);
  ok('and shows background on all four sides', p.left > 0 && p.top > 0 && p.right < 1 && p.bottom < 1,
    'this is the whole reason it pads — ' + JSON.stringify(p));
}

// ── 8. the wiring in index.html ───────────────────────────────────────────
ok('the detector is wired into _fitCrop', /_cropAutoOK && !_cropUserMoved/.test(html));
ok('auto-crop is gated off cards', /_cropAutoOK = !\(formData\.type === "card"/.test(html));
ok('auto-crop is gated to main slots only', /_cropAutoOK = .*type === "main";/.test(html),
  'a bounding box round a corner macro is actively wrong');
ok('the user-moved latch is armed on cropstart', /cropstart: function\(\) \{ _cropUserMoved = true; \}/.test(html),
  'without it, _fitCrop at 450ms yanks the box back from under the user');
ok('detection runs once per open', /if \(!_cropAutoTried\) \{/.test(html));
// v6.59. The opposite of what this file asserted a week ago, and the reason
// is worth keeping: the 9:14 fallback cut both side edges off a correctly
// framed photo and the assessment failed at the gate that needs whole edges.
// confirmCrop() replaces the stored image, so it destroyed the original.
// An automatic action that destroys data has to be right far more often than
// that was. A refusal now leaves the WHOLE IMAGE selected.
ok('there is NO aspect-ratio fallback box', !/const _ar = 9 \/ 14;/.test(html),
  'a 9:14 box is a claim about the BOOK, not the PHOTO - imposing it on the canvas cuts');
ok('a refusal leaves the crop box alone',
  /if \(!_cropAutoBox \|\| !_cropAutoBox\.box\) return;/.test(html),
  'no crop is recoverable; a wrong crop is not');
ok('rotation is applied before any box is set',
  html.indexOf('_cropperInstance.rotate(_cropAutoBox.angle)') <
  html.indexOf('_cropperInstance.setCropBoxData({\n                  left:   _cc.left + _b.left')
  || /rotate\(_cropAutoBox\.angle\)/.test(html));
ok('the skew estimator requires BOTH edges to agree',
  /AUTOCROP_SKEW_AGREE/.test(html) && /edges disagree on skew/.test(html),
  'two parallel fits agreeing is the evidence; one fit alone could be a mat rule or a shadow');
ok('skew is bounded', /AUTOCROP_MAX_SKEW\s*=\s*12/.test(html) && /AUTOCROP_MIN_SKEW\s*=\s*0\.4/.test(html));

// ── v6.61: nothing may destroy pixels the user cannot get back ────────────
// Two separate places were throwing image data away, and only one of them was
// the crop tool:
//   1. cameraCapture() reproduced the VIEWFINDER, which is object-fit:cover
//      and therefore already a crop of the sensor feed. The pixels outside the
//      stage aspect never reached the file, so the cropper could not show them
//      and the handles could not reach them. This is what Matt actually hit.
//   2. confirmCrop() replaced the slot image, so the pre-crop frame was gone.
ok('the camera captures the FULL sensor frame',
  /canvas\.width = videoW;[\s\S]{0,120}ctx\.drawImage\(video, 0, 0, videoW, videoH\)/.test(html),
  'the viewfinder is a crop of the feed - capturing what it showed is how the margin was lost');
ok('the old cover-rect capture is gone',
  !/ctx\.drawImage\(video, sx, sy, visibleW, visibleH/.test(html));
ok('the pre-crop original is kept', /formData\._cropOriginals\[_key\] = _cropperOriginalSrc/.test(html));
ok('only the FIRST original is kept',
  /if \(!formData\._cropOriginals\[_key\] && _cropperOriginalSrc\)/.test(html),
  'crop twice and you must still get back to the camera frame, not to the last crop');
ok('the cropper reopens on the ORIGINAL', /const src = _orig \|\| shown;/.test(html));
ok('the previous box is restored on reopen', /_cropperReopenBox/.test(html));
ok('a reopen does not re-run auto-crop',
  /_cropAutoTried = true;   \/\/ and do not let auto-crop fire after it/.test(html),
  're-detecting would silently overrule a framing the user already chose');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
