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

// ── Format definitions ─────────────────────────────────────────────────────
// Two label sheet formats supported (S12, May 5):
//
//   SMALL — Avery 8161 (4" × 1") — 20 per sheet, 2 columns × 10 rows
//     The default. Designed for general-purpose labeling on bagged-and-boarded
//     comics. Dimensions extracted from the official Avery 8161 PDF template:
//     top margin 0.5", left margin 0.1667", column gap 0.1882", no row gap.
//
//   LARGE — OL5450 (7.5" × 1.5") — 7 per sheet, 1 column × 7 rows
//     Sized to fit over the front label on a CGC slab. Wider and taller
//     than the Small format. Top margin 0.25", left margin 0.5", no gaps.
//     Source: dimensions verified against the official OL5450 template.
//
// Pixel dimensions for the rendered label markup are at 288 DPI so the
// jsPDF output preserves crisp QR codes and text at print resolution.
const LABEL_FORMATS = {
  small: {
    name: 'small',
    sheetCount: 20,
    rows: 10, cols: 2,
    labelW: 4.0, labelH: 1.0,      // inches
    sheetTopMargin: 0.5,
    sheetLeftMargin: 0.1667,
    colGap: 0.1882,
    rowGap: 0,
    pixelW: 1152, pixelH: 288      // 288 DPI canonical render
  },
  // S12 May 6: Square format (Avery 22806 / OnlineLabels OL3016 — same grid).
  // 2"×2" labels, 12 per sheet (3 cols × 4 rows). Spec verified from the
  // OnlineLabels OL3016 product page (the 22806 template is a cross-brand
  // standard so any seller's "12-per-sheet 2×2" sheet will align):
  //   Top/bottom margins: 0.25"
  //   Left/right margins: 0.25"
  //   Horizontal pitch:   3"     (label 2" + gap 1")
  //   Vertical pitch:     2.8333" (label 2" + gap 0.8333")
  // Pixel canvas: 576 × 576 at 288 DPI (matches Small's 288 DPI density).
  // Recommended Amazon source: Avery 22806 — https://a.co/d/0fMlMbAB
  square: {
    name: 'square',
    sheetCount: 12,
    rows: 4, cols: 3,
    labelW: 2.0, labelH: 2.0,
    sheetTopMargin: 0.25,
    sheetLeftMargin: 0.25,
    colGap: 1.0,                   // horizontal gap between labels
    rowGap: 0.8333,                // vertical gap between labels
    pixelW: 576, pixelH: 576       // 288 DPI canonical render
  },
  large: {
    name: 'large',
    sheetCount: 7,
    rows: 7, cols: 1,
    labelW: 7.5, labelH: 1.5,
    sheetTopMargin: 0.25,
    sheetLeftMargin: 0.5,
    colGap: 0,
    rowGap: 0,
    pixelW: 2160, pixelH: 432
  }
};

// ── Purchase links (S12 May 6) ─────────────────────────────────────────────
// Where to buy the actual label sheets for each format. Surfaced in the
// Print Label modal as a subtle helper strip beneath the size toggle. Not
// affiliate links; informational convenience only.
//
//   small  → Avery 8161 on Amazon (1×4, 20 per sheet, mailing labels —
//            the most universally available collector option)
//   square → Avery 22806 on Amazon (2×2, 12 per sheet — the new default;
//            short Amazon shortlink provided by Matt)
//   large  → OL5450 on OnlineLabels (7.5×1.5, 7 per sheet — only sold by
//            OnlineLabels under their "Water Bottle Labels" SKU; matches
//            CGC slab-label dimensions for slab overlay use)
const LABEL_BUY_LINKS = {
  small: {
    label: 'Avery 8161',
    url: 'https://www.amazon.com/Avery-White-Inkjet-Address-Labels/dp/B01LXUAKOY',
    vendor: 'Amazon'
  },
  square: {
    label: 'Avery 22806',
    url: 'https://a.co/d/0fMlMbAB',
    vendor: 'Amazon'
  },
  large: {
    label: 'OL5450',
    url: 'https://www.onlinelabels.com/products/OL5450',
    vendor: 'OnlineLabels'
  }
};

// ── Label options (persisted via localStorage) ─────────────────────────────
// User's size + price-tag toggle preferences. Persists across sessions so a
// user printing CGC-slab labels doesn't have to reset Small every open.
//
// S12 May 6: square (Avery 22806, 12/sheet) is the new default. The square
// format addresses the placement problem identified in the May 5 print test:
// rectangular labels obscure too much horizontal cover real estate. The
// square shape lets users place a label in the upper-right of a comic
// without clipping into the title or Marvel/DC box.
const OPTIONS_KEY = 'robograder.labelOptions.v1';

const VALID_SIZES = ['small', 'square', 'large'];

function readOptions() {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return { size: 'square', priceTag: false, includePrice: false };
    const o = JSON.parse(raw);
    return {
      // Validated against the known set; unknown values fall back to square
      // (the new default). Pre-S12-May-6 stored values of 'small' or 'large'
      // are preserved as-is for users who'd already chosen one.
      size: VALID_SIZES.includes(o.size) ? o.size : 'square',
      priceTag: !!o.priceTag,
      // S12: includePrice controls whether the comic's askingPrice is rendered
      // INSIDE the price pad. Only meaningful when priceTag is also true and
      // the comic has an askingPrice set. UI toggle for this is conditionally
      // shown — see renderModal.
      includePrice: !!o.includePrice
    };
  } catch { return { size: 'square', priceTag: false, includePrice: false }; }
}

