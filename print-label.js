// Robograder — Label viewer + PDF generation module (S12 rewrite)
// Loaded dynamically when the user clicks "Print Label" on a detail view.
//
// REWRITE SUMMARY (S12 May 3):
//   - Replaced popup-based label window with in-page modal overlay.
//     window.open() was failing on first tap due to async-import severing
//     the user-gesture chain that Safari requires for popups. Modal-based
//     UX is also better long-term (no popup blocker fights, works in PWA).
//   - Added queue mechanism: user can stack up to 20 labels for batch
//     PDF generation on a single Avery 8161 sheet (2×10 layout).
//   - localStorage-backed queue, cleared on app reload (per Matt's spec —
//     this is a session feature, not persistent).
//   - Pivoted from window.print() to PDF generation (jsPDF + html2canvas).
//     iOS PWA print pipeline was too unreliable: ~30-40s delays, blank-page
//     output, "blocked from automatically printing" warnings even from real
//     gestures. PDF gen is more reliable: render labels off-screen at high
//     DPI, capture each as canvas, place at exact 8161 grid positions in
//     a jsPDF document, save to user's Downloads. They open + print/AirDrop
//     from there — the PDF renders identically wherever it's printed.
//
// LOCKED DESIGN — see DESIGN NOTES inside renderLabelMarkup() before
// changing any visual styling. The font/layout/color choices are the
// result of cross-device testing in Sessions 12+ and any drift will
// reintroduce subtle rendering bugs.
//
// Public API:
//   openLabelViewer(comic, allItems) — opens modal for the given comic.
//                                       allItems is the items[] array used
//                                       to look up queued comics at PDF time.
//   clearLabelQueue()                 — clears the localStorage queue (called
//                                       by app init for session-only behavior).

const QUEUE_KEY = 'robograder.labelQueue.v1';
const QUEUE_LIMIT = 20;

// ── Queue helpers (localStorage-backed) ────────────────────────────────────
// Queue stores comic IDs only — labels render fresh from the items[] array
// at print time, so re-graded books reflect the latest assessment.

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeQueue(arr) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(arr)); }
  catch (e) { console.warn('[label queue] write failed:', e); }
}

function clearQueue() {
  try { localStorage.removeItem(QUEUE_KEY); }
  catch (e) { console.warn('[label queue] clear failed:', e); }
}

function isQueued(id) {
  return readQueue().includes(id);
}

function addToQueue(id) {
  const q = readQueue();
  if (q.includes(id)) return q;
  if (q.length >= QUEUE_LIMIT) return q;
  q.push(id);
  writeQueue(q);
  return q;
}

function removeFromQueue(id) {
  const q = readQueue().filter(x => x !== id);
  writeQueue(q);
  return q;
}

// Exposed so index.html can clear the queue on app load (per session-only spec).
export function clearLabelQueue() {
  clearQueue();
}

// ── Public entry point ─────────────────────────────────────────────────────
// Opens the modal viewer for a single comic. allItems is required so that
// when Print is tapped, queued comics can be looked up from the same array
// the rest of the app uses.
export function openLabelViewer(comic, allItems) {
  if (!comic || !comic.roboGrade) return;
  if (!Array.isArray(allItems)) {
    console.warn('[label] openLabelViewer requires allItems array');
    allItems = [comic];
  }

  // Mount modal markup if not already present. We keep one modal element in
  // the DOM and re-use it across opens so we don't accumulate orphaned nodes.
  let modal = document.getElementById('label-viewer-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'label-viewer-modal';
    document.body.appendChild(modal);
  }
  // Inject styles once
  ensureStylesInjected();

  // Pre-load the QR library now (fire-and-forget) so by the time the user
  // taps Print, the library is loaded and `new QRCode(...)` calls are
  // synchronous. Without this, the first Print tap fires window.print()
  // BEFORE QRs render and the print sheet shows blank/missing QR codes.
  ensureQRCodeLoaded().catch(err => {
    console.warn('[label] QR library preload failed:', err);
  });

  // Initial render
  renderModal(modal, comic, allItems);
}

