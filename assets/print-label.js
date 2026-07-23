// Robograder — Label viewer + PDF generation module (S12 rewrite)
// BUILD FINGERPRINT: S14-2026-05-17-ALL-LABELS-SCORE-PREC
// (If the label feature misbehaves, check this line in the deployed
//  print-label.js — a stale cached upload shows an older fingerprint.
//  This build: scaleX condensation for PDF, micro-preview loop fixed,
//  Large first-open clipping fixed, Small L URL + precision positioning.)
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
//                                       allItems is the Print-category subset
//                                       (the print queue); every graded book in
//                                       it prints. S17: the old localStorage
//                                       queue was removed — the Print ownership
//                                       category is now the single source of
//                                       truth, managed via the List-view LABEL
//                                       toggle (togglePrintState in index.html).

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
  // S15 May 28 — Small L migrated from Avery 8161 (4"×1", 20/sheet) to
  // Avery 5162 (4"×1.33", 14/sheet). The extra 0.33" of height is used
  // for a top "wrap strip" that folds 90° over the top of a comic case
  // so the book is identifiable when stored upright in a long box,
  // without pulling it out. The bottom 1.00" is the face (identical to
  // the prior Small L content); the middle 0.08" is the fold zone with
  // a 2pt centered guide line at 1.04" from the bottom; the top 0.25"
  // is the wrap strip that sits on top of the case. Small R unchanged
  // (still on Avery 8161, no wrap — different use case for cases with
  // no flat top surface like top loaders and mylars).
  //
  // Sheet geometry extracted directly from the official Avery 5162
  // template PDF (same provenance method as the Square config — public
  // specs have been wrong before, the template is authoritative):
  //   Page: 8.5" × 11" letter
  //   Top margin:   0.8326"  (792pt - 732.050pt label top)
  //   Left margin:  0.1556"  (11.201pt)
  //   Column gap:   0.1875"  (label 1 right = 299.201; label 2 left = 312.701)
  //   Row gap:      0.0000"
  //   Label:        4.0000" × 1.3333"  (288pt × 96pt)
  //   Column pitch: 4.1875"
  //   Row pitch:    1.3333"
  // Pixel canvas: 1152 × 384 at 288 DPI (4.0 × 1.3333 inches).
  'small-l': {
    name: 'small-l',
    sheetCount: 14,
    rows: 7, cols: 2,
    labelW: 4.0, labelH: 1.3333,
    sheetTopMargin: 0.8326,
    sheetLeftMargin: 0.1556,
    colGap: 0.1875,
    rowGap: 0,
    pixelW: 1152, pixelH: 384
  },
  // Square format — Avery 22806, 2"×2", 12 per sheet (3 cols × 4 rows).
  // S14: spacing CORRECTED against the user's actual Avery 22806 template
  // PDF (geometry extracted directly from the template's label rects).
  // The previous values came from an "OnlineLabels OL3016" product-page
  // spec that does NOT match the Avery 22806 sheet — every label was
  // offset and the error compounded down the sheet. Authoritative values
  // from the template:
  //   Top/left margin:  0.625"
  //   Label:            2.000" × 2.000"
  //   Column pitch:     2.625"  (label 2" + gap 0.625")
  //   Row pitch:        2.5833" (label 2" + gap 0.5833")
  // Pixel canvas unchanged: 576 × 576 at 288 DPI.
  square: {
    name: 'square',
    sheetCount: 12,
    rows: 4, cols: 3,
    labelW: 2.0, labelH: 2.0,
    sheetTopMargin: 0.625,
    sheetLeftMargin: 0.625,
    colGap: 0.625,                 // horizontal gap (col pitch 2.625 − 2.0)
    rowGap: 0.5833,                // vertical gap (row pitch 2.5833 − 2.0)
    pixelW: 576, pixelH: 576       // 288 DPI canonical render
  },
  large: {
    name: 'large',
    sheetCount: 7,
    rows: 7, cols: 1,
    // S14: labelW shortened 7.5 → 6.25 (−1.25" off the right) so the
    // printed label clears CGC's holographic authenticity seal. The
    // OL5450 sheet is still physically 7.5"×1.5" per label; the user
    // hand-trims the right 1.25". Row PITCH is driven by labelH (1.5)
    // + rowGap (0), NOT labelW, so vertical sheet alignment is
    // unchanged — only the image width placed by pdf.addImage shrinks,
    // leaving the right 1.25" of each label cell blank for trimming.
    // pixelW 2160 → 1800 keeps the capture box at 288 DPI for the new
    // 6.25" width (6.25 × 288 = 1800); aspect ratio stays correct so
    // the label is not distorted by html2canvas.
    labelW: 6.25, labelH: 1.5,
    sheetTopMargin: 0.25,
    sheetLeftMargin: 0.5,
    colGap: 0,
    rowGap: 0,
    pixelW: 1800, pixelH: 432
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
    url: 'https://www.amazon.com/Avery-White-Inkjet-Address-Labels/dp/B01LXUAKOY?tag=grailstoaston-20',
    vendor: 'Amazon'
  },
  // S15 May 28: Small L migrated to Avery 5162 (1-1/3" × 4", 14/sheet) to
  // accommodate the new wrap-over-top design. Small R stays on 8161 for
  // case types that have no flat top surface.
  'small-l': {
    label: 'Avery 5162',
    url: 'https://www.amazon.com/dp/B00004Z6IY?tag=grailstoaston-20',
    vendor: 'Amazon'
  },
  square: {
    label: 'Avery 22806',
    url: 'https://www.amazon.com/dp/B093LZ1KW2?tag=grailstoaston-20',
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

// S14: 'small-l' is the mirrored/tightened Small variant (right edge at
// 3.5"). The original 'small' is now surfaced in the UI as "Small R" but
// the stored key stays 'small' for backward compatibility with users who
// already picked it.
const VALID_SIZES = ['small', 'small-l', 'square', 'large'];

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
    // S14 FIX — root cause of "all condensed text broke at once".
    // The previous URL was:
    //   Noto+Sans+Display:wdth,wght@62.5..100,500;700;900
    //   &Noto+Sans+Mono:wdth,wght@62.5,800
    // Two fatal problems with the Google Fonts CSS2 API:
    //  1. When a family declares multiple axes (wdth,wght), EVERY
    //     ;-separated instance must be a COMPLETE tuple in alphabetical
    //     axis order. "62.5..100,500;700;900" is not — after the first
    //     tuple it lists bare weights with no width coordinate, which is
    //     malformed.
    //  2. Noto Sans Mono is monospace and has NO wdth axis at all, so
    //     "Noto+Sans+Mono:wdth,wght@62.5,800" is invalid.
    // Either error makes Google Fonts 400 the WHOLE combined request and
    // serve nothing — so the condensed faces never loaded and every
    // element relying on font-stretch:62.5% (the score number, GRADED/ID
    // values, etc.) silently fell back to a default font with wrong
    // metrics. That cascade — not the score-box markup — is what was
    // throwing the layout off.
    // Correct form: pair the width RANGE with each weight as full
    // tuples for Display; request Mono with only its valid wght axis.
    fonts.href = 'https://fonts.googleapis.com/css2'
      + '?family=Noto+Sans+Display:wdth,wght@62.5..100,500;62.5..100,700;62.5..100,900'
      + '&family=Noto+Sans+Mono:wght@800'
      + '&family=Barlow+Condensed:wght@400;500;600;700;800'
      + '&display=swap';
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
    flex-wrap: wrap;
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
    letter-spacing: 0.3px;
    /* S14: tightened 12→10 horizontal so four segments (Small R / Small L
       / Square / Large) fit on one row on narrow phones; the group can
       wrap as a last resort rather than overflow the modal. */
    padding: 5px 10px;
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
    background: linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);
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
  .rg-label .rg-stars {
    opacity: 0.5;
    position: absolute; top: 44px; left: 0; right: 0;
    text-align: center; font-size: 24px; line-height: 1;
    letter-spacing: 2px;
  }
  .rg-label .rg-num-wrap {
    /* Holds ONLY the number. This is the flex child the score-box
       centers → the NUMBER is exactly centered, always. The precision
       is a SEPARATE absolutely-positioned child of .score-box (out of
       flow, zero width here) so it can never shift this. The recurring
       bug was making number+precision one centered unit; they must be
       independent. */
    display: inline-flex;
    line-height: 1;
  }
  .rg-label .rg-num {
    /* S14: was 148, dropped to 140, now 150 — brought back up a touch
       to match the Large label's score-prominence pass now that the
       condensed scaleX text leaves room. Centered in the 252px box.
       PDF FIX: scaleX(0.625) replaces font-stretch (html2canvas 1.4.1
       ignores the wdth axis when rasterizing); transform-origin:center
       keeps it centered; inline-block so the transform applies. */
    font-size: 150px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: center;
  }
  .rg-label .rg-prec {
    /* Upper-right of the score box, ABSOLUTELY positioned so it is out
       of flow and cannot displace the centered number. Anchored to the
       box at a fixed top/right inset.
       S14: sized UP 30 → 50 to match the title (was barely readable in
       print) — same rule applied to Large. scaleX(0.625) replaces
       font-stretch; transform-origin:right keeps the compressed text
       pinned at the right inset and growing leftward. Verified clear of
       the 150px centered number (~10px gap; precision is absolute/out
       of flow so it cannot displace the number regardless). */
    position: absolute;
    top: 34px; right: 20px;
    font-size: 50px; font-weight: 700;
    color: #b8d820; opacity: 0.9;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: right center;
    line-height: 1;
    letter-spacing: 1px;
    white-space: nowrap;
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
    /* S14 PDF FIX: scaleX(0.625) replaces font-stretch (html2canvas
       can't rasterize the wdth axis). transform-origin:left so the
       title compresses toward the info column's left edge and stays
       left-aligned exactly as before. The layout box is unchanged by
       the transform, which is fine — the title was already constrained
       by the fixed-width .info column; visually it now reads condensed
       and fits more characters per line, matching the on-screen look. */
    font-size: 50px; font-weight: 900;
    color: #0d0d0f; line-height: 1.05;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
  }
  .rg-label .iss {
    font-size: 36px; font-weight: 600;
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    /* S14 PDF FIX: scaleX(0.625) replaces font-stretch. The flex row
       (issue + date) compresses as a unit incl. its gap — proportional
       and visually identical to the condensed-axis result. */
    display: flex; gap: 24px; align-items: baseline;
    transform: scaleX(0.625);
    transform-origin: left center;
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
    /* S14: +2pt (22→24) per user — Grade/Date and ID/Value were a touch
       small to read at arm's length on the printed Small label. */
    font-size: 24px; font-weight: 600;
    color: #7a8a5a;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label .meta-val {
    font-size: 24px; font-weight: 800;
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

  /* ── Small L variant (S14) ────────────────────────────────────────────
     A mirrored, tightened variant of the Small label for fitting inside
     comic cases. Same physical label stock as Small (Avery 8161, 4"×1",
     1152×288 px at 288 DPI) but the printed CONTENT is constrained so its
     right edge lands at 3.5" from the left (x=1008px), leaving 0.5"
     (144px) clear on the right so it sits cleanly in the user's cases.

     Layout (top-to-bottom in the content column, score box on the LEFT):
       • Score box   — left edge, 252×252 (same as Small R)
       • Title       — right of the score box, top
       • Issue + Pub date — one line below title
       • Printing    — line below that
       • GRADED / Grade Date — below (2pt larger than Small R baseline)
       • ID / ID value       — below (2pt larger)
       • QR code     — right-aligned, right edge at x=1008 (0.5" from
                        the physical right edge of the label)
       • SCAN TO VERIFY — under the QR
       • robograder URL — under that
       • Optional price pad — to the LEFT of the QR column

     Geometry math (288 DPI):
       Score box:  left 18,  width 252  → x = 18 … 270
       Content:    left 290 … right boundary depends on price/QR
       QR col:     118px wide; right edge at x=1008 → left ≈ x=874
                   (qr-col width 134, left = 1008-134 = 874)
       Price pad:  when shown, sits left of QR: width 200, right edge
                   at x=854 (20px gap to QR) → left x=654
       Content right boundary: x=634 (no price) or x=634 (kept constant;
                   the info column is comfortably clear of both) */
  .rg-label-l {
    /* S15 May 28: height 288 → 384 px (Avery 5162, 1.333" at 288 DPI).
       Vertical layout from top:
         •   0 … 72px  WRAP STRIP — 0.25" tall, sits on TOP of the comic
                       case after the user folds the label 90° forward.
         •  72 …  96px FOLD ZONE — 0.083" tall, dead space straddling the
                       fold so 0.04" of clearance exists above the face
                       and below the wrap strip (paper consumed by bend).
                       A 2pt guide line is centered at y=84 (= 1.04"
                       from the bottom) so the user knows where to fold.
         •  96 … 384px FACE — 1.000" tall, identical content/layout to the
                       previous Small L. Every existing CSS rule that
                       targets a child of .rg-label-l uses absolute
                       positioning anchored to the OLD top:0 of the face;
                       we preserve that by wrapping the face content in
                       a .face element positioned at top:96px so the
                       children's coordinate space is unchanged. */
    width: 1152px; height: 384px;
    background: linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);
    border: 1px solid #8a9a6a;
    border-radius: 4px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  /* Face wrapper: positions the original Small L content 96px down from
     the top edge so all the inner-element absolute coords (score box at
     top:18, info at top:14, etc.) continue to render in the right place
     relative to the FACE, not the new full-label-with-wrap canvas. */
  .rg-label-l .face {
    position: absolute;
    left: 0; right: 0;
    top: 90px;  /* face top sits at the fold line so its gradient meets it */
    height: 294px;
    background: linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);
  }
  /* Fold guide: thin horizontal line at y=84 (1.04" from bottom), 2pt
     (=8px at 288 DPI) tall, centered in the 0.083" fold zone. Tells the
     user precisely where to bend the label. Subtle but visible — same
     palette as the label border so it's understated but findable when
     folding. */
  .rg-label-l .fold-guide {
    position: absolute;
    left: 0; right: 0;
    top: 80px; height: 10px;
    background: #5a7030;
    opacity: 0.8;
    border-radius: 1px;
  }
  /* Wrap strip: top 0.25" of the label that wraps over the top of the
     comic case. Single horizontal row, contents from left:
       small score box (RG number only, no precision)
       title  •  issue  •  pub date  •  printing (if any)  •  6-char ID
     Padding 8px sides. Content baseline-aligned. Background blends with
     the face gradient (transparent — inherits from .rg-label-l). */
  .rg-label-l .wrap-strip {
    position: absolute;
    left: 0; right: 0;
    top: 0; height: 80px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px 0 48px;
    box-sizing: border-box;
    font-family: 'Barlow Condensed', sans-serif;
    overflow: hidden;
    white-space: nowrap;
    background: linear-gradient(180deg, #b58a5f 0%, #d6b391 45%, #eedbc5 100%);
  }
  .rg-label-l .wrap-strip .ws-score {
    flex: 0 0 auto;
    width: 60px; height: 56px;
    background: #1a2208;
    border-radius: 10px;
    display: flex;
    align-items: center; justify-content: center;
    color: #b8d820;
    font-family: 'Noto Sans Display', sans-serif;
    font-weight: 900;
    font-size: 38px;
    line-height: 1;
  }
  .rg-label-l .wrap-strip .ws-ttl {
    flex: 0 1 auto;
    font-size: 40px;
    font-weight: 700;
    color: #0d0d0f;
    letter-spacing: 0.2px;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .rg-label-l .wrap-strip .ws-iss,
  .rg-label-l .wrap-strip .ws-date,
  .rg-label-l .wrap-strip .ws-prt {
    flex: 0 0 auto;
    font-size: 34px;
    font-weight: 600;
    color: #2a3a18;
  }
  .rg-label-l .wrap-strip .ws-id {
    flex: 0 0 auto;
    margin-left: auto;
    /* S15 May 29: align the ID's right edge with the face QR code, which
       sits at x=1008 (0.5" from the physical right edge / 3.5" from left
       — the trim line). The strip has 12px right padding; we need the ID
       144px in from the right edge, so add 132px (144 − 12) of right
       margin. After the user trims the label to 3.5", the ID and QR both
       sit flush against the new right edge. */
    margin-right: 60px;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-size: 26px;
    font-weight: 600;
    color: #2a3a18;
    letter-spacing: 1px;
  }
  /* Separator dot between wrap-strip fields. Pure CSS, no DOM needed.
     Renders only between adjacent .ws-iss/.ws-date/.ws-prt elements. */
  .rg-label-l .wrap-strip .ws-iss + .ws-date::before,
  .rg-label-l .wrap-strip .ws-date + .ws-prt::before,
  .rg-label-l .wrap-strip .ws-iss + .ws-prt::before {
    content: '·';
    margin-right: 14px;
    color: #6a7a48;
    font-weight: 700;
  }
  .robot-badge { display: none; }
  .rg-label-l .robot-badge {
    position: absolute;
    left: 724px; top: 20px; width: 190px; height: 232px;
    display: flex; align-items: flex-end; justify-content: center;
  }
  .rg-label-l .robot-badge img {
    width: 160px; height: auto;
    opacity: 0.8;
  }
  .rg-label-l .meta-id-lbl, .rg-label-l .meta-id-val { display: none; }
  .url-id { font-weight: 800; }
  .rg-label-l .url-id { font-size: 24px; }
  .rg-label-l .score-box {
    width: 252px; height: 252px;
    background: #1a2208;
    border-radius: 38px;
    position: absolute;
    left: 18px; top: 18px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label-l .rg-word {
    font-size: 24px; font-weight: 700;
    color: #6a8030; letter-spacing: 3px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 14px;
  }
  .rg-label-l .rg-stars {
    opacity: 0.5;
    position: absolute; top: 44px; left: 0; right: 0;
    text-align: center; font-size: 24px; line-height: 1; letter-spacing: 2px;
  }
  .rg-label-l .rg-num-wrap {
    display: inline-flex;
    line-height: 1;
  }
  .rg-label-l .rg-num {
    /* S15 May 29 (Option A test on Small L only): 150px → 160px font,
       scaleX(0.625) → scaleX(0.75). Makes the score number larger and
       less horizontally squished. Risk: ~22% width growth eats the
       ~10px clearance to .rg-prec at the old size. If real-print test
       shows the number colliding with the precision modifier, revert
       to: font-size: 150px; transform: scaleX(0.625).
       Other label variants (Small R / Square / Large) intentionally
       unchanged pending verification on this one. */
    font-size: 160px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.75);
    transform-origin: center;
  }
  .rg-label-l .rg-prec {
    /* Absolute to the score-box corner, out of flow — never displaces
       the centered number. Matches Small R: sized up 30 → 50 (= title)
       with the tighter top:34/right:20 inset for the larger glyph. */
    position: absolute;
    top: 34px; right: 20px;
    font-size: 50px; font-weight: 700;
    color: #b8d820; opacity: 0.9;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: right center;
    line-height: 1;
    letter-spacing: 1px;
    white-space: nowrap;
  }
  .rg-label-l .rg-v {
    font-size: 20px;
    color: #5a7030;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 14px;
    letter-spacing: 1px;
  }
  /* Content column: right of the score box. Right boundary keeps it clear
     of the price pad / QR column on the right side. */
  .rg-label-l .info {
    position: absolute;
    left: 290px; top: 8px; right: 436px;
    display: flex; flex-direction: column;
  }
  .rg-label-l.has-price .info { right: 436px; }
  .rg-label-l .info-upper {
    padding-bottom: 4px;
  }
  .rg-label-l .ttl {
    font-size: 58px; font-weight: 900;
    color: #0d0d0f; line-height: 1.0;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    white-space: normal;
    max-height: 118px;
    overflow: hidden;
  }
  .rg-label-l .iss {
    font-size: 52px; font-weight: 600;
    color: #333; line-height: 1.0;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    display: flex; gap: 24px; align-items: baseline;
  }
  .rg-label-l .prt {
    font-size: 20px; color: #555544;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
  }
  .rg-label-l .info-lower { padding-top: 5px; }
  .rg-label-l .meta-grid {
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 16px; row-gap: 3px;
    align-items: baseline;
  }
  /* +2pt vs Small R's already-bumped 24 → 26, per user spec for Small L. */
  .rg-label-l .meta-lbl {
    font-size: 26px; font-weight: 600;
    color: #2a3a18;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label-l .meta-val {
    font-size: 34px; font-weight: 800;
    color: #0d0d0f;
    font-family: 'Noto Sans Mono', monospace;
  }
  /* QR column — right edge at x=1008 (3.5" from left / 0.5" from the
     physical right edge). qr-col is 134 wide → left = 874. */
  .rg-label-l .qr-col {
    position: absolute;
    /* QR column right edge at x=1008 (0.5" from the label's physical
       right edge / 3.5" from left). align-items:flex-end so the QR
       canvas's right edge lands exactly on x=1008, matching the URL
       beneath it (which is right-anchored to the same line). */
    right: 72px; bottom: 48px;
    width: 160px;
    display: flex; flex-direction: column;
    align-items: flex-end; gap: 4px;
  }
  .rg-label-l .qr-col .qrc canvas,
  .rg-label-l .qr-col .qrc img {
    width: 150px !important;
    height: 150px !important;
  }
  .rg-label-l .verify {
    display: none;
  }
  .rg-label-l .url {
    /* S14 fix: the URL was positioned correctly (left:874 width:134, same
       as the QR column) but the string "robograder.app/id/XXXXXX" (~24
       chars) is far wider than 134px at 16px mono, so it overflowed the
       column and ran to the label's right edge — looking unaligned even
       though the box wasn't. Fix: anchor by RIGHT edge to x=1008 (the
       label's 0.5"-from-edge line, matching where the QR's right edge
       sits) and shrink so the whole URL fits within the printed-content
       zone (right edge 3.5" from left). right = 1152 − 1008 = 144. */
    font-size: 20px; color: #5a6a4a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: right;
    position: absolute;
    right: 72px; bottom: 14px;
    letter-spacing: 0px;
    white-space: nowrap;
  }
  /* Price pad — to the LEFT of the QR column. Width 200, right edge at
     x=854 (20px gap to the QR col at x=874) → left x=654. */
  .rg-label-l .price-pad { display: none; }
  .rg-label-l.has-price .price-pad {
    display: block;
    position: absolute;
    left: 724px; top: 18px;
    width: 190px; height: 150px;
    background: #ffffff;
    border: 1px solid #b8c098;
    border-radius: 14px;
  }
  .rg-label-l.has-price .price-pad .price-placeholder {
    position: absolute;
    top: 16px; left: 0; right: 0;
    text-align: center;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 36px; font-weight: 600;
    color: #7a8a5a; letter-spacing: 0.5px;
  }
  .rg-label-l.has-price .price-pad .price-value {
    position: absolute;
    top: 50%; left: 0; right: 0;
    transform: translateY(-50%);
    text-align: center;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: center;
    font-size: 52px; font-weight: 900;
    color: #0d0d0f;
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
     S14 OVERHAUL. New layout per user direction:

       TOP-RIGHT:  Score box, 220×220 (right:14 top:14). Precision
                   modifier sits ABOVE the big number (carried over from
                   the Small/Large clip fix — no more ± collision).
       TOP-LEFT:   Title in the corner (narrow column beside the score
                   box), then Issue+PubDate, then printing, then
                   GRADED/Grade Date, then ID/ID value, stacked downward.
       BOTTOM-LEFT:  QR cluster — SCAN TO VERIFY above, QR, URL below.
       BOTTOM-RIGHT: Optional price pad.

     Coordinate map (576 × 576):
       Score box:   right:14,  top:14,   220×220  → x=342-562, y=14-234
       Info column: left:18,   top:14,   right:248 → x=18-328,  y from 14
                    (right:248 keeps a 14px gutter to the score box at
                     x=342; width ≈ 310px)
       QR cluster:  left:18,   bottom:14, 150 wide → x=18-168, anchored
                    bottom-left; SCAN above (flex order:-1), URL below
       Price pad:   right:18,  bottom:14, 210×190 → bottom-right corner

     The info column is tall (y=14 down to ~y=400 before the QR/price row)
     so the five stacked fields fit even for 2-line titles. */
  .rg-label-square {
    width: 576px; height: 576px;
    background: linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);
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
  .rg-label-square .rg-stars {
    opacity: 0.5;
    position: absolute; top: 38px; left: 0; right: 0;
    text-align: center; font-size: 22px; line-height: 1; letter-spacing: 2px;
  }
  .rg-label-square .rg-num-wrap {
    display: inline-flex;
    line-height: 1;
  }
  .rg-label-square .rg-num {
    /* S14: 122 → 130, matching the score-prominence pass on the other
       labels (proportionally smaller bump to suit the 220px box). */
    font-size: 130px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: center;
  }
  /* Precision absolute to the score-box corner, out of flow — never
     displaces the centered number. S14: sized up 24 → 34 to match the
     Square title (same rule as the other labels). top:30/right:16 inset
     tuned for the larger glyph in the 220px box; verified ~18px clear
     of the 130px centered number. */
  .rg-label-square .rg-prec {
    position: absolute;
    top: 30px; right: 16px;
    font-size: 34px; font-weight: 700;
    color: #b8d820; opacity: 0.9;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: right center;
    line-height: 1;
    letter-spacing: 1px;
    white-space: nowrap;
  }
  .rg-label-square .rg-v {
    font-size: 18px;
    color: #5a7030;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 12px;
    letter-spacing: 1px;
  }
  /* Info column — TOP-LEFT corner, beside the score box. */
  .rg-label-square .info {
    position: absolute;
    left: 18px; top: 14px; right: 248px;
    display: flex; flex-direction: column;
  }
  .rg-label-square .info-upper {
    padding-bottom: 8px;
    border-bottom: 1px solid #b0b89a;
  }
  .rg-label-square .ttl {
    /* Narrower column now (~310px beside the score box), so 34px keeps
       a typical title to 1-2 lines. */
    font-size: 34px; font-weight: 900;
    color: #0d0d0f; line-height: 1.05;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    word-wrap: break-word;
  }
  .rg-label-square .iss {
    font-size: 24px; font-weight: 600;
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    display: flex; gap: 14px; align-items: baseline;
    margin-top: 4px;
  }
  .rg-label-square .prt {
    font-size: 19px; color: #555544;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    margin-top: 3px;
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
  /* QR cluster — BOTTOM-LEFT corner. SCAN TO VERIFY above (flex order:-1),
     QR, then URL beneath. */
  .rg-label-square .qr-col {
    position: absolute;
    left: 18px; bottom: 34px;
    width: 150px;
    display: flex; flex-direction: column;
    align-items: center; gap: 2px;
  }
  .rg-label-square .qr-col .qrc canvas,
  .rg-label-square .qr-col .qrc img {
    width: 132px !important;
    height: 132px !important;
  }
  .rg-label-square .verify {
    font-size: 14px; color: #7a8a5a;
    letter-spacing: 1.2px;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600; text-align: center;
    order: -1;
    margin-bottom: 2px;
  }
  /* URL under the QR, left-aligned with the QR cluster. */
  .rg-label-square .url {
    font-size: 13px; color: #5a6a4a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: center;
    position: absolute;
    left: 18px; width: 150px; bottom: 14px;
    letter-spacing: 0.2px;
  }
  /* Price pad — BOTTOM-RIGHT corner. */
  .rg-label-square .price-pad {
    display: none;
  }
  .rg-label-square.has-price .price-pad {
    display: block;
    position: absolute;
    right: 18px; bottom: 14px;
    width: 210px; height: 190px;
    background: #ffffff;
    border: 1px solid #b8c098;
    border-radius: 14px;
  }
  .rg-label-square.has-price .price-pad .price-placeholder {
    position: absolute;
    top: 14px; left: 0; right: 0;
    text-align: center;
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 34px;
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
    /* S14: width shortened from 2160px (7.5") to 1800px (6.25"), i.e.
       1.25" trimmed off the RIGHT edge. Reason: these labels overlay
       CGC slab cases, and the far-right 1.25" was covering CGC's
       holographic authenticity seal and leaving residue when removed.
       The user trims the printed sheet's right margin by hand; the
       OL5450 stock is still 7.5"-pitch so sheet alignment is unchanged
       (only labelW in LABEL_FORMATS shrinks, not the row pitch).
       All right-anchored children (QR, URL, price pad, info right
       boundary) use the CSS right property so they automatically
       re-anchor to the new 1800px right edge — nothing is clipped, the
       layout just becomes 360px narrower with everything still 18px
       clear of the new right edge. 1800px = 6.25" at 288 DPI. */
    width: 1800px; height: 432px;
    background: linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);
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
  .rg-label-large .rg-stars {
    opacity: 0.5;
    position: absolute; top: 69px; left: 0; right: 0;
    text-align: center; font-size: 37px; line-height: 1; letter-spacing: 3px;
  }
  .rg-label-large .rg-num-wrap {
    display: inline-flex;
    line-height: 1;
  }
  .rg-label-large .rg-num {
    /* S14: bumped back up to 240px (from 224) — now that the condensed
       text renders correctly in the PDF there is ample room, and the
       user wants the headline score more prominent. Still centered in
       the 396px box; the precision is a separate absolute element so a
       larger number cannot collide with it (verified: 2-digit number at
       240px scaleX(0.625) ≈ x123–273; precision right-anchored ≈ x290+,
       ~17px clearance). */
    font-size: 240px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: center;
  }
  .rg-label-large .rg-prec {
    /* Absolute to the score-box corner, out of flow — never displaces
       the centered number. S14: sized UP to 64px to match the title
       (was 46px, barely readable in print per user). At
       transform-origin:right it grows leftward from the right:36 inset,
       staying clear of the centered number (see .rg-num note). */
    position: absolute;
    top: 56px; right: 34px;
    font-size: 64px; font-weight: 700;
    color: #b8d820; opacity: 0.9;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: right center;
    line-height: 1;
    letter-spacing: 1px;
    white-space: nowrap;
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
    /* S14: right boundary moved left 72px (220 → 292) to keep the same
       gap to the QR column, which shifted left 0.25" for trim clearance.
       Width = 1800 − 444 − 292 = 1064px. */
    left: 444px; top: 28px; right: 292px;
    display: flex; flex-direction: column;
  }
  .rg-label-large.has-price .info {
    /* S14: with price tag, the info must clear the relocated price pad
       (now at right:322, 340px wide → its left edge is 662 from the
       right). Boundary moved left 72px (580 → 652) to preserve the
       prior gap. Width = 1800 − 444 − 652 = 704px (still positive). */
    right: 652px;
  }
  .rg-label-large .info-upper {
    padding-bottom: 14px;
    border-bottom: 1px solid #b0b89a;
  }
  .rg-label-large .ttl {
    font-size: 64px; font-weight: 900;
    color: #0d0d0f; line-height: 1.1;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
  }
  .rg-label-large .iss {
    font-size: 42px; font-weight: 600;
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
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
    /* S14: shifted left 72px (0.25" @288DPI) — right:18 → right:90 — to
       guarantee right-side clearance so no QR is cut off near the trim
       edge. The price pad and .info right boundary shift by the same
       72px to keep the column relationships intact. */
    position: absolute;
    right: 90px; top: 22px;
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
    /* S14: +2pt (22 → 30px; 1pt = 4px @288DPI). Sits inside .qr-col so
       it moves left with the QR automatically — no separate offset. */
    font-size: 30px; color: #7a8a5a;
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
    /* S14: shifted left 72px (right:18 → right:90) to stay aligned with
       the QR column above it, which also moved left for trim clearance. */
    right: 90px; bottom: 26px;
    letter-spacing: 0.3px;
  }
  /* Price pad for large variant — bigger, fills most of the taller cell.
     S13: nudged left from right:220 → right:250 to add visual breathing
     room between the pad's right edge and the QR's left edge.
     S14: shifted a further 72px left (right:250 → right:322) so it moves
     in step with the QR/URL column's 0.25" leftward shift, preserving
     the same gap between the price pad and the QR column. The
     .info.has-price right boundary moves the same 72px (580 → 652) so
     the text column doesn't run into the relocated pad. */
  .rg-label-large.has-price .price-pad {
    display: block;
    position: absolute;
    top: 28px; right: 322px;
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
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: center;
    font-size: 80px;
    font-weight: 900;
    color: #1a2208;
    letter-spacing: 0.5px;
  }
  .rg-label-large.has-price .price-pad .price-value {
    font-size: 130px;
  }
  .rg-label-square.has-price .price-pad .price-value {
    /* S14: square pad is now 210×190 (bottom-right corner). 72px keeps a
       4-5 char value ("$1,200") inside the narrower pad without clipping. */
    font-size: 72px;
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
  // S17: the Print ownership category IS the queue. Count every passed-in book
  // with an RG grade. No localStorage queue, no per-book Add/Remove toggle.
  const printable = (Array.isArray(allItems) ? allItems : []).filter(c => c && c.roboGrade);
  const queueCount = printable.length;
  const printDisabled = queueCount === 0;

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
      ${seg('small',   'Small R')}
      ${seg('small-l', 'Small L')}
      ${seg('square',  'Square')}
      ${seg('large',   'Large')}
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
  //
  // S14 fix: a SINGLE requestAnimationFrame ran fitPreviewToFrame before
  // the modal's layout had fully settled (modal still animating in /
  // fonts still loading), so area.clientWidth was not yet final. The
  // Large label (the widest aspect ratio) got a slightly-too-large scale
  // and clipped on the right; switching tabs re-ran the fit against a
  // now-settled layout, which is why it "fixed itself." Fix: run it
  // across several settle points AND attach a ResizeObserver so any
  // later size change (open animation finishing, chrome appearing,
  // rotation) re-fits automatically. Idempotent — recomputing with the
  // same measurements just sets the same scale.
  // S14 fix: a SINGLE requestAnimationFrame ran fitPreviewToFrame before
  // the modal's layout had settled, so the widest label (Large) clipped
  // on first open. We recompute across several settle points so the
  // measurement happens against final layout.
  //
  // S14 fix #2 (micro-preview regression): an earlier version of this
  // ALSO attached a ResizeObserver to .lvm-preview-area. That created a
  // feedback loop — fitPreviewToFrame() mutates the frame's scale, which
  // changes the frame's rendered size, which changes the observed area's
  // content size, which re-fires the observer, which computes a smaller
  // scale… ratcheting the preview to microscopic size (user
  // screenshot). A ResizeObserver must never observe an element whose
  // size its own callback mutates. Removed entirely. Genuine viewport
  // changes (rotation, window resize) are handled by window-level
  // listeners instead — those fire only on real viewport changes, never
  // as a side effect of the scale we set.
  const fit = () => fitPreviewToFrame(modal);
  requestAnimationFrame(fit);
  requestAnimationFrame(() => requestAnimationFrame(fit)); // after 2 frames
  setTimeout(fit, 60);
  setTimeout(fit, 200);   // after the open transition (~0.18s) completes
  if (!modal._fitViewportWired) {
    modal._fitViewportWired = true;
    const onViewportChange = () => {
      if (modal.classList.contains('open')) fit();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    modal._fitViewportHandler = onViewportChange;
  }
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
  // Available WIDTH is scale-independent: the preview area's width is
  // driven by the modal/viewport, not by the label's scale. Safe to use
  // area.clientWidth.
  const areaStyle = getComputedStyle(area);
  const padX = parseFloat(areaStyle.paddingLeft) + parseFloat(areaStyle.paddingRight);
  // Pull in another 4% margin so the label visibly clears the modal edges
  // — a label that touches the right edge looks clipped even if it's not.
  const availW = (area.clientWidth - padX) * 0.96;
  if (availW <= 0) return;
  // Available HEIGHT must NOT come from area.clientHeight: the frame is a
  // child of the area, so if the area hugs its content, shrinking the
  // label shrinks the area, which would feed back into a smaller scale
  // on the next call — the ratchet-to-micro bug. Derive a STABLE height
  // budget from the viewport instead: the preview should occupy at most
  // ~38% of the visible viewport height. This value does not change when
  // we change the label scale, so repeated fit() calls converge to the
  // same result instead of spiralling. (The window-level resize listener
  // re-runs fit on genuine viewport changes, which is correct.)
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const availH = vh * 0.38;
  // Read the format's pixel dimensions from inline CSS variables on the
  // frame (set in renderModal based on the active format). Falls back to
  // 1152×288 (Small) if not set.
  const labelW = parseFloat(frame.style.getPropertyValue('--lvm-label-w')) || 1152;
  const labelH = parseFloat(frame.style.getPropertyValue('--lvm-label-h')) || 288;
  // Scale to the MORE constraining dimension so neither axis overflows
  // (Square is 1:1 so height matters as much as width; the long Small/
  // Large labels are width-bound).
  const scaleW = availW / labelW;
  const scaleH = availH / labelH;
  const scale = Math.min(0.85, scaleW, scaleH);
  // Guard against a degenerate tiny scale (e.g. a transient 0-width
  // measurement slipping through): never set below a sane floor.
  if (scale < 0.05) return;
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
// S14: resolve only once the label's web fonts are actually usable, so
// html2canvas captures the condensed faces (not the fallback). Uses the
// FontFace Loading API. We explicitly load() the specific
// family/weight/stretch combos the label CSS depends on — listing them
// makes document.fonts.ready meaningful (ready alone can resolve before
// a lazily-injected <link>'s faces finish). Bounded so a slow/blocked
// font CDN degrades to "print with whatever we have" instead of hanging
// the export.
function ensureLabelFontsReady() {
  if (!document.fonts || !document.fonts.load) {
    // No FontFace API (very old engine) — fall back to a fixed wait.
    return new Promise(r => setTimeout(r, 600));
  }
  // The exact faces the label markup renders. font-stretch goes in the
  // shorthand as a percentage keyword between style and size for the
  // condensed Noto Sans Display; plain shorthands for the others.
  const specs = [
    '900 condensed 100px "Noto Sans Display"',
    '700 condensed 100px "Noto Sans Display"',
    '500 condensed 100px "Noto Sans Display"',
    '800 100px "Noto Sans Mono"',
    '700 100px "Barlow Condensed"',
    '600 100px "Barlow Condensed"',
    '500 100px "Barlow Condensed"',
  ];
  // Some engines reject the 'condensed' keyword in the load() shorthand;
  // fall back to a non-stretch shorthand for those so the load() still
  // resolves the family (the @font-face/axis still applies via CSS).
  const loadOne = (s) => {
    try {
      return document.fonts.load(s).catch(() => null);
    } catch (e) {
      const noStretch = s.replace(' condensed ', ' ');
      try { return document.fonts.load(noStretch).catch(() => null); }
      catch (e2) { return Promise.resolve(null); }
    }
  };
  const loads = Promise.all(specs.map(loadOne))
    .then(() => document.fonts.ready)
    .catch(() => null);
  // Hard timeout: never let font loading block the export indefinitely.
  const timeout = new Promise(r => setTimeout(r, 4000));
  return Promise.race([loads, timeout]);
}

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
  // S17: the Print ownership category IS the queue. Print every passed-in book
  // that has an RG grade (only graded books get a label) — no separate
  // localStorage queue. Books are added/removed via the List-view LABEL toggle.
  const comicsToprint = (Array.isArray(allItems) ? allItems : [])
    .filter(c => c && c.roboGrade);

  if (comicsToprint.length === 0) {
    alert('No graded books in the print queue.');
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
//   SMALL (Avery 8161):
//     Top margin 0.5", left margin 0.1667", column gap 0.1882", row gap 0
//     Label 4" × 1", 2 cols × 10 rows = 20 per sheet
//   SMALL-L (Avery 5162): S15 May 28
//     Top margin 0.8326", left margin 0.1556", column gap 0.1875", row gap 0
//     Label 4" × 1.3333", 2 cols × 7 rows = 14 per sheet
//   SQUARE (Avery 22806):
//     Top margin 0.625", left margin 0.625", column gap 0.625", row gap 0.5833"
//     Label 2" × 2", 3 cols × 4 rows = 12 per sheet
//   LARGE (OL5450):
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

  // S18: Small-L only — shift the LEFT column right by this much so its grade
  // box + top-strip content clear the printer's non-printable left margin
  // (~3–5mm) and any leftward registration drift. Only the left column has
  // content against a page edge (the right column's inner content is interior);
  // the full-width band still fills the widened left margin with green. Tune to
  // your printer: raise it if the grade box is still clipped, lower it if the
  // left column drifts too far toward the gap. 0.1in = 2.5mm.
  const SMALL_L_LEFT_SHIFT_IN = 0.1;

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
      labelsHTML += `<div class="pdf-label-box" data-idx="${i}" style="width:${fmt.pixelW}px;height:${fmt.pixelH}px;display:block;background:linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);">${renderLabelMarkup(comics[i], opts)}</div>`;
    }
    offscreen.innerHTML = labelsHTML;

    // Render QR codes synchronously (library is already loaded from the
    // modal preview path).
    renderQRsIn(offscreen);

    // S14 FIX — condensed text was rendering wrong in the printed PDF
    // (titles colliding: "UncannyX-Men", "FantasticFour"). Root cause:
    // html2canvas rasterizes whatever font is loaded AT CAPTURE TIME.
    // The label font (Noto Sans Display, the condensed variable face) is
    // requested via an injected <link>, but font fetch+parse is async
    // and frequently NOT done within the single requestAnimationFrame we
    // used to wait. html2canvas then captured the FALLBACK font — wider,
    // un-condensed metrics — so titles laid out for condensed widths
    // overflowed and letters ran together. The score numbers survived
    // because they're large/isolated; the tightly-set titles did not.
    //
    // Fix: explicitly wait for the FontFace Loading API to confirm the
    // exact faces we depend on are ready before capturing. We request
    // the specific family+weight+stretch combos the labels actually use
    // so document.fonts.load resolves only when those faces are usable,
    // then await document.fonts.ready as a backstop. Bounded by a
    // timeout so a font-CDN hiccup degrades to "capture anyway" rather
    // than hanging the export forever.
    await ensureLabelFontsReady();

    // One more animation frame so layout + QR canvases are flushed after
    // fonts settle (font swap can reflow text).
    await new Promise(r => requestAnimationFrame(r));

    // S20: full-bleed gradient band for Small L (Avery 5162). Physical printing
    // clips the page's left/right margins + the inter-column gap, leaving white
    // strips (worst on the LEFT column). We lay a page-width gradient band behind
    // each row so the green bleeds edge-to-edge; the label images (same gradient,
    // same row height) sit on top, so the margins/gap read green instead of white.
    // Rendered once and reused for every row. Small-L only — other formats are
    // left untouched (Square's row gaps would fill green and change its look).
    let bandImgData = null;
    if (opts.size === 'small-l') {
      const PAGE_W_IN = 8.5;
      const dpi = fmt.pixelW / fmt.labelW;          // 288
      const bandEl = document.createElement('div');
      bandEl.style.cssText = `width:${Math.round(PAGE_W_IN * dpi)}px;height:${fmt.pixelH}px;background:linear-gradient(180deg, #b58a5f 0%, #d6b391 38%, #eedbc5 100%);`;
      offscreen.appendChild(bandEl);
      try {
        const bandCanvas = await window.html2canvas(bandEl, { scale: 1, backgroundColor: '#d4d9be', logging: false });
        bandImgData = bandCanvas.toDataURL('image/jpeg', 0.92);
      } catch (e) { bandImgData = null; /* fall back to per-label gradients only */ }
    }

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
      let x = fmt.sheetLeftMargin + col * (fmt.labelW + fmt.colGap);
      const y = fmt.sheetTopMargin + row * (fmt.labelH + fmt.rowGap);

      // S18: nudge the Small-L LEFT column right (see SMALL_L_LEFT_SHIFT_IN).
      if (opts.size === 'small-l' && col === 0) {
        x += SMALL_L_LEFT_SHIFT_IN;
      }

      // S20: lay the full-width gradient band for this row (Small L only), once
      // per row at col 0, BEFORE the label image so the label draws on top of it.
      if (bandImgData && col === 0) {
        pdf.addImage(bandImgData, 'JPEG', 0, y, 8.5, fmt.labelH);
      }

      const canvas = await window.html2canvas(boxes[i], {
        scale: 1,
        useCORS: true,
        backgroundColor: '#d4d9be',
        logging: false,
        // S14 FIX (round 2) — the real reason condensed text was still
        // wrong in the PDF. html2canvas renders into a CLONED document
        // in a sandboxed iframe. Web fonts referenced by a parent <link>
        // are re-fetched asynchronously by that clone, and html2canvas
        // does NOT wait for the clone's fetch — so it rasterized the
        // FALLBACK font even though the parent document had the real
        // font loaded (which is why the on-screen preview was correct
        // but the PDF was not — see user screenshots). Waiting on the
        // PARENT's document.fonts.ready (the previous fix) could never
        // solve this because it's the CLONE's font load that's late.
        //
        // onclone runs against the cloned document BEFORE rasterization
        // and html2canvas awaits a returned promise. We re-inject the
        // font <link> into the clone (so its @font-face rules exist
        // there), explicitly load() the exact faces in the clone's own
        // FontFaceSet, and await the clone's fonts.ready. Now the clone
        // has the condensed faces resolved before it's drawn. Bounded by
        // a timeout so a hung clone fetch degrades to "draw anyway"
        // rather than freezing the export at the booth.
        onclone: async (clonedDoc) => {
          try {
            if (!clonedDoc.querySelector('link[data-label-fonts]')) {
              const src = document.querySelector('link[data-label-fonts]');
              if (src) clonedDoc.head.appendChild(src.cloneNode(true));
            }
            const cf = clonedDoc.fonts;
            if (cf && cf.load) {
              const specs = [
                '900 condensed 100px "Noto Sans Display"',
                '700 condensed 100px "Noto Sans Display"',
                '500 condensed 100px "Noto Sans Display"',
                '800 100px "Noto Sans Mono"',
                '700 100px "Barlow Condensed"',
                '600 100px "Barlow Condensed"',
                '500 100px "Barlow Condensed"',
              ];
              const loadOne = (s) => {
                try { return cf.load(s).catch(() => null); }
                catch (e) {
                  try { return cf.load(s.replace(' condensed ', ' ')).catch(() => null); }
                  catch (e2) { return Promise.resolve(null); }
                }
              };
              const all = Promise.all(specs.map(loadOne))
                .then(() => cf.ready).catch(() => null);
              await Promise.race([all, new Promise(r => setTimeout(r, 3500))]);
            }
          } catch (e) { /* never let onclone throw — draw with what we have */ }
        },
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
                  : opts.size === 'small-l' ? '5162'
                  : '8161';
    const priceTag = opts.priceTag ? '-Price' : '';
    const filename = `Robograder-Labels-${sizeTag}${priceTag}-${new Date().toISOString().slice(0, 10)}.pdf`;
    // Deliver the PDF. Three environments behave differently:
    //
    //   1. Native iOS app (Capacitor WKWebView): navigator.share is NOT wired
    //      into the WKWebView, and jsPDF's pdf.save() builds a blob: URL the
    //      shell can't open (LSApplicationWorkspace Code=115) — it fails
    //      silently. So write the PDF to the cache dir with @capacitor/filesystem
    //      and hand its file:// URI to @capacitor/share, which opens the real
    //      iOS share sheet (Save to Files / Print / AirDrop). Requires those two
    //      plugins to be installed + `npx cap sync ios`.
    //   2. Mobile Safari PWA: navigator.share({files}) works → share sheet.
    //   3. Desktop browser: canShare is false → pdf.save() download.
    //
    const Cap = window.Capacitor;
    const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
    if (isNative) {
      const P = (Cap && Cap.Plugins) || {};
      const FS = P.Filesystem;
      const ShareP = P.Share;
      if (FS && ShareP) {
        try {
          // datauristring → strip the "data:application/pdf;base64," prefix so
          // Filesystem writes the raw base64 as binary (no encoding = base64).
          const b64 = pdf.output('datauristring').split(',')[1];
          const written = await FS.writeFile({ path: filename, data: b64, directory: 'CACHE' });
          let uri = written && written.uri;
          if (!uri) { uri = (await FS.getUri({ path: filename, directory: 'CACHE' })).uri; }
          await ShareP.share({ title: filename, url: uri });
          return; // delivered via the native share sheet (finally still cleans up)
        } catch (e) {
          const msg = (e && e.message) || String(e);
          if (/cancel|abort|dismiss/i.test(msg)) return; // user closed the sheet
          console.warn('[label] native share failed:', e);
          alert('Could not save the label PDF: ' + msg);
          return;
        }
      } else {
        // Plugins not in this build yet — tell us plainly instead of failing silently.
        alert('Saving labels in the app needs the Filesystem and Share plugins. '
            + 'Install @capacitor/filesystem and @capacitor/share, then run npx cap sync ios.');
        return;
      }
    }

    // Web (PWA / desktop): try the Web Share API with the file, fall back to the
    // browser download where file-sharing isn't offered. This path works today.
    const pdfBlob = pdf.output('blob');
    const pdfFile = new File([pdfBlob], filename, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      try {
        await navigator.share({ files: [pdfFile], title: filename });
        return; // delivered via the share sheet (finally still runs cleanup)
      } catch (shareErr) {
        if (shareErr && shareErr.name === 'AbortError') return; // user dismissed
        console.warn('[label] share failed, falling back to download:', shareErr);
      }
    }
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
  const isSmallL = opts.size === 'small-l';
  const showPrice = !!opts.priceTag;
  const includePrice = !!opts.includePrice;

  const rg = comic.roboGrade;
  const score = Math.round(rg.score ?? 0);
  // S16: Restoration state for purple coloring + check mark
  const _labelRestored = !!(comic.restorationHighConfidence || (comic.cgcNotes && /\b(RC|restored|restoration|conserved)\b/i.test(comic.cgcNotes)));
  const _labelRestoNeg = !!(comic.restorationCheckRan && !comic.restorationFlag && !_labelRestored);
  const _labelScoreColor = _labelRestored ? '#c8a8e8' : '#b8d820';
  const _labelBgColor = _labelRestored ? '#1a0a2a' : '#1a2208';
  const _labelCheckHtml = _labelRestoNeg ? '<span style="color:#9a7ab8;font-size:9px;font-weight:900;margin-left:2px">\u2713</span>' : '';
  // S17: assessment-tier stars on the label score box (room here, so ROBOGRADE
  // word stays and stars sit beneath it). 1 Main / 2 Deep / 3 Full + purple if
  // a Restoration check ran.
  const _labelTierStars = (() => {
    const _full = !!comic.fullAssessmentRan;
    const _deep = !!(comic.deepAssessmentRan || comic.highGradeTier || (comic.roboGrade && comic.roboGrade.deepAssessmentRan));
    const _restoRan = !!comic.restorationCheckRan;
    let _t = 1; if (_full) _t = 3; else if (_deep) _t = 2;
    // S17: chunky SVG star (short points, thick center) in the score color, not
    // the pointy Unicode ★. Size comes from the .rg-stars CSS per format (the
    // SVG fills the line via height:1em). Restoration star is purple.
    const _green = _labelRestored ? _labelScoreColor : '#b8d820';
    const _star = (c) => `<svg viewBox="0 0 24 24" style="height:1em;width:1em;display:inline-block;vertical-align:middle"><path d="M12.00,2.00 15.64,6.98 21.51,8.91 17.90,13.92 17.88,20.09 12.00,18.20 6.12,20.09 6.10,13.92 2.49,8.91 8.36,6.98Z" fill="${c}"/></svg>`;
    let _s = '';
    for (let i = 0; i < _t; i++) _s += _star(_green);
    if (_restoRan) _s += _star('#b58be0');
    return `<div class="rg-stars">${_s}</div>`;
  })();

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
  // S12 May 6: read assessment version from rg.version (not hardcoded V2.0
  // anymore). Current model returns "2.3" (S13 v7 — added paper-loss
  // defect category, per-corner inspection, severe-defect cap). Older
  // books in the user's collection may carry "2.0", "2.1", or "2.2" tags
  // from prior schema versions — display whatever was actually computed.
  // Falls back to "2.0" only if the field is missing entirely (extremely
  // old records pre-versioning).
  //
  // S14: precision widening applied after the mode-cap, same as
  // robograde-panel.js. The label is a snapshot tied to the print date,
  // and the precision printed should reflect today's reduced certainty
  // about a book originally assessed N years ago. Re-printing a label
  // years from now will show a wider ± than the original printing —
  // that's intentional. The print date is on the label too, so the
  // pairing reads correctly: "as of this print, with N years of paper
  // aging since the original assessment, the precision is wider."
  const highGradeRun = !!comic.highGradeUnlocked;
  const assessmentDateISO = comic.roboGradeDate;
  const widenFn = (window.RobograderPanel && window.RobograderPanel.widenPrecisionForAge)
    ? window.RobograderPanel.widenPrecisionForAge
    : function(n){ return n; };  // defensive fallback if panel module didn't load
  let precision = '';
  if (score < 100) {
    if (highGradeRun) {
      let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 3;
      n = Math.max(0, Math.min(6, n));
      n = widenFn(n, assessmentDateISO);
      const headroom = Math.max(0, 100 - score);
      if (n > headroom) n = headroom;
      precision = n > 0 ? `±${n}` : '';
    } else if (score >= 90) {
      precision = '';  // S18: '+' teaser removed
    } else {
      let n = rg.confidenceRange != null ? Math.round(rg.confidenceRange) : 8;
      n = Math.max(0, Math.min(16, n));
      n = widenFn(n, assessmentDateISO);
      const headroom = Math.max(0, 100 - score);
      if (n > headroom) n = headroom;
      precision = n > 0 ? `±${n}` : '';
    }
  }

  const versionStr = `V${esc(rg.version || '2.0')}`;
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
                  : isSmallL ? 'rg-label-l'
                  : 'rg-label';
  const wrapClass = baseClass + (showPrice ? ' has-price' : '');

  // S15 May 28: Small L wrap-strip — the 0.25" strip at the top of the
  // 4×1.333 label that folds 90° over the top of the comic case. Single
  // horizontal row, score-box-only (no precision), then the same identifying
  // fields as the face: title, issue, pub date, printing (if any), and the
  // 6-char roboGradeId. Same orientation as the face — the user folds the
  // strip backward (away from the face) so it reads correctly when viewed
  // from above the case. The fold guide is a thin line halfway between the
  // strip and the face, marking the 1.04"-from-bottom fold point.
  const smallLWrap = isSmallL ? `
      <div class="wrap-strip">
        <div class="ws-score">${score}</div>
        <div class="ws-ttl">${title}</div>
        ${issue ? `<div class="ws-iss">${issue}</div>` : ''}
        ${issueDate ? `<div class="ws-date">${issueDate}</div>` : ''}
        ${printing ? `<div class="ws-prt">${printing}</div>` : ''}
        <div class="ws-id">GRADE ID: <b>${gradeId}</b></div>
      </div>
      <div class="fold-guide"></div>
  ` : '';
  // For Small L, the face content lives inside a positioned wrapper so the
  // child element's absolute coords (still anchored at the face's top:0)
  // render correctly within the bottom 288px of the 384px canvas. For all
  // other sizes the face wrapper is omitted and the children sit directly
  // in the label canvas (unchanged behavior).
  const faceOpen  = isSmallL ? '<div class="face">' : '';
  const faceClose = isSmallL ? '</div>'             : '';

  return `
    <div class="${wrapClass}" data-grade-id="${gradeId}">
      ${smallLWrap}
      ${faceOpen}
      <div class="score-box"${_labelRestored ? ` style="background:${_labelBgColor}"` : ''}>
        <div class="rg-word">ROBOGRADE</div>
        ${_labelTierStars}
        <div class="rg-num-wrap"><span class="rg-num"${_labelRestored ? ` style="color:${_labelScoreColor}"` : ''}>${score}</span>${_labelCheckHtml}</div>
        ${precision ? `<span class="rg-prec"${_labelRestored ? ` style="color:${_labelScoreColor};opacity:0.9"` : ''}>${precision}</span>` : ''}
        <div class="rg-v">${versionStr}</div>
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
            <span class="meta-lbl meta-id-lbl">ID</span><span class="meta-val meta-id-val">${gradeId}</span>
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
      })() : '<div class="robot-badge"><img src="assets/Robograder_Charging.png" alt=""></div>'}
      <div class="qr-col">
        ${comic.publicListing
          ? `<div class="qrc" data-qr-id="${gradeId}"></div>
             <div class="verify">SCAN TO VERIFY</div>`
          : `<!-- S14: private book — no QR. A scannable code that lands on a
                  "this listing is private" page reads as broken to anyone
                  who scans it (e.g. a booth visitor). Showing nothing is
                  cleaner than showing a dead link. The grade ID still
                  prints below for manual reference. -->
             <div class="qr-private" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center">
               <div style="font-size:9px;letter-spacing:1.5px;color:#9a8a7a;text-transform:uppercase;line-height:1.5">Private<br>Listing</div>
             </div>`}
      </div>
      ${comic.publicListing
        ? `<div class="url">robograder.app/id/<span class="url-id">${gradeId}</span></div>`
        : `<div class="url" style="color:#b0a494">ID ${gradeId}</div>`}
      ${faceClose}
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
