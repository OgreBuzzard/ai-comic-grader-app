// lib/roboscore_v3.js — Robograder Scoring v3 (half-point 0–10).
// Pure display/quantization transform over the stored 0–100 subscores.
// See claude/SCORING_V3_SPEC.md. Classic-script + CommonJS dual export.
(function (root) {
  "use strict";

  function roundHalf(x) { return Math.round(Number(x) * 2) / 2; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function interiorBase(pageQuality) {
    var pq = String(pageQuality || "").toLowerCase().trim();
    if (!pq) return 0.5;
    if (pq === "white") return 1;
    if (pq === "off-white to white" || pq === "off-white" || pq === "cream to off-white") return 0.5;
    if (pq.indexOf("cream") === 0 || pq.indexOf("tan") !== -1 || pq.indexOf("brittle") !== -1) return 0;
    if (pq.indexOf("off-white") !== -1) return 0.5;
    return 0;
  }
  function interiorTier(pageQuality, interiorDefect) {
    var base = interiorBase(pageQuality);
    if (interiorDefect) base = Math.max(0, base - 0.5);
    return base;
  }

  var DEPTH_CAP = { main: 9.0, deep: 9.5, full: 10.0 };

  // Confidence-hold cap: shave 0.5 at a time, round-robin front -> back -> spine,
  // until the subscores sum to the ceiling. Front is shaved first each cycle, so
  // it is restored LAST (Main holds front+back at 9.0; Deep holds front at 9.5;
  // Full restores all). Interior (page-quality) is never shaved. Subscores always
  // reconcile to the displayed grade.
  function shaveToCap(sub, cap) {
    var s = { front: sub.front, back: sub.back, spine: sub.spine, interior: sub.interior };
    var order = ["front", "back", "spine"];
    var i = 0, guard = 0;
    function total() { return s.front + s.back + s.spine + s.interior; }
    while (total() > cap + 1e-9 && guard < 200) {
      var k = order[i % order.length];
      if (s[k] >= 0.5) s[k] = roundHalf(s[k] - 0.5);
      i++; guard++;
      if (s.front <= 0 && s.back <= 0 && s.spine <= 0) break;
    }
    return s;
  }

  function photoSeverity(pg) {
    if (!pg) return 0;
    var c = 0, b = 0;
    ["focus", "lighting", "cropping", "angle"].forEach(function (k) {
      var v = String(pg[k] || "").toUpperCase();
      if (v === "C") c++; else if (v === "B") b++;
    });
    return c * 2 + b;   // C counts double
  }

  // PM (Precision Modifier). Returns one of 0, 0.5, 1, 1.5, 2.
  function computePM(input) {
    var depth = (input.depth || "main").toLowerCase();
    var slab = !!input.slabbed;
    var sev = photoSeverity(input.photograder);
    var pm;
    if (slab) {
      pm = (depth === "deep") ? (sev <= 1 ? 1.0 : sev === 2 ? 1.5 : 2.0)
                              : (sev <= 1 ? 1.5 : 2.0);          // slabbed main (2 imgs, through plastic)
    } else if (depth === "full") {
      pm = (input.all16Present && sev === 0) ? 0
                                             : (sev <= 1 ? 0.5 : sev === 2 ? 1.0 : 1.5);
    } else if (depth === "deep") {
      pm = (sev <= 1 ? 0.5 : sev === 2 ? 1.0 : 1.5);
    } else { // main (raw, 4 imgs)
      pm = (sev <= 1 ? 1.0 : sev === 2 ? 1.5 : 2.0);
      pm = pm + 0.5 * (input.missingCore || 0);                 // missing spine/interior widens
    }
    return Math.min(2.0, pm);
  }
  function formatPM(pm) { return (!pm || pm <= 0) ? "" : "±" + pm; }   // ±1 not ±1.0; ±0.5 keeps decimal

  function computeRoboScoreV3(input) {
    input = input || {};
    var depth = (input.depth || "main").toLowerCase();
    var slabbed = !!input.slabbed;

    var raw = {
      front: clamp(roundHalf((input.front50 || 0) / 10), 0, 5),
      back: clamp(roundHalf((input.back20 || 0) / 10), 0, 2),
      spine: clamp(roundHalf((input.spine20 || 0) / 10), 0, 2),
      interior: interiorTier(input.pageQuality, !!input.interiorDefect)
    };
    var uncapped = raw.front + raw.back + raw.spine + raw.interior;

    var cap = DEPTH_CAP[depth] != null ? DEPTH_CAP[depth] : 9.0;
    if (slabbed) cap = Math.min(cap, 9.5);   // slab can never reach RG 10 (no Full)

    var sub = (uncapped > cap + 1e-9) ? shaveToCap(raw, cap) : raw;
    var grade = sub.front + sub.back + sub.spine + sub.interior;
    var ceilingHit = uncapped > cap + 1e-9;

    var upsell = null;
    if (depth === "main" && ceilingHit) upsell = "deep";
    else if (depth === "deep" && ceilingHit && !slabbed) upsell = "full";

    var pm = computePM(input);

    return {
      grade: grade,
      uncappedGrade: uncapped,
      subscores: sub,
      rawSubscores: raw,
      pm: pm,
      pmLabel: formatPM(pm),
      ceilingHit: ceilingHit,
      upsell: upsell
    };
  }

  // Display formatting: integers show bare ("9","10"); halves keep one decimal
  // ("9.5","8.5"). Same on EVERY surface (screens + labels) — no ".0".
  function formatGrade(g){ g = Number(g); return (g % 1 === 0) ? String(g) : g.toFixed(1); }
  function gradeParts(g){ g = Number(g); var w = Math.trunc(g); return { whole: String(w), frac: (g % 1 === 0) ? "" : ("." + Math.round((g - w) * 10)) }; }

  // ---- Comic-record adapter (shared by all render surfaces) -----------------
  // Interior PHYSICAL-flaw keywords, distinct from page COLOR (pageQuality
  // already scores color). Presence drops the interior tier one step (§3 step 2).
  var INT_FLAW = /(tear|split|tape|stain|spill|water|damp|mold|mildew|chip|piece|missing|detach|loose page|writing|ink stain|stamp|marker|crayon|glue|residue|hole|punch|clip|rust stain|brittle|crack)/i;

  function depthOf(comic) {
    if (comic && comic.fullAssessmentRan === true) return "full";
    if (comic && (comic.highGradeTier === true || comic.highGradeAssessed === true ||
                  comic._highGradeTier === true || comic.deepAssessmentRan === true)) return "deep";
    return "main";
  }

  // Compute the v3 result straight from a stored COMIC record. Returns null for
  // cards, missing roboGrade, or records with no comic subscores.
  function forComic(comic) {
    if (!comic || comic.type === "card") return null;
    var rg = comic.roboGrade; if (!rg) return null;
    if (rg.frontScore == null && rg.backScore == null && rg.spineScore == null) return null;
    var defects = Array.isArray(rg.defects) ? rg.defects : [];
    var interiorDefect = defects.some(function (d) {
      return String(d && d.category || "").toLowerCase() === "interior" &&
             INT_FLAW.test(String(d && d.type || ""));
    });
    var depth = depthOf(comic);
    return computeRoboScoreV3({
      front50: rg.frontScore, back20: rg.backScore, spine20: rg.spineScore,
      pageQuality: rg.pageQuality || comic.pageQuality,
      interiorDefect: interiorDefect,
      depth: depth,
      slabbed: comic.labelDetected === true,
      photograder: comic.photograder || rg.photograder || null,
      all16Present: depth === "full" && comic.fullInteriorComplete === true,
      missingCore: 0
    });
  }

  var api = { compute: computeRoboScoreV3, forComic: forComic, depthOf: depthOf, computePM: computePM, formatPM: formatPM,
              formatGrade: formatGrade, gradeParts: gradeParts,
              interiorTier: interiorTier, interiorBase: interiorBase, roundHalf: roundHalf,
              shaveToCap: shaveToCap, DEPTH_CAP: DEPTH_CAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RoboScoreV3 = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