// ── Style injection ────────────────────────────────────────────────────────
// Styles live in a single <style> block appended to <head> on first open.
// Includes both screen styles (modal chrome, scaled label preview) and print
// styles (multi-label sheet at exact Avery 8161 dimensions).

function ensureStylesInjected() {
  if (document.getElementById('label-viewer-styles')) return;

  // Load the same Google Fonts the popup version used. <link> append works
  // because we're injecting into the parent document's <head>.
  if (!document.querySelector('link[data-label-fonts]')) {
    const fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Display:wdth,wght@62.5..100,500;700;900&family=Noto+Sans+Mono:wdth,wght@62.5,800&family=Barlow+Condensed:wght@400;500;600;700;800&display=swap';
    fonts.setAttribute('data-label-fonts', 'true');
    document.head.appendChild(fonts);
  }

  const style = document.createElement('style');
  style.id = 'label-viewer-styles';
  style.textContent = `
  /* ── Modal chrome (screen only) ──────────────────────────────────────── */
  /* Body scroll lock: when the modal is open, prevent the page underneath
     from scrolling on touch. Without this, taps that land on the modal's
     translucent backdrop or even on the label preview can scroll the
     detail view behind. position:fixed on body would also work but causes
     the page to jump to the top on close on iOS. The class-based touch-
     action approach is non-disruptive. */
  body.lvm-locked {
    overflow: hidden;
    touch-action: none;
  }
  #label-viewer-modal {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: none;
    align-items: center; justify-content: center;
    z-index: 1500;
    padding: 0;
    /* Catch all touches that don't reach the card so they don't bubble to
       the page underneath. */
    touch-action: none;
  }
  #label-viewer-modal.open { display: flex; }

  .lvm-card {
    background: #fff;
    border-radius: 14px;
    width: calc(100vw - 24px);
    max-width: 720px;
    max-height: calc(100vh - 24px);
    display: flex; flex-direction: column;
    overflow: hidden;
    /* Restore native touch behavior inside the card so the preview area
       can scroll if the label exceeds height (rare but possible). */
    touch-action: auto;
  }
  .lvm-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px;
    background: #f4f0e8;
    border-bottom: 1px solid #e0d8c8;
    gap: 12px;
  }
  /* Right-side stack: Queue count on top, subtitle directly under it.
     Right-aligned so it visually pairs as a unit. The subtitle moved here
     from under the Print Label title so it sits exactly where users look
     for queue context (right under the count). */
  .lvm-header-right {
    display: flex; flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    flex-shrink: 0;
  }
  .lvm-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 14px; font-weight: 700;
    color: #3a3028;
    letter-spacing: 1px; text-transform: uppercase;
  }
  .lvm-subtitle {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 12px; font-weight: 500;
    color: #7a6a5a;
    letter-spacing: 0.3px;
    text-align: right;
  }
  .lvm-queue-count {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 13px; font-weight: 600;
    color: #5a5040;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }
  .lvm-queue-count.full { color: #a04018; }

  /* Scaled label preview area. Label is 1152px wide (Avery 8161 at 288 DPI);
     the preview scales it to fit the modal width regardless of viewport.
     CSS transform: scale() preserves visual fidelity perfectly while letting
     us collapse the apparent height afterward via wrapper sizing. */
  .lvm-preview-area {
    background: #f0ece4;
    padding: 16px;
    overflow: auto;
    flex: 1 1 auto;
    min-height: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .lvm-preview-wrap {
    /* 1152x288 scaled to fit a typical phone width (~360px usable area
       after modal padding). 360/1152 ≈ 0.31. We use 0.32 as the default
       and let CSS variables override per breakpoint below. */
    --lvm-scale: 0.32;
    width: 1152px;
    height: 288px;
    transform: scale(var(--lvm-scale));
    transform-origin: top left;
    /* When scaling, the element occupies its UN-scaled size in flow. We
       compensate by overriding flow-size via outer wrapper. */
  }
  /* Outer container that consumes only the scaled visual size. The trick:
     wrap .lvm-preview-wrap in a div whose width/height are the SCALED
     dimensions, then position the scaled element absolutely inside. This
     way flow layout uses the visible size, not the 1152x288 intrinsic. */
  .lvm-preview-frame {
    position: relative;
    width: calc(1152px * var(--lvm-frame-scale, 0.32));
    height: calc(288px * var(--lvm-frame-scale, 0.32));
    overflow: hidden;
  }
  .lvm-preview-frame .lvm-preview-wrap {
    position: absolute;
    top: 0; left: 0;
    --lvm-scale: var(--lvm-frame-scale, 0.32);
  }
  /* CSS-only fallback scaling tiers in case fitPreviewToFrame() doesn't run
     (e.g. JS error before measurement). The JS-computed scale overrides
     these via inline style. */
  @media (min-width: 480px) { .lvm-preview-frame { --lvm-frame-scale: 0.40; } }
  @media (min-width: 600px) { .lvm-preview-frame { --lvm-frame-scale: 0.55; } }

  /* ── Action buttons (Back / Add to Queue / Print) ────────────────────── */
  .lvm-actions {
    display: flex; gap: 8px;
    padding: 12px 16px;
    background: #f4f0e8;
    border-top: 1px solid #e0d8c8;
  }
  /* Modal action buttons use the canonical .rg-btn-* system from the host
     page (added S12 May 3). The only modal-specific override is flex:1 so
     the buttons fill the action bar evenly. The Queue toggle gets a
     slightly smaller font when its long "Remove from Queue" label is
     active so it doesn't wrap to three lines. */
  .lvm-actions .rg-btn { flex: 1; }
  .rg-btn-queue-active { font-size: 12px !important; }

  /* ── Label visual styles (used in both preview AND print sheet) ──────── */
  .rg-label {
    width: 1152px; height: 288px;
    background: #d4d9be;
    border: 1px solid #8a9a6a;
    border-radius: 4px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  .rg-label .score-box {
    width: 252px; height: 252px;
    background: #1a2208;
    border-radius: 38px;
    position: absolute;
    left: 14px; top: 18px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label .rg-word {
    font-size: 24px; font-weight: 700;
    color: #6a8030; letter-spacing: 3px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 14px;
  }
  .rg-label .rg-num {
    font-size: 148px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
  }
  .rg-label .rg-prec {
    position: absolute; top: 60px; right: 18px;
    font-size: 26px; font-weight: 700;
    color: #b8d820; opacity: 0.92;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    line-height: 1;
    /* Extra space between the ± and the digit so they read as separate
       characters. Without this, the condensed font crowds them together
       to where the symbol disappears into the digit visually. */
    letter-spacing: 2px;
  }
  .rg-label .rg-v {
    font-size: 20px;
    color: #5a7030;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 14px;
    letter-spacing: 1px;
  }
  .rg-label .info {
    position: absolute;
    left: 282px; top: 18px; right: 144px;
    display: flex; flex-direction: column;
  }
  .rg-label .info-upper {
    padding-bottom: 8px;
    border-bottom: 1px solid #b0b89a;
    margin-bottom: 0;
  }
  .rg-label .ttl {
    font-size: 38px; font-weight: 900;
    color: #0d0d0f; line-height: 1.1;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
  }
  .rg-label .iss {
    font-size: 26px; font-weight: 600;
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    display: flex; gap: 24px; align-items: baseline;
  }
  .rg-label .prt {
    font-size: 20px; color: #555544;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
  }
  .rg-label .info-lower { padding-top: 10px; }
  .rg-label .meta-grid {
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 16px; row-gap: 5px;
    align-items: baseline;
  }
  .rg-label .meta-lbl {
    font-size: 22px; font-weight: 600;
    color: #7a8a5a;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label .meta-val {
    font-size: 22px; font-weight: 800;
    color: #0d0d0f;
    font-family: 'Noto Sans Mono', monospace;
  }
  .rg-label .qr-col {
    position: absolute;
    right: 12px; top: 14px;
    width: 122px;
    display: flex; flex-direction: column;
    align-items: center; gap: 4px;
  }
  .rg-label .qr-col .qrc canvas,
  .rg-label .qr-col .qrc img {
    width: 118px !important;
    height: 118px !important;
  }
  .rg-label .verify {
    font-size: 14px; color: #7a8a5a;
    letter-spacing: 1px;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600; text-align: center;
  }
  .rg-label .url {
    font-size: 16px; color: #5a6a4a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: right;
    position: absolute;
    right: 12px; bottom: 18px;
    letter-spacing: 0.2px;
  }

  /* Print sheet markup is no longer used — PDF generation (handleSavePDF)
     replaces window.print() entirely. The label DOM is captured by
     html2canvas off-screen and embedded into a jsPDF document. See
     handleSavePDF / generatePDF below for details. */
  `;
  document.head.appendChild(style);
}

