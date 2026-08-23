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

  // ---- Shared score-box renderer (identical look on every surface) ----------
  // Structural anti-clip layout: stars pinned top-center; the number is
  // flex-centered so it is ALWAYS dead-center regardless of PM width; PM and the
  // footer (version / "RG") are stacked at the bottom, so PM can never touch the
  // stars or the number. One uniform-size decimal — no fragile superscript.
  // opts: {grade, pmLabel, stars(0-3), restoStar, footer('version'|'RG'|''),
  //   footerText, size, numColor, starColor, footerColor, pmColor, bg, border}
  var _STAR_PATH = "M12,2 15.64,6.98 21.51,8.91 17.9,13.92 17.88,20.09 12,18.2 6.12,20.09 6.1,13.92 2.49,8.91 8.36,6.98Z";
  function _starRow(n, px, color, resto, restoColor) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" style="display:inline-block"><path d="' + _STAR_PATH + '" fill="' + color + '"/></svg>';
    if (resto) s += '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" style="display:inline-block"><path d="' + _STAR_PATH + '" fill="' + (restoColor || "#b58be0") + '"/></svg>';
    return s ? '<span style="display:inline-flex;gap:1px;align-items:center;line-height:1">' + s + '</span>' : "";
  }
  function scoreBox(o) {
    o = o || {};
    var size = o.size || 104;
    var numColor = o.numColor || "#b8d820";
    var starColor = o.starColor || numColor;
    var footerColor = o.footerColor || numColor;
    var pmColor = o.pmColor || footerColor;
    var bg = o.bg || "#0f1a05";
    var border = o.border || ("1.5px solid " + (o.borderColor || "#3a5010"));
    var stars = o.stars || 0;
    var starPx = o.starPx || Math.max(8, Math.round(size * 0.11));
    var numSize = o.numSize || Math.round(size * 0.66);
    var _nudge = Math.round(numSize * 0.09);
    var p = gradeParts(o.grade);
    // Number: ABSOLUTELY centered in the full box so PM/stars/footer never shift
    // it off-center. font-stretch 62.5% uses Noto Sans Display's real condensed
    // width axis (narrow glyphs, prints correctly) so decimals like 5.5 stay tight.
    var _numInner = p.frac ? (p.whole + '<span style="font-size:0.5em">.</span>' + p.frac.slice(1)) : p.whole;
    var numHtml = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">'
      + '<span style="font-family:\'League Spartan\',system-ui,sans-serif;font-weight:900;transform:scaleX(0.66) translateY(' + _nudge + 'px);transform-origin:center;display:inline-block;color:' + numColor + ';line-height:1;font-size:' + numSize + 'px">' + _numInner + '</span></div>';
    // Stars: top-center.
    var starsHtml = (stars > 0 || o.restoStar) ? '<div style="position:absolute;top:' + Math.round(size*0.05) + 'px;left:0;right:0;display:flex;justify-content:center;pointer-events:none">' + _starRow(stars, starPx, starColor, o.restoStar, o.restoColor) + '</div>' : "";
    // PM: UPPER-RIGHT (never below the score).
    var pmHtml = "";
    if (o.pmLabel) {
      var _pmM = String(o.pmLabel).match(/^([^0-9.]*)(.*)$/);
      var _pmSym = _pmM ? _pmM[1] : '';
      var _pmNum = _pmM ? _pmM[2] : String(o.pmLabel);
      var _pmSize = Math.max(11, Math.round(size * 0.17));
      var _pmTop = Math.round(size * 0.5 + _nudge - numSize * 0.365 - _pmSize * 0.5);
      pmHtml = '<div style="position:absolute;top:' + _pmTop + 'px;right:' + Math.round(size*0.07) + 'px;line-height:1;white-space:nowrap;pointer-events:none;color:' + pmColor + ';font-weight:700">'
        + '<span style="font-family:\'Saira\',system-ui,sans-serif;font-size:' + _pmSize + 'px">' + _pmSym + '</span>'
        + '<span style="font-family:\'Saira Extra Condensed\',system-ui,sans-serif;font-size:' + _pmSize + 'px">' + _pmNum + '</span></div>';
    }
    // Footer (version / RG): bottom-center.
    var footHtml = "";
    if (o.footer === "RG") footHtml = '<div style="position:absolute;bottom:' + Math.round(size*0.05) + 'px;left:0;right:0;text-align:center;font-size:' + Math.max(8, Math.round(size*0.086)) + 'px;font-weight:700;color:' + footerColor + ';opacity:0.85;letter-spacing:1px;line-height:1;pointer-events:none">RG</div>';
    else if (o.footer === "version" && o.footerText) footHtml = '<div style="position:absolute;bottom:' + Math.round(size*0.05) + 'px;left:0;right:0;text-align:center;font-size:' + Math.max(7, Math.round(size*0.077)) + 'px;font-weight:700;color:' + footerColor + ';opacity:0.8;letter-spacing:0.8px;line-height:1;pointer-events:none">' + o.footerText + '</div>';
    return '<div style="position:relative;width:' + size + 'px;height:' + size + 'px;background:' + bg + ';border:' + border + ';border-radius:' + Math.round(size*0.14) + 'px;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.4)">' + numHtml + starsHtml + pmHtml + footHtml + '</div>';
  }

  // ---- CARD scoring (v3) ----------------------------------------------------
  // Card axes: Surface 0-5, Corners 0-2, Edges 0-2, Centering 0-1. Cards have no
  // "Full" (no interior/spine to open), so a Deep (raking-light, all angles) is
  // the deepest pass and CAN confirm a 10. Caps: Main 9.0, Deep 10; slab <= 9.5.
  var DEPTH_CAP_CARD = { main: 9.5, deep: 10.0 };  // cards have no interior surfaces — confident to 9.5 on the first pass
  function shaveToCapCard(sub, cap) {
    var s = { surface: sub.surface, corners: sub.corners, edges: sub.edges, centering: sub.centering };
    var order = ["surface", "corners", "edges"];  // centering never shaved (mirrors interior)
    var i = 0, guard = 0;
    function total() { return s.surface + s.corners + s.edges + s.centering; }
    while (total() > cap + 1e-9 && guard < 200) {
      var k = order[i % order.length];
      if (s[k] >= 0.5) s[k] = roundHalf(s[k] - 0.5);
      i++; guard++;
      if (s.surface <= 0 && s.corners <= 0 && s.edges <= 0) break;
    }
    return s;
  }
  function computeCardV3(input) {
    input = input || {};
    var depth = (input.depth || "main").toLowerCase();
    var slabbed = !!input.slabbed;
    var raw = {
      surface: clamp(roundHalf((input.surface50 || 0) / 10), 0, 5),
      corners: clamp(roundHalf((input.corners20 || 0) / 10), 0, 2),
      edges: clamp(roundHalf((input.edges20 || 0) / 10), 0, 2),
      centering: clamp(roundHalf((input.centering10 || 0) / 10), 0, 1)
    };
    var uncapped = raw.surface + raw.corners + raw.edges + raw.centering;
    var cap = DEPTH_CAP_CARD[depth] != null ? DEPTH_CAP_CARD[depth] : 9.0;
    if (slabbed) cap = Math.min(cap, 9.5);
    var sub = (uncapped > cap + 1e-9) ? shaveToCapCard(raw, cap) : raw;
    var grade = sub.surface + sub.corners + sub.edges + sub.centering;
    var ceilingHit = uncapped > cap + 1e-9;
    var upsell = (depth === "main" && ceilingHit && !slabbed) ? "deep" : null;   // cards: Main -> Deep only
    var pm = computePM({ depth: depth, slabbed: slabbed, photograder: input.photograder });  // reuse comic PM table
    return { grade: grade, uncappedGrade: uncapped, subscores: sub, rawSubscores: raw, pm: pm, pmLabel: formatPM(pm), ceilingHit: ceilingHit, upsell: upsell, kind: "card" };
  }
  function forCard(card) {
    if (!card) return null;
    var cd = (card.cardData && card.cardData.robograde) || (card.roboGrade && card.roboGrade.subscores);
    if (!cd) return null;
    var g = function (k) { return cd[k] && cd[k].total; };
    var surf = g("surface"), corn = g("corners"), edg = g("edges"), cent = g("centering");
    if (surf == null && corn == null && edg == null && cent == null) return null;
    var depth = (card.fullAssessmentRan || card.deepAssessmentRan || card.highGradeTier) ? "deep" : "main";
    return computeCardV3({
      surface50: surf, corners20: corn, edges20: edg, centering10: cent,
      depth: depth, slabbed: !!(card.officialPSAGrade || card.officialCGCGrade || card.labelDetected),
      photograder: card.photograder || (card.roboGrade && card.roboGrade.photograder) || null
    });
  }

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

  var api = { compute: computeRoboScoreV3, forComic: forComic, computeCard: computeCardV3, forCard: forCard, depthOf: depthOf, computePM: computePM, formatPM: formatPM,
              formatGrade: formatGrade, gradeParts: gradeParts, scoreBox: scoreBox,
              interiorTier: interiorTier, interiorBase: interiorBase, roundHalf: roundHalf,
              shaveToCap: shaveToCap, DEPTH_CAP: DEPTH_CAP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RoboScoreV3 = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
