/* slab-detect.js — client-side slab (graded-comic) detection
 *
 * S15 May 29. Detects whether a captured front-cover image shows a comic in a
 * third-party grading case (CGC / PSA / CBCS) by scanning the top region for a
 * saturated color band (the label) and classifying its hue.
 *
 * CALIBRATION (against Matt's reference images):
 *   - Handheld CGC phone shots (the real input distribution): 10/10 detection,
 *     10/10 color classification.
 *   - Flat reference scans (CGC/PSA/CBCS): 10/10 detection, 7/10 color — the
 *     3 misses are CBCS/PSA edge cases (the stated ~5% tail). CGC is perfect.
 *
 * The feature uses DETECTION to decide whether to auto-skip interior photos;
 * color only drives the "Graded by ___" display label. Detection is the
 * reliable signal (20/20 across all test images); color is best-effort.
 *
 * CGC label colors: blue=universal, purple=restored, green=qualified,
 * yellow=signature, gold=pedigree. PSA=red. CBCS=blue or yellow.
 *
 * Pure client-side, no API call. ~80ms on a downsampled 240x336 canvas.
 */
(function (global) {
  'use strict';

  // Downsample target. 240x336 (≈2:3) chosen during calibration: at 160x224
  // thin labels on handheld shots didn't register enough vertical rows and
  // misclassified (e.g. a blue CGC label read as red cover art below it).
  // 240x336 gives thin labels the resolution to register without meaningful
  // cost (~80k px, sub-100ms).
  var W = 240, H = 336;
  var TOP_FRAC = 0.30;   // scan the top 30% — where a slab label sits
  var GAP_TOL = 2;       // tolerate up to 2 weak rows within a band (label
                         // white-text gaps) before the band breaks
  var MIN_ROWS = 4;      // a band needs >=4 downsampled rows to count
  var SAT_MIN = 0.40;    // per-pixel saturation floor to be "label color"
  var VAL_MIN = 0.20;    // per-pixel value floor (ignore near-black)
  var ROW_FRAC = 0.35;   // fraction of a row that must be one label color

  var CGC_FAMILY = { blue: 1, purple: 1, green: 1, 'yellow/gold': 1 };

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d !== 0) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h: h, s: mx === 0 ? 0 : d / mx, v: mx };
  }

  function classify(h) {
    if (h >= 195 && h <= 250) return 'blue';        // CGC universal / CBCS blue
    if (h > 250 && h <= 295) return 'purple';        // CGC restored
    if (h >= 85 && h <= 185) return 'green';         // CGC qualified
    if (h >= 40 && h <= 75) return 'yellow/gold';    // CGC signature / gold / CBCS yellow
    if (h >= 345 || h <= 15) return 'red';           // PSA
    return null;
  }

  // Map a classified band color to a grading company for display. CBCS shares
  // blue/yellow with CGC, so we can't distinguish CBCS from CGC by color alone
  // — default the ambiguous colors to CGC (95% of real cases) and only call
  // PSA on red. The label text is what truly disambiguates; the assessment
  // prompt reads that. This is just the quick visual guess.
  function companyForColor(color) {
    if (color === 'red') return 'PSA';
    if (color) return 'CGC';   // blue/purple/green/yellow → overwhelmingly CGC
    return null;
  }

  /**
   * analyze(source) → { detected, classification, company, bandStartY, bandRows }
   * source: an HTMLImageElement, HTMLCanvasElement, or ImageBitmap that can be
   * drawn to a canvas.
   */
  function analyze(source) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, W, H);
    var data = ctx.getImageData(0, 0, W, H).data;

    var topRows = Math.floor(H * TOP_FRAC);
    var x0 = Math.floor(W * 0.15), x1 = Math.floor(W * 0.85);
    var rows = [];
    for (var y = 0; y < topRows; y++) {
      var buckets = {}, labelPix = 0, tot = 0;
      for (var x = x0; x < x1; x++) {
        var i = (y * W + x) * 4;
        var hsv = rgb2hsv(data[i], data[i + 1], data[i + 2]);
        tot++;
        if (hsv.s > SAT_MIN && hsv.v > VAL_MIN) {
          var cls = classify(hsv.h);
          if (cls) { labelPix++; buckets[cls] = (buckets[cls] || 0) + 1; }
        }
      }
      var dom = null, dc = 0;
      for (var k in buckets) { if (buckets[k] > dc) { dc = buckets[k]; dom = k; } }
      rows.push({ frac: tot ? labelPix / tot : 0, dom: dom, y: y });
    }

    // Collect all qualifying bands (each anchored to a color, tolerating gaps).
    var bands = [], idx = 0;
    while (idx < rows.length) {
      var r = rows[idx];
      if (r.frac >= ROW_FRAC && r.dom) {
        var anchor = r.dom, run = 1, gaps = 0, j = idx + 1;
        while (j < rows.length) {
          var rj = rows[j];
          if (rj.frac >= ROW_FRAC && rj.dom === anchor) { run++; gaps = 0; j++; }
          else if (rj.frac >= ROW_FRAC && rj.dom && rj.dom !== anchor) break;
          else { gaps++; if (gaps > GAP_TOL) break; j++; }
        }
        if (run >= 2) bands.push({ y: r.y, run: run, color: anchor });
        idx = j;
      } else idx++;
    }

    if (!bands.length) {
      return { detected: false, classification: null, company: null, bandStartY: -1, bandRows: 0 };
    }

    // Prefer the topmost CGC-family band (blue/purple/green/yellow) — these are
    // almost always the real label. Red at the very top is usually cover art on
    // a red-heavy book, so only fall back to red when no CGC-family band exists
    // (preserves PSA-red detection without false-reading red artwork). Reflects
    // the 95%-CGC reality.
    var strong = bands.filter(function (b) { return b.run >= MIN_ROWS; });
    var pool = strong.length ? strong : bands;
    var cgcBands = pool.filter(function (b) { return CGC_FAMILY[b.color]; });
    var chosen;
    if (cgcBands.length) {
      chosen = cgcBands.reduce(function (a, b) { return b.y < a.y ? b : a; });
      return {
        detected: true, classification: chosen.color,
        company: companyForColor(chosen.color),
        bandStartY: chosen.y, bandRows: chosen.run
      };
    }
    chosen = pool.reduce(function (a, b) { return b.y < a.y ? b : a; });
    return {
      detected: chosen.run >= MIN_ROWS, classification: chosen.color,
      company: companyForColor(chosen.color),
      bandStartY: chosen.y, bandRows: chosen.run
    };
  }

  global.SlabDetect = { analyze: analyze };
})(typeof window !== 'undefined' ? window : this);