// ── Render the modal contents for a given comic ────────────────────────────

function renderModal(modal, comic, allItems) {
  const queue = readQueue();
  const queueCount = queue.length;
  const inQueue = queue.includes(comic.id);
  const printDisabled = queueCount === 0 && !inQueue;

  const labelHTML = renderLabelMarkup(comic);
  const queueClass = queueCount >= QUEUE_LIMIT ? 'lvm-queue-count full' : 'lvm-queue-count';

  const queueBtnLabel = inQueue ? 'Remove from Queue' : `Add to Queue`;
  // When in queue, use secondary style — "Remove from Queue" is an undo
  // action, not destructive ("undestructive"). Destructive styling read as
  // "are you sure you want to do this irreversibly" which overstates the
  // weight; removing from queue is just reversing the recent add. Primary
  // for the affirmative add when not in queue.
  const queueBtnCategory = inQueue ? 'rg-btn-secondary' : 'rg-btn-primary';
  // The "Remove from Queue" label is long; mark it for the small-font tweak.
  const queueBtnSizeMod = inQueue ? 'rg-btn-queue-active' : '';
  const queueBtnDisabled = (!inQueue && queueCount >= QUEUE_LIMIT);

  modal.innerHTML = `
    <div class="lvm-card">
      <div class="lvm-header">
        <div class="lvm-title">Print Label</div>
        <div class="lvm-header-right">
          <div class="${queueClass}">Queue: ${queueCount} / ${QUEUE_LIMIT}</div>
          <div class="lvm-subtitle">Labels print 20 to a sheet</div>
        </div>
      </div>
      <div class="lvm-preview-area">
        <div class="lvm-preview-frame">
          <div class="lvm-preview-wrap">
            ${labelHTML}
          </div>
        </div>
      </div>
      <div class="lvm-actions">
        <button class="rg-btn ${queueBtnCategory} rg-btn-md ${queueBtnSizeMod}" data-action="toggle-queue" ${queueBtnDisabled ? 'disabled' : ''}>${queueBtnLabel}</button>
        <button class="rg-btn rg-btn-primary rg-btn-md" data-action="print" ${printDisabled ? 'disabled' : ''}>Save as PDF</button>
      </div>
    </div>
  `;

  // Render QR for the previewed label
  renderQRsIn(modal);

  // Wire up button handlers. Back button removed in favor of tap-outside-
  // to-close — see backdrop handler below. Tap-outside semantically reads
  // as "freeze and step away", which preserves the queue. A "Back" button
  // reads as Cancel — and tapping it after just adding to the queue would
  // feel like erasing what you just added. Tap-outside avoids that conflict.
  modal.querySelector('[data-action="toggle-queue"]').addEventListener('click', (e) => {
    if (e.currentTarget.disabled) return;
    if (isQueued(comic.id)) {
      removeFromQueue(comic.id);
    } else {
      addToQueue(comic.id);
    }
    // Re-render to reflect new state
    renderModal(modal, comic, allItems);
  });
  modal.querySelector('[data-action="print"]').addEventListener('click', (e) => {
    if (e.currentTarget.disabled) return;
    handleSavePDF(modal, comic, allItems);
  });

  // Tap-outside-to-close. Backdrop click closes; clicks on .lvm-card stop
  // propagation so they don't reach the backdrop handler.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal(modal);
  });
  const card = modal.querySelector('.lvm-card');
  if (card) {
    card.addEventListener('click', (e) => e.stopPropagation());
  }

  // Open the modal + lock body scroll so the page underneath can't scroll
  // when the user touches the preview area (which fills most of the screen
  // on phones).
  modal.classList.add('open');
  document.body.classList.add('lvm-locked');

  // Compute the preview scale dynamically based on the actual preview area
  // width. This is more reliable than CSS breakpoints because the modal
  // width depends on viewport, padding, and dynamic platform chrome (e.g.
  // PWA safe-area insets) — none of which CSS media queries can capture.
  // Run on next tick so the modal layout has settled.
  requestAnimationFrame(() => fitPreviewToFrame(modal));
}

