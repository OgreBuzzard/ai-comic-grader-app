// Robograder — Label viewer + print queue module (S12 rewrite)
// Loaded dynamically when the user clicks "Print Label" on a detail view.
//
// REWRITE SUMMARY (S12 May 3):
//   - Replaced popup-based label window with in-page modal overlay.
//     window.open() was failing on first tap due to async-import severing
//     the user-gesture chain that Safari requires for popups. Modal-based
//     UX is also better long-term (no popup blocker fights, works in PWA).
//   - Added queue mechanism: user can stack up to 20 labels for batch
//     printing on a single Avery 8161 sheet (2×10 layout).
//   - localStorage-backed queue, cleared on app reload (per Matt's spec —
//     this is a session feature, not persistent).
//
// LOCKED DESIGN — see DESIGN NOTES inside renderLabelMarkup() before
// changing any visual styling. The font/layout/color choices are the
// result of cross-device testing in Sessions 12+ and any drift will
// reintroduce subtle rendering bugs.
//
// Public API:
//   openLabelViewer(comic, allItems) — opens modal for the given comic.
//                                       allItems is the items[] array used
//                                       to look up queued comics at print time.

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
  #label-viewer-modal {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: none;
    align-items: center; justify-content: center;
    z-index: 1500;
    padding: 0;
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
  }
  .lvm-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px;
    background: #f4f0e8;
    border-bottom: 1px solid #e0d8c8;
  }
  .lvm-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 14px; font-weight: 700;
    color: #3a3028;
    letter-spacing: 1px; text-transform: uppercase;
  }
  .lvm-queue-count {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 13px; font-weight: 600;
    color: #5a5040;
    letter-spacing: 0.5px;
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
  /* Responsive scaling tiers — use whichever fits the available width. */
  @media (min-width: 480px) { .lvm-preview-frame { --lvm-frame-scale: 0.40; } }
  @media (min-width: 600px) { .lvm-preview-frame { --lvm-frame-scale: 0.55; } }

  /* ── Action buttons (Back / Add to Queue / Print) ────────────────────── */
  .lvm-actions {
    display: flex; gap: 8px;
    padding: 12px 16px;
    background: #f4f0e8;
    border-top: 1px solid #e0d8c8;
  }
  .lvm-btn {
    flex: 1;
    padding: 12px 8px;
    border: none;
    border-radius: 10px;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 14px; font-weight: 700;
    letter-spacing: 1px; text-transform: uppercase;
    cursor: pointer;
    line-height: 1.2;
  }
  .lvm-btn:active { transform: scale(0.97); }
  .lvm-btn-back { background: #5a4030; color: #f0e0c0; }
  .lvm-btn-back:active { background: #6a5038; }
  .lvm-btn-queue { background: #4a6028; color: #d8e8b0; }
  .lvm-btn-queue:active { background: #5a7030; }
  .lvm-btn-queue.is-queued { background: #c8b890; color: #4a3818; }
  .lvm-btn-queue.is-queued:active { background: #d8c8a0; }
  .lvm-btn-queue:disabled { background: #c0c0b0; color: #888880; cursor: not-allowed; }
  .lvm-btn-print { background: #1a2208; color: #b8d820; }
  .lvm-btn-print:active { background: #243010; }
  .lvm-btn-print:disabled {
    background: #c0c0b0; color: #888880; cursor: not-allowed;
  }

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
    position: absolute; top: 80px; right: 22px;
    font-size: 32px; font-weight: 700;
    color: #b8d820; opacity: 0.92;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    line-height: 1;
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

  /* ── Print sheet (shown only during print operation) ─────────────────── */
  /* The print sheet contains up to 20 labels in a 2×10 grid sized to Avery
     8161 (4"×1" labels, sheet 8.5"×11"). It lives in the DOM at all times
     but is hidden on screen via .lvm-print-sheet:not(.printing). When the
     user taps Print, we add .printing and call window.print(); CSS @media
     print hides everything else. */
  .lvm-print-sheet {
    display: none;
    position: fixed; inset: 0;
    background: white;
    z-index: 2000;
  }
  .lvm-print-sheet.printing { display: block; }
  .print-sheet-grid {
    width: 8.5in; height: 11in;
    margin: 0;
    padding: 0.5in 0.156in 0;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 4in 4in;
    grid-template-rows: repeat(10, 1in);
    column-gap: 0.156in;
    row-gap: 0;
    background: white;
  }
  .print-sheet-grid .rg-label,
  .print-sheet-grid .print-cell-empty {
    width: 4in;
    height: 1in;
    border: none;
    border-radius: 0;
  }
  /* Print cell: each grid cell holds one scaled label.
     Scaling math:
       Label intrinsic: 1152px wide × 288px tall
       Target rendered: 4in × 1in
       Browser default: 96 DPI → 4in = 384px, 1in = 96px
       Scale factor: 384/1152 = 0.3333... AND 96/288 = 0.3333... ✓
     Apply transform:scale(0.3333) with top-left origin so the scaled label
     fills the cell starting from its upper-left corner. */
  .print-cell {
    width: 4in; height: 1in;
    overflow: hidden;
    position: relative;
  }
  .print-cell .rg-label {
    transform-origin: top left;
    transform: scale(0.3333);
    width: 1152px; height: 288px;
  }

  /* Actual print rules. */
  @media print {
    @page {
      size: 8.5in 11in;
      margin: 0;
    }
    /* Hide everything by default during print */
    body > * { visibility: hidden !important; }
    /* Then show only the print sheet */
    .lvm-print-sheet,
    .lvm-print-sheet * {
      visibility: visible !important;
    }
    .lvm-print-sheet {
      position: absolute !important;
      left: 0; top: 0;
      width: 8.5in; height: 11in;
    }
    .lvm-print-sheet .print-sheet-grid {
      width: 8.5in; height: 11in;
    }
    /* Modal chrome must not show during print */
    #label-viewer-modal {
      visibility: hidden !important;
    }
  }
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

  const queueBtnLabel = inQueue ? 'Queued — Remove' : `Add to Queue`;
  const queueBtnClass = inQueue ? 'lvm-btn lvm-btn-queue is-queued' : 'lvm-btn lvm-btn-queue';
  const queueBtnDisabled = (!inQueue && queueCount >= QUEUE_LIMIT);

  modal.innerHTML = `
    <div class="lvm-card">
      <div class="lvm-header">
        <div class="lvm-title">Print Label</div>
        <div class="${queueClass}">Queue: ${queueCount} / ${QUEUE_LIMIT}</div>
      </div>
      <div class="lvm-preview-area">
        <div class="lvm-preview-frame">
          <div class="lvm-preview-wrap">
            ${labelHTML}
          </div>
        </div>
      </div>
      <div class="lvm-actions">
        <button class="lvm-btn lvm-btn-back" data-action="back">Back</button>
        <button class="${queueBtnClass}" data-action="toggle-queue" ${queueBtnDisabled ? 'disabled' : ''}>${queueBtnLabel}</button>
        <button class="lvm-btn lvm-btn-print" data-action="print" ${printDisabled ? 'disabled' : ''}>Print</button>
      </div>
    </div>
    <div class="lvm-print-sheet" id="lvm-print-sheet"></div>
  `;

  // Render QR for the previewed label
  renderQRsIn(modal);

  // Wire up button handlers
  modal.querySelector('[data-action="back"]').addEventListener('click', () => {
    closeModal(modal);
  });
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
    handlePrint(modal, comic, allItems);
  });

  // Open the modal
  modal.classList.add('open');
}

function closeModal(modal) {
  modal.classList.remove('open');
}

// ── Print orchestration ────────────────────────────────────────────────────
// Builds the multi-label print sheet from queued comics, calls window.print(),
// then clears the queue and closes the modal once print is initiated.

function handlePrint(modal, currentComic, allItems) {
  const queue = readQueue();
  // If the current comic is in the queue, use queue as-is. Otherwise, the
  // user tapped Print without adding to queue (Print would be disabled, but
  // defensively handle). In either case, queue is what we print.
  if (queue.length === 0) return;

  // Look up each queued comic from allItems
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

  // Build the print sheet
  const sheet = modal.querySelector('#lvm-print-sheet');
  let cellsHTML = '';
  for (let i = 0; i < QUEUE_LIMIT; i++) {
    if (i < comicsToprint.length) {
      cellsHTML += `<div class="print-cell">${renderLabelMarkup(comicsToprint[i])}</div>`;
    } else {
      cellsHTML += `<div class="print-cell-empty"></div>`;
    }
  }
  sheet.innerHTML = `<div class="print-sheet-grid">${cellsHTML}</div>`;

  // Render QR codes for all print-sheet labels
  renderQRsIn(sheet);

  // Show the print sheet, trigger print, then clean up
  sheet.classList.add('printing');

  // Allow QR rendering to complete (synchronous in qrcodejs but the layout
  // engine needs a tick to flush). 50ms is generous.
  setTimeout(() => {
    window.print();
    // After print dialog closes (or is cancelled), clear queue + reset.
    // The queue clears regardless — per spec, Print is a "send and reset"
    // operation, not a "send and keep."
    sheet.classList.remove('printing');
    clearQueue();
    closeModal(modal);
  }, 100);
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
  ensureQRCodeLoaded().then(() => {
    const qrEls = container.querySelectorAll('.qrc');
    qrEls.forEach(el => {
      const id = el.getAttribute('data-qr-id');
      if (!id) return;
      // Clear any prior contents (in case of re-render)
      el.innerHTML = '';
      new window.QRCode(el, {
        text: `https://robograder.app/id/${id}`,
        width: 118, height: 118,
        colorDark: '#1a2208', colorLight: '#d4d9be',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    });
  }).catch(err => {
    console.warn('[label] QR render failed:', err);
  });
}
