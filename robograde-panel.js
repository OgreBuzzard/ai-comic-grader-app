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
    // High-grade run → ±N (narrower confidence range, default ±3)
    // Score ≥80, no high-grade → "+" (signals high-grade is available)
    // Score <80, no high-grade → ±N (standard range, default ±8)
    const highGradeRun = !!(comic && comic.highGradeUnlocked);
    let precision = '';
    if (scoreRounded < 100) {
      if (highGradeRun) precision = `±${rg.confidenceRange || 3}`;
      else if (scoreRounded >= 80) precision = '+';
      else precision = `±${rg.confidenceRange || 8}`;
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

    const sectionsHTML = [
      catSection('FRONT',    fs,  byCat['Front']),
      catSection('BACK',     bs,  byCat['Back']),
      catSection('SPINE',    ss,  byCat['Spine']),
      catSection('INTERIOR', ins, byCat['Interior']),
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
  window.RobograderPanel = { buildDisplay: buildRoboGradeDisplay };
})();