function closeModal(modal) {
  modal.classList.remove('open');
  document.body.classList.remove('lvm-locked');
}

// Measure the preview-area width and set the CSS variable that scales the
// preview so the entire 1152px label fits comfortably inside.
function fitPreviewToFrame(modal) {
  const area = modal.querySelector('.lvm-preview-area');
  const frame = modal.querySelector('.lvm-preview-frame');
  if (!area || !frame) return;
  // Available width = preview area's content width minus its horizontal
  // padding (which is 2 × 16px = 32px in the CSS below).
  const areaStyle = getComputedStyle(area);
  const padX = parseFloat(areaStyle.paddingLeft) + parseFloat(areaStyle.paddingRight);
  // Pull in another 4% margin so the label visibly clears the modal edges
  // — a label that touches the right edge looks clipped even if it's not.
  const avail = (area.clientWidth - padX) * 0.96;
  if (avail <= 0) return;
  // Label intrinsic width is 1152px. Compute scale factor and clamp to a
  // sensible max so we don't blow up the label on huge displays.
  const scale = Math.min(0.85, Math.max(0.18, avail / 1152));
  frame.style.setProperty('--lvm-frame-scale', scale.toFixed(4));
}

// ── PDF generation (jsPDF + html2canvas) ───────────────────────────────────
// We replaced window.print() with PDF generation in S12 because iOS PWA's
// print pipeline was unreliable: ~30-40s delay before the print dialog
// appeared, blank-page output, and Safari's "blocked from automatically
// printing" warning even when called from a real user gesture.
//
// PDF generation is more reliable: we render labels at high DPI, place them
// at exact Avery 8161 grid positions, and hand the user a downloaded PDF.
// They open it in iOS Files / Preview and print/AirDrop/share from there.
// The PDF renders identically wherever it's printed.
//
// Library loading: jsPDF and html2canvas both ~150KB combined. Lazy-loaded
// on first Save tap so the module pre-warm doesn't pay this cost upfront.

