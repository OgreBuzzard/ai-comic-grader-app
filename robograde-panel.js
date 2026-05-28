// ── Shared RoboGrade panel renderer ─────────────────────────────────────────
//
// Renders the dark-olive RoboGrade panel: score box (left), proportional
// sub-grade grid (right; Front full row, Back+Spine+Int at 2:2:1 below),
// provenance row, and tractor-feed printout-paper defect breakdown by
// category.
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
    // High-grade run → ±N (narrower confidence range, default ±3, capped 6)
    // Score ≥80, no high-grade → "+" (signals high-grade is available)
    // Score <80, no high-grade → ±N (standard range, default ±8)
    //
    // S12 May 6: client-side clamping applied here too, defending against
    // legacy records saved before the server-side clamp shipped:
    //   - Mode cap (high-grade ≤6, standard ≤16) prevents nonsense ranges.
    //   - Score+conf cap (score + N ≤ 100) prevents implied upper bounds
    //     above 100 (e.g. score 94 ± 8 → range 102, capped to 94 ± 6 → 100).
    const highGradeRun = !!(comic && comic.highGradeUnlocked);
    let precision = '';
    if (scoreRounded < 100) {
      if (highGradeRun) {
        let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 3;
        n = Math.max(0, Math.min(6, n));
        const headroom = Math.max(0, 100 - scoreRounded);
        if (n > headroom) n = headroom;
        precision = n > 0 ? `±${n}` : '';
      } else if (scoreRounded >= 80) {
        precision = '+';
      } else {
        let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 8;
        n = Math.max(0, Math.min(16, n));
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
        // S15 May 28: do not fall through to 'Low' on empty severity.
        // Page quality entries (and any other descriptive observation that
        // isn't a defect) emit severity:"" deliberately — the prompt schema
        // reserves Low/Med/High for actual defects. Previously this was
        // `d.severity || 'Low'` which clobbered empty severity into LOW on
        // display, even though the model was emitting it correctly.
        const sev = (d.severity == null) ? 'Low' : d.severity;
        const rowIdx = (startIdx || 0) + i;
        const rowBg = (rowIdx % 2 === 0) ? PAPER_GREEN : PAPER_CREAM;
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 10px;font-size:11px;gap:8px;background:${rowBg};font-family:'IBM Plex Mono','Menlo',monospace">
          <span style="color:${PAPER_INK}"><strong>${d.type}</strong>${detailStr}</span>
          ${sev ? `<span style="color:${sevColor(sev)};font-weight:800;font-size:11px;white-space:nowrap;flex-shrink:0;letter-spacing:0.5px">${sev.toUpperCase()}</span>` : ''}
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
      // Returns true when the stapleCondition text describes NO defect —
      // in which case the display suppresses the row entirely. The model
      // is asked (by the schema) to fill stapleCondition, and on books
      // where the staples are fine OR not clearly visible, it produces
      // strings like "Clean, no migration", "Staples appear intact",
      // "Not clearly visible in provided photos". None of those are
      // defects and none should render.
      // S15 May 28: broadened to catch the "intact", "not visible",
      // "not clearly visible", "no obvious", "appear" patterns that were
      // slipping through and rendering under Interior.
      if (!s) return true;
      const lower = s.toLowerCase();
      // Defect signals — if ANY of these are present, the staple condition
      // describes a real defect and should render.
      const hasDefect = /\b(rust|oxidation|migration|missing|popped|pulled|loose|hole|stain|brown|orange|crooked|bent|tear)\b/.test(lower)
                     && !/\bno\s+(rust|oxidation|migration|stain)\b/.test(lower);
      if (hasDefect) return false;
      // Otherwise, treat as a non-defect observation and suppress.
      return true;
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
    // the score box (left) and proportional sub-grade grid (right) can both
    // start from the same baseline below it. The sub-grade grid uses Front
    // on a full row and Back+Spine+Int at 2:2:1 below, encoding the score
    // weights (50/20/20/10) into visible box sizes. The defect listing is
    // styled as 1970s tractor-feed printout paper.
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
        <div style="flex:1;display:grid;grid-template-columns:2fr 2fr 1fr;grid-template-rows:auto auto;gap:4px">
          <!-- Row 1: Front spans the full width of the sub-score grid. The
               proportional layout (Front full row; Back+Spine+Int below at
               2:2:1) encodes the underlying score weights (Front 50, Back 20,
               Spine 20, Interior 10) into the visible box sizes. The equal-
               size 2x2 grid that preceded this misrepresented Front as just
               1/4 of the score when it's actually 1/2. -->
          <div style="grid-column:1/-1;background:${OLIVE};border-radius:6px;padding:10px 6px;text-align:center">
            <div style="font-size:26px;font-weight:800;color:${CHARTREUSE};line-height:1">${fs}</div>
            <div style="font-size:9px;color:${OLIVE_LT};letter-spacing:1.5px;margin-top:3px">FRONT</div>
          </div>
          <!-- Row 2: Back and Spine at 2/5 each, Interior at 1/5 ("INT"). -->
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE};line-height:1">${bs}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px;margin-top:2px">BACK</div>
          </div>
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE};line-height:1">${ss}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px;margin-top:2px">SPINE</div>
          </div>
          <div style="background:${OLIVE};border-radius:6px;padding:6px;text-align:center">
            <div style="font-size:18px;font-weight:800;color:${CHARTREUSE};line-height:1">${ins}</div>
            <div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px;margin-top:2px">INT</div>
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
