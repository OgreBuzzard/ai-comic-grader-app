// ── Shared RoboGrade panel renderer ─────────────────────────────────────────
//
// Renders the dark-olive RoboGrade panel: score box (left), 2x2 sub-grade
// grid (right), provenance row, and tractor-feed printout-paper defect
// breakdown by category.
//
// EDIT THIS FILE ONLY. Used by:
//   - index.html (Detail view)
//   - public.html (public verification page at /id/XXXXXX)
//
// Both pages must stay in sync; the previous arrangement of duplicating this
// HTML between the two surfaces caused inconsistent rendering and double
// maintenance work. If a tweak is needed, change it here and both pages
// pick it up automatically.
//
// Usage:
//   const html = window.RobograderPanel.buildDisplay(rg, comic);
//   container.innerHTML = html;
//
// Inputs:
//   rg    — the comic.roboGrade object: { score, frontScore, backScore,
//           spineScore, interiorScore, defects[], stapleCondition,
//           restorationFlags[], confidenceRange, version }
//   comic — the full comic record (for highGradeUnlocked, roboGradeDate,
//           roboGradeId)
//
// Returns: HTML string. Empty string if rg is null/undefined.

(function () {
  'use strict';

  // ── Time-degraded precision modifier (S14) ─────────────────────────────
  // The grade itself never changes after assessment — it's testimony, a
  // record of what RG saw on a specific date. But the *precision modifier*
  // (the ± range around the score) reflects how well we can know the book's
  // condition today from a photo taken then. That precision degrades with
  // time: paper acidifies, moisture creeps in, UV fades inks, slabs flex.
  // None of this is visible in the original photo, so as years accumulate
  // the photo tells us less about the book in the buyer's hand right now.
  //
  // Curve: piecewise. Anchors hand-tuned to feel right at each milestone.
  // S14 v2 (May 15): slowed the curve. The original anchors hit ±99 from a
  // ±3 starting point at year 216; the slower curve below reaches ±99 from
  // ±3 around year 495 — closer to the "pulp paper eventually turns to
  // dust on the scale of centuries" framing we want. Anchor sequence:
  //   0 yrs → +0, 10 → +1, 19 → +2, 27 → +3, 34 → +4, 40 → +5, 45 → +6.
  // After year 45, +1 every 5 years (was +1 every 2 in v1).
  // Cap at 99 — eventually the photo tells us so little that any score on
  // a 1-100 scale could plausibly apply.
  //
  // The widening is ADDITIVE on top of the original confidence range. A
  // book originally assessed at ±3 that's now 10 years old displays as ±4.
  // Re-assessing resets the clock: the new assessment date becomes "now"
  // and widening starts over from the new (presumably tighter) base.
  const PRECISION_DECAY_ANCHORS = [
    [0,  0],
    [10, 1],
    [19, 2],
    [27, 3],
    [34, 4],
    [40, 5],
    [45, 6],
  ];
  const PRECISION_DECAY_MAX = 99;
  // Step interval for the linear phase after the last anchor.
  // S14 v2: 5 years per +1 (was 2 years per +1).
  const PRECISION_DECAY_STEP_YEARS = 5;

  function precisionWideningForYears(years) {
    if (!Number.isFinite(years) || years <= 0) return 0;
    // Phase 1: piecewise linear through the anchor points.
    for (let i = 0; i < PRECISION_DECAY_ANCHORS.length - 1; i++) {
      const [y0, w0] = PRECISION_DECAY_ANCHORS[i];
      const [y1, w1] = PRECISION_DECAY_ANCHORS[i + 1];
      if (years >= y0 && years <= y1) {
        // Floor rather than round so the widening only ticks up to the
        // next integer when we actually reach the next anchor's year.
        // (A book 4 years old should feel like ±0, not get rounded up.)
        const frac = (years - y0) / (y1 - y0);
        return Math.floor(w0 + frac * (w1 - w0));
      }
    }
    // Phase 2: past the last anchor (year 45), +1 every N years
    // (PRECISION_DECAY_STEP_YEARS).
    const [lastY, lastW] = PRECISION_DECAY_ANCHORS[PRECISION_DECAY_ANCHORS.length - 1];
    const extra = Math.floor((years - lastY) / PRECISION_DECAY_STEP_YEARS);
    return Math.min(PRECISION_DECAY_MAX, lastW + extra);
  }

  // widenPrecisionForAge(originalRange, assessmentDateISO, [nowMs])
  //   originalRange: number from rg.confidenceRange (integer, the ± value
  //                  computed at assessment time).
  //   assessmentDateISO: ISO string from comic.roboGradeDate, or null.
  //   nowMs (optional): test seam; defaults to Date.now().
  //
  // Returns the WIDENED range — original + age-based widening, additive.
  // If assessmentDateISO is missing or unparseable, returns the original
  // unchanged (we don't fabricate a "since when" date; better to under-
  // widen than mislead). Cap at PRECISION_DECAY_MAX even if the original
  // was already huge.
  function widenPrecisionForAge(originalRange, assessmentDateISO, nowMs) {
    const orig = Number.isFinite(originalRange) ? Math.max(0, Math.round(originalRange)) : 0;
    if (!assessmentDateISO) return orig;
    const t = Date.parse(assessmentDateISO);
    if (!Number.isFinite(t)) return orig;
    const now = (nowMs != null) ? nowMs : Date.now();
    // 365.25 day-year average accounts for leap years without precision
    // we can't afford. A few hours one way or the other doesn't matter for
    // a function that increments at year boundaries.
    const years = (now - t) / (365.25 * 24 * 60 * 60 * 1000);
    const widening = precisionWideningForYears(years);
    return Math.min(PRECISION_DECAY_MAX, orig + widening);
  }

  function buildRoboGradeDisplay(rg, comic) {
    if (!rg) return '';

    const score = rg.score;
    const scoreRounded = Math.round(score);

    // Color palette (mascot-green theme, color-matched to the actual
    // Robograder character):
    // OLIVE      → mascot body mid-tone (warm forest green, NOT cyan-leaning)
    // CHARTREUSE → score color
    // OLIVE_LT   → secondary text on dark panel (mascot lime-highlight tone)
    // OLIVE_MID  → border between body cells
    // SECTION_HD → darker green for FRONT/BACK/SPINE/INTERIOR section headers
    //              on the printout-paper bands
    // BG         → panel surround, slightly darker than the body so the body
    //              cells stand out against it
    const OLIVE      = '#2a4a1e';
    const CHARTREUSE = '#b8d820';
    const OLIVE_LT   = '#7aa838';
    const OLIVE_MID  = '#4a7028';
    const SECTION_HD = '#1a3818';
    const LIGHT      = '#9abf60';
    const RULE       = '#3a5818';
    const BG         = '#152e10';

    // Precision suffix logic (mirrors print-label.js exactly).
    // Score 100      → no suffix (perfect, no uncertainty)
    // High-grade run → ±N (narrower confidence range, default ±3, capped 6)
    // Score ≥80, no high-grade → "+" (signals high-grade is available)
    // Score <80, no high-grade → ±N (standard range, default ±8)
    //
    // S12 May 6: client-side clamping applied here too, defending against
    // legacy records saved before the server-side clamp shipped:
    //   - Mode cap (high-grade ≤6, standard ≤16) prevents nonsense ranges.
    //   - Score+conf cap (score + N ≤ 100) prevents implied upper bounds
    //     above 100 (e.g. score 94 ± 8 → range 102, capped to 94 ± 6 → 100).
    //
    // S14: age-based widening applied AFTER the original mode-cap and
    // BEFORE the score+headroom cap. Order matters — the mode cap (≤6 for
    // high-grade, ≤16 standard) protects against bad original data, then
    // age widening extends the range based on time elapsed, then the
    // headroom cap (score + N ≤ 100) prevents the display from implying
    // a grade above 100. Without that final cap, a 70-year-old score-90
    // book would widen to ±50, implying upper bound 140 — nonsense. The
    // cap reads "the book is somewhere between (score - N) and 100" which
    // is what we mean. Lower bound isn't explicitly floored at 0 because
    // headroom-only capping handles that asymmetrically: a score-90 ±60
    // becomes a score-90 ±10 (capped to top), and a score-10 ±60 stays a
    // score-10 ±60 (lower bound implied to be near zero — fine, that's
    // truthful).
    const highGradeRun = !!(comic && comic.highGradeUnlocked);
    const assessmentDateISO = comic && comic.roboGradeDate;
    let precision = '';
    if (scoreRounded < 100) {
      if (highGradeRun) {
        let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 3;
        n = Math.max(0, Math.min(6, n));
        n = widenPrecisionForAge(n, assessmentDateISO);
        const headroom = Math.max(0, 100 - scoreRounded);
        if (n > headroom) n = headroom;
        precision = n > 0 ? `±${n}` : '';
      } else if (scoreRounded >= 80) {
        precision = '+';
      } else {
        let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 8;
        n = Math.max(0, Math.min(16, n));
        n = widenPrecisionForAge(n, assessmentDateISO);
        const headroom = Math.max(0, 100 - scoreRounded);
        if (n > headroom) n = headroom;
        precision = n > 0 ? `±${n}` : '';
      }
    }

    // Severity color — tuned for the printout paper bands (pale green / cream
    // backgrounds), deeper and more saturated than dark-panel equivalents.
    function sevColor(s) {
      if (!s) return PAPER_INK_LT;
      const u = s.toUpperCase();
      if (u === 'HIGH') return '#a8202a';
      if (u === 'MED')  return '#a86010';
      return '#3a5018';
    }

    // Group defects by category
    const defects = rg.defects || [];
    const cats = ['Front', 'Back', 'Spine', 'Interior'];
    const byCat = {};
    cats.forEach(c => byCat[c] = []);
    defects.forEach(d => {
      const cat = d.category || 'Front';
      if (byCat[cat]) byCat[cat].push(d);
      else byCat['Front'].push(d);
    });

    function defectList(arr, startIdx) {
      if (!arr.length) return '';
      return arr.map((d, i) => {
        const detailParts = [];
        if (d.location && d.location !== 'N/A') detailParts.push(d.location);
        if (d.measurement && d.measurement !== 'N/A') detailParts.push(d.measurement.replace(/^~\s*/, ''));
        if (d.colorBreaking) detailParts.push('color breaking');
        const detailStr = detailParts.length ? ` - ${detailParts.join(', ')}` : '';
        const sev = d.severity || 'Low';
        const rowIdx = (startIdx || 0) + i;
        const rowBg = (rowIdx % 2 === 0) ? PAPER_GREEN : PAPER_CREAM;
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 10px;font-size:11px;gap:8px;background:${rowBg};font-family:'IBM Plex Mono','Menlo',monospace">
          <span style="color:${PAPER_INK}"><strong>${d.type}</strong>${detailStr}</span>
          <span style="color:${sevColor(sev)};font-weight:800;font-size:11px;white-space:nowrap;flex-shrink:0;letter-spacing:0.5px">${sev.toUpperCase()}</span>
        </div>`;
      }).join('');
    }

    // Component scores — integers only. v2.0 additive system:
    // Front 0-50, Back 0-20, Spine 0-20, Interior 0-10. Final = sum.
    const fs  = rg.frontScore    != null ? Math.round(rg.frontScore)    : '—';
    const bs  = rg.backScore     != null ? Math.round(rg.backScore)     : '—';
    const ss  = rg.spineScore    != null ? Math.round(rg.spineScore)    : '—';
    const ins = rg.interiorScore != null ? Math.round(rg.interiorScore) : '—';

    // Printout paper palette — vintage tractor-feed continuous-form paper:
    // pale mint-green bars and slightly-off-white cream bars, dark olive ink.
    const PAPER_GREEN    = '#cce8b8';
    const PAPER_CREAM    = '#f4f0dc';
    const PAPER_HEADER   = '#a8c898';
    const PAPER_INK      = '#1f2a08';
    const PAPER_INK_HD   = '#0a1404';
    const PAPER_INK_LT   = '#5a6a3a';

    // Category sections — only render if there are defects. Each row gets a
    // running-index passed in so green/cream banding flows continuously across
    // categories rather than resetting at each section break.
    let runningIdx = 0;
    function catSection(label, score, defArr) {
      if (!defArr.length) return '';
      const startIdx = runningIdx;
      runningIdx += defArr.length;
      return `<div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:${PAPER_HEADER};border-top:1px solid ${PAPER_INK_LT};border-bottom:1px solid ${PAPER_INK_LT}">
          <span style="font-size:10px;font-weight:700;color:${PAPER_INK_HD};letter-spacing:1.5px;font-family:'IBM Plex Mono','Menlo',monospace">${label}</span>
          <span style="font-size:14px;font-weight:800;color:${PAPER_INK_HD};font-family:'IBM Plex Mono','Menlo',monospace">${score}</span>
        </div>
        ${defectList(defArr, startIdx)}
      </div>`;
    }

    // S14: Interior justification row. catSection('INTERIOR') renders
    // nothing when there are no interior DEFECTS (correct — page quality
    // is not a defect). But on a graded book the interior score is
    // derived from the slab label's page-quality designation, and with
    // the section absent the user had no idea why Interior scored what it
    // did. If there are no interior defects but we have a pageQuality
    // value, emit an informational (non-defect) row that states the
    // derivation, so the Interior score is explained rather than
    // unexplained. Styled distinctly from defect rows (it's not a flaw).
    const pq = (rg.pageQuality && String(rg.pageQuality).trim()) ? String(rg.pageQuality).trim() : '';
    // Local escaper — pageQuality is model-generated text. Even though the
    // expected values are constrained designations ("Off-White to White"
    // etc.), escape defensively before injecting into innerHTML.
    const pqEsc = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let interiorSectionHTML = catSection('INTERIOR', ins, byCat['Interior']);
    if (!interiorSectionHTML && pq) {
      interiorSectionHTML = `<div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:${PAPER_HEADER};border-top:1px solid ${PAPER_INK_LT};border-bottom:1px solid ${PAPER_INK_LT}">
          <span style="font-size:10px;font-weight:700;color:${PAPER_INK_HD};letter-spacing:1.5px;font-family:'IBM Plex Mono','Menlo',monospace">INTERIOR</span>
          <span style="font-size:14px;font-weight:800;color:${PAPER_INK_HD};font-family:'IBM Plex Mono','Menlo',monospace">${ins}</span>
        </div>
        <div style="padding:7px 10px;background:${PAPER_CREAM};font-size:11px;color:${PAPER_INK_LT};font-family:'IBM Plex Mono','Menlo',monospace;line-height:1.45;font-style:italic">
          Interior page quality derived as ${pqEsc(pq)} from label info.
        </div>
      </div>`;
    }

    const sectionsHTML = [
      catSection('FRONT',    fs,  byCat['Front']),
      catSection('BACK',     bs,  byCat['Back']),
      catSection('SPINE',    ss,  byCat['Spine']),
      interiorSectionHTML,
    ].filter(Boolean).join('');

    // Hide the staples line when there are no defects to call out.
    function staplesAreClean(s) {
      if (!s) return true;
      const lower = s.toLowerCase();
      if (/^clean\b/.test(lower)) return true;
      if (/\bno\s+(rust|oxidation|migration)\b/.test(lower) && !/\b(but|except|however|some|minor|slight|trace)\b/.test(lower)) return true;
      return false;
    }

    const extrasHTML = [
      (rg.stapleCondition && !staplesAreClean(rg.stapleCondition)) ? `<div style="padding:6px 10px;background:${PAPER_CREAM};font-size:11px;color:${PAPER_INK};font-family:'IBM Plex Mono','Menlo',monospace"><strong>Staples:</strong> ${rg.stapleCondition}</div>` : '',
      rg.restorationFlags && rg.restorationFlags.length ? `<div style="padding:6px 10px;background:${PAPER_CREAM};font-size:11px;color:#a02020;font-family:'IBM Plex Mono','Menlo',monospace">⚠ Restoration flags: ${rg.restorationFlags.join(', ')}</div>` : '',
    ].filter(Boolean).join('');

    // Provenance row — date and ID between score panel and defect printout.
    let provenanceHTML = '';
    if (comic && (comic.roboGradeDate || comic.roboGradeId)) {
      let dateStr = '';
      if (comic.roboGradeDate) {
        try {
          const dt = new Date(comic.roboGradeDate);
          dateStr = dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch (e) { dateStr = ''; }
      }
      provenanceHTML = `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:${OLIVE};border-radius:6px;margin-bottom:10px;font-family:'IBM Plex Mono','Menlo',monospace;font-size:11px">
        ${comic.roboGradeId ? `<div><span style="color:${OLIVE_LT};letter-spacing:1px;font-size:9px;font-weight:700">ID</span> <span style="color:${CHARTREUSE};margin-left:6px;letter-spacing:0.5px">${comic.roboGradeId}</span></div>` : '<div></div>'}
        ${dateStr ? `<div><span style="color:${OLIVE_LT};letter-spacing:1px;font-size:9px;font-weight:700">GRADED</span> <span style="color:${CHARTREUSE};margin-left:6px">${dateStr}</span></div>` : ''}
      </div>`;
    }

    // Layout: heading "ROBOGRADE SCORE" spans full container width on top so
    // the score box (left) and 2x2 sub-grade grid (right) can both start from
    // the same baseline below it. The defect listing is styled as 1970s
    // tractor-feed printout paper.
    return `<div style="background:${BG};border:1.5px solid ${OLIVE_MID};border-radius:12px;padding:14px 14px 0;margin-bottom:8px;overflow:hidden">
      <div style="font-size:12px;font-weight:700;color:${OLIVE_LT};letter-spacing:2px;margin-bottom:10px;text-align:center">ROBOGRADE SCORE</div>
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
        <div style="background:${OLIVE};border-radius:16px;width:88px;height:88px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1.5px solid ${OLIVE_MID};position:relative">
          ${precision ? `<span style="font-family:system-ui,-apple-system,sans-serif;font-size:11px;font-weight:700;color:${OLIVE_LT};position:absolute;top:6px;right:7px;white-space:nowrap;letter-spacing:0.2px;line-height:1">${precision.replace('±', '± ')}</span>` : ''}
          <div style="font-size:8px;font-weight:700;color:${OLIVE_LT};letter-spacing:2px;margin-bottom:2px">RG</div>
          <div style="position:relative;display:flex;justify-content:center;align-items:flex-end;width:100%">
            <span style="font-family:'Noto Sans Display',sans-serif;font-stretch:62.5%;font-size:40px;font-weight:900;color:${CHARTREUSE};line-height:1">${scoreRounded}</span>
          </div>
          <div style="font-size:8px;font-weight:700;color:#5a7028;letter-spacing:1px;margin-top:3px;opacity:0.85">V${rg.version || '2.0'}</div>
        </div>
        <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:4px">
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE}">${fs}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px">FRONT</div>
          </div>
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE}">${bs}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px">BACK</div>
          </div>
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE}">${ss}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px">SPINE</div>
          </div>
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE}">${ins}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px">INTERIOR</div>
          </div>
        </div>
      </div>
      ${provenanceHTML}
      ${sectionsHTML || extrasHTML ? `<div style="margin:0 -14px;border-top:2px solid ${OLIVE_MID};border-bottom:1.5px solid ${OLIVE_MID};position:relative">
        <div style="position:absolute;left:0;top:0;bottom:0;width:8px;background-image:radial-gradient(circle at 4px 8px, ${OLIVE_MID} 1.5px, transparent 1.6px);background-size:8px 14px;background-repeat:repeat-y;background-color:${PAPER_CREAM};z-index:1"></div>
        <div style="position:absolute;right:0;top:0;bottom:0;width:8px;background-image:radial-gradient(circle at 4px 8px, ${OLIVE_MID} 1.5px, transparent 1.6px);background-size:8px 14px;background-repeat:repeat-y;background-color:${PAPER_CREAM};z-index:1"></div>
        <div style="margin:0 8px;background:${PAPER_CREAM}">
          ${sectionsHTML}
          ${extrasHTML}
        </div>
      </div>` : ''}
    </div>`;
  }

  // Expose under a namespace so we don't pollute the global scope and so the
  // intent ("this is the shared RoboGrader panel") is clear at every call site.
  // S14: widenPrecisionForAge also exposed so print-label.js and index.html
  // can use the same widening function — single source of truth for the
  // age-decay curve, no risk of the three surfaces drifting apart.
  window.RobograderPanel = {
    buildDisplay: buildRoboGradeDisplay,
    widenPrecisionForAge: widenPrecisionForAge,
    precisionWideningForYears: precisionWideningForYears,
  };
})();