let _pdfLibsPromise = null;
function ensurePdfLibsLoaded() {
  if (window.jspdf && window.html2canvas) return Promise.resolve();
  if (_pdfLibsPromise) return _pdfLibsPromise;
  _pdfLibsPromise = Promise.all([
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'),
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
  ]);
  return _pdfLibsPromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load: ' + src));
    document.head.appendChild(s);
  });
}

async function handleSavePDF(modal, currentComic, allItems) {
  const queue = readQueue();
  if (queue.length === 0) return;

  const itemsById = new Map(allItems.map(c => [c.id, c]));
  const comicsToprint = queue
    .map(id => itemsById.get(id))
    .filter(c => c && c.roboGrade);

  if (comicsToprint.length === 0) {
    alert('Queued labels could not be found. Queue cleared.');
    clearQueue();
    renderModal(modal, currentComic, allItems);
    return;
  }

  // Show a transient "Generating PDF…" overlay so the user knows something
  // is happening (PDF gen takes 2-5s for a full sheet).
  const saveBtn = modal.querySelector('[data-action="print"]');
  const origLabel = saveBtn ? saveBtn.textContent : 'Save as PDF';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Generating…';
  }

  try {
    await ensurePdfLibsLoaded();
    await generatePDF(comicsToprint, modal);
    // Success — clear queue and re-render to show empty state
    clearQueue();
    renderModal(modal, currentComic, allItems);
  } catch (err) {
    console.error('[label] PDF generation failed:', err);
    alert('PDF generation failed: ' + err.message);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = origLabel;
    }
  }
}

