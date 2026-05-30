/* slab-detect.js — client-side slab (graded-comic) detection
 *
 * S16 rewrite (May 30, 2026). APPROACH CHANGE: aspect ratio, not color bands.
 *
 * The prior color-band detector false-positived on raw books whose top cover
 * art is a saturated horizontal band (it read cover art as a label). The
 * reliable signal is GEOMETRY: a slab is a rigid case that is taller relative
 * to its width than a bare comic, because the grading label adds a header band
 * on top of the cover. Measured (OpenCV oracle, then validated against this
 * exact JS geometry, 0.003% max diff):
 *   - Handheld CGC slabs (n=10): aspect 1.51 – 1.68
 *   - Raw comics: ~1.49 mathematically; uncropped phone frames measure ~1.43–1.46
 * So: aspect >= SLAB_MIN -> slab; <= RAW_MAX -> raw; in between -> use the
 * secondary label cue (saturated header band + bright grade plaque upper-left).
 *
 * PIPELINE: downsample -> grayscale -> Otsu threshold -> largest connected
 * component (best rectangularity across both polarities) -> convex hull ->
 * min-area rectangle (rotating calipers) -> aspect = long/short.
 *
 * STATUS: Pass 2a (RECORD ONLY). analyze() returns the would-be decision plus
 * the raw aspect and signals; the call site logs it and stores _slabDetect but
 * does NOT yet skip interior slots or change scoring. Once the logged aspects
 * confirm the raw/slab threshold on real device captures (both classes), flip
 * on Pass 2b auto-skip and lock SLAB_MIN / RAW_MAX from that data.
 *
 * Return shape is unchanged from the prior detector for drop-in compatibility:
 *   { detected, classification, company, bandStartY, bandRows }
 * plus new diagnostic fields: { aspect, fill, frameFrac, signal, ambiguous }.
 *
 * Pure client-side, no API call.
 */
