// lib/roboscore_v3.js — Robograder Scoring v3 (half-point 0–10).
// Pure display/quantization transform over the stored 0–100 subscores.
// See claude/SCORING_V3_SPEC.md. Classic-script + CommonJS dual export.
(function (root) {
  "use strict";

  function roundHalf(x) { return Math.round(Number(x) * 2) / 2; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // Page-quality designation -> interior base tier (0 / 0.5 / 1). Only White = 1.
  function interiorBase(pageQuality) {
    var pq = String(pageQuality || "").toLowerCase().trim();
    if (!pq) return 0.5;                        // unknown -> mid (matches "default OW/W")
    if (pq === "white") return 1;
    // mid band
    if (pq === "off-white to white" || pq === "off-white/white" ||
        pq === "off-white" || pq === "cream to off-white" || pq === "cream/off-white") return 0.5;
    // cream, tan, brittle, or anything worse
    if (pq.indexOf("cream") === 0 || pq.indexOf("tan") !== -1 || pq.indexOf("brittle") !== -1) return 0;
    // fallback: any remaining off-white variant -> 0.5, else 0
    if (pq.indexOf("off-white") !== -1) return 0.5;
    return 0;
  }

  function interiorTier(pageQuality, interiorDefect) {
    var base = interiorBase(pageQuality);
    if (interiorDefect) base = Math.max(0, base - 0.5);   // §3 interior-flaw drop
    return base;
  }

  var PM_STEPS = [0.5, 1, 1.5];
  function widenPM(pm) {
    var i = PM_STEPS.indexOf(pm);
    if (i < 0) return 1;
    return PM_STEPS[Math.min(i + 1, PM_STEPS.length - 1)];
  }
  function hasBorC(pg) {
    if (!pg) return false;
    return ["focus", "lighting", "cropping", "angle"].some(function (k) {
      var v = String(pg[k] || "").toUpperCase();
      return v === "B" || v === "C";
    });
  }

  var DEPTH_CAP = { main: 9.0, deep: 9.5, full: 10.0 };

  function computeRoboScoreV3(input) {
    input = input || {};
    var depth = (input.depth || "main").toLowerCase();
    var slabbed = !!input.slabbed;

    var front = clamp(roundHalf((input.front50 || 0) / 10), 0, 5);
    var back = clamp(roundHalf((input.back20 || 0) / 10), 0, 2);
    var spine = clamp(roundHalf((input.spine20 || 0) / 10), 0, 2);
    var interior = interiorTier(input.pageQuality, !!input.interiorDefect);

    var uncapped = front + back + spine + interior;   // 0–10, already 0.5-stepped

    var cap = DEPTH_CAP[depth] != null ? DEPTH_CAP[depth] : 9.0;
    if (slabbed) cap = Math.min(cap, 9.5);            // slab can never reach RG 10 (no Full)
    var grade = Math.min(uncapped, cap);
    var ceilingHit = uncapped > cap + 1e-9;

    var upsell = null;
    if (depth === "main" && ceilingHit) upsell = "deep";
    else if (depth === "deep" && ceilingHit && !slabbed) upsell = "full";

    // Precision Modifier
    var pm = slabbed ? 1.5 : (depth === "main" ? 1 : 0.5);   // deep & full = 0.5
    if (input.missingImages) pm = 1.5;
    else if (hasBorC(input.photograder)) pm = widenPM(pm);

    return {
      grade: grade,
      uncappedGrade: uncapped,
      subscores: { front: front, back: back, spine: spine, interior: interior },
      pm: pm,
      ceilingHit: ceilingHit,
      upsell: upsell   // 'deep' | 'full' | null
    };
  }

  var api = { compute: computeRoboScoreV3, interiorTier: interiorTier, interiorBase: interiorBase, roundHalf: roundHalf, DEPTH_CAP: DEPTH_CAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RoboScoreV3 = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