function writeOptions(opts) {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts)); }
  catch (e) { console.warn('[label options] write failed:', e); }
}

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
    /* Size of the canonical label markup. Defaults match Large (1152×288);
       overridden inline for Small (2160×432). */
    --lvm-label-w: 1152px;
    --lvm-label-h: 288px;
    --lvm-scale: 0.32;
    width: var(--lvm-label-w);
    height: var(--lvm-label-h);
    transform: scale(var(--lvm-scale));
    transform-origin: top left;
    /* When scaling, the element occupies its UN-scaled size in flow. We
       compensate by overriding flow-size via outer wrapper. */
  }
  /* Outer container that consumes only the scaled visual size. The trick:
     wrap .lvm-preview-wrap in a div whose width/height are the SCALED
     dimensions, then position the scaled element absolutely inside. This
     way flow layout uses the visible size, not the canonical intrinsic. */
  .lvm-preview-frame {
    position: relative;
    --lvm-label-w: 1152px;
    --lvm-label-h: 288px;
    width: calc(var(--lvm-label-w) * var(--lvm-frame-scale, 0.32));
    height: calc(var(--lvm-label-h) * var(--lvm-frame-scale, 0.32));
    overflow: hidden;
  }
  .lvm-preview-frame .lvm-preview-wrap {
    position: absolute;
    top: 0; left: 0;
    --lvm-scale: var(--lvm-frame-scale, 0.32);
    --lvm-label-w: inherit;
    --lvm-label-h: inherit;
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

  /* ── Options toggle row (S12, May 5) ──────────────────────────────────
     Sits between the modal header and the label preview. Two toggles in
     one row: size (Small/Large) on the left, price-tag (Include/Exclude)
     on the right. Both visually look like text labels with an inline
     pill-toggle so the row stays compact on phone widths. */
  .lvm-toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    background: #f4f0e8;
    border-bottom: 1px solid #e0d8c8;
    gap: 12px;
    flex-wrap: wrap;
  }
  .lvm-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }
  .lvm-toggle-label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 13px; font-weight: 600;
    color: #3a3028;
    letter-spacing: 0.4px;
  }
  /* Pill toggle — two states, animates the background color and the dot's
     horizontal position. Sized small (32×18) so the row reads as a
     compact options strip rather than a heavyweight settings panel. */
  .lvm-pill {
    position: relative;
    width: 32px; height: 18px;
    background: #c0b8a8;
    border-radius: 9px;
    transition: background 0.15s ease;
    flex-shrink: 0;
  }
  .lvm-pill::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: #fff;
    border-radius: 50%;
    transition: left 0.15s ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }
  .lvm-pill.on {
    background: #5a7030;
  }
  .lvm-pill.on::after {
    left: 16px;
  }
  /* When a toggle is disabled (e.g. the price-tag toggle while size is
     small if we ever decide to lock it), dim the entire row segment. */
  .lvm-toggle.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* Secondary toggle row (S12) — appears below the main toggle row when
     the conditional Include Price toggle is shown. Right-aligned (the
     left half is empty) so it visually nests under the price tag toggle
     above it. Slightly dimmer background for visual hierarchy. */
  .lvm-toggle-row-secondary {
    background: #ede9e0;
    padding-top: 6px;
    padding-bottom: 8px;
    border-bottom: 1px solid #e0d8c8;
  }

  /* ── 3-way size segmented control (S12 May 6) ─────────────────────────
     Replaces the binary Small/Large pill with a 3-segment Small/Square/Large
     selector. Uses radio-button visual idiom: pill background, current
     segment highlighted with the olive accent color. Each segment is a
     button that re-renders the modal on click. */
  .lvm-segment-group {
    display: inline-flex;
    background: #e8e1d2;
    border: 1px solid #c8bea8;
    border-radius: 14px;
    padding: 2px;
    gap: 0;
  }
  .lvm-segment {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 13px; font-weight: 600;
    color: #5a4a38;
    letter-spacing: 0.5px;
    padding: 5px 12px;
    border-radius: 12px;
    cursor: pointer;
    background: transparent;
    border: none;
    transition: background 0.12s ease, color 0.12s ease;
    user-select: none;
  }
  .lvm-segment:hover:not(.active) {
    background: rgba(90, 112, 48, 0.08);
  }
  .lvm-segment.active {
    background: #5a7030;
    color: #fff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  }

  /* ── Purchase link button (S12 May 6 v2) ───────────────────────────────
     Sits BELOW the action buttons (was above the preview area in v1).
     Restyled as a proper button rather than an inline text link — Matt
     flagged the v1 styling as "junk SEO link" feeling. Now reads as a
     clear utility action with no preamble or arrow emoji.
     Uses a thin row with a single secondary button. The button itself
     uses the existing rg-btn-secondary system from the host page so it
     visually relates to the action buttons above it. */
  .lvm-buylink-footer {
    background: #f4f0e8;
    border-top: 1px solid #e0d8c8;
    padding: 8px 16px 12px;
    display: flex; justify-content: center;
  }
  .lvm-buylink-btn {
    /* Inherits from rg-btn rg-btn-secondary rg-btn-sm in the host page;
       this rule just constrains width so it doesn't span full row. */
    min-width: 220px;
    max-width: 100%;
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
    right: 14px; top: 18px;
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
  /* Info column — starts after the QR column on the left.
     S12 May 6 v2: left edge bumped from 144 → 170px to accommodate the
     wider QR padding (QR ends at x=154 after the left-edge fix; +16px
     gap → info starts at 170). */
  .rg-label .info {
    position: absolute;
    left: 170px; top: 14px; right: 282px;
    display: flex; flex-direction: column;
  }
  .rg-label .info-upper {
    padding-bottom: 8px;
    border-bottom: 1px solid #b0b89a;
    margin-bottom: 0;
  }
  /* S12 May 5: Title and Issue font sizes bumped after Matt printed
     Uncanny X-Men #151 and reported these were hard to read at arm's
     length. Other label fields (printing, meta, URL, verify) were
     readable enough as-is — bumped them in an earlier iteration but
     reverted because the result was overstuffed for the cell.
       ttl:  38 → 50 (+12)
       iss:  26 → 36 (+10)
     Score box and QR remain unchanged. */
  .rg-label .ttl {
    font-size: 50px; font-weight: 900;
    color: #0d0d0f; line-height: 1.05;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
  }
  .rg-label .iss {
    font-size: 36px; font-weight: 600;
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
  /* QR column — anchored to the LEFT edge after the S12 May 6 mirror flip.
     S12 May 6 v2: left edge bumped from 12 → 32px after Matt's printed-
     label test showed the QR getting clipped on actual sheets. Avery's
     printer-alignment tolerance is roughly ±1/16" (~18px at 288 DPI) so
     a 12px margin had effectively zero safety. 32px = ~0.11" — clears
     a typical Avery drift with room to spare. The QR canvas itself is
     118px wide; total left-edge buffer (margin + padding to QR's first
     module) is now ~34px. */
  .rg-label .qr-col {
    position: absolute;
    left: 32px; top: 14px;
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
  /* URL — paired with the QR at the bottom-left (S12 May 6 v2: left padded
     to 32px to match the QR column above for a consistent left margin). */
  .rg-label .url {
    font-size: 16px; color: #5a6a4a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: left;
    position: absolute;
    left: 32px; bottom: 18px;
    letter-spacing: 0.2px;
  }

  /* ── Price pad (S12, May 5) ────────────────────────────────────────────
     White rounded-rectangle space between the identity block and the QR
     column, where a price can be hand-written. Only present when the
     price-tag toggle is on. Implementation:
       - Adds a .has-price modifier to .rg-label
       - On Large: identity narrows from right:144px to right:380px,
         price pad sits at right:144px width 220px, QR stays at right
       - On Small: similar but proportional
     The "Price" placeholder text is rendered in a faint, thin font near
     the top of the pad — clear enough to read at-a-glance, light enough
     not to compete with whatever the user writes in. */
  /* When the price tag is enabled, the info column shrinks on the right
     to make room for the price pad — which sits between the info column
     and the score box. With score box on the right edge (S12 May 6 mirror):
       - Score box: right:14, width:252  → x=886-1138
       - Price pad: right:282, width:220 → x=650-870 (16px gap to score)
       - Info ends at x≈634         → right:518 (16px gap to price pad)
     The "Price" placeholder text is rendered in the same olive used for
     GRADED / ID labels and at the same weight (S12 May 6). The original
     pale thin "300 weight" was disappearing on the printed white pad. */
  .rg-label.has-price .info {
    right: 518px;
  }
  .rg-label .price-pad {
    display: none;
  }
  .rg-label.has-price .price-pad {
    display: block;
    position: absolute;
    top: 18px; right: 282px;
    width: 220px; height: 220px;
    background: #ffffff;
    border: 1px solid #b8c098;
    border-radius: 14px;
  }
  .rg-label.has-price .price-pad .price-placeholder {
    position: absolute;
    top: 18px; left: 0; right: 0;
    text-align: center;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 36px;
    font-weight: 600;
    color: #7a8a5a;
    letter-spacing: 0.5px;
  }

  /* ── Square variant (Avery 22806, 2" × 2" → 576 × 576 px) ──────────────
     S12 May 6: new format introduced to solve the placement problem from
     Matt's print test. Rectangular labels obscure too much horizontal cover
     real estate; square labels can be placed in the upper-right corner of a
     bagged comic without clipping into the title or Marvel/DC box.

     Layout (S12 May 6, v2 — revised after first-render feedback):
       - Score box upper-right (220 × 220, anchored to right edge)
       - Title + issue/date + GRADED + ID stack at top-left, BIGGER fonts
       - QR moved to bottom-right corner (was below score box)
       - SCAN TO VERIFY text above the QR
       - URL beneath the QR (paired with it — they're both verification)
       - Price pad centered vertically in the empty middle/left region
         when toggle on (was tucked at bottom-left)

     Coordinate map (576 × 576 canvas, v2):
       Score box:     right:14, top:14, 220×220   → x=342-562, y=14-234
       Info col:      left:14, top:14, right:250  → x=14-326, top-anchored
       Verify lbl:    above QR via flex order:-1
       QR:            right:14, bottom:38, 174×174→ x=388-562, y=364-538
       URL:           right:14, bottom:14         → y=546-562 (under QR)
       Price pad:     left:14, top:300, 256×160   → vertically centered

     For long titles ("Marvel Super Heroes Secret Wars"), title wraps to
     2 lines at consistent font size — never shrinks. Two-line title still
     leaves room above the price pad. */
  .rg-label-square {
    width: 576px; height: 576px;
    background: #d4d9be;
    border: 1px solid #8a9a6a;
    border-radius: 8px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  .rg-label-square .score-box {
    width: 220px; height: 220px;
    background: #1a2208;
    border-radius: 32px;
    position: absolute;
    right: 14px; top: 14px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label-square .rg-word {
    font-size: 22px; font-weight: 700;
    color: #6a8030; letter-spacing: 2.5px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 12px;
  }
  .rg-label-square .rg-num {
    font-size: 130px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
  }
  /* Precision modifier: positioned BELOW the top of the digit (per Matt's
     v2 feedback — at top:50 in v1 it floated above the digit and clipped
     the ± character). At top:80 it sits firmly inside the digit's vertical
     band; smaller font (24 → 18px) and tighter letter-spacing keep it
     compact so a 2-character value like "±10" fits without clipping. */
  .rg-label-square .rg-prec {
    position: absolute; top: 80px; right: 12px;
    font-size: 18px; font-weight: 700;
    color: #b8d820; opacity: 0.92;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    line-height: 1;
    letter-spacing: 1.5px;
  }
  .rg-label-square .rg-v {
    font-size: 18px;
    color: #5a7030;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 12px;
    letter-spacing: 1px;
  }
  .rg-label-square .info {
    position: absolute;
    left: 14px; top: 14px; right: 250px;
    display: flex; flex-direction: column;
  }
  .rg-label-square .info-upper {
    padding-bottom: 10px;
    border-bottom: 1px solid #b0b89a;
  }
  /* S12 May 6 v2: title font bumped 30 → 38px after Matt flagged it read
     too small at print scale. At 38px in a 312-px-wide info column, single
     line fits ~17 chars ("Amazing Spider-Man" = 18, fits). Long titles
     ("Marvel Super Heroes Secret Wars" = 31) wrap to 2 lines. The 2-line
     case ends around y=180; price pad starts at y=300, leaving comfortable
     gap. */
  .rg-label-square .ttl {
    font-size: 38px; font-weight: 900;
    color: #0d0d0f; line-height: 1.05;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    word-wrap: break-word;
  }
  .rg-label-square .iss {
    font-size: 26px; font-weight: 600;
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    display: flex; gap: 14px; align-items: baseline;
    margin-top: 4px;
  }
  .rg-label-square .prt {
    font-size: 20px; color: #555544;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
  }
  .rg-label-square .info-lower { padding-top: 10px; }
  .rg-label-square .meta-grid {
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 14px; row-gap: 5px;
    align-items: baseline;
  }
  .rg-label-square .meta-lbl {
    font-size: 22px; font-weight: 600;
    color: #7a8a5a;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label-square .meta-val {
    font-size: 22px; font-weight: 800;
    color: #0d0d0f;
    font-family: 'Noto Sans Mono', monospace;
  }
  /* QR cluster (S12 May 6 v2): now anchored to BOTTOM-right corner with
     three pieces stacked top-to-bottom — SCAN TO VERIFY above, QR square
     below, URL underneath (URL is positioned separately at bottom:14).
     Pairing the URL with the QR makes thematic sense (both are verification
     mechanisms) and frees up the left/middle for the price pad to live in
     negative space rather than corner-tucked. */
  .rg-label-square .qr-col {
    position: absolute;
    right: 14px; bottom: 38px;
    width: 174px;
    display: flex; flex-direction: column;
    align-items: center; gap: 2px;
  }
  .rg-label-square .qr-col .qrc canvas,
  .rg-label-square .qr-col .qrc img {
    width: 174px !important;
    height: 174px !important;
  }
  /* Verify text rendered ABOVE the QR via flex order:-1. The .verify span
     is the second child in the DOM (per renderLabelMarkup), but order:-1
     puts it first in the visual flex column. */
  .rg-label-square .verify {
    font-size: 14px; color: #7a8a5a;
    letter-spacing: 1.2px;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600; text-align: center;
    order: -1;
    margin-bottom: 2px;
  }
  .rg-label-square .url {
    font-size: 14px; color: #5a6a4a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: right;
    position: absolute;
    right: 14px; bottom: 14px;
    letter-spacing: 0.2px;
  }
  /* Price pad — centered vertically in the empty middle of the label
     (S12 May 6 v2 reposition). Previously tucked at bottom-left, which
     read as cluttered next to the URL. Now it floats in the negative
     space between the info column (which ends ~y=180-200 depending on
     title length) and the QR cluster's verify-text bar (~y=340).
     Pad: 256 × 160 at left:14, top:300 → vertical center at y=380. */
  .rg-label-square .price-pad {
    display: none;
  }
  .rg-label-square.has-price .price-pad {
    display: block;
    position: absolute;
    left: 14px; top: 300px;
    width: 256px; height: 160px;
    background: #ffffff;
    border: 1px solid #b8c098;
    border-radius: 14px;
  }
  /* "Price" placeholder: smaller than v1 (visibility was the original
     concern, not size — so dropping 40 → 32 makes the placeholder less
     visually heavy without sacrificing readability) and positioned higher
     in the pad (top:18 instead of 50) so the seller has room to write the
     price below the label. */
  .rg-label-square.has-price .price-pad .price-placeholder {
    position: absolute;
    top: 18px; left: 0; right: 0;
    text-align: center;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 32px;
    font-weight: 600;
    color: #7a8a5a;
    letter-spacing: 0.5px;
  }

  /* ── Large variant (CGC-slab, 7.5" × 1.5" → 2160 × 432 px) ──────────
     Score box scales up to fill the taller cell. Identity block has more
     horizontal room. QR column stays similar size (QR codes don't benefit
     from being huge — phone cameras pick up smaller ones easily).
     Layout proportions:
       - Score box: 396 × 396 (was 252 × 252) — proportional growth
       - Score box num: ~228 (was 148)
       - Score box left: 18, top: 18
       - Info: left: 432, right: 220 (or right:580 with price pad)
       - QR col: right: 18, width: 184 (slightly larger, fits the height)
       - URL: right: 18, bottom: 22 */
  .rg-label-large {
    width: 2160px; height: 432px;
    background: #d4d9be;
    border: 1px solid #8a9a6a;
    border-radius: 6px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  .rg-label-large .score-box {
    width: 396px; height: 396px;
    background: #1a2208;
    border-radius: 60px;
    position: absolute;
    left: 18px; top: 18px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label-large .rg-word {
    font-size: 38px; font-weight: 700;
    color: #6a8030; letter-spacing: 5px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 22px;
  }
  .rg-label-large .rg-num {
    font-size: 232px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
  }
  .rg-label-large .rg-prec {
    position: absolute; top: 92px; right: 28px;
    font-size: 40px; font-weight: 700;
    color: #b8d820; opacity: 0.92;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    line-height: 1;
    letter-spacing: 3px;
  }
  .rg-label-large .rg-v {
    font-size: 30px;
    color: #5a7030;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 22px;
    letter-spacing: 1.5px;
  }
  .rg-label-large .info {
    position: absolute;
    left: 444px; top: 28px; right: 220px;
    display: flex; flex-direction: column;
  }
  .rg-label-large.has-price .info {
    right: 580px;
  }
  .rg-label-large .info-upper {
    padding-bottom: 14px;
    border-bottom: 1px solid #b0b89a;
  }
  .rg-label-large .ttl {
    font-size: 64px; font-weight: 900;
    color: #0d0d0f; line-height: 1.1;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
  }
  .rg-label-large .iss {
    font-size: 42px; font-weight: 600;
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    display: flex; gap: 36px; align-items: baseline;
  }
  .rg-label-large .prt {
    font-size: 32px; color: #555544;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
  }
  .rg-label-large .info-lower { padding-top: 18px; }
  .rg-label-large .meta-grid {
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 24px; row-gap: 8px;
    align-items: baseline;
  }
  .rg-label-large .meta-lbl {
    font-size: 36px; font-weight: 600;
    color: #7a8a5a;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.7px;
  }
  .rg-label-large .meta-val {
    font-size: 36px; font-weight: 800;
    color: #0d0d0f;
    font-family: 'Noto Sans Mono', monospace;
  }
  .rg-label-large .qr-col {
    position: absolute;
    right: 18px; top: 22px;
    width: 184px;
    display: flex; flex-direction: column;
    align-items: center; gap: 6px;
  }
  .rg-label-large .qr-col .qrc canvas,
  .rg-label-large .qr-col .qrc img {
    width: 178px !important;
    height: 178px !important;
  }
  .rg-label-large .verify {
    font-size: 22px; color: #7a8a5a;
    letter-spacing: 1.5px;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600; text-align: center;
  }
  .rg-label-large .url {
    font-size: 24px; color: #5a6a4a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: right;
    position: absolute;
    right: 18px; bottom: 26px;
    letter-spacing: 0.3px;
  }
  /* Price pad for large variant — bigger, fills most of the taller cell.
     Height calc: cell is 432 tall, URL band at bottom is 26+24=50 tall,
     so the pad's bottom edge needs to be at most 432-50-12=370 (with 12px
     gap above URL). Pad starts at top:28 → max height 342. Set 336 for a
     touch more breathing room above the URL. (Was 376 — overlapped URL by
     ~22px in earlier S12 build.) */
  .rg-label-large.has-price .price-pad {
    display: block;
    position: absolute;
    top: 28px; right: 220px;
    width: 340px; height: 336px;
    background: #ffffff;
    border: 1px solid #b8c098;
    border-radius: 18px;
  }
  .rg-label-large.has-price .price-pad .price-placeholder {
    position: absolute;
    top: 28px; left: 0; right: 0;
    text-align: center;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 56px;
    font-weight: 600;
    color: #7a8a5a;
    letter-spacing: 0.8px;
  }
  /* Price value (when includePrice toggle is on) — bold and centered.
     Size proportional to label format. */
  .rg-label.has-price .price-pad .price-value {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Noto Sans Display', sans-serif;
    font-stretch: 62.5%;
    font-size: 80px;
    font-weight: 900;
    color: #1a2208;
    letter-spacing: 0.5px;
  }
  .rg-label-large.has-price .price-pad .price-value {
    font-size: 130px;
  }
  .rg-label-square.has-price .price-pad .price-value {
    /* Square pad is 256 × 160 — sized between Small (220 sq) and Large
       (340 × 336). Font sized for the wider, shorter pad. */
    font-size: 90px;
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

  // S12: read user's persisted size + price-tag preferences. These drive
  // the label markup, the "X to a sheet" subtitle, and the PDF generation.
  const opts = readOptions();
  const fmt = LABEL_FORMATS[opts.size];

  // Queue display tracks the active format's per-sheet count, NOT the
  // global QUEUE_LIMIT. Per Matt's spec: "Queue: 1 / 7" when Large is
  // selected, "Queue: 1 / 20" when Small. The actual queue cap stays at
  // QUEUE_LIMIT (20) — Large format with >7 books just produces a
  // multi-page PDF.
  const queueCap = fmt.sheetCount;
  // If the queue count exceeds the format's per-sheet capacity, the
  // "queue full" visual styling kicks in, BUT we still allow saving —
  // the PDF will just span multiple pages.
  const queueOverflow = queueCount > queueCap;

  const queueClass = queueOverflow ? 'lvm-queue-count full' : 'lvm-queue-count';

  const queueBtnLabel = inQueue ? 'Remove from Queue' : `Add to Queue`;
  // When in queue, use secondary style — "Remove from Queue" is an undo
  // action, not destructive ("undestructive"). Destructive styling read as
  // "are you sure you want to do this irreversibly" which overstates the
  // weight; removing from queue is just reversing the recent add. Primary
  // for the affirmative add when not in queue.
  const queueBtnCategory = inQueue ? 'rg-btn-secondary' : 'rg-btn-primary';
  // The "Remove from Queue" label is long; mark it for the small-font tweak.
  const queueBtnSizeMod = inQueue ? 'rg-btn-queue-active' : '';
  // Disable Add to Queue when the absolute QUEUE_LIMIT is reached — not
  // the format-specific sheet count. Users can keep queuing past 7 in
  // Large and the PDF will produce multiple pages, but past 20 we cap.
  const queueBtnDisabled = (!inQueue && queueCount >= QUEUE_LIMIT);

  // Pluralize correctly on the subtitle. Tracks the active format's
  // sheetCount: 20 for Small (Avery 8161), 7 for Large (OL5450).
  const subtitleText = `Labels print ${fmt.sheetCount} to a sheet`;

  // S12 May 6: 3-way size segmented control replaces the binary Small/Large
  // pill. Each segment is "active" when its size is the currently selected
  // option. Click handlers read the data-size attribute and persist.
  const seg = (size, label) =>
    `<button type="button" class="lvm-segment${opts.size === size ? ' active' : ''}" data-action="set-size" data-size="${size}">${label}</button>`;
  const sizeSegments = `
    <div class="lvm-segment-group">
      ${seg('small',  'Small')}
      ${seg('square', 'Square')}
      ${seg('large',  'Large')}
    </div>`;

  const pricePillClass = opts.priceTag ? 'lvm-pill on' : 'lvm-pill';

  // S12: Include Asking Price secondary toggle. Conditional visibility — only shows
  // when BOTH:
  //   1. priceTag is on (no point asking about value if pad isn't shown)
  //   2. comic.askingPrice has a value (no value to include if not set)
  // When hidden, includePrice option is treated as effectively off regardless
  // of stored value. When shown, the toggle drives whether the asking-price
  // value renders inside the pad or the pad stays blank for hand-writing.
  const hasAskingPrice = comic.askingPrice != null && comic.askingPrice !== '' && Number(comic.askingPrice) > 0;
  const showIncludePriceToggle = opts.priceTag && hasAskingPrice;
  const includePricePillClass = opts.includePrice ? 'lvm-pill on' : 'lvm-pill';

  // Effective options for rendering: includePrice only takes effect if the
  // toggle is visible (i.e. price tag on AND asking price exists). This way
  // a stored "true" value doesn't accidentally render a missing price.
  const effectiveOpts = {
    ...opts,
    includePrice: showIncludePriceToggle && opts.includePrice
  };

  // Build the label preview markup. MUST come after effectiveOpts is declared
  // since renderLabelMarkup reads from it. (S12 May 6 incident: this line
  // ended up above effectiveOpts during the segmented-control + buylink
  // refactor and triggered a temporal-dead-zone ReferenceError on every modal
  // open. Keep this directly under effectiveOpts.)
  const labelHTML = renderLabelMarkup(comic, effectiveOpts);

  // S12 May 6 v2: purchase link now sits as a button below the action
  // buttons (was above the preview in v1). Restyled as a proper button
  // with no SEO-ish "Need labels?" preamble or arrow emoji. Updates when
  // the user switches sizes since renderModal re-runs on toggle.
  const buyLink = LABEL_BUY_LINKS[opts.size];
  const buyLinkHTML = buyLink ? `
      <div class="lvm-buylink-footer">
        <button type="button" class="rg-btn rg-btn-secondary rg-btn-sm lvm-buylink-btn" data-action="open-buylink" data-url="${esc(buyLink.url)}">
          Buy ${esc(buyLink.label)} on ${esc(buyLink.vendor)}
        </button>
      </div>` : '';

  modal.innerHTML = `
    <div class="lvm-card">
      <div class="lvm-header">
        <div class="lvm-title">Print Label</div>
        <div class="lvm-header-right">
          <div class="${queueClass}">Queue: ${queueCount} / ${queueCap}</div>
          <div class="lvm-subtitle">${subtitleText}</div>
        </div>
      </div>
      <div class="lvm-toggle-row">
        ${sizeSegments}
        <div class="lvm-toggle" data-action="toggle-price" role="button" tabindex="0">
          <span class="lvm-toggle-label">Include price tag</span>
          <span class="${pricePillClass}"></span>
        </div>
      </div>
      ${showIncludePriceToggle ? `
      <div class="lvm-toggle-row lvm-toggle-row-secondary">
        <div></div>
        <div class="lvm-toggle" data-action="toggle-include-price" role="button" tabindex="0">
          <span class="lvm-toggle-label">Include asking price</span>
          <span class="${includePricePillClass}"></span>
        </div>
      </div>` : ''}
      <div class="lvm-preview-area">
        <div class="lvm-preview-frame" style="--lvm-label-w: ${fmt.pixelW}px; --lvm-label-h: ${fmt.pixelH}px;">
          <div class="lvm-preview-wrap" style="--lvm-label-w: ${fmt.pixelW}px; --lvm-label-h: ${fmt.pixelH}px;">
            ${labelHTML}
          </div>
        </div>
      </div>
      <div class="lvm-actions">
        <button class="rg-btn ${queueBtnCategory} rg-btn-md ${queueBtnSizeMod}" data-action="toggle-queue" ${queueBtnDisabled ? 'disabled' : ''}>${queueBtnLabel}</button>
        <button class="rg-btn rg-btn-primary rg-btn-md" data-action="print" ${printDisabled ? 'disabled' : ''}>Save as PDF</button>
      </div>
      ${buyLinkHTML}
    </div>
  `;

  // Render QR for the previewed label
  renderQRsIn(modal);

  // Wire up toggle handlers. All toggles persist immediately on tap and
  // re-render the modal so the user sees their selection reflected in the
  // preview, subtitle, and (eventually) the PDF output.
  //
  // S12 May 6: size toggle is now a 3-segment control (small/square/large).
  // Each segment carries its own data-size attribute. Use querySelectorAll +
  // forEach because there are now three click targets, not one.
  modal.querySelectorAll('[data-action="set-size"]').forEach(seg => {
    seg.addEventListener('click', () => {
      const newSize = seg.getAttribute('data-size');
      if (!VALID_SIZES.includes(newSize)) return;
      const cur = readOptions();
      if (cur.size === newSize) return;  // already selected, no-op
      writeOptions({ ...cur, size: newSize });
      renderModal(modal, comic, allItems);
    });
  });
  modal.querySelector('[data-action="toggle-price"]').addEventListener('click', () => {
    const cur = readOptions();
    writeOptions({ ...cur, priceTag: !cur.priceTag });
    renderModal(modal, comic, allItems);
  });
  // S12: Include Price toggle (conditional). The element only exists in the
  // DOM when showIncludePriceToggle is true, so guard the listener wiring.
  const includePriceEl = modal.querySelector('[data-action="toggle-include-price"]');
  if (includePriceEl) {
    includePriceEl.addEventListener('click', () => {
      const cur = readOptions();
      writeOptions({ ...cur, includePrice: !cur.includePrice });
      renderModal(modal, comic, allItems);
    });
  }

  // S12 May 6 v2: buylink button — opens vendor URL in a new tab. Same
  // safety attributes as the prior anchor (noopener noreferrer) but as
  // window.open since the click target is now a button, not an <a>.
  // The element only exists when LABEL_BUY_LINKS has an entry for the
  // current size, so guard the listener wiring.
  const buyLinkEl = modal.querySelector('[data-action="open-buylink"]');
  if (buyLinkEl) {
    buyLinkEl.addEventListener('click', () => {
      const url = buyLinkEl.getAttribute('data-url');
      if (!url) return;
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }

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
  const padY = parseFloat(areaStyle.paddingTop) + parseFloat(areaStyle.paddingBottom);
  // Pull in another 4% margin so the label visibly clears the modal edges
  // — a label that touches the right edge looks clipped even if it's not.
  const availW = (area.clientWidth - padX) * 0.96;
  const availH = (area.clientHeight - padY) * 0.96;
  if (availW <= 0) return;
  // Read the format's pixel dimensions from inline CSS variables on the
  // frame (set in renderModal based on the active format). Falls back to
  // 1152×288 (Small) if not set.
  const labelW = parseFloat(frame.style.getPropertyValue('--lvm-label-w')) || 1152;
  const labelH = parseFloat(frame.style.getPropertyValue('--lvm-label-h')) || 288;
  // Compute scale factor based on the MORE constraining dimension. Pre
  // S12-May-6 this only considered width, which was fine for the long
  // rectangular Small (4:1) and Large (5:1) — width was always the binding
  // constraint. Square (1:1) made height matter equally, and on short
  // viewports a width-only scale was producing a label taller than the
  // preview area, forcing scroll. Use min of both ratios.
  const scaleW = availW / labelW;
  const scaleH = availH > 0 ? availH / labelH : scaleW;
  const scale = Math.min(0.85, scaleW, scaleH);
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
//
// S12 May 6: cache only successful loads. Earlier version cached the in-
// flight promise unconditionally — if the first load failed (CDN hiccup,
// network blip, ad-block injection), the cached rejected promise would be
// returned for every subsequent call, permanently breaking PDF generation
// in the session until reload. Now we cache only after both libs are
// confirmed on window; on failure, we clear the cache so the next attempt
// retries fresh.

let _pdfLibsPromise = null;
function ensurePdfLibsLoaded() {
  if (window.jspdf && window.html2canvas) return Promise.resolve();
  if (_pdfLibsPromise) return _pdfLibsPromise;
  _pdfLibsPromise = Promise.all([
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'),
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
  ]).then(() => {
    // Defensive: confirm globals actually arrived. CDN scripts that load
    // 200 OK but execute incorrectly (rare, but possible with corrupted
    // CDN responses) can resolve the load promise without exposing the libs.
    if (!window.jspdf || !window.html2canvas) {
      throw new Error('PDF libraries loaded but globals missing');
    }
  }).catch(err => {
    // Clear the cached promise so the next call retries fresh instead of
    // returning the same rejected promise.
    _pdfLibsPromise = null;
    throw err;
  });
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
// Generate the PDF using whichever format the user has currently selected.
// Each label is rendered off-screen via html2canvas at 2× DPI, then placed
// at the correct sheet-grid position in jsPDF. For Small format, the queue
// (up to 20 labels) may span multiple sheets — we add new pages as needed.
//
// Format-specific grid positions (extracted from official PDF templates):
//   LARGE (Avery 8161):
//     Top margin 0.5", left margin 0.1667", column gap 0.1882", row gap 0
//     Label 4" × 1", 2 cols × 10 rows = 20 per sheet
//   SMALL (OL5450):
//     Top margin 0.25", left margin 0.5", no gaps
//     Label 7.5" × 1.5", 1 col × 7 rows = 7 per sheet
async function generatePDF(comics, modal) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'in',
    format: 'letter',  // 8.5 × 11
  });

  // S12: read current options to determine format + price-tag inclusion.
  // Capture them at PDF-generation time (NOT at queue-add time) so the
  // active toggle state at the moment of Save dictates the output. This
  // matches Matt's spec: "all the labels in the Queue would be saved in
  // whichever label size and price tag setting is active when the button
  // is tapped."
  const opts = readOptions();
  const fmt = LABEL_FORMATS[opts.size];

  // Reference to the Save button so we can update its label with progress
  // during the loop. Without per-label updates, a 7-label queue on iOS
  // Safari shows "Generating..." for ~20-30s with no feedback — users
  // assume the app has frozen. Updating the text on each iteration makes
  // it clear progress is happening even when each step takes 2-4s.
  const saveBtn = modal && modal.querySelector('[data-action="print"]');
  const setProgress = (txt) => {
    if (saveBtn) saveBtn.textContent = txt;
  };

  // Off-screen container for rendering labels at high DPI. We keep this in
  // the DOM (not display:none) so html2canvas can measure it correctly, but
  // position it off-screen via absolute positioning + negative coordinates.
  const offscreen = document.createElement('div');
  offscreen.style.cssText = 'position:fixed;left:-99999px;top:0;background:white;';
  document.body.appendChild(offscreen);

  try {
    // Pre-render every label box in the off-screen container so html2canvas
    // can capture each. Each box is sized to the format's pixel dimensions.
    let labelsHTML = '';
    for (let i = 0; i < comics.length; i++) {
      labelsHTML += `<div class="pdf-label-box" data-idx="${i}" style="width:${fmt.pixelW}px;height:${fmt.pixelH}px;display:block;background:#d4d9be;">${renderLabelMarkup(comics[i], opts)}</div>`;
    }
    offscreen.innerHTML = labelsHTML;

    // Render QR codes synchronously (library is already loaded from the
    // modal preview path).
    renderQRsIn(offscreen);

    // Wait one animation frame so layout + QR canvases are flushed before
    // html2canvas captures.
    await new Promise(r => requestAnimationFrame(r));

    // Capture each label and place in PDF. For multi-page output (Small
    // format with >20 queued items, or Large with >7), we add a new page
    // each time the per-sheet count overflows.
    //
    // S12 May 6: scale dropped from 2 to 1.
    // The label markup is already rendered at 1152px (Small) / 2160px (Large)
    // wide, which corresponds to 288 DPI at the printed size — print-quality.
    // Scale=2 was capturing at 576 DPI which doubled canvas memory (4× pixels)
    // and roughly doubled per-label capture time, with no visible quality
    // benefit on print. The change reduces a 7-label PDF generation from
    // ~25-30s to ~10-15s on iOS Safari, eliminating the apparent freeze.
    //
    // Yield (setTimeout 0) after each iteration to let iOS Safari pump its
    // UI queue. Without this, the main thread stays busy for the whole
    // duration and the spinner/text updates may not paint.
    const perSheet = fmt.sheetCount;
    const boxes = offscreen.querySelectorAll('.pdf-label-box');
    const total = boxes.length;
    for (let i = 0; i < total; i++) {
      setProgress(`Generating ${i + 1}/${total}…`);

      const cellIdx = i % perSheet;            // 0 .. perSheet-1
      const sheetIdx = Math.floor(i / perSheet);

      // Add a new page when starting a new sheet (skip on first sheet).
      if (cellIdx === 0 && sheetIdx > 0) {
        pdf.addPage('letter', 'portrait');
      }

      const col = cellIdx % fmt.cols;
      const row = Math.floor(cellIdx / fmt.cols);
      const x = fmt.sheetLeftMargin + col * (fmt.labelW + fmt.colGap);
      const y = fmt.sheetTopMargin + row * (fmt.labelH + fmt.rowGap);

      const canvas = await window.html2canvas(boxes[i], {
        scale: 1,
        useCORS: true,
        backgroundColor: '#d4d9be',
        logging: false,
      });
      // JPEG instead of PNG: the label uses photographic-style anti-aliased
      // text and a flat olive background — JPEG at quality 0.92 is visually
      // indistinguishable from PNG for this content but produces a PDF
      // that's roughly 1/4 the file size. Smaller PDFs save+open faster on
      // mobile, which matters when users print 7+ labels.
      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(imgData, 'JPEG', x, y, fmt.labelW, fmt.labelH);

      // Yield so iOS Safari can repaint button text and event-loop catch-up.
      // Without this, the entire loop blocks and progress text doesn't appear.
      await new Promise(r => setTimeout(r, 0));
    }

    setProgress('Saving PDF…');

    // Save / download. iOS Safari saves to Files → Downloads. Desktop
    // browsers save to default Downloads folder. Filename includes the
    // format so users with both Small and Large PDFs in their Downloads
    // can tell them apart at a glance.
    // Filename suffix identifies the format so a user with multiple PDFs in
    // their Downloads can tell them apart at a glance:
    //   Small  → "8161"  (Avery 8161 product number, 4×1, 20/sheet)
    //   Square → "22806" (Avery 22806 product number, 2×2, 12/sheet)
    //   Large  → "CGC"   (CGC-slab overlay, OL5450, 7.5×1.5, 7/sheet)
    const sizeTag = opts.size === 'large' ? 'CGC'
                  : opts.size === 'square' ? '22806'
                  : '8161';
    const priceTag = opts.priceTag ? '-Price' : '';
    const filename = `Robograder-Labels-${sizeTag}${priceTag}-${new Date().toISOString().slice(0, 10)}.pdf`;
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

function renderLabelMarkup(comic, opts) {
  // S12: opts is { size, priceTag, includePrice }. Defaults to small + no
  // price tag + no included price if not supplied (preserves backward
  // compatibility for any caller still using the single-argument form).
  // Note: 'small' = the default Avery 8161 (4"×1", 20 per sheet) — it's the
  // long-standing "default size". 'large' is the OL5450 CGC-slab format
  // (7.5"×1.5", 7 per sheet).
  // includePrice (S12 May 6): when true AND comic has an askingPrice, the
  // value renders inside the price pad. Otherwise the pad shows the faint
  // "Price" placeholder for handwriting.
  opts = opts || { size: 'square', priceTag: false, includePrice: false };
  const isLarge  = opts.size === 'large';
  const isSquare = opts.size === 'square';
  const showPrice = !!opts.priceTag;
  const includePrice = !!opts.includePrice;

  const rg = comic.roboGrade;
  const score = Math.round(rg.score ?? 0);

  // Precision suffix logic (same four-tier rule as the popup version):
  //   100 → no suffix
  //   High-grade run → ±N (narrower confidence range, default ±3, capped 6)
  //   Initial only, 80+ → "+"
  //   Initial only, <80 → ±N (default ±8, capped 16)
  //
  // S12 May 6: client-side clamping applied here too, mirroring the same
  // logic in robograde-panel.js. Defends against legacy records where the
  // server-side clamp wasn't yet shipping. Two stages:
  //   1. Mode cap: high-grade ≤6, standard ≤16
  //   2. Score+conf cap: score + N must not exceed 100
  const highGradeRun = !!comic.highGradeUnlocked;
  let precision = '';
  if (score < 100) {
    if (highGradeRun) {
      let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 3;
      n = Math.max(0, Math.min(6, n));
      const headroom = Math.max(0, 100 - score);
      if (n > headroom) n = headroom;
      precision = n > 0 ? `±${n}` : '';
    } else if (score >= 80) {
      precision = '+';
    } else {
      let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 8;
      n = Math.max(0, Math.min(16, n));
      const headroom = Math.max(0, 100 - score);
      if (n > headroom) n = headroom;
      precision = n > 0 ? `±${n}` : '';
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

  // Wrapper class drives all visual differences between Small/Square/Large,
  // plus the .has-price modifier toggles the price pad on/off.
  const baseClass = isLarge ? 'rg-label-large'
                  : isSquare ? 'rg-label-square'
                  : 'rg-label';
  const wrapClass = baseClass + (showPrice ? ' has-price' : '');

  return `
    <div class="${wrapClass}" data-grade-id="${gradeId}">
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
      ${showPrice ? (() => {
        // Price pad rendering. Two states:
        //   includePrice=false → faint "Price" placeholder for handwriting
        //   includePrice=true  → bold dollar value of comic.askingPrice
        // The label modal logic gates includePrice on (priceTag && askingPrice
        // > 0), so by the time we get here we trust the inputs.
        if (includePrice && comic.askingPrice != null) {
          const priceNum = Number(comic.askingPrice);
          // Format with $ and 2 decimals if cents exist, no decimals if whole
          const priceStr = priceNum % 1 === 0
            ? `$${Math.round(priceNum)}`
            : `$${priceNum.toFixed(2)}`;
          return `<div class="price-pad"><div class="price-value">${priceStr}</div></div>`;
        }
        return `<div class="price-pad"><div class="price-placeholder">Price</div></div>`;
      })() : ''}
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
    // Detect label size by walking up to find which variant's class is on
    // the parent. Three sizes:
    //   .rg-label-large  (CGC-slab)         → 178 × 178 QR
    //   .rg-label-square (Avery 22806 2×2)  → 174 × 174 QR
    //   .rg-label        (Avery 8161 4×1)   → 118 × 118 QR
    // The CSS will visually constrain the rendered canvas, but the underlying
    // data resolution should match the rendered pixels for crisp output.
    const isLarge  = !!el.closest('.rg-label-large');
    const isSquare = !!el.closest('.rg-label-square');
    const qrPx = isLarge ? 178 : isSquare ? 174 : 118;
    new window.QRCode(el, {
      text: `https://robograder.app/id/${id}`,
      width: qrPx, height: qrPx,
      colorDark: '#1a2208', colorLight: '#d4d9be',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  });
}