(function (global) {
  'use strict';

  // ── Tunables ───────────────────────────────────────────────────────────────
  var MAXDIM = 320;        // downsample longest side to this (speed vs accuracy)
  var SLAB_MIN = 1.51;     // aspect >= this -> slab (confirmed on 10 CGC slabs)
  var RAW_MAX  = 1.46;     // aspect <= this -> raw (firm up from device logs)
  var MIN_FRAC = 0.05;     // blob must be >=5% of frame
  var MAX_FRAC = 0.985;    // and not essentially the whole frame
  // Secondary (ambiguous-zone) label cues:
  var TOP_FRAC = 0.16;     // header band lives in the top ~16% of a slab
  var BAND_SAT = 0.32;     // mean top-band saturation to count as a colored header
  var UL_BRIGHT = 0.30;    // fraction of upper-left that is bright (grade plaque)

  // ── Color helpers (company label only — best-effort) ────────────────────────
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
    if (h >= 195 && h <= 250) return 'blue';      // CGC universal / CBCS blue
    if (h > 250 && h <= 295) return 'purple';      // CGC restored
    if (h >= 85 && h <= 185) return 'green';       // CGC qualified
    if (h >= 40 && h <= 75) return 'yellow/gold';  // CGC signature / gold
    if (h >= 345 || h <= 15) return 'red';         // PSA
    return null;
  }
  function companyForColor(color) {
    if (color === 'red') return 'PSA';
    if (color) return 'CGC';                        // blue/purple/green/yellow → CGC
    return null;
  }

  // ── Geometry: convex hull (monotone chain) + min-area rect (rotating calipers)
  // Validated against cv2.minAreaRect to 0.003% on the slab set.
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], i;
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    var upper = [], k;
    for (k = pts.length - 1; k >= 0; k--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[k]) <= 0) upper.pop();
      upper.push(pts[k]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  function minAreaRect(points) {
    var hull = convexHull(points);
    if (hull.length < 3) {
      var xs = points.map(function (p) { return p[0]; }), ys = points.map(function (p) { return p[1]; });
      return { w: Math.max.apply(null, xs) - Math.min.apply(null, xs), h: Math.max.apply(null, ys) - Math.min.apply(null, ys) };
    }
    var best = null;
    for (var i = 0; i < hull.length; i++) {
      var p1 = hull[i], p2 = hull[(i + 1) % hull.length];
      var ex = p2[0] - p1[0], ey = p2[1] - p1[1], len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      var ux = ex / len, uy = ey / len;
      var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var j = 0; j < hull.length; j++) {
        var u = hull[j][0] * ux + hull[j][1] * uy;
        var v = -hull[j][0] * uy + hull[j][1] * ux;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      var w = maxU - minU, h = maxV - minV, area = w * h;
      if (best === null || area < best.area) best = { area: area, w: w, h: h };
    }
    return best;
  }

  // ── Otsu threshold over a grayscale histogram ───────────────────────────────
  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, maxVar = 0, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (wB === 0) continue;
      var wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; thr = i; }
    }
    return thr;
  }

  // ── Largest connected component (iterative flood fill, 4-connectivity) ───────
  // Returns the pixel coordinates of the largest blob in the binary mask `fg`
  // (Uint8Array, 1 = foreground). Uses a stack; no recursion.
  function largestBlob(fg, w, h) {
    var seen = new Uint8Array(w * h);
    var best = null, bestN = 0;
    var stack = new Int32Array(w * h);
    for (var s = 0; s < w * h; s++) {
      if (!fg[s] || seen[s]) continue;
      var sp = 0; stack[sp++] = s; seen[s] = 1;
      var pix = []; // collect coords
      while (sp > 0) {
        var idx = stack[--sp];
        var x = idx % w, y = (idx - x) / w;
        pix.push([x, y]);
        if (x + 1 < w) { var r = idx + 1; if (fg[r] && !seen[r]) { seen[r] = 1; stack[sp++] = r; } }
        if (x - 1 >= 0) { var l = idx - 1; if (fg[l] && !seen[l]) { seen[l] = 1; stack[sp++] = l; } }
        if (y + 1 < h) { var d = idx + w; if (fg[d] && !seen[d]) { seen[d] = 1; stack[sp++] = d; } }
        if (y - 1 >= 0) { var u = idx - w; if (fg[u] && !seen[u]) { seen[u] = 1; stack[sp++] = u; } }
      }
      if (pix.length > bestN) { bestN = pix.length; best = pix; }
    }
    return best;
  }

  function evalPolarity(gray, w, h, thr, invert) {
    var fg = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) fg[i] = (invert ? gray[i] < thr : gray[i] >= thr) ? 1 : 0;
    var blob = largestBlob(fg, w, h);
    if (!blob) return null;
    var frac = blob.length / (w * h);
    if (frac < MIN_FRAC || frac > MAX_FRAC) return null;
    var rect = minAreaRect(blob);
    if (!rect || rect.w < 4 || rect.h < 4) return null;
    var L = Math.max(rect.w, rect.h), S = Math.min(rect.w, rect.h);
    var aspect = S > 0 ? L / S : 0;
    var fill = blob.length / (rect.w * rect.h);   // rectangularity
    return { aspect: aspect, fill: fill, frac: frac };
  }

  // ── Secondary label cues for the ambiguous zone ─────────────────────────────
  function labelCue(data, w, h) {
    var topRows = Math.max(1, Math.floor(h * TOP_FRAC));
    var x0 = Math.floor(w * 0.12), x1 = Math.floor(w * 0.88);
    var satSum = 0, n = 0, band = {};
    for (var y = 0; y < topRows; y++) {
      for (var x = x0; x < x1; x++) {
        var p = (y * w + x) * 4;
        var hsv = rgb2hsv(data[p], data[p + 1], data[p + 2]);
        satSum += hsv.s; n++;
        if (hsv.s > 0.40 && hsv.v > 0.20) { var c = classify(hsv.h); if (c) band[c] = (band[c] || 0) + 1; }
      }
    }
    var meanSat = n ? satSum / n : 0;
    // upper-left bright plaque (large grade number sits on a white block)
    var ulW = Math.floor(w * 0.28), ulH = Math.floor(h * 0.20), bright = 0, m = 0;
    for (var yy = 0; yy < ulH; yy++) {
      for (var xx = 0; xx < ulW; xx++) {
        var q = (yy * w + xx) * 4;
        var lum = 0.299 * data[q] + 0.587 * data[q + 1] + 0.114 * data[q + 2];
        if (lum > 180) bright++; m++;
      }
    }
    var ulBright = m ? bright / m : 0;
    var dom = null, dc = 0;
    for (var k in band) if (band[k] > dc) { dc = band[k]; dom = k; }
    var hasBand = meanSat >= BAND_SAT && dom != null;
    return { meanSat: meanSat, ulBright: ulBright, dom: dom, present: hasBand || ulBright >= UL_BRIGHT };
  }

  /**
   * analyze(source) → record-only result.
   * source: HTMLImageElement / HTMLCanvasElement / ImageBitmap.
   */
  function analyze(source) {
    var sw = source.naturalWidth || source.width;
    var sh = source.naturalHeight || source.height;
    if (!sw || !sh) return { detected: false, classification: null, company: null, bandStartY: -1, bandRows: 0, aspect: 0, signal: 'no-image' };
    var scale = MAXDIM / Math.max(sw, sh);
    var w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;

    // grayscale + histogram
    var gray = new Uint8Array(w * h), hist = new Float64Array(256);
    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      var g = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
      gray[i] = g; hist[g]++;
    }
    var thr = otsu(hist, w * h);

    // best of both polarities by rectangularity
    var a = evalPolarity(gray, w, h, thr, true);
    var b = evalPolarity(gray, w, h, thr, false);
    var m = (!a && !b) ? null : (!a ? b : (!b ? a : (a.fill >= b.fill ? a : b)));

    var cue = labelCue(data, w, h);
    var company = cue.dom ? companyForColor(cue.dom) : null;

    if (!m) {
      return { detected: false, classification: cue.dom, company: company, bandStartY: -1, bandRows: 0, aspect: 0, fill: 0, frameFrac: 0, signal: 'no-blob', ambiguous: false };
    }

    var aspect = m.aspect, detected, signal, ambiguous = false;
    if (aspect >= SLAB_MIN) { detected = true; signal = 'aspect'; }
    else if (aspect <= RAW_MAX) { detected = false; signal = 'aspect'; }
    else { ambiguous = true; detected = cue.present; signal = cue.present ? 'aspect+label' : 'aspect-ambiguous-no-label'; }

    // company defaults to CGC when we called it a slab but saw no usable band color
    if (detected && !company) company = 'CGC';

    return {
      detected: detected,
      classification: cue.dom,
      company: company,
      bandStartY: -1,            // retained for return-shape compatibility
      bandRows: 0,
      aspect: Math.round(aspect * 1000) / 1000,
      fill: Math.round(m.fill * 100) / 100,
      frameFrac: Math.round(m.frac * 100) / 100,
      labelMeanSat: Math.round(cue.meanSat * 100) / 100,
      ulBright: Math.round(cue.ulBright * 100) / 100,
      signal: signal,
      ambiguous: ambiguous
    };
  }

  // Export geometry for headless testing (node) without touching the DOM path.
  var api = { analyze: analyze, _geom: { convexHull: convexHull, minAreaRect: minAreaRect } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SlabDetect = api;
})(typeof window !== 'undefined' ? window : this);