// Renders the print sheet's labels off-screen at high DPI, captures each as
// a canvas via html2canvas, places them at exact Avery 8161 grid positions
// in a jsPDF document, and triggers the download.
//
// 8161 grid positions (extracted from the official Avery PDF template):
//   Top margin:    0.5in
//   Left margin:   0.1667in
//   Label:         4in × 1in
//   Column gap:    0.1882in
//   Row gap:       0in
//   2 columns × 10 rows = 20 labels per sheet
async function generatePDF(comics, modal) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'in',
    format: 'letter',  // 8.5 × 11
  });

  // Off-screen container for rendering labels at high DPI. We keep this in
  // the DOM (not display:none) so html2canvas can measure it correctly, but
  // position it off-screen via absolute positioning + negative coordinates.
  const offscreen = document.createElement('div');
  offscreen.style.cssText = 'position:fixed;left:-99999px;top:0;background:white;';
  document.body.appendChild(offscreen);

  try {
    // Pre-render all 20 cell labels (real ones + blanks) in the off-screen
    // container so html2canvas can capture each. Doing this in batch is
    // faster than serial appending.
    let labelsHTML = '';
    for (let i = 0; i < QUEUE_LIMIT; i++) {
      if (i < comics.length) {
        labelsHTML += `<div class="pdf-label-box" data-idx="${i}" style="width:1152px;height:288px;display:block;background:#d4d9be;">${renderLabelMarkup(comics[i])}</div>`;
      }
      // Skip blank cells — no need to render or place them in the PDF
    }
    offscreen.innerHTML = labelsHTML;

    // Render QR codes synchronously (library is already loaded from the
    // modal preview path).
    renderQRsIn(offscreen);

    // Wait one animation frame so layout + QR canvases are flushed before
    // html2canvas captures.
    await new Promise(r => requestAnimationFrame(r));

    // Capture each label and place in PDF at correct grid position.
    const boxes = offscreen.querySelectorAll('.pdf-label-box');
    for (let i = 0; i < boxes.length; i++) {
      const idx = parseInt(boxes[i].dataset.idx, 10);
      const col = idx % 2;        // 0 = left column, 1 = right column
      const row = Math.floor(idx / 2);  // 0-9
      const x = 0.1667 + col * (4 + 0.1882);  // inches
      const y = 0.5 + row * 1.0;  // inches

      // html2canvas at 2× for crisper output without ballooning PDF size
      const canvas = await window.html2canvas(boxes[i], {
        scale: 2,
        useCORS: true,
        backgroundColor: '#d4d9be',
        logging: false,
      });
      const imgData = canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', x, y, 4, 1);
    }

    // Save / download. iOS Safari saves to Files → Downloads. Desktop
    // browsers save to default Downloads folder.
    const filename = `Robograder-Labels-${new Date().toISOString().slice(0, 10)}.pdf`;
    pdf.save(filename);
  } finally {
    // Always clean up the off-screen container
    document.body.removeChild(offscreen);
  }
}

