// Robograder — Label printing module
// Loaded dynamically when the user clicks "Print Label" on a detail view.
// Self-contained: no app state required; receives the comic record as an argument.
//
// LOCKED DESIGN — see DESIGN NOTES inside printLabelForComic() before changing
// anything. The font/layout/color choices are the result of cross-device testing
// in Session 12 and any drift will reintroduce subtle rendering bugs.

export function printLabelForComic(comic) {
  if (!comic || !comic.roboGrade) return;

  const rg = comic.roboGrade;
  const score = Math.round(rg.score ?? 0);
  // ── Precision suffix logic ──────────────────────────────────────────────
  // 100 → no suffix (perfect score, no uncertainty to express)
  // High-grade unlocked → ±N (narrower confidence range, e.g. ±3)
  // Initial only, 80+   → "+" (signals "hasn't run high-grade assessment yet")
  // Initial only, <80   → ±N (standard confidence range, e.g. ±8)
  const highGradeRun = !!comic.highGradeUnlocked;
  let precision = '';
  if (score < 100) {
    if (highGradeRun) {
      precision = `±${rg.confidenceRange || 3}`;
    } else if (score >= 80) {
      precision = '+';
    } else {
      precision = `±${rg.confidenceRange || 8}`;
    }
  }
  const title = comic.title || '';
  const issue = comic.issue ? `#${comic.issue}` : '';
  const issueDate = comic.issueDate || '';
  const printing = comic.printing || null;
  const gradeId = comic.roboGradeId || 'XXXXXX';
  const _dateObj = comic.roboGradeDate ? new Date(comic.roboGradeDate) : new Date();
  const gradeDate = _dateObj.toLocaleDateString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }).replace(/\//g, '/');

  // ── DESIGN NOTES (DO NOT DRIFT) ──────────────────────────────────────────
  // This label was iterated over Session 12 to a locked baseline. CSS below
  // is the validated design. Subsequent edits should ONLY change behavior
  // explicitly approved by Matt; do not refactor styling for "consistency"
  // with other parts of the app — this label is its own surface.
  //
  // Specifically protected decisions (do not change without Matt's approval):
  //   - Dark olive score box (#1a2208) with chartreuse number (#b8d820)
  //   - 38px score-box corner radius
  //   - Score box wordmark "ROBOGRADE" (not ROBOGRADER) — book is the result
  //   - 1152×288 absolute label dimensions (Avery 8161 at 288 DPI = 4"×1")
  //   - QR + URL point to robograder.app
  //
  // Avery 8161 layout (S12 May 2): switched from 5160 (2.625"×1", 30/sheet)
  // because 5160 was too small in physical use. 8161 is 4"×1", 20/sheet (2×10).
  // The extra ~400px of width was distributed to the info column — title
  // and meta block now have comfortable breathing room. Score box and QR
  // module dimensions retained at 5160 sizing to keep the score the visual
  // anchor of the label.
  //
  // Font system (the key insight from Session 12):
  //   - Original code used `font-family: sans-serif` which on iPhone Safari
  //     resolves to a CONDENSED width of San Francisco, but on macOS/Chrome
  //     resolves to a regular-width system sans. This caused the label to
  //     render visibly heavier on every device that wasn't Matt's iPhone.
  //   - Fix: use Barlow Condensed (Google Font) for everything that was
  //     previously `sans-serif`, and engage `font-stretch: 62.5%` on the
  //     Noto variable fonts (Display + Mono). This locks the rendering
  //     identically across every device.
  //   - URL line uses a system-mono stack to look like a browser address bar.
  //
  // Layout decisions (also locked):
  //   - Info column anchored to TOP of label (was bottom-anchored in the
  //     pre-locked version; switched per Matt's request so empty space sits
  //     below the meta block, not above the title)
  //   - 1st Printing line appears BELOW issue+date (was above pre-Session-12)
  //   - Precision suffix `position: absolute; top: 80px; right: 22px` so the
  //     score number stays perfectly centered (precision overlays, not flexes)
  //   - GRADED/ID labels right-aligned, values left-aligned, in CSS grid so
  //     the right edge of "GRADED" and "ID" land on the same vertical line
  //
  // Precision logic (also locked, per the four-tier rule above):
  //   - 100 → no suffix
  //   - High-grade run → ±N (small confidence range)
  //   - Initial only, 80+ → "+"
  //   - Initial only, <80 → ±N (standard confidence range)
  //
  // Version stamp: V2.0
  // ────────────────────────────────────────────────────────────────────────

  const win = window.open('', '_blank', 'width=900,height=700');
  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>RoboGrade Label — ${title} ${issue}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
  /* Variable fonts with width axis (Noto family) + Barlow Condensed for
     non-display text. See DESIGN NOTES above for why this matters. */
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Display:wdth,wght@62.5..100,500;700;900&family=Noto+Sans+Mono:wdth,wght@62.5,800&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; gap: 20px; font-family: 'Barlow Condensed', sans-serif; }
  .label-wrap { width: 1152px; height: 288px; position: relative; }
  .label {
    width: 1152px; height: 288px;
    background: #d4d9be;
    border: 1px solid #8a9a6a;
    border-radius: 4px;
    display: flex;
    overflow: hidden;
    position: relative;
  }
  .score-box {
    width: 252px; height: 252px;
    background: #1a2208;
    border-radius: 38px;
    position: absolute;
    left: 14px; top: 18px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-word { font-size: 24px; font-weight: 700; color: #6a8030; letter-spacing: 3px; font-family: 'Barlow Condensed', sans-serif; position: absolute; top: 14px; }
  .rg-num { font-size: 148px; font-weight: 900; color: #b8d820; line-height: 1; font-family: 'Noto Sans Display', sans-serif; font-stretch: 62.5%; }
  /* Precision overlays absolutely so it cannot affect score-number centering */
  .rg-prec { position: absolute; top: 80px; right: 22px; font-size: 32px; font-weight: 700; color: #b8d820; opacity: 0.92; font-family: 'Barlow Condensed', sans-serif; line-height: 1; }
  .rg-v { font-size: 20px; color: #5a7030; font-family: 'Barlow Condensed', sans-serif; font-weight: 500; position: absolute; bottom: 14px; letter-spacing: 1px; }
  /* Info column TOP-anchored; flows downward from there.
     Right boundary at 144px from edge keeps the QR+URL block clear.
     Width grew from ~330px (5160) to ~726px (8161) — about 2.2× more
     horizontal room for the title, issue, and meta block. */
  .info { position: absolute; left: 282px; top: 18px; right: 144px; display: flex; flex-direction: column; }
  .info-upper { padding-bottom: 8px; border-bottom: 1px solid #b0b89a; margin-bottom: 0; }
  /* Title font bumped from 32px to 38px to fill the wider label without
     looking sparse. Meta-block fonts also get small bumps for proportion. */
  .ttl { font-size: 38px; font-weight: 900; color: #0d0d0f; line-height: 1.1; font-family: 'Noto Sans Display', sans-serif; font-stretch: 62.5%; }
  /* Issue + date uses Noto Sans Display 500 (lighter, condensed, contrasts w/ title weight) */
  .iss { font-size: 26px; font-weight: 500; color: #333; font-family: 'Noto Sans Display', sans-serif; font-stretch: 62.5%; }
  .prt { font-size: 20px; color: #555544; font-family: 'Barlow Condensed', sans-serif; font-weight: 500; }
  .info-lower { padding-top: 10px; }
  /* Grid alignment: GRADED and ID right-aligned to same column edge; values left-aligned in their own column */
  .meta-grid { display: grid; grid-template-columns: max-content max-content; column-gap: 16px; row-gap: 5px; align-items: baseline; }
  .meta-lbl { font-size: 22px; font-weight: 600; color: #7a8a5a; font-family: 'Barlow Condensed', sans-serif; text-align: right; letter-spacing: 0.5px; }
  /* Mono values: Noto Sans Mono with wdth=62.5 already loaded — no explicit font-stretch needed */
  .meta-val { font-size: 22px; font-weight: 800; color: #0d0d0f; font-family: 'Noto Sans Mono', monospace; }
  .qr-col { position: absolute; right: 12px; top: 14px; width: 122px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .qr-col #qrc canvas, .qr-col #qrc img { width: 118px !important; height: 118px !important; }
  .verify { font-size: 14px; color: #7a8a5a; letter-spacing: 1px; font-family: 'Barlow Condensed', sans-serif; font-weight: 600; text-align: center; }
  /* URL uses system mono stack so it reads like a browser address bar */
  .url { font-size: 16px; color: #5a6a4a; font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace; font-weight: 500; text-align: right; position: absolute; right: 12px; bottom: 18px; letter-spacing: 0.2px; }
  .action-row { display: flex; gap: 14px; margin-top: 8px; }
  .btn-print, .btn-back {
    padding: 16px 40px; border: none; border-radius: 10px;
    font-size: 18px; font-weight: 800; cursor: pointer;
    letter-spacing: 1.5px; min-width: 180px;
    font-family: 'Barlow Condensed', sans-serif;
  }
  .btn-print { background: #1a2208; color: #b8d820; }
  .btn-back { background: #5a4030; color: #f0e0c0; }
  .btn-print:hover { background: #243010; }
  .btn-back:hover { background: #6a5038; }
  .labels-link {
    margin-top: 18px; font-size: 13px; color: #555544; text-align: center;
  }
  .labels-link a { color: #1a5fa8; text-decoration: underline; }
  @media print {
    body { margin: 0; background: white; justify-content: flex-start; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
<div class="label">
  <div class="score-box">
    <div class="rg-word">ROBOGRADE</div>
    <div class="rg-num">${score}</div>
    ${precision ? `<div class="rg-prec">${precision}</div>` : ''}
    <div class="rg-v">V2.0</div>
  </div>
  <div class="info">
    <div class="info-upper">
      <div class="ttl">${title}</div>
      <div class="iss">${issue}${issueDate ? '   ' + issueDate : ''}</div>
      ${printing ? `<div class="prt">${printing}</div>` : ''}
    </div>
    <div class="info-lower">
      <div class="meta-grid">
        <span class="meta-lbl">GRADED</span><span class="meta-val">${gradeDate}</span>
        <span class="meta-lbl">ID</span><span class="meta-val">${gradeId}</span>
      </div>
    </div>
  </div>
  <div class="qr-col">
    <div id="qrc"></div>
    <div class="verify">SCAN TO VERIFY</div>
  </div>
  <div class="url">robograder.app/id/${gradeId}</div>
</div>
<div class="action-row no-print">
  <button class="btn-back" onclick="window.close()">← Back</button>
  <button class="btn-print" onclick="window.print()">Print</button>
</div>
<div class="labels-link no-print">
  Prints on Avery 8161 address labels —
  <a href="https://www.amazon.com/s?k=avery+8161+labels" target="_blank" rel="noopener">buy on Amazon</a>
</div>
<script>
  new QRCode(document.getElementById('qrc'), {
    text: 'https://robograder.app/id/${gradeId}',
    width: 118, height: 118,
    colorDark: '#1a2208', colorLight: '#d4d9be',
    correctLevel: QRCode.CorrectLevel.M
  });
<\/script>
</body></html>`);
  win.document.close();
}
