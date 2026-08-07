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
    // Scoring v2 display (preview via ?v2=1): 31-tier grade + subscore tiers,
    // same layout. Comics only for now (card detail is a separate surface).
    const _v2on = !!(window.RG_V2_DISPLAY && window.RGScoreV2 && rg.frontScore != null);
    const _v2 = _v2on ? window.RGScoreV2.fromSubscores({ front: rg.frontScore, back: rg.backScore, spine: rg.spineScore, interior: rg.interiorScore }, 'comic') : null;

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
    // S16: Detect restored books (CGC purple label or HIGH-CONFIDENCE restoration check)
    // and swap to a purple color palette for the entire score box.
    // Low-confidence restoration indicators don't trigger purple — only high-confidence
    // findings (clear color touch, clear reinforcement) or official CGC restored labels.
    const _isRestored = !!(comic && (
      comic.restorationHighConfidence ||
      (comic.cgcNotes && /\b(RC|restored|restoration|conserved)\b/i.test(comic.cgcNotes)) ||
      comic.cgcDesignation === "restored"
    ));
    // S16: Purple checkmark for negative restoration result
    const _restorationNegative = !!(comic && comic.restorationCheckRan && !comic.restorationFlag && !_isRestored);

    const OLIVE      = _isRestored ? '#3a2a4a' : '#2a4a1e';
    const CHARTREUSE = _isRestored ? '#c8a8e8' : '#b8d820';
    const OLIVE_LT   = _isRestored ? '#9a7ab8' : '#7aa838';
    const OLIVE_MID  = _isRestored ? '#5a3a7a' : '#4a7028';
    const SECTION_HD = _isRestored ? '#2a1a3a' : '#1a3818';
    const LIGHT      = _isRestored ? '#b898d8' : '#9abf60';
    const RULE       = _isRestored ? '#4a2a6a' : '#3a5818';
    const BG         = _isRestored ? '#1a1226' : '#152e10';

    // Precision suffix logic (mirrors print-label.js exactly).
    // Score 100      → no suffix (perfect, no uncertainty)
    // High-grade run → ±N (narrower confidence range, default ±3, capped 6)
    // Score ≥90, no high-grade → no suffix ('+' teaser removed S18)
    // Score <90, no high-grade → ±N (standard range, default ±8)
    //
    // S12 May 6: client-side clamping applied here too, defending against
    // legacy records saved before the server-side clamp shipped:
    //   - Mode cap (high-grade ≤6, standard ≤16) prevents nonsense ranges.
    //   - Score+conf cap (score + N ≤ 100) prevents implied upper bounds
    //     above 100 (e.g. score 94 ± 8 → range 102, capped to 94 ± 6 → 100).
    const highGradeRun = !!(comic && comic.highGradeUnlocked);
    let precision = '';
    if (_v2on) {
      const _slab = !!(comic && comic.labelDetected);
      const _dp = !!(comic && (comic.highGradeTier || comic.deepAssessmentRan));
      const _fl = !!(comic && (comic.fullAssessmentRan || comic.fullUnlocked));
      const _base = _fl ? 0 : _dp ? 1 : _slab ? 4 : 2;
      const _pg = comic && comic.photograder;
      const _pen = _pg ? ['focus','lighting','cropping','angle'].reduce((a,k)=>{ const v=String(_pg[k]||'').trim().toUpperCase(); return a+(v==='B'?1:v==='C'?2:0); },0) : 0;
      const _nt = _base + _pen;
      precision = _nt > 0 ? '↕' + _nt : '';
    } else if (scoreRounded < 100) {
      if (highGradeRun) {
        let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 3;
        n = Math.max(0, Math.min(6, n));
        const headroom = Math.max(0, 100 - scoreRounded);
        if (n > headroom) n = headroom;
        precision = n > 0 ? `±${n}` : '';
      } else if (scoreRounded >= 90) {
        precision = '';
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
        // S16: Skip "interior" location for Page quality — it's redundant
        if (d.location && d.location !== 'N/A' && !(d.type === 'Page quality' && d.location === 'interior')) detailParts.push(d.location);
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
    const fs  = _v2 ? _v2.subs[0].display : (rg.frontScore    != null ? Math.round(rg.frontScore)    : '—');
    const bs  = _v2 ? _v2.subs[1].display : (rg.backScore     != null ? Math.round(rg.backScore)     : '—');
    const ss  = _v2 ? _v2.subs[2].display : (rg.spineScore    != null ? Math.round(rg.spineScore)    : '—');
    const ins = _v2 ? _v2.subs[3].display : (rg.interiorScore != null ? Math.round(rg.interiorScore) : '—');

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
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px">
        <div style="background:${OLIVE};border-radius:18px;width:104px;height:104px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid ${OLIVE_MID};position:relative">
          ${(() => {
            if (_v2on) {
              if (!precision) return '';
              const _n = precision.replace(/^↕/, '');
              return `<span style="position:absolute;top:9px;right:9px;color:${CHARTREUSE};line-height:1;display:inline-flex;align-items:center;gap:2px;font-family:'Noto Sans Display',sans-serif;font-size:15px;font-weight:700"><img src="/assets/pm-notch.svg" width="9" height="12" style="display:block" alt="">${_n}</span>`;
            }
            return precision ? `<span style="font-family:'Noto Sans Display',sans-serif;font-size:18px;font-weight:700;color:${OLIVE_LT};position:absolute;top:9px;right:9px;white-space:nowrap;line-height:1;display:inline-block;transform:scaleX(0.62);transform-origin:right center">${precision.replace('±', '± ')}</span>` : '';
          })()}
          <div style="position:absolute;top:6px;left:0;right:0;text-align:center;pointer-events:none;display:flex;justify-content:center;opacity:0.5">${(() => {
            // S17: chunky SVG tier stars in the score-text color, centered at the
            // top, ABSOLUTE (out of flow) so the score stays dead-center. No "RG"
            // (redundant with the "ROBOGRADE SCORE" header).
            const _full = !!(comic && comic.fullAssessmentRan);
            const _deep = !!(comic && (comic.deepAssessmentRan || comic.highGradeTier || (comic.roboGrade && comic.roboGrade.deepAssessmentRan)));
            const _restoRan = !!(comic && comic.restorationCheckRan);
            let _t = 1; if (_full) _t = 3; else if (_deep) _t = 2;
            const _star = (c) => `<svg viewBox="0 0 24 24" width="13" height="13" style="display:inline-block;vertical-align:middle"><path d="M12.00,2.00 15.64,6.98 21.51,8.91 17.90,13.92 17.88,20.09 12.00,18.20 6.12,20.09 6.10,13.92 2.49,8.91 8.36,6.98Z" fill="${c}"/></svg>`;
            let _s = '';
            for (let i = 0; i < _t; i++) _s += _star(CHARTREUSE);
            if (_restoRan) _s += _star('#b58be0');
            return `<span style="display:inline-flex;gap:1px;align-items:center;line-height:1">${_s}</span>`;
          })()}</div>
          <span style="position:relative;display:inline-block;line-height:1"><span style="font-family:'Noto Sans Display',sans-serif;font-weight:900;color:${CHARTREUSE};line-height:1;font-size:62px;display:inline-block;transform:scaleX(0.80);transform-origin:center">${_v2 ? String(_v2.grade).replace(/[+-]$/, '') : scoreRounded}</span>${_v2 && /[+-]$/.test(String(_v2.grade)) ? `<span style="position:absolute;left:100%;top:8px;margin-left:-2px;font-family:'Noto Sans Display',sans-serif;font-size:26px;font-weight:500;color:${CHARTREUSE};line-height:1">${String(_v2.grade).slice(-1)}</span>` : ''}</span>
          <div style="font-size:8px;font-weight:700;color:#5a7028;letter-spacing:1px;opacity:0.85;position:absolute;bottom:8px;left:0;right:0;text-align:center">V${(window.RG_GRADING_VERSION || '4.63')}</div>
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
      ${renderPhotograderPanel((comic && comic.photograder) || (rg && rg.photograder))}
    </div>`;
  }

  // ── Photograder bookend ─────────────────────────────────────────────
  // Renders the photo-quality panel at the bottom of the RoboGrade box: four
  // streetlight-colored cells (A green / B yellow / C red, '?' neutral) with
  // neutral letters, and an alternating cream/green guidance list (one terse
  // line per B/C flag — category bold, no color-coding, like the defect list).
  function _pgEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function _pgCell(label, letter) {
    const L = String(letter == null ? '' : letter).trim().toUpperCase();
    const map = {
      A: { bg: '#4e9e2e', lab: '#143d08', ltr: '#10240c' },
      B: { bg: '#ffd655', lab: '#4a3406', ltr: '#3a2804' },
      C: { bg: '#cc4436', lab: '#4a1410', ltr: '#40100a' },
    };
    const s = map[L] || { bg: '#26331c', lab: '#6a8a4a', ltr: '#6a8a4a' };
    const show = (L === 'A' || L === 'B' || L === 'C') ? L : '?';
    // Border matches the RoboGrade score box above (1.5px solid OLIVE_MID).
    return `<div style="flex:1;text-align:center;background:${s.bg};border:1.5px solid #4a7028;border-radius:8px;padding:8px 2px"><div style="font-size:9px;color:${s.lab};letter-spacing:0.5px;margin-bottom:3px">${label}</div><div style="font-size:26px;font-weight:600;color:${s.ltr};line-height:1">${show}</div></div>`;
  }
  function renderPhotograderPanel(pg) {
    if (!pg) return '';
    const has = k => /^[ABC]$/.test(String(pg[k] == null ? '' : pg[k]).trim().toUpperCase());
    if (!(has('focus') || has('lighting') || has('cropping') || has('angle'))) return '';
    const cells = _pgCell('FOCUS', pg.focus) + _pgCell('LIGHTING', pg.lighting) + _pgCell('CROPPING', pg.cropping) + _pgCell('ANGLE', pg.angle);
    const flags = Array.isArray(pg.flags) ? pg.flags.filter(f => f && (f.image || f.note)) : [];
    let flagsHTML = '';
    if (flags.length) {
      // Full-container-width tractor-feed printout, matching the defect list:
      // full-bleed (margin:0 -14px cancels the container's 14px padding), with
      // dotted printer-paper margin strips on both sides.
      const rows = flags.map((f, i) => {
        const bg = i % 2 === 0 ? '#f4f0dc' : '#cce8b8';
        const cat = f.category ? f.category.charAt(0).toUpperCase() + f.category.slice(1) : '';
        const img = f.image ? String(f.image).trim() : '';
        // The note field should be the short fix ONLY. Older data (and occasional
        // model drift) echo "<axis> - <image> -" into the note; strip those leading
        // redundancies so we don't render "Focus · Front — Focus - Front - <fix>".
        let note = String(f.note == null ? '' : f.note).trim();
        const strip = (pfx) => { if (!pfx) return; const re = new RegExp('^' + pfx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-\u2013\u2014:]\\s*', 'i'); note = note.replace(re, '').trim(); };
        strip(cat); strip(img); strip(cat);
        const parts = [];
        if (img)  parts.push(_pgEsc(img));
        if (note) parts.push(_pgEsc(note));
        const body = parts.join(': ');
        return `<div style="font-size:11px;line-height:1.45;color:#1f2a08;font-family:'IBM Plex Mono','Menlo',monospace;padding:6px 10px;background:${bg}">${cat ? `<b>${_pgEsc(cat)}</b>${body ? ' — ' : ''}` : ''}${body}</div>`;
      }).join('');
      flagsHTML = `<div style="margin:12px -14px 0;border-top:2px solid #4a7028;border-bottom:1.5px solid #4a7028;position:relative">
        <div style="position:absolute;left:0;top:0;bottom:0;width:8px;background-image:radial-gradient(circle at 4px 8px, #4a7028 1.5px, transparent 1.6px);background-size:8px 14px;background-repeat:repeat-y;background-color:#f4f0dc;z-index:1"></div>
        <div style="position:absolute;right:0;top:0;bottom:0;width:8px;background-image:radial-gradient(circle at 4px 8px, #4a7028 1.5px, transparent 1.6px);background-size:8px 14px;background-repeat:repeat-y;background-color:#f4f0dc;z-index:1"></div>
        <div style="margin:0 8px;background:#f4f0dc">${rows}</div>
      </div>`;
    }
    // No border-top here — the defect list's border-bottom already separates
    // this dark-green section from the printout above.
    return `<div style="margin-top:14px;padding-bottom:${flags.length ? '0' : '12px'}">
      <div style="font-size:12px;font-weight:700;color:#7aa838;letter-spacing:2px;text-align:center;margin-bottom:10px">PHOTOGRADER</div>
      <div style="display:flex;gap:6px">${cells}</div>
      ${flagsHTML}
    </div>`;
  }

  // ── Shared CARD RoboGrade panel ─────────────────────────────────────
  // Single source for the card results panel, used by BOTH index.html
  // (Detail/Edit: index.html's buildCardRoboDisplay wrapper calls this)
  // and public.html (public /id/XXXXXX page). Mirrors the
  // comic panel layout: green score box + 50/20/20/10 subscores, tractor-
  // feed defect printout, portrait centering rects, Photograder.
  function buildCardDisplay(item) {
    var esc = function(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");};
    const rg = item.roboGrade || {};
    const card = item.cardData || {};
    const cd = card.robograde || rg.subscores || null;
    const score = (rg.score != null) ? rg.score : (cd && cd.total != null ? cd.total : null);
    const scoreRounded = score != null ? Math.round(score) : null;

    const OLIVE = "#2a4a1e", CHARTREUSE = "#b8d820", OLIVE_LT = "#7aa838", OLIVE_MID = "#4a7028", BG = "#152e10";
    const PAPER_GREEN = "#cce8b8", PAPER_CREAM = "#f4f0dc", PAPER_HEADER = "#a8c898";
    const PAPER_INK = "#1f2a08", PAPER_INK_HD = "#0a1404", PAPER_INK_LT = "#5a6a3a";

    // Cards use the shared v2 (31-tier) grade. Weights now mirror comics: 50/20/20/10.
    const cardSubs = cd ? {
      surface: cd.surface && cd.surface.total,
      corners: cd.corners && cd.corners.total,
      edges: cd.edges && cd.edges.total,
      centering: cd.centering && cd.centering.total
    } : null;
    const _hasSubs = !!(cardSubs && [cardSubs.surface, cardSubs.corners, cardSubs.edges, cardSubs.centering].some(v => v != null));
    const _v2 = (window.RGScoreV2 && _hasSubs) ? window.RGScoreV2.fromSubscores(cardSubs, "card") : null;
    const gradeLabel = _v2 ? _v2.grade : (window.RGScoreV2 && score != null ? window.RGScoreV2.gradeFromScore(score) : (scoreRounded != null ? String(scoreRounded) : ""));

    // subs order (from CONFIG.card): surface, corners, edges, centering.
    const rawT = k => (cd && cd[k] && cd[k].total != null) ? cd[k].total : "—";
    const vSurface = _v2 ? _v2.subs[0].display : rawT("surface");
    const vCorners = _v2 ? _v2.subs[1].display : rawT("corners");
    const vEdges = _v2 ? _v2.subs[2].display : rawT("edges");
    const vCentering = _v2 ? _v2.subs[3].display : rawT("centering");

    const _deep = !!item.deepAssessmentRan;
    const _pg = card.photograder;
    const _pen = _pg ? ["focus", "lighting", "cropping", "angle"].reduce((a, k) => {
      const v = String(_pg[k] || "").trim().toUpperCase(); return a + (v === "B" ? 1 : v === "C" ? 2 : 0);
    }, 0) : 0;
    const precision = (_deep ? 1 : 2) + _pen;
    const _stars = _deep ? 2 : 1;
    const _verLabel = "V" + (window.RG_GRADING_VERSION || "4.63");

    // Consistent grade rendering: big base + smaller (same-weight) +/- suffix.
    // Used by the main score AND every subscore so all +/- match.
    const tierHTML = (str, baseSize, color) => {
      const s = String(str == null ? "" : str);
      const m = s.match(/^(\d+|—|-)([+-])?$/);
      const base = m ? m[1] : s;
      const suf = (m && m[2]) ? m[2] : "";
      const sup = Math.round(baseSize * 0.5);
      return `<span style="display:inline-flex;align-items:center;line-height:1;font-family:'Noto Sans Display',sans-serif;font-weight:800;color:${color}"><span style="font-size:${baseSize}px;line-height:1">${base}</span>${suf ? `<span style="font-size:${sup}px;line-height:1;margin-left:1px">${suf}</span>` : ""}</span>`;
    };

    // ---------- defects ----------
    const sevColor = s => { const u = String(s || "").toUpperCase(); return u === "HIGH" ? "#a8202a" : (u === "MED" || u === "MEDIUM") ? "#a86010" : "#3a5018"; };
    const sevChip = s => s ? `<span style="color:${sevColor(s)};font-weight:800;font-size:11px;white-space:nowrap;flex-shrink:0;letter-spacing:0.5px">${String(s).toUpperCase() === "MEDIUM" ? "MED" : String(s).toUpperCase()}</span>` : "";
    const parseDef = str => {
      let s = String(str == null ? "" : str).trim();
      if (!s) return null;
      if (/\bis clean\b/i.test(s) || /\bno\s+[\w\/ ]+?\s+(?:detected|marks|damage|fading|present|issues)\b/i.test(s) || /\bshows no\b/i.test(s)) return null;
      let sev = null;
      const m = s.match(/[\s,;.–-]*\b(HIGH|MED|MEDIUM|LOW)\b\.?$/i);
      if (m) { sev = m[1].toUpperCase(); s = s.slice(0, m.index).trim(); }
      s = s.replace(/[.\s]+$/, "");
      return s ? { t: s, sev: sev } : null;
    };
    const def = card.defects || {};
    const arrOf = k => Array.isArray(def[k]) ? def[k] : [];
    const surfaceRows = [].concat(arrOf("creases"), arrOf("scratches"), arrOf("printDefects"), arrOf("stains"), arrOf("other")).map(parseDef).filter(Boolean);

    const CORNER_MAP = { "SLIGHT FRAY": { t: "Slight fraying", sev: "LOW" }, "MINOR BLUNT": { t: "Minor blunting", sev: "LOW" }, "SOFT": { t: "Soft corner", sev: "LOW" }, "HEAVY BLUNT": { t: "Heavy blunting", sev: "MED" }, "CHIPPED": { t: "Chipped", sev: "MED" }, "DESTROYED": { t: "Destroyed", sev: "HIGH" } };
    const humanLoc = k => k.replace(/([A-Z])/g, " $1").replace(/\s+/g, " ").trim().toLowerCase();
    const cornerGroups = {};
    const _pc = cd && cd.corners && cd.corners.perCorner;
    if (_pc) for (const k in _pc) { const V = String(_pc[k] || "").toUpperCase().trim(); if (!V || V === "PRISTINE" || V === "SHARP") continue; const map = CORNER_MAP[V] || { t: V.charAt(0) + V.slice(1).toLowerCase(), sev: "MED" }; (cornerGroups[map.t] = cornerGroups[map.t] || { sev: map.sev, locs: [] }).locs.push(humanLoc(k)); }
    const cornerRows = Object.keys(cornerGroups).map(t => ({ t: t + ", " + cornerGroups[t].locs.join(" and "), sev: cornerGroups[t].sev }));

    const EDGE_MAP = { "LIGHT WEAR": { t: "Light wear", sev: "LOW" }, "NOTCHING": { t: "Notching", sev: "MED" }, "CHIPPING": { t: "Chipping", sev: "MED" }, "ROUGH": { t: "Rough", sev: "MED" }, "TEAR": { t: "Tear", sev: "HIGH" } };
    const edgeGroups = {};
    const _ed = cd && cd.edges;
    if (_ed) for (const side of ["top", "bottom", "left", "right"]) { const V = String(_ed[side] || "").toUpperCase().trim(); if (!V || V === "CLEAN") continue; const map = EDGE_MAP[V] || { t: V.charAt(0) + V.slice(1).toLowerCase(), sev: "MED" }; (edgeGroups[map.t] = edgeGroups[map.t] || { sev: map.sev, sides: [] }).sides.push(side); }
    const edgeRows = Object.keys(edgeGroups).map(t => ({ t: t + ", " + edgeGroups[t].sides.join(" and ") + " edge", sev: edgeGroups[t].sev }));
    arrOf("edgeIssues").map(parseDef).filter(Boolean).forEach(r => edgeRows.push(r));

    let runningIdx = 0;
    const catSection = (label, scoreVal, rows) => {
      if (!rows.length) return "";
      const body = rows.map((d, i) => {
        const bg = ((runningIdx + i) % 2 === 0) ? PAPER_GREEN : PAPER_CREAM;
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 10px;font-size:11px;gap:8px;background:${bg};font-family:'IBM Plex Mono','Menlo',monospace"><span style="color:${PAPER_INK}">${esc(String(d.t))}</span>${sevChip(d.sev)}</div>`;
      }).join("");
      runningIdx += rows.length;
      return `<div><div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:${PAPER_HEADER};border-top:1px solid ${PAPER_INK_LT};border-bottom:1px solid ${PAPER_INK_LT}"><span style="font-size:10px;font-weight:700;color:${PAPER_INK_HD};letter-spacing:1.5px;font-family:'IBM Plex Mono','Menlo',monospace">${label}</span><span style="font-size:14px;font-weight:800;color:${PAPER_INK_HD};font-family:'IBM Plex Mono','Menlo',monospace">${scoreVal}</span></div>${body}</div>`;
    };

    // ---------- centering (a defect-list category; portrait 5:7 rects with inner rect) ----------
    const parseRatio = str => {
      const out = { top: null, bottom: null, left: null, right: null };
      if (str == null) return out;
      const s = String(str).replace(/~/g, " ");
      const lr = s.match(/(\d+)\s*\/\s*(\d+)\s*L\s*\/?\s*R/i);
      const tb = s.match(/(\d+)\s*\/\s*(\d+)\s*T\s*\/?\s*B/i);
      if (lr) { out.left = +lr[1]; out.right = +lr[2]; }
      if (tb) { out.top = +tb[1]; out.bottom = +tb[2]; }
      if (!lr && !tb) { const g = s.match(/(\d+)\s*\/\s*(\d+)/); if (g) { out.left = +g[1]; out.right = +g[2]; } }
      return out;
    };
    const faceCentering = which => {
      const c = cd && cd.centering;
      if (c && c[which] && typeof c[which] === "object" && !Array.isArray(c[which]) && (c[which].left != null || c[which].right != null || c[which].top != null || c[which].bottom != null)) {
        return { top: c[which].top, bottom: c[which].bottom, left: c[which].left, right: c[which].right };
      }
      return parseRatio(c && c[which + "Ratio"]);
    };
    const _cf = faceCentering("front"), _cb = faceCentering("back");
    const _hasCentering = [_cf.top, _cf.bottom, _cf.left, _cf.right, _cb.top, _cb.bottom, _cb.left, _cb.right].some(x => x != null && x !== "" && !isNaN(x));
    const nrm = x => (x == null || x === "" || isNaN(x)) ? "–" : String(x);
    const numFont = "font-size:10px;font-weight:700;color:" + CHARTREUSE + ";font-family:'IBM Plex Mono','Menlo',monospace";
    const centerRect = (label, v) => `<div style="text-align:center">
      <div style="font-size:9px;letter-spacing:1px;color:${PAPER_INK_HD};font-weight:700;margin-bottom:5px;font-family:'IBM Plex Mono','Menlo',monospace">${label}</div>
      <div style="position:relative;width:64px;height:90px;margin:0 auto;background:${OLIVE};border:2px solid ${OLIVE_LT};border-radius:8px">
        <div style="position:absolute;top:16px;bottom:16px;left:14px;right:14px;border:1.5px solid ${OLIVE_LT};border-radius:4px"></div>
        <div style="position:absolute;top:1px;left:0;right:0;text-align:center;${numFont}">${nrm(v.top)}</div>
        <div style="position:absolute;bottom:1px;left:0;right:0;text-align:center;${numFont}">${nrm(v.bottom)}</div>
        <div style="position:absolute;left:1px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;${numFont}">${nrm(v.left)}</div>
        <div style="position:absolute;right:1px;top:0;bottom:0;display:flex;align-items:center;justify-content:center;${numFont}">${nrm(v.right)}</div>
      </div>
    </div>`;
    const centeringCatHTML = _hasCentering ? `<div><div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:${PAPER_HEADER};border-top:1px solid ${PAPER_INK_LT};border-bottom:1px solid ${PAPER_INK_LT}"><span style="font-size:10px;font-weight:700;color:${PAPER_INK_HD};letter-spacing:1.5px;font-family:'IBM Plex Mono','Menlo',monospace">CENTERING</span><span style="font-size:14px;font-weight:800;color:${PAPER_INK_HD};font-family:'IBM Plex Mono','Menlo',monospace">${vCentering}</span></div><div style="background:${PAPER_CREAM};padding:12px 10px;display:flex;gap:22px;justify-content:center">${centerRect("FRONT", _cf)}${centerRect("BACK", _cb)}</div></div>` : "";

    const sectionsHTML = [catSection("SURFACE", vSurface, surfaceRows), catSection("CORNERS", vCorners, cornerRows), catSection("EDGES", vEdges, edgeRows)].filter(Boolean).join("") + centeringCatHTML;

    // ---------- Photograder ----------
    // Full Photograder panel (cells + per-image guidance flags) via the shared
    // renderPhotograderPanel — identical to comics, single source.
    const pgHTML = (typeof renderPhotograderPanel === "function") ? renderPhotograderPanel(_pg) : "";

    // ---------- Provenance ----------
    let provenanceHTML = "";
    if (item.roboGradeId || item.roboGradeDate) {
      let dateStr = "";
      if (item.roboGradeDate) { try { dateStr = new Date(item.roboGradeDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); } catch (e) { dateStr = ""; } }
      provenanceHTML = `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:${OLIVE};border-radius:6px;margin-bottom:10px;font-family:'IBM Plex Mono','Menlo',monospace;font-size:11px">${item.roboGradeId ? `<div><span style="color:${OLIVE_LT};letter-spacing:1px;font-size:9px;font-weight:700">ID</span> <span style="color:${CHARTREUSE};margin-left:6px;letter-spacing:0.5px">${esc(String(item.roboGradeId))}</span></div>` : "<div></div>"}${dateStr ? `<div><span style="color:${OLIVE_LT};letter-spacing:1px;font-size:9px;font-weight:700">GRADED</span> <span style="color:${CHARTREUSE};margin-left:6px">${dateStr}</span></div>` : ""}</div>`;
    }

    // ---------- Score box ----------
    const _starSvg = c => `<svg viewBox="0 0 24 24" width="13" height="13" style="display:inline-block;vertical-align:middle"><path d="M12.00,2.00 15.64,6.98 21.51,8.91 17.90,13.92 17.88,20.09 12.00,18.20 6.12,20.09 6.10,13.92 2.49,8.91 8.36,6.98Z" fill="${c}"/></svg>`;
    let _starsHTML = "";
    for (let i = 0; i < _stars; i++) _starsHTML += _starSvg(CHARTREUSE);
    const scoreBox = `<div style="background:${OLIVE};border-radius:18px;width:104px;height:104px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1.5px solid ${OLIVE_MID};position:relative">
      ${precision > 0 ? `<span style="position:absolute;top:8px;right:8px;color:${CHARTREUSE};line-height:1;display:inline-flex;align-items:center;gap:0;font-family:'Noto Sans Display',sans-serif;font-size:16px;font-weight:800"><img src="/assets/pm-notch.svg" width="16" height="22" style="display:block" alt=""><span style="margin-left:-1px">${precision}</span></span>` : ""}
      <div style="position:absolute;top:6px;left:0;right:0;text-align:center;pointer-events:none;display:flex;justify-content:center;opacity:0.5"><span style="display:inline-flex;gap:1px;align-items:center;line-height:1">${_starsHTML}</span></div>
      <div style="line-height:1">${tierHTML(gradeLabel, 60, CHARTREUSE)}</div>
      <div style="font-size:8px;font-weight:700;color:#5a7028;letter-spacing:1px;opacity:0.85;position:absolute;bottom:8px;left:0;right:0;text-align:center">${_verLabel}</div>
    </div>`;

    // ---------- Sub-grade grid: comic layout (SURFACE full row; CORN/EDGE/CENTER 2/2/1) ----------
    // Sub-grade cells fill a fixed 104px column so the two rows exactly match the
    // score box height. box-sizing:border-box keeps bordered cells aligned.
    const _HL = "#c8e838"; // bright accent for CORNERS marks / EDGES border
    const bigCell = (label, val) => `<div style="flex:1;background:${OLIVE};border-radius:6px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2px 6px">${tierHTML(val, 26, CHARTREUSE)}<div style="font-size:9px;color:${OLIVE_LT};letter-spacing:1.5px;margin-top:4px">${label}</div></div>`;
    // CORNERS accent: bright L-marks flush at the four outer corners (corners lit,
    // edges normal). EDGES accent: bright bars at the mid-point of each side
    // (edges lit, corners normal) — the visual inverse of CORNERS.
    const _cornerMarks = ["top:0;left:0;border-top:1.25px solid " + _HL + ";border-left:1.25px solid " + _HL + ";border-top-left-radius:6px", "top:0;right:0;border-top:1.25px solid " + _HL + ";border-right:1.25px solid " + _HL + ";border-top-right-radius:6px", "bottom:0;left:0;border-bottom:1.25px solid " + _HL + ";border-left:1.25px solid " + _HL + ";border-bottom-left-radius:6px", "bottom:0;right:0;border-bottom:1.25px solid " + _HL + ";border-right:1.25px solid " + _HL + ";border-bottom-right-radius:6px"].map(x => `<span style="position:absolute;width:11px;height:11px;${x}"></span>`).join("");
    const _edgeMarks = ["top:0;left:30%;right:30%;height:1.25px;background:" + _HL, "bottom:0;left:30%;right:30%;height:1.25px;background:" + _HL, "left:0;top:30%;bottom:30%;width:1.25px;background:" + _HL, "right:0;top:30%;bottom:30%;width:1.25px;background:" + _HL].map(x => `<span style="position:absolute;${x}"></span>`).join("");
    const smCell = (label, val, accent) => {
      const marks = accent === "corners" ? _cornerMarks : accent === "edges" ? _edgeMarks : "";
      return `<div style="position:relative;flex:1;height:100%;background:${OLIVE};border-radius:6px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;padding:2px">${marks}<div style="line-height:1">${tierHTML(val, 18, CHARTREUSE)}</div><div style="font-size:8px;color:${OLIVE_LT};letter-spacing:1px;margin-top:3px">${label}</div></div>`;
    };
    // Centering cell: a fixed 7:5 (portrait) card shape — reinforces that the
    // rectangle IS the card. Two concentric strokes (outer edge + inner inset 3px,
    // a card-margin look). Number + "CNT." stacked inside.
    const centerCell = `<div style="position:relative;height:100%;aspect-ratio:5/7;width:auto;flex-shrink:0;background:${OLIVE};border:1.5px solid ${OLIVE_LT};border-radius:6px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div style="position:absolute;inset:2px;border:1.5px solid ${OLIVE_LT};border-radius:4px"></div>
      <div style="position:relative;line-height:1">${tierHTML(vCentering, 16, CHARTREUSE)}</div>
      <div style="position:relative;font-size:8px;color:${OLIVE_LT};letter-spacing:1px;margin-top:2px">CNT.</div>
    </div>`;
    const subGrid = `<div style="flex:1;min-width:0;height:104px;display:flex;flex-direction:column;gap:4px">
      <div style="flex:1;min-height:0;display:flex">${bigCell("SURFACE", vSurface)}</div>
      <div style="flex:1;min-height:0;display:flex;gap:4px">${smCell("CRN.", vCorners, "corners")}${smCell("EDG.", vEdges, "edges")}${centerCell}</div>
    </div>`;

    return `<div style="background:${BG};border:1.5px solid ${OLIVE_MID};border-radius:12px;padding:14px 14px 14px;margin-bottom:8px;overflow:hidden">
      <div style="font-size:12px;font-weight:700;color:${OLIVE_LT};letter-spacing:2px;margin-bottom:10px;text-align:center">ROBOGRADE SCORE</div>
      <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px">${scoreBox}${subGrid}</div>
      ${provenanceHTML}
      ${sectionsHTML ? `<div style="margin:0 -14px;border-top:2px solid ${OLIVE_MID};border-bottom:1.5px solid ${OLIVE_MID};position:relative">
        <div style="position:absolute;left:0;top:0;bottom:0;width:8px;background-image:radial-gradient(circle at 4px 8px, ${OLIVE_MID} 1.5px, transparent 1.6px);background-size:8px 14px;background-repeat:repeat-y;background-color:${PAPER_CREAM};z-index:1"></div>
        <div style="position:absolute;right:0;top:0;bottom:0;width:8px;background-image:radial-gradient(circle at 4px 8px, ${OLIVE_MID} 1.5px, transparent 1.6px);background-size:8px 14px;background-repeat:repeat-y;background-color:${PAPER_CREAM};z-index:1"></div>
        <div style="margin:0 8px;background:${PAPER_CREAM}">${sectionsHTML}</div>
      </div>` : ""}
      ${pgHTML}
    </div>`;
  }

  // Expose under a namespace so we don't pollute the global scope and so the
  // intent ("this is the shared RoboGrader panel") is clear at every call site.
  // pgCell is exposed so the pre-assessment Photograder mini-panel in index.html
  // renders IDENTICAL cells to the full results panel (single source of truth —
  // prevents the two from drifting apart visually).
  window.RobograderPanel = { buildDisplay: buildRoboGradeDisplay, buildCardDisplay: buildCardDisplay, pgCell: _pgCell };
})();