// ── Label markup builder ───────────────────────────────────────────────────
// Builds the HTML for a single label. Used for both the modal preview and
// each cell of the print sheet. Scaling is handled by the container, not
// here — this always returns 1152×288 markup.
//
// LOCKED DESIGN — see rewrite header above. Specifically protected:
//   - Dark olive score box (#1a2208) with chartreuse number (#b8d820)
//   - 38px score-box corner radius
//   - Score box wordmark "ROBOGRADE" (not ROBOGRADER) — book is the result
//   - 1152×288 absolute label dimensions (Avery 8161 at 288 DPI = 4"×1")
//   - QR + URL point to robograder.app

function renderLabelMarkup(comic) {
  const rg = comic.roboGrade;
  const score = Math.round(rg.score ?? 0);

  // Precision suffix logic (same four-tier rule as the popup version):
  //   100 → no suffix
  //   High-grade run → ±N (narrower confidence range, default ±3)
  //   Initial only, 80+ → "+"
  //   Initial only, <80 → ±N (default ±8)
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

  const title = esc(comic.title || '');
  const issue = comic.issue ? `#${esc(comic.issue)}` : '';
  const issueDate = esc(comic.issueDate || '');
  const printing = comic.printing ? esc(comic.printing) : '';
  const gradeId = esc(comic.roboGradeId || 'XXXXXX');
  const _dateObj = comic.roboGradeDate ? new Date(comic.roboGradeDate) : new Date();
  const gradeDate = _dateObj.toLocaleDateString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }).replace(/\//g, '/');

  return `
    <div class="rg-label" data-grade-id="${gradeId}">
      <div class="score-box">
        <div class="rg-word">ROBOGRADE</div>
        <div class="rg-num">${score}</div>
        ${precision ? `<div class="rg-prec">${precision}</div>` : ''}
        <div class="rg-v">V2.0</div>
      </div>
      <div class="info">
        <div class="info-upper">
          <div class="ttl">${title}</div>
          <div class="iss">${issue ? `<span>${issue}</span>` : ''}${issueDate ? `<span>${issueDate}</span>` : ''}</div>
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
        <div class="qrc" data-qr-id="${gradeId}"></div>
        <div class="verify">SCAN TO VERIFY</div>
      </div>
      <div class="url">robograder.app/id/${gradeId}</div>
    </div>
  `;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── QR code rendering ──────────────────────────────────────────────────────
// qrcodejs is loaded on first use via dynamic script tag. Subsequent calls
// reuse the global. Each .qrc element gets its own QR generated from the
// data-qr-id attribute.

let _qrcodeLoadPromise = null;
function ensureQRCodeLoaded() {
  if (window.QRCode) return Promise.resolve();
  if (_qrcodeLoadPromise) return _qrcodeLoadPromise;
  _qrcodeLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('QR library failed to load'));
    document.head.appendChild(script);
  });
  return _qrcodeLoadPromise;
}

function renderQRsIn(container) {
  // Synchronous path when QR library is already loaded. This is critical
  // for the print path: window.print() must be called in the same tick as
  // the user gesture to avoid Safari's "blocked from automatically printing"
  // dialog, so QR rendering must NOT defer to a microtask.
  if (window.QRCode) {
    renderQRsImmediately(container);
    return;
  }
  // Fallback: library not yet loaded, render after it arrives. Used only by
  // the modal preview at first-open if user taps Print before preload finishes.
  ensureQRCodeLoaded().then(() => {
    renderQRsImmediately(container);
  }).catch(err => {
    console.warn('[label] QR render failed:', err);
  });
}

function renderQRsImmediately(container) {
  const qrEls = container.querySelectorAll('.qrc');
  qrEls.forEach(el => {
    const id = el.getAttribute('data-qr-id');
    if (!id) return;
    el.innerHTML = '';  // clear any prior contents
    new window.QRCode(el, {
      text: `https://robograder.app/id/${id}`,
      width: 118, height: 118,
      colorDark: '#1a2208', colorLight: '#d4d9be',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  });
}
