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
let _singleMode = false;   // see openLabelViewer
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
    pixelW: 1152, pixelH: 384,
    // S22 — SINGLE-LABEL CASE IS A DIFFERENT PIECE OF STOCK.
    // Nobody makes a 4" x 1.333" thermal roll. The roll Matt bought is 4" x 2",
    // so a single Case label prints on that while the Avery 5162 SHEET keeps
    // its 1.333". Same design, 0.67" (192px) taller, and the extra height is
    // the fold-over: it wraps the top of the case and covers the back.
    // Kept as a variant of 'small-l' rather than a new size: the format list is
    // what the size chips render from, and a second Case chip would make the
    // user choose between two things that are the same label.
    single: {
      labelW: 4.0, labelH: 2.0,
      pixelW: 1152, pixelH: 576
    }
  },
  // Card format — Avery 94235 (2.625"x2" fold-over, 756x576px @288DPI). Folds
  // horizontally over the top edge of a card case: BOTTOM half = FRONT (score +
  // identity + optional price), TOP half = BACK (QR + robot, rotated 180deg).
  // Fold zone 0.25" (case thickness) centered -> 0.875" usable front and back.
  // Geometry extracted directly from the official Avery 94235 template PDF:
  //   Page 8.5x11; label 2.625x2.0; 3 cols x 5 rows = 15/sheet.
  //   Top margin 0.5"; left margin 0.1875"; col pitch 2.75" (gap 0.125");
  //   row pitch 2.0" (gap 0").
  card: {
    name: 'card',
    sheetCount: 15,
    rows: 5, cols: 3,
    labelW: 2.625, labelH: 2.0,
    sheetTopMargin: 0.5,
    sheetLeftMargin: 0.1875,
    colGap: 0.125,
    rowGap: 0,
    pixelW: 756, pixelH: 576
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
  // Card -> Avery 94235 (2.625"x2" fold-over). Amazon affiliate link (Matt).
  card: {
    label: 'Avery 94235',
    url: 'https://amzn.to/4qf8Zy3',
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

// ── S22: ROLLS FOR SINGLE LABELS, SHEETS FOR SHEETS ────────────────────────
// Printing one label at a time means a thermal roll printer, not an Avery
// sheet - a sheet is 20 labels and you do not feed one through for a single
// book. So the Buy button points at roll stock in single-label mode and at the
// sheet stock in sheet mode.
//
// ASINs supplied by Matt (Amazon refuses automated fetches, so the a.co short
// links he sent first could not be resolved from here). The associate tag is
// appended at build time rather than stored in the URL, so there is one place
// to change it if the tag ever does.
// An entry with an empty asin falls back to that size's sheet link, so the
// button is never broken or pointed somewhere wrong - see buyLink below.
//
// NOTE on small-l: that roll is 4" x 2", not the 4" x 1.33" the Case layout is
// built for. The layout has to be adapted to the taller stock before this link
// is the right thing to offer.
const AMAZON_ASSOCIATE_TAG = 'grailstoaston-20';
function amazonProductUrl(asin) {
  return 'https://www.amazon.com/dp/' + asin + '?tag=' + AMAZON_ASSOCIATE_TAG;
}
const LABEL_ROLL_LINKS = {
  small:     { label: '4\u2033 \u00d7 1\u2033 thermal rolls', asin: 'B0H2668WYX', vendor: 'Amazon' },
  square:    { label: '2\u2033 \u00d7 2\u2033 thermal rolls', asin: 'B0FDFWJ4K6', vendor: 'Amazon' },
  'small-l': { label: '4\u2033 \u00d7 2\u2033 thermal rolls', asin: 'B0FGXX2NJC', vendor: 'Amazon' }
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
// The geometry a size renders at. Only Case differs between one label and a
// sheet - see the `single` block on 'small-l' - so everything else falls
// straight through to its own entry.
export function _fmtFor(size) {
  const f = LABEL_FORMATS[size];
  if (!f) return f;
  if (_singleMode && f.single) return { ...f, ...f.single };
  return f;
}

const OPTIONS_KEY = 'robograder.labelOptions.v1';

// S14: 'small-l' is the mirrored/tightened Small variant (right edge at
// 3.5"). The original 'small' is now surfaced in the UI as "Small R" but
// the stored key stays 'small' for backward compatibility with users who
// already picked it.
// S22: Large ('large') and Wide ('small') brought back for the Baltimore show.
// Both formats were still fully defined in LABEL_FORMATS — only the UI and this
// allow-list had them switched off.
//   Case  ('small-l') — graded books in hard cases; has the fold-over wrap strip
//   Large ('large')   — goes over a CGC label
//   Wide  ('small')   — regular bagged-and-boarded comics
//   Square('square')  — corner placement, leaves the cover visible
// v5.86: 'large' removed from the choosable set. A stored preference of
// 'large' (anyone who picked it before) now fails this check and falls back to
// the default, instead of selecting a chip that no longer renders.
const VALID_SIZES = ['small-l', 'small', 'card', 'square'];

function readOptions() {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return { size: 'small-l', priceTag: false, includePrice: false, mono: false };
    const o = JSON.parse(raw);
    return {
      // Validated against the known set; unknown values fall back to square
      // (the new default). Pre-S12-May-6 stored values of 'small' or 'large'
      // are preserved as-is for users who'd already chosen one.
      size: VALID_SIZES.includes(o.size) ? o.size : 'small-l',
      priceTag: !!o.priceTag,
      // S12: includePrice controls whether the comic's askingPrice is rendered
      // INSIDE the price pad. Only meaningful when priceTag is also true and
      // the comic has an askingPrice set. UI toggle for this is conditionally
      // shown — see renderModal.
      includePrice: !!o.includePrice,
      // v5.91: THERMAL MODE. A direct-thermal roll printer (Rollo, Zebra, the
      // Jadens) has one ink and one substrate: it burns black or it leaves the
      // stock white. There is no orange, no green, and no grey - a mid-tone is
      // dithered into hatching. Rendered untouched, the Wide label's full-bleed
      // gradient covers the whole 4x1 in cross-hatch and swallows the smaller
      // type outright (measured: the printing line and the URL both disappear).
      // So thermal is not a print setting, it is a different RENDER: white
      // ground, black ink, the score box as an outline instead of a fill.
      mono: !!o.mono
    };
    // S22: widePrice / widePriceFor are GONE. They held a price typed on the
    // label screen; the label reads comic.askingPrice now, so there is one
    // price per book and no second place for it to disagree. Any stale pair
    // left in a user's localStorage is simply ignored by the read above.
  } catch { return { size: 'small-l', priceTag: false, includePrice: false, mono: false }; }
}

function writeOptions(opts) {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts)); }
  catch (e) { console.warn('[label options] write failed:', e); }
}

// ── Public entry point ─────────────────────────────────────────────────────
// Opens the modal viewer for a single comic. allItems is required so that
// when Print is tapped, queued comics can be looked up from the same array
// the rest of the app uses.
// v5.85, Matt: `opts.single` is set by the Detail view's Print Label button.
// It changes ONE thing - the PDF page becomes the label itself instead of a
// letter sheet with the label placed at an Avery grid position. The label's
// own dimensions are unchanged: a 4" x 1.33" label still comes out 4" x 1.33",
// because the point is to hand the user a file their printer driver can scale
// to the physical stock. List view's batch sheet is untouched.
export function openLabelViewer(comic, allItems, opts) {
  // v6.33: start the QR library downloading NOW rather than when the first
  // render asks for it. renderQRsIn() has a deferred path for the
  // not-yet-loaded case, but the whole point is that there should be nothing
  // to defer by the time the preview paints.
  try { ensureQRCodeLoaded(); } catch (e) {}
  _singleMode = !!(opts && opts.single);
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

// ── Exported for the label measurement harness (label-measure.mjs) ────────
// Nothing in the app imports these; openLabelViewer remains the only entry
// point. They are exported because the alternative is a harness that measures
// a COPY of the label, and this file's history says that is how you end up
// measuring something that is not what ships.
export function ensureStylesInjected() {
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
      + '?family=Barlow+Condensed:wght@400;500;600;700;800'
      + '&family=League+Spartan:wght@700;800;900'
      + '&family=Noto+Sans+Display:wdth,wght@62.5..100,500;62.5..100,700;62.5..100,900'
      + '&family=Noto+Sans+Mono:wght@800'
      + '&display=swap';
    fonts.setAttribute('data-label-fonts', 'true');
    document.head.appendChild(fonts);
  }


  const style = document.createElement('style');
  style.id = 'label-viewer-styles';
  style.textContent = `
  /* ═══════════════════════════════════════════════════════════════════════
     SHARED — every comic label (.rg-any)
     ═══════════════════════════════════════════════════════════════════════
     PUT A RULE HERE when it is true of Wide AND Case AND Square. Put it in a
     variant section only when that variant genuinely differs.

     WHY THIS EXISTS: four times now a rule written while working on Wide was
     scoped to '.rg-label' - which is Wide and nothing else - for an object
     that exists on every label. The score-box chip colour (twice), the '(+)'
     mark, and the price face. Each one shipped looking subtly wrong on Case
     and Square and was found by eye, on paper, weeks later.

     THIS BLOCK IS FIRST IN SOURCE ORDER, deliberately. '.rg-any .x' and
     '.rg-label-l .x' have identical specificity, so a variant rule later in
     the file wins. Shared default, variant override, no '!important'.

     SIZES AND POSITIONS DO NOT BELONG HERE. The labels are 4x1, 4x2 and 2x2
     inches; a shared 'font-size' or 'top' is almost always a mistake. What
     belongs here is what should not vary: typeface, weight, colour, tracking,
     line-height, white-space. The grade numeral's size is computed per label
     from the string's measured width (see _NUMFIT) - not here, and not in CSS.
     ═══════════════════════════════════════════════════════════════════════ */

  /* The Asking Price. Size is set inline per label from the measured string
     width; everything that should NOT vary is here. */
  .rg-any .rg-price {
    font-family: 'Noto Sans Display', sans-serif;
    font-weight: 900;
    color: #0d0d0f;
    line-height: 1;
    white-space: nowrap;
    text-align: center;
  }
  .rg-any.mono .rg-price { color: #000; }

  /* The grade numeral's FACE. Its size and offset are per-variant. */
  .rg-any .rg-num, .rg-any .rgc-num { font-family: 'League Spartan', sans-serif; }

  /* v6.38: the issue number inside the title. Weight and colour are
     PROPERTIES, so they belong here - they were set on Wide alone, which is
     why the same number read lighter on Case and Square. Its SIZE still comes
     from each variant's .ttl, as it should. */
  .rg-any .ttl-iss { font-weight: 700; color: #2a2a2a; }

  /* v6.38 - THE DATE / PUBLISHER LINE WRAPS. It was 'white-space: nowrap' on
     all three variants, with a width of 160% to undo the scaleX(0.625). A
     line longer than the column therefore could not break; it simply drew
     past the end of the info column and over the score box. Reported on
     Square, where the column is narrowest, but the rule was the same on Wide
     and Case and only the geometry hid it.
     Shared, because whether a line may break is a BEHAVIOUR of the line, not
     a size or a position - the two things LABEL_SHARED_STYLES.md says are
     legitimately per-variant. The per-variant nowrap declarations are gone;
     this one rule governs all of them. */
  .rg-any .iss {
    display: block;
    white-space: normal;
    overflow-wrap: break-word;
    /* v6.40: Wide and Case both declared line-height 1.0 here and SQUARE DID
       NOT, so its date line fell back to 'normal' - about 1.35 - and carried
       roughly 17px of internal leading nobody asked for. That is the "too
       tall" spacing between Title/Issue and Pub Date/Publisher, and between
       that line and Printing/Variant: not a margin, the line box itself.
       Shared, for the same reason the wrap rule above is - this is how the
       line is SET, not where it sits. */
    line-height: 1.0;
  }

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
    /* v6.38: was 100vh - 24px, which left a 12px strip of backdrop. On
       Square - a 1:1 label, so the preview is as tall as it is wide - the
       card took the whole screen and tap-outside-to-close had almost nothing
       left to tap. 88px guarantees a ~44px band top and bottom, a real touch
       target, and the preview area is flex:1 with overflow:auto so it gives
       up the height rather than anything being cut. The explicit close
       control in the header is the belt to this pair of braces. */
    max-height: calc(100vh - 88px);
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
  /* v6.38: tap-outside was the ONLY way out of this modal. That reads well
     when there is a backdrop to tap; it is a trap when the card fills the
     screen, which is what Square does. A close control is not clutter at the
     point where the alternative is being stuck.
     It is a CLOSE, not a Cancel: the note on the old Back button still holds
     - leaving must never read as erasing the queue - so it is an x in the
     corner rather than a worded button in the action row. */
  .lvm-close {
    appearance: none; -webkit-appearance: none;
    border: 1px solid #ddd3c2;
    background: #fffdf8;
    color: #6a5c4a;
    width: 34px; height: 34px;
    min-width: 34px;
    border-radius: 999px;
    font-size: 19px; line-height: 1;
    font-family: inherit;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    padding: 0;
  }
  .lvm-close:active { background: #f0e8da; }
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
  /* S22: with four size options (Case / Large / Wide / Square) the group gets
     its own row and the price toggle moves to the line below. */
  .lvm-toggle-row-sizes { justify-content: center; }
  .lvm-toggle-row-sizes .lvm-segment-group { width: 100%; justify-content: stretch; }
  .lvm-toggle-row-sizes .lvm-segment { flex: 1 1 0; text-align: center; }
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
    background: linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);
    border: 1px solid #8a9a6a;
    border-radius: 4px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  /* S22 (Wide light-box pass): the Wide score box flipped from the dark
     #1a2208 fill to a light green from the app palette (#cfe8a8) with BLACK
     numerals and a 3px border in the app's RoboGrade-Score dark green
     (#0f1a05). Reason: thermal label printers are 1-bit BLACK-ONLY. A pale
     numeral knocked out of a dark panel is physically unprintable on one —
     the printer can only burn dark, so the panel prints solid and the number
     disappears. Light interior + black ink is the only arrangement that
     survives thermal, laser AND pre-printed stock. Only Wide changed; Case
     (.rg-label-l), Square and Large keep the dark box because they are not
     the thermal-roll format. */
  /* S22 — SIZED FOR A WALL, NOT A DESK. These labels go on display walls read
     from 10+ feet, so the score is the only element that has to carry at that
     distance; everything else is read at arm's length. 252 -> 276 square (the
     label is 288 tall, so 6px top and bottom is all the margin a die-cut can
     safely give up) and the numeral goes with it. The four satellites are all
     absolutely positioned OUT OF FLOW — wordmark top, stars under it, version
     bottom, PM and the (+) on the right — so the numeral is centred in the
     whole box and the ceiling is not arithmetic. It is the point at which the
     glyph's cap height touches the stars above or the version below. Measured
     at 300dpi: 196px at scaleX(0.625) is the largest that clears both, with the
     PM and (+) still clear on the right. */
  /* S22: 276 -> 262, right inset 6 -> 10, top 6 -> 12. Measured off Matt's
     printed mock-up, not estimated. At 276/6 the box sat close enough to the
     die-cut edge that a half-millimetre of thermal feed drift clipped it. */
  .rg-label .score-box {
    width: 262px; height: 262px;
    box-sizing: border-box;
    background: #cfe8a8;
    border: 3px solid #0f1a05;
    border-radius: 38px;
    position: absolute;
    right: 10px; top: 12px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  /* S22: top 14 -> 8. The PM moved up to the mock's position and the wordmark
     is full-box-width, so the two were overlapping. Lifting the wordmark puts
     its ink at 8..28 and the PM's at 32..100 - no vertical overlap, so their
     horizontal positions stop mattering. */
  /* S22: CONSTRAINED, not merely lifted. Relying on 12px of vertical clearance
     between the wordmark and the PM meant any later nudge to either one put
     them back on top of each other - which is what Matt printed. Boxing the
     wordmark into the space LEFT of the PM makes the overlap impossible
     whatever their vertical positions. right:76 is the PM's column plus a gap. */
  .rg-label .rg-word {
    /* 22/2, not 26/3: at 26 the word measured 192px of ink and simply
       OVERFLOWED the 6..186 box - a box with no overflow:hidden does not
       constrain anything - so it still ran under the PM. 22px with 2px of
       tracking measures ~150 and fits. overflow:hidden is set as a backstop so
       a future size change cannot quietly reintroduce the overlap. */
    font-size: 22px; font-weight: 700;
    color: #2a4010; letter-spacing: 2px;
    font-family: 'Barlow Condensed', sans-serif;
    /* S22: 10 -> 6. Centring the word on the box put its right end (x=209)
       into the PM's column (x=192..251), so the two were only held apart
       vertically - and measured, they were NOT: word ink ran y 17..33 and the
       PM's y 31..72, a 2px overlap. The word goes up 4 and the PM down 4, for
       8px of clear air between the two bands. */
    position: absolute; top: 6px;
    /* S22: left:6 / right:76 centred the word in the space LEFT of the PM, so
       it printed visibly off-centre in the box. It is centred on the BOX now.
       The PM is no longer held off by a horizontal box: it is held off
       vertically, and that is measured, not assumed - the wordmark's ink runs
       y 15..31 and the PM's y 36..100, so they cannot meet at any x.
       overflow:hidden stays as the backstop against a future size change. */
    left: 0; right: 0;
    text-align: center;
    overflow: hidden; white-space: nowrap;
  }
  .rg-label .rg-stars {
    opacity: 0.85;   /* S22: dark stars on the light box need no knock-down */
    /* S22: 44 -> 34. At 44 the stars sat midway between the wordmark and the
       numeral and read as part of the number; they belong to the ROBOGRADE
       line. 34 puts 3px under the wordmark's ink and hands the 10px back to
       the numeral, which drops by the same amount below. */
    position: absolute; top: 34px; left: 0; right: 0;
    text-align: center; font-size: 24px; line-height: 1;
    letter-spacing: 2px;
  }
  /* League Spartan for every label score number + precision (all variants),
     matching the app score box. Override kept together so it is easy to find. */
  .rg-num, .rgc-num { font-family: 'League Spartan', sans-serif !important; }
  .rg-label .rg-num-wrap {
    /* S22: Wide (Small R) — same score-number drop applied to Case and Large,
       so all three variants read identically. */
    transform: translateY(16px);
    /* Holds ONLY the number. This is the flex child the score-box
       centers → the NUMBER is exactly centered, always. The precision
       is a SEPARATE absolutely-positioned child of .score-box (out of
       flow, zero width here) so it can never shift this. The recurring
       bug was making number+precision one centered unit; they must be
       independent. */
    display: inline-flex;
    line-height: 1;
  }
  /* S22: 16 -> 26 on Wide only. Matt's mock sits the numeral lower in the box,
     closer to the version string. */
  /* S22: 20 -> 26. The 2px-off-the-version finding that pinned this at 20 was
     measured at numeral 215; at 200 there is 15px more room under the ink, and
     the stars moving up 10px added their own clearance above. Re-measured by
     rasterising the box and diffing black pixels across 6 / 9.5 / 10 / 4.5:
     at 26 the numeral's ink ended at y=227 and the version string's began at
     226 - a 1px OVERLAP, which is what the first render of this showed: the 0
     of "60" sitting on top of V4.81. 22 is the measured landing: 4px of clear
     air under the numeral, 32 above it to the stars. Still 2px lower than the
     20 it came from, which is the direction asked for. */
  /* v6.20: 24px, not 14. Measured with the REAL League Spartan 900 (every
     earlier ink run in the harness fell back to a substitute face, whose
     digits are shorter, so the clearance it reported was fiction). At 14px
     the numeral's cap top landed 4-7px ABOVE the star's ink on every
     no-plus grade - the collision on Matt's printed Batman #151. */
  .rg-label .rg-num-wrap { transform: translateY(24px); }
  .rg-label .rg-num {
    /* S14: was 148, dropped to 140, now 150 — brought back up a touch
       to match the Large label's score-prominence pass now that the
       condensed scaleX text leaves room. Centered in the 252px box.
       PDF FIX: scaleX(0.625) replaces font-stretch (html2canvas 1.4.1
       ignores the wdth axis when rasterizing); transform-origin:center
       keeps it centered; inline-block so the transform applies. */
    /* S22 (2nd pass): back to 150px at scaleX(0.625). The S15 "Option A" test
       (160 @ 0.75) made the numeral noticeably WIDER than Large and Square, and
       Matt reads the narrower condense as the better one. Wide and Case now
       match the other two variants exactly.
       S22: 150 -> 188 for wall readability. 188 and not more because MEASURED
       ink extents (not line boxes) put the worst case — "9.5", three glyphs,
       with a PM and three stars — at 17px clear of the stars and 18px clear of
       the version at 188. At 192 the PM clearance drops to 3px and at 200 it
       goes negative. Line-box arithmetic says there is room at 210; the ink
       says otherwise, which is why this was measured by rasterising the box and
       finding the black pixels. */
    /* S22: 188 -> 215. The mock keeps the numeral's TOP where it was and takes
       the BOTTOM down toward the version string, using room the old size left
       empty. Measured off the mock: 170px of ink against ~133 at 188. */
    /* S22: scaleX 0.625 -> 0.78. 0.625 is a heavy condense - it is what let
       the numeral grow to 200px without reaching the PM - but at that ratio
       the strokes are thin enough that the grade, the one thing on this label
       meant to be read from across a room, reads worst of anything on it.
       Not removed, because the width is what keeps it clear of the PM: 0.78 is
       a quarter wider and the measured horizontal gap to the PM is still
       positive on every two-glyph case. The font size comes down with it so
       the overall footprint is close to unchanged. */
    /* S22: 188 -> 212. The PM was never the vertical constraint - removing it
       freed the RIGHT side of the box, not the bottom - so the numeral could
       not simply grow in place: at 188 the version string was already only 3px
       under its ink. The room came from moving the numeral UP (translateY 22
       -> 14, into the 28px of slack that had opened under the stars) and the
       version DOWN (bottom 14 -> 10).
       212 is measured, not chosen. Swept 196/204/208/212/216 across
       6 / 9.5 / 100 / 4.5 / 8, rasterising the box and diffing black pixels:
       at 212 the worst case clears the stars by 12, the version by 7 and the
       (+) by 6. At 216 the version drops to 5 and there is no case for the
       last 4px. */
    font-size: 212px; font-weight: 900;
    color: #0d0d0f; line-height: 1;   /* S22: black on the light box */
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.78);
    transform-origin: center;
  }
  /* S22 — THE (+) NOW EXISTS ON THE LABEL, AND IT IS BOTTOM-RIGHT.
     It did not render here at all before: the app's score box draws it on the
     RIGHT MIDLINE, the label's never did, and Matt asked for room to be left
     for it. Room on the midline is the one thing this box cannot give — a
     three-glyph grade like "9.5" already reaches x=223 of 276, so a midline
     (+) overlaps it at EVERY numeral size, 140 included. Measured, not
     assumed. So it goes to the bottom-right corner instead, beside the version
     string and below the numeral band, where it costs the grade nothing.

     S22 — SUPERSEDED, and the S22 reasoning was wrong. "A midline (+) overlaps
     the grade at every numeral size" treated the numeral size as fixed. It is
     not. When a (+) is present — and only then — the grade shrinks to make room
     and the two sit together on the midline, which is where the app's own score
     box has always drawn it. A book with no (+) keeps the full 188.
     The midline matched here is the NUMBER's, not the box's: .rg-num-wrap
     carries translateY(16px), so this tracks it rather than centring on the
     box, exactly as the app's scoreBox() offsets its own (+) by the same nudge. */
  .rg-label .rg-plus {
    position: absolute;
    /* S22: margin-top instead of calc() inside transform. html2canvas renders
       into a cloned document and its transform parser does not evaluate
       calc() — it threw there, the capture promise never settled, and Save PDF
       sat on "Generating 1/1..." forever. Same visual result, parseable.
       The 16px matches .rg-num-wrap's translateY so the (+) sits on the
       NUMBER's midline rather than the box's. */
    top: 50%; right: 8px;
    margin-top: 16px;
    transform: translateY(-50%);
    font-size: 44px; font-weight: 700;
    color: #0d0d0f; opacity: 0.85;
    font-family: 'Saira', 'Barlow Condensed', sans-serif;
    line-height: 1;
    white-space: nowrap;
  }
  /* THE SHRINK. 188 -> 168 only while a (+) is showing, and 168 is measured,
     not chosen: rendering the numeral and the (+) separately and diffing their
     BLACK PIXELS puts the worst case — "9.5", three glyphs — at 8px of
     clearance at 168 and 0px at 190. The vertical axis is nowhere near binding
     (32px to the stars, 30px to the version), so the whole constraint is the
     horizontal run to the (+).
     Two passes got here. At the (+)'s first size, 56px, the ceiling was 136 —
     worse than the 150 these labels carried before S22, which would have made
     a (+) book LOOK DOWNGRADED. Dropping the (+) to 44px and tightening it to
     right:8 bought 32px of numeral. The (+) is the secondary mark; the grade
     is the thing read from across the room, so the (+) yields. */
  /* NOT scaled with the base size. Scaling it to 167 (148 x 212/188) put the
     numeral's ink 1px INTO the (+) - measured, not predicted. The base numeral
     grew because the room came from the vertical axis; the (+) is a HORIZONTAL
     constraint on the midline, and nothing about removing the PM moved it (the
     PM lived in the top-right corner, the (+) sits on the number's midline at
     right:8). So a (+) book gains almost nothing here, which is correct: the
     (+) is the thing taking the space. 152 leaves 5px. */
  .rg-label .score-box.has-plus .rg-num { font-size: 152px; }
  /* S22 - THREE-GLYPH SCORES WERE BREAKING THE BOX, AND HAD BEEN FOR A WHILE.
     .rg-num-wrap is a flex item in a 256px-wide column, so its width is capped
     at the box interior. "100" at 200px is ~360px of UNSCALED text (scaleX
     only shrinks what is drawn, never the line box the text wraps against), so
     it wrapped to two lines inside the wrap and the second line ran down over
     the version string - measured ink y 86..260 against 86..227 for a
     two-glyph score. This is not new in this version; at 215 it was worse.
     Two parts: nowrap so it can never break mid-score, and a smaller size for
     three glyphs so the one line it is now forced onto fits the box.
     This matters more under the v3 display than the 0-100 one: "9.5" is three
     glyphs and ordinary, where 100 is rare. */
  .rg-label .rg-num-wrap { white-space: nowrap; }
  /* 172, measured rather than guessed: a digit in Noto Sans Display is
     0.556em, so "100" is 3 x 0.556 x 172 = 287px of UNSCALED text, 245px once
     scaleX(0.78) has it, inside the 256px interior with 5px a side - and that
     is with the restoration check mark, which rides inside .rg-num-wrap and
     costs another ~27px. "9.5", which is the ordinary three-glyph case under
     the v3 display, is narrower again (the period is ~0.28em). */
  .rg-label .score-box.num-3 .rg-num { font-size: 172px; }
  .rg-label .score-box.has-plus.num-3 .rg-num { font-size: 120px; }
  .rg-label .rg-v {
    font-size: 24px;   /* S22: 20 -> 22 -> 24 for legibility */
    color: #3a5010;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 10px;   /* S22: 14 -> 10, room for the numeral */
    letter-spacing: 1px;
  }
  /* Info column — starts after the QR column on the left.
     S12 May 6 v2: left edge bumped from 144 → 170px to accommodate the
     wider QR padding (QR ends at x=154 after the left-edge fix; +16px
     gap → info starts at 170). */
  /* S22 (Wide QR relocation): the QR left the bottom-left corner for the
     former mascot slot, so the info column now starts at the label's own left
     margin (32px) instead of clearing a QR that is no longer there. That is
     +138px of column — the point of the move — spent on bigger type below.
     The has-price state is the exception: with a price pad in the mascot slot
     the QR falls BACK to bottom-left, so .has-price .info keeps left:170. */
  .rg-label .info {
    /* S22 (pre-print pass): the column now spans top to bottom and pushes
       info-lower to the floor, so GRADED and ID sit at FIXED y on every
       label regardless of how many lines the title took. That is what makes
       them pre-printable — a flowed position could not be. The divider moved
       with them (border-bottom on .info-upper -> border-top on .info-lower)
       for the same reason. */
    position: absolute;
    /* S22: the box grew 24px and moved 8px left, so every column to its left
       gives up 8px — 282 -> 290 here, on .qr-col and on .url, which keeps the
       12px gutter between the QR and the box. */
    left: 32px; top: 12px; right: 290px; bottom: 14px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  /* S22: VISIBLE, not hidden. .ttl carries its own max-height and overflow, so
     this clip added nothing except eating descenders - the tail of the y in
     "Fantasy" and the g in "Aug" were shaved off on every print. */
  .rg-label .info-upper { overflow: visible; }
  /* S22 - WHO GIVES WAY WHEN THERE IS NOT ROOM FOR EVERYTHING.
     The column runs y 12..226 (the rule), so 214px. Worst case wants more
     than that: a 2-line title (118) + the date line (48) + a 2-line Key Info
     (~69 with its margin) is 235.
     Rather than pick a fixed line count for the Key Info - which would waste
     the room a 1-line title leaves, and still overflow when the title takes
     two - the column is a flex box with a hard 214px ceiling and the Key Info
     is the only item allowed to shrink. So it takes two lines under a short
     title and one under a long one, automatically, and the block can never
     cross the rule.
     flex-shrink on .prt alone is what does it; .ttl and .iss are 0 0 auto. */
  .rg-label .info-upper {
    display: flex; flex-direction: column;
    /* 208, not the 214 the arithmetic gives: .info's top:12 lands at y=13
       inside the label's 1px border, so 214 put the block's bottom at 227
       against a rule at 225 - measured, not assumed. 210 clears it by 2. */
    max-height: 210px;
  }
  .rg-label .info-upper > .ttl,
  .rg-label .info-upper > .iss { flex: 0 0 auto; }
  .rg-label .info-upper > .prt { flex: 0 1 auto; min-height: 0; }
  .rg-label .info-upper {
    /* S22: 8 -> 6. With a price pad the info column narrows to 462px, which wraps
       a longer title to two lines; measured, the block then ran 2px past the
       288px label and .rg-label's overflow:hidden shaved the bottom of the
       GRADE ID row. 4px comes off here and 4px off .info-lower below. */
    padding-bottom: 0;
    border-bottom: none;   /* S22: moved to .info-lower's border-top */
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
    /* S22: brought up to Case's scale (50 -> 58, line-height 1.05 -> 1.0)
       plus Case's 2-line clamp. Wide's info column is 700px wide (vs Case's
       462), so at 58px scaleX(0.625) it takes ~31 chars on a line — most
       titles still fit on one. The clamp only bites on the rare long one. */
    /* S22 (Wide QR relocation): 58 -> 66, line-height 1.0 -> 0.95, paid for
       by the 138px the QR gave back. Two-line clamp holds at 128px
       (2 x 66 x 0.95 = 125); measured worst case — 2-line title + issue +
       both meta rows — ends at y=268 inside the 288px label. */
    /* S22 (Wide QR relocation, 2nd pass): width 160%.
       scaleX(0.625) compresses the RENDERED glyphs but leaves the layout box
       alone, so the title was wrapping against the 602px column and then
       rendering at 602 x 0.625 = 376px — 226px of the column thrown away on
       every label, and a title as ordinary as "The Amazing Spider-Man"
       wrapping to two lines for no reason. 160% = 1/0.625, so the line box is
       963px and the rendered result is exactly 602px: the column's real
       width, ~31 visual characters, and most titles back on one line. Same
       correction applied to .iss below. */
    /* S22: the descender fix needed TWO changes and only one landed last time.
       .info-upper's overflow:hidden was cutting the g in "Aug" (.iss) - fixed.
       But .ttl carries its OWN overflow:hidden for the 2-line clamp, and at
       line-height 0.95 the line box ends at the baseline, so the y in
       "Fantasy" was still being cut by .ttl itself. padding-bottom extends the
       box the clamp measures, so the tails show and the clamp still holds:
       1 line = 59 + 8, 2 lines = 118 + 8, both inside 126. */
    width: 160%;
    font-size: 62px; font-weight: 900;
    color: #0d0d0f; line-height: 0.95;
    white-space: normal;
    padding-bottom: 8px;
    /* S22: 126 -> 118. 2 x 62 x 0.95 = 117.8, so 126 was 8px MORE than two
       lines and let the tops of a third line through under the second - the
       same sliced-glyph sliver the one-line clamp had. 118 is the two line
       boxes exactly; the 8px of padding-bottom below it is what carries the
       descenders. */
    max-height: 118px;
    overflow: hidden;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
  }
  /* S22: the issue number rides WITH the title - no line break between them.
     If the line has to break it breaks before the issue number, never between
     the issue number and the publication date, which is now the start of the
     line below. */
  .rg-label .iss {
    /* S22: 36 -> 46 toward Case's 52. Held 6pt under Case because Wide still
       carries the info-upper divider AND the ID row in the meta grid, so it
       has less vertical budget than Case (which moved ID into the URL). */
    width: 160%;   /* S22: see the .ttl width note above */
    font-size: 48px; font-weight: 600;
    color: #333;   /* v6.40: line-height moved to .rg-any .iss */
    font-family: 'Noto Sans Display', sans-serif;
    /* S22: this line is now "<pub date>, <publisher>" as one string, so the
       old flex row with a 24px gap is gone - a comma and a space do the
       separating. scaleX(0.625) still compresses the line as a unit. */
    transform: scaleX(0.625);
    transform-origin: left center;
  }
  .rg-label .prt {
    font-size: 32px; color: #4a4a38;   /* S22: 22 -> 28 -> 32 */
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    /* S22: the line sat directly under .iss's baseline, so a descender in the
       date line (the g in "Aug") came down into it. 6px of clearance. */
    margin-top: 6px;
    /* 1.4, and NO padding-bottom. The two were fighting: overflow:hidden clips
       at the PADDING box, so padding added to save the last line's descenders
       also let the tops of the next line through - which is exactly the sliced
       row of letter-tops this was meant to prevent.
       A line box has to contain its own glyphs instead. At 1.12 the box is
       31px against ~38px of actual ink at 28px, so descenders hung outside it
       and any cut on a line boundary shaved them. 1.4 contains them, so
       clipping at a whole multiple of the line height cuts between lines and
       touches no glyph. fitLabelText does that clamping.
       1.3 and not the 1.4 this started at: at 28px either value fitted two
       lines, but at 32px two lines need 2 x 1.4 x 32 = 90 against the 89 this
       column has, so 1.4 silently dropped the Key Info to ONE line and left
       46px of the column empty. 1.3 gives 83 and still contains the glyphs -
       Barlow Condensed's ascender plus descender is about 1.25em. */
    line-height: 1.3;
    /* S22: this line carries the printing AND, after it, whatever of the
       book's Key Info fits. It WRAPS now - one line was throwing away most of
       a Key Info that is routinely a sentence. It is still clipped, because
       Key Info can be a paragraph; what bounds it is the flex rule below, not
       a fixed line count, so the number of lines it gets depends on how much
       room the title left.
       text-overflow:ellipsis does nothing on a wrapping element - it only
       marks a single clipped line - so the cut is clean rather than marked.
       That is the trade for showing several times as much of it. */
    white-space: normal; overflow: hidden;
  }
  .rg-label .info-lower {
    /* S22: the rule takes the SAME colour as GRADED and ID (#2a3a18). The old
       #b0b89a was a pale olive on an orange gradient - it all but vanished in
       print, and since the rule and those two words are one pre-printed unit
       at fixed positions, they should read as one. */
    border-top: 1px solid #2a3a18;
    padding-top: 6px;
  }
  /* S22 - THE RULE DROPS TO THE CODE'S BOTTOM EDGE AND THE META BLOCK GOES TO
     ONE ROW. Two changes that only work together: stacking GRADED over the ID
     row cost ~40px of height that the title and the Key Info line both wanted,
     and the rule sitting where it did cut across the figure.
     The band is pinned, not flowed - y 226..274, with the border-top landing
     at exactly 226, which is also where the QR and the figure now end. Pinning
     is what keeps GRADED and the ID at the SAME y on every label however the
     title wrapped, which is the whole reason this stock can be pre-printed.
     right:-191 takes it 191px PAST .info's own right edge (665) out to 856,
     the right edge of the QR column: with the code ending above the rule there
     is nothing below it to clear, so the ID row reads out to the full width
     instead of stopping short. .info-upper keeps the narrow column, because
     the figure is still beside it. */
  .rg-label .info-lower {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 48px;
    box-sizing: border-box;
  }
  /* S22: a 2-line title PLUS a printing line does not fit the room above the
     pinned meta block. The template adds .has-prt to .info only when a
     printing line is present, so in exactly that case the title clamps to one
     line. Without a printing line the 2-line clamp stands. */
  /* S22: 60 -> 59 and a one-line clamp that LOOKS like one.
     60 was the two-line clamp halved before .ttl carried padding-bottom; with
     the padding in place it let 1px of the second line through, and the
     narrower text column (the figure took 172px of it) makes two-line titles
     much more common than they were - so what printed was a full first line
     with a sliver of sliced glyph tops under it, which reads as a rendering
     fault. 59 is the line box exactly, and nowrap + ellipsis makes the
     truncation deliberate rather than a cut. The 8px of padding-bottom still
     sits below it, so descenders survive. */
  /* S22: this used to key on .has-prt - i.e. on the book HAVING a printing or
     Key Info line - which meant every such book got a one-line, ellipsised
     title whether or not it needed one. .squeeze is set by fitLabelText()
     instead, only on the labels that measured short of room.
     The ellipsis goes on the TITLE, not on the line. Truncating the line as
     one string ate the issue number - "The Amazing Spider-M..." with no #300 -
     and the issue number is identity, not decoration: a label that cannot say
     which issue it is has failed at its job. So in the clamped state the line
     becomes a flex row, the title takes the squeeze (min-width:0 is what lets
     a flex item shrink below its content and is the whole trick here), and the
     issue number is flex:0 0 auto - it is never the thing that goes. */
  /* S22: the one-line clamp is GONE. It existed because a 2-line title plus a
     printing line did not fit above the rule; the rule is 36px lower now and
     the meta block is one row instead of two, so it does. Measured worst case:
     title 118 + date line 48 + printing/Key Info 26 = 192, inside the 214 the
     column now has. The flex rule below still applies - it is what keeps the
     issue number when a title is too long even for two lines. */
  /* S22: Case is EXEMPT from the squeeze. Matt: do not truncate the title -
     truncate the printing/variant line instead. On Case the title is the
     thing being read across a shelf of slabs, and the printing is the
     detail. fitLabelText only adds .squeeze when there is no room for even
     one line of the printing; on Case that line simply gets none. */
  /* v6.37: Square had NO squeeze rule, so when fitLabelText decided the
     printing/Key Info line could not fit a whole line and added .squeeze,
     nothing happened and the line stayed half-height. The title is what
     should give - it is the longest thing in the column and it already
     truncates elsewhere - so it clamps to two lines with an ellipsis.
     (Case deliberately does the opposite: Matt asked that its title never
     truncate, and its squeeze rule RELEASES the title's clamp instead.) */
  .rg-label-square .info.squeeze .ttl {
    max-height: 2.1em;
    overflow: hidden;
  }
  .rg-label-square .info.squeeze .ttl > .ttl-name {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rg-label-l .info.squeeze .ttl { display: block; max-height: none; }
  .rg-label-l .info.squeeze .ttl > .ttl-name { overflow: visible; text-overflow: clip; white-space: normal; }
  .rg-label .info.squeeze .ttl {
    max-height: 59px;
    display: flex; align-items: baseline; flex-wrap: nowrap;
  }
  .rg-label .info.squeeze .ttl > .ttl-name {
    min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rg-label .info.squeeze .ttl > .ttl-iss {
    flex: 0 0 auto;
    padding-left: 0.22em;
  }
  /* S22: the meta block right-justifies against the info column's right edge
     so "ROBOGRADER.APP/ ID / A7K2M9" reads as one flush line. justify-content
     moves the whole two-column grid; the columns stay max-content so the
     GRADED row still aligns its value with the ID row's. */
  .rg-label .meta-grid {
    display: grid;
    justify-content: flex-end;   /* S22: not 'end' — html2canvas only knows the flex-* spellings */
    grid-template-columns: max-content max-content;
    column-gap: 8px; row-gap: 3px;   /* S22: 18 -> 8, slash sits against the ID */
    align-items: baseline;
  }
  /* One row: GRADED and its date on the left, the ID on the right. The four
     spans are unchanged - margin-left:auto on the ID label is what splits them
     into two groups, which beats restructuring markup that Case, Square and
     Large all share. */
  .rg-label .meta-grid {
    display: flex; align-items: baseline; flex-wrap: nowrap;
  }
  .rg-label .meta-grid .meta-val { margin-left: 8px; }
  .rg-label .meta-grid .meta-id-lbl { margin-left: auto; }
  /* The TEXT runs 191px past .info's right edge, out to 856 - the right edge
     of the QR column - while the RULE above it stops at 665 where it always
     did, which is how the mock has it: a rule the width of the text block, and
     an ID line that uses the room under the code now that the code ends above
     the rule. Negative margin rather than a wider .info-lower, so the border
     and the content can have different widths without a second element. */
  .rg-label .meta-grid { margin-right: -191px; }
  .rg-label .meta-lbl {
    /* S14: +2pt (22→24) per user — Grade/Date and ID/Value were a touch
       small to read at arm's length on the printed Small label.
       S22: 24 -> 26 and the washed olive #7a8a5a -> Case's #2a3a18. The
       pale olive on the orange gradient is the thing that reads worst in
       print; Case fixed it and Wide had been left behind. */
    font-size: 26px; font-weight: 600;
    color: #2a3a18;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label .meta-val {
    /* S22: 24 -> 28 toward Case's 34. Held under Case for the same reason
       as .iss — Wide keeps the ID row, so it pays for two meta rows. */
    font-size: 30px; font-weight: 800;
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
  /* S22 — THE FIGURE IS GONE AND THE CODE IS SIZED FROM THE PHYSICS.
     Three versions were spent trying to fit a scannable code inside Robo's
     chest. It cannot be done at this label size, and the arithmetic says why in
     one line: a phone wants each module about 0.4mm across, the payload makes a
     29x29 grid, the spec adds 4 modules of quiet zone on each side, and
     37 x 0.4mm is 0.58" — more than half the height of a figure that is itself
     only 0.96" tall. No redraw fixes that; a chest big enough IS the figure.
     So the code goes back to standing on its own, at 160px: 0.556" at
     288 px/inch, which is 0.38mm a module — essentially the target.
     Worth recording: the 118px the bare code carried before all of this was
     already in the right range (0.41", 0.28mm/module). The chest was the
     problem, never the code. */
  /* S22: the code was centred in the full label height, which put its bottom
     at 234 - below the rule at its old position and below it again at the new
     one. It is pinned to end ON the rule now: 46 + 180 = 226. */
  .rg-label .qr-col {
    position: absolute;
    top: 46px; bottom: auto; right: 296px;
    left: auto; width: 180px; height: 180px;
    display: flex; align-items: center; justify-content: center;
  }
  /* S22 — THE PANEL IS SQUARED TO THE CODE.
     The chest interior measures 166 x 157 in the 427x512 art — close to square
     but not square, and v5.93 stretched the code to fill it. A stretched QR is
     sloppy at best and unscannable at worst, since a decoder expects square
     modules. The fix is geometric, not artistic: inscribe the LARGEST SQUARE
     that fits the panel (157 x 157, centred horizontally, 4.5px of the art's
     own interior left either side) and let the code fill that.
       left  = (131 + 4.5) / 427 = 31.733%
       top   =  149       / 512 = 29.102%
       width =  157       / 427 = 36.768%
       height=  157       / 512 = 30.664%
     Against the 230 x 276 figure that is 84.6 x 84.6 — square to a tenth of a
     pixel. Re-derive all four if the art is ever redrawn.
     The code is then inset to 86% of the panel so the remaining white is its
     quiet zone. A QR with no quiet zone, butted against the art's black chest
     stroke, is the classic reason a code "looks fine and won't scan". */
  /* The white pad IS the quiet zone — 10px each side, which at 288 px/inch is
     a shade over 3 modules at this code size. The spec asks 4; 3 on a plain
     white label with nothing printed against it is the practical equivalent,
     and buying the 4th would cost 10px of code. */
  .rg-label .qr-col .qrc {
    position: relative;
    background: #ffffff;
    padding: 10px;
    border-radius: 6px;
    line-height: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .rg-label .qr-col .qrc canvas,
  .rg-label .qr-col .qrc img {
    width: 160px !important;
    height: 160px !important;
  }
  /* v6.38 - EVERY .rg-label.has-price RULE IS DELETED. Wide NEVER CARRIES THE
     CLASS: showPrice is opts.priceTag AND size is not 'small', and Wide IS
     'small', so none of these has matched since the per-size price slot
     arrived. They described the retired white price-pad layout - QR moved to
     bottom-left at 118px, the figure hidden, the info column reclaiming its
     width - a label that cannot be produced any more. Same removal, and the
     same reasoning, as the Case rules in v6.25.
     The .price-pad rules go with them on the stronger ground that the class is
     not emitted ANYWHERE in this file, on any variant. */
  .rg-label .verify {
    font-size: 14px; color: #7a8a5a;
    letter-spacing: 1px;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600; text-align: center;
  }
  /* URL — paired with the QR at the bottom-left (S12 May 6 v2: left padded
     to 32px to match the QR column above for a consistent left margin). */
  /* S22: the Wide label no longer prints a URL line — it duplicated the ID,
     which now carries the domain itself (see .meta-grid). Hidden rather than
     deleted because the has-price layout and the other formats still use it. */
  .rg-label .url { display: none; }
  .rg-label.has-price .url { display: block; }
  .rg-label .url {
    /* 14px, not 17: at 17 the 24-character URL measured ~250px against the
       220px column and ran out under the score box. nowrap keeps it on one
       line so the overflow can never come back silently. */
    font-size: 14px; color: #4a5a3a;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-weight: 500;
    text-align: center;
    white-space: nowrap;
    position: absolute;
    left: auto; right: 290px; width: 220px; top: 233px; bottom: auto;
    letter-spacing: 0.2px;
  }
  .rg-label.has-price .url {
    font-size: 16px; color: #5a6a4a;
    text-align: left; white-space: normal;
    left: 32px; right: auto; width: auto; top: auto; bottom: 18px;
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
    background: linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);
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
  /* S22 — THE 4in x 2in SINGLE-LABEL VARIANT.
     The stock is 0.67in (192px) taller than the Avery sheet, and all of the
     extra height goes ABOVE the existing design: it folds over the top of the
     case and covers the back. The face and the chip row keep their layout
     exactly and move down by 192 together, so nothing inside them had to be
     re-measured.
     The back is deliberately blank for now - just the gradient, INVERTED, so
     that when the label is folded the two gradients run the same way as the
     eye travels down the front and up the back. */
  .rg-label-l.tall { height: 576px; }
  .rg-label-l.tall .fold-back {
    display: block;
    position: absolute;
    /* v6.31: 192 -> 129, tracking the raised chip row. */
    left: 0; right: 0; top: 0; height: 129px;
    background: linear-gradient(0deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);
  }
  .rg-label-l .fold-back { display: none; }
  .rg-label-l.tall .face { top: 282px; }
  /* v6.31: the chip row is 0.5in - 144px at 288dpi - measured from the top of
     the UPPER thick bar to the top of the lower one. The lower bar does NOT
     move (273px): it is the fold the user makes first, and every label already
     printed is creased there. So the upper bar rises instead, 273 - 144 = 129,
     and the blank fold-over panel above it shrinks to suit.
     The row's border-top IS the upper bar, so top and height define both. With
     box-sizing:border-box and align-items:center the text centres in the 137px
     BETWEEN the bars, not in the row including its own border. */
  .rg-label-l.tall .wrap-strip { top: 129px; height: 144px; }
  /* Moves down with the chip row rather than being hidden: the 4x2 stock folds
     TWICE and this is the second one. */
  .rg-label-l.tall .fold-guide { top: 273px; }
  /* The FOLD. A thick rule across the top of the chip row: this is the line
     the label bends on, and it is the only thing on the label that is an
     instruction rather than information, so it is heavier than the hairlines
     everywhere else. */
  .rg-label-l.tall .wrap-strip {
    border-top: 7px solid #2a3a18;
  }
  .rg-label-l .face {
    position: absolute;
    left: 0; right: 0;
    top: 90px;  /* face top sits at the fold line so its gradient meets it */
    height: 294px;
    background: linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);
  }
  /* Fold guide: thin horizontal line at y=84 (1.04" from bottom), 2pt
     (=8px at 288 DPI) tall, centered in the 0.083" fold zone. Tells the
     user precisely where to bend the label. Subtle but visible — same
     palette as the label border so it's understated but findable when
     folding. */
  /* S22 — THERE ARE TWO FOLDS, SO THERE ARE TWO LINES.
     This one is the lower of the pair: the chip row bends forward here so it
     sits ON TOP of the case. The upper line (the chip row's border-top, on the
     4x2 stock) is where the label bends BACK over the top and down the back.
     Both are instructions rather than information, so both are heavy - and
     this one is on EVERY version of the Case label, sheet and roll alike. A
     fold line that is only on some of them is worse than none, because the
     user learns to look for it.
     7px to match the upper rule; the old 10px soft olive bar read as
     decoration rather than as a mark to line a thumb up against. */
  .rg-label-l .fold-guide {
    position: absolute;
    left: 0; right: 0;
    top: 81px; height: 7px;
    background: #2a3a18;
    opacity: 1;
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
    background: linear-gradient(180deg, #c97a14 0%, #dd9430 45%, #e8b571 100%);
  }
  /* S22: the fold-strip chip was still the OLD dark score box - #1a2208 with a
     chartreuse numeral - while the face's box below it had moved to the light
     green with black numerals. Same label, same book, two different score
     boxes. It is also the thermal argument again: a pale numeral knocked out
     of a dark panel is physically unprintable on a one-ink printer, which is
     why the face changed in the first place. */
  .rg-label-l .wrap-strip .ws-score {
    flex: 0 0 auto;
    width: 60px; height: 56px;
    background: #cfe8a8;
    border: 2px solid #0f1a05;
    box-sizing: border-box;
    border-radius: 10px;
    display: flex;
    align-items: center; justify-content: center;
    color: #0d0d0f;
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
    margin-right: 24px;
    font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Mono", "Roboto Mono", monospace;
    font-size: 26px;
    font-weight: 600;
    color: #2a3a18;
    letter-spacing: 1px;
  }
  /* Separator dot between wrap-strip fields. Pure CSS, no DOM needed.
     Renders only between adjacent .ws-iss/.ws-date/.ws-prt elements. */
  /* S22: a comma between the publication date and the printing, not a bullet -
     Matt's call. The issue number keeps its bullet: "#15 . Aug 1962, 2nd
     Printing" separates the identity from the description, which a second
     comma would not. */
  .rg-label-l .wrap-strip .ws-date + .ws-prt::before {
    /* v6.25: -14px cancels the strip's flex gap of 14px, which sat between the
       date and this pseudo-element and printed as "May 1988 , 1st Printing".
       A comma has to touch the word before it; the bullet beside it wants the
       gap, which is why only this one needs the cancel. */
    content: ', ';
    margin: 0 2px 0 -14px;
  }
  .rg-label-l .wrap-strip .ws-iss + .ws-date::before,
  .rg-label-l .wrap-strip .ws-iss + .ws-prt::before {
    content: '·';
    margin-right: 14px;
    color: #6a7a48;
    font-weight: 700;
  }
  .robot-badge { display: none; }
  /* Square: fill the empty bottom-right with the Robograder mascot when no price tag. */
  /* S22: 316 -> 269 (-15%). Its head was clipping over the score box. The
     bottom/right anchor is unchanged, so it simply shrinks in place. */
  /* S22: the robot-badge is gone - the shared .rg-art slot replaced it, and
     it holds the price too. */
  .rg-label-l .robot-badge {
    position: absolute;
    left: 760px; top: 20px; width: 190px; height: 232px;
    display: flex; align-items: flex-end; justify-content: center;
  }
  .rg-label-l .robot-badge img {
    width: 160px; height: auto;
    opacity: 0.8;
  }
  /* S22 (2nd pass): Wide and Large now put the mascot exactly where the price
     pad sits, at the pad's size — the same rule Case and Square already follow.
     The first pass tucked a 60px / 88px badge into the rail the QR column
     vacated, which Matt read (correctly) as too small and in the wrong place.
     The pad's slot is free precisely BECAUSE there is no price tag, so it is the
     right home: same box, same visual weight, and the two states swap cleanly.
     The badge only exists in the no-price branch of the template, so turning the
     price tag on removes it — the behaviour Case and Square already had.

     Boxes mirror the .has-price .price-pad rules verbatim:
       Wide  — top:18  right:282  220x220
       Large — top:28  right:322  340x336
     The image is bottom-anchored and centred inside that box (same treatment as
     Case), inset so the mascot reads as art rather than filling a panel. */
  /* S22 (Wide QR relocation): the Wide mascot badge is retired — the QR owns
     this slot now. Matt is producing a Robograder figure that INTEGRATES the
     code (the QR as Robo's chest, head/arms/wheels extending past it) for the
     pre-printed stock; the app-rendered label draws the bare code. The base
     '.robot-badge { display: none }' rule above already hides it, so there is
     nothing to re-declare here. Case, Square and Large keep their badges. */
  .rg-label-large .robot-badge {
    display: block;
    position: absolute;
    top: 28px; right: 322px;
    width: 340px; height: 336px;
    display: flex; align-items: flex-end; justify-content: center;
  }
  .rg-label-large .robot-badge img { width: 288px; height: auto; display: block; opacity: 0.85; }

  /* S22: the ID pair was hidden here because the separate .url line under the
     QR carried it. That line is gone - it said the same thing twice, in a
     second typeface - so the ID belongs in the meta row, as on Wide. */
  .url-id { font-weight: 800; }
  .rg-label-l .url-id { font-size: 24px; }
  .rg-label-l .score-box {
    width: 252px; height: 252px;
    background: #cfe8a8;
    border: 3px solid #0f1a05;
    box-sizing: border-box;
    border-radius: 38px;
    position: absolute;
    left: 18px; top: 18px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label-l .rg-word {
    font-size: 24px; font-weight: 700;
    color: #2a4010; letter-spacing: 3px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 14px;
  }
  .rg-label-l .rg-stars {
    opacity: 0.85;
    position: absolute; top: 44px; left: 0; right: 0;
    text-align: center; font-size: 24px; line-height: 1; letter-spacing: 2px;
  }
  .rg-label-l .rg-num-wrap {
    /* S22: nudged DOWN. ROBOGRADE + stars sit at the top of the box and the ±PM
       is pinned at top:34px, so the flex-centred number crowded it. translateY
       (not margin) leaves the centring maths untouched. */
    transform: translateY(16px);
    display: inline-flex;
    line-height: 1;
  }
  /* S22 (carried from Wide): a three-glyph score - "100", or "9.5" under the
     v3 display, which is ordinary - wrapped to two lines inside the flex item
     and ran down over the version string. The .num-3 class was already being
     emitted for every size; only Wide had rules for it.
     nowrap stops the break; the smaller size is what then fits the one line.
     Sized off the measured glyph width (a digit is 0.556em in Noto Sans
     Display) against each box's own interior, not copied from Wide's. */
  .rg-label-l .rg-num-wrap { white-space: nowrap; }
  .rg-label-l .score-box.num-3 .rg-num { font-size: 132px; }
  .rg-label-l .score-box.has-plus.num-3 .rg-num { font-size: 118px; }
  .rg-label-square .rg-num-wrap { white-space: nowrap; }
  .rg-label-square .score-box.num-3 .rg-num { font-size: 134px; }
  .rg-label-square .score-box.has-plus.num-3 .rg-num { font-size: 120px; }
  .rg-label-l .rg-num {
    /* S15's Option A (150 -> 160 at scaleX(0.75)) is REVERTED here in S22.
       Matt, comparing all four variants side by side: the Case/Wide numeral is
       too wide and Large/Square's narrower condense reads better. Back to the
       original 150px at scaleX(0.625), which also restores the ~10px clearance
       to .rg-prec that Option A was eating into. */
    font-size: 150px; font-weight: 900;
    color: #0d0d0f; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.78);
    transform-origin: center;
  }
  /* S22: Case had no .rg-plus rule. The base one is scoped to .rg-label, which
     does NOT match .rg-label-l, so the (+) was a static block inside the
     centring flex column - it rendered under the number rather than beside it.
     Same fix as Square: on the number's midline, to its right. */
  .rg-label-l .rg-plus {
    position: absolute;
    top: 50%; right: 10px;
    margin-top: 16px;   /* tracks .rg-num-wrap's own translateY */
    transform: translateY(-50%);
    font-size: 48px; font-weight: 700;
    color: #0d0d0f; opacity: 0.85;
    font-family: 'Saira', 'Barlow Condensed', sans-serif;
    line-height: 1;
    white-space: nowrap;
  }
  .rg-label-l .rg-v {
    font-size: 24px;   /* S22: 20 -> 24, matching Wide */
    color: #3a5010;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 14px;
    letter-spacing: 1px;
  }
  /* Content column: right of the score box. Right boundary keeps it clear
     of the price pad / QR column on the right side. */
  .rg-label-l .info {
    position: absolute;
    /* S22: a bottom inset added. The meta band is pinned to the BOTTOM of this
       column, and without a bottom the column was auto-height - so the band
       landed in the middle of the text instead of under it. */
    /* right:490 (not 400) so the column ends before the art/price slot at
       x=686 rather than running under it. */
    left: 290px; top: 8px; right: 490px; bottom: 10px;
    display: flex; flex-direction: column;
  }
  /* v6.25: DELETED - .rg-label-l.has-price .info { right: 400px; }
     It made the text column 90px WIDER when the price was on (490 -> 400), a
     leftover from the retired white price-pad, which sat somewhere else on the
     label. The shared .rg-art slot occupies the SAME box whether it holds the
     figure or the price, so the column must not move at all - and because
     .info-lower is positioned against .info, that 90px also slid
     ROBOGRADER.APP/ID sideways whenever the toggle changed. The text wrapped
     later, ran into the price, and the ID moved. One rule did all three. */
  .rg-label-l .info-upper {
    padding-bottom: 4px;
  }
  .rg-label-l .ttl {
    /* S22: width:160% (= 1/0.625). Without it the title wrapped against the
       full box and then rendered at 0.625 of it, throwing away 37% of the
       column - the same fault Wide and Square both had. "The Amazing
       Spider-Man" took three lines where it takes two. */
    width: 160%;
    font-size: 58px; font-weight: 900;
    color: #0d0d0f; line-height: 1.0;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    white-space: normal;
    max-height: 116px;
    padding-bottom: 8px;
    overflow: hidden;
  }
  .rg-label-l .iss {
    width: 160%;   /* S22: see the .ttl note */
    font-size: 52px; font-weight: 600;
    color: #333;   /* v6.40: line-height moved to .rg-any .iss */
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
  }
  .rg-label-l .prt {
    /* S22 (carried from Wide): this line carries printing, then My Notes, then
       whatever of the Key Info fits. 20 -> 26, and line-height 1.3 so a line
       box contains its own descenders - fitLabelText clamps to whole lines and
       a tighter box would have it cutting through glyphs. */
    font-size: 26px; color: #555544;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    margin-top: 6px;
    line-height: 1.3;
    white-space: normal; overflow: hidden;
  }
  .rg-label-l .info-upper {
    display: flex; flex-direction: column;
    /* The face is 294 tall, the column runs top:8 to bottom:10 of it, and the
       pinned meta band takes 48 at the floor. 220 leaves the band clear. */
    max-height: 220px;
  }
  .rg-label-l .info-upper > .ttl,
  .rg-label-l .info-upper > .iss { flex: 0 0 auto; }
  .rg-label-l .info-upper > .prt { flex: 0 1 auto; min-height: 0; }
  /* S22 (carried from Wide): ONE meta row at the bottom, GRADED and the date
     on the left, ROBOGRADER.APP/ ID / XXXXXX on the right, with a rule above
     them in the same colour as the words - the rule and those two labels are
     one pre-printed unit and should read as one.
     Pinned rather than flowed, which is what keeps them at the SAME y on every
     label however the title wrapped. That is the whole reason this stock can
     be pre-printed, and a flowed position could not do it.
     The separate .url line is gone with it: "robograder.app/id/XXXXXX" under
     the QR said the same thing twice, in a second typeface, and was the thing
     that did not fit its column. */
  .rg-label-l .info-lower {
    position: absolute;
    /* v6.25: -454, not -285. .info's right edge is x=662 (1152 - 490); the QR
       column is right:36 and its image is right-aligned within it, so the QR's
       right edge is x=1116, and 662 + 454 = 1116. The band and its border-top
       - the horizontal rule - now stop exactly under the QR's right edge. The
       printed code and the code the QR encodes are the same thing, so they
       share an edge. -285 stopped at 947 and read as arbitrary, because it
       was: it was measured off the QR column's LEFT edge. */
    /* v6.36b: the BAND goes back to full width (-454, the QR's right edge):
       GRADED sits at its left and the ID pair at its right, and shortening the
       band wrapped the ID onto a second line. The RULE is a different object
       from the band, so it is drawn as a background strip rather than a
       border - 644px, stopping 30px short of the QR's left edge at x=935, so
       the QR's bottom edge rests ON the line instead of being cut off from the
       ID text by it. */
    left: 0; right: -454px; bottom: 0;
    height: 48px;
    box-sizing: border-box;
    border-top: none;
    background-image: linear-gradient(#2a3a18, #2a3a18);
    background-repeat: no-repeat;
    background-position: left top;
    background-size: 644px 1px;
    padding-top: 8px;
  }
  .rg-label-l .meta-grid {
    display: flex; align-items: baseline; flex-wrap: nowrap;
  }
  .rg-label-l .meta-grid .meta-val { margin-left: 10px; }
  .rg-label-l .meta-grid .meta-id-lbl { margin-left: auto; }
  .rg-label-l .url { display: none; }
  /* +2pt vs Small R's already-bumped 24 → 26, per user spec for Small L. */
  .rg-label-l .meta-lbl {
    font-size: 20px; font-weight: 600;   /* S22: both pairs on one row */
    color: #2a3a18;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label-l .meta-val {
    font-size: 24px; font-weight: 800;   /* S22: 34 -> 24 so both pairs fit one row */
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
    /* v6.36: 76 -> 58. The band is 48px tall against .info's bottom:10, so the
       rule sits at labelH-58 and the QR's bottom edge now lands on it. The
       rule itself stops 20px short of the QR (see .info-lower): it used to run
       underneath the code and cut it off from the ID text below, and those two
       are the same thing pointing at the same place. Wide does it this way. */
    right: 36px; bottom: 58px;
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
    right: 36px; bottom: 14px;
    letter-spacing: 0px;
    white-space: nowrap;
  }

  /* Card label (S22) — Avery 94235 fold-over, 756x576px @288DPI. Bottom half =
     FRONT (score + identity), top half = BACK (QR + robot, rotated 180). */
  .rg-label-card {
    width: 756px; height: 576px;
    background: linear-gradient(180deg, #e8b571 0%, #c97a14 43.75%, #c97a14 56.25%, #e8b571 100%);
    border: 1px solid #8a9a6a; border-radius: 4px;
    position: relative; overflow: hidden; box-sizing: border-box;
    font-family: 'Barlow Condensed', sans-serif;
  }
  .rg-label-card .rgc-foldtop, .rg-label-card .rgc-foldbot {
    position: absolute; left: 24px; right: 24px; height: 0;
    border-top: 1px dashed rgba(60,50,30,0.55); z-index: 3;
  }
  .rg-label-card .rgc-foldtop { top: 252px; }
  .rg-label-card .rgc-foldbot { top: 324px; }
  /* S21: Card name written in the 0.25" fold zone (252-324px), upright and
     horizontal like the Comic label wrap-strip, so cards standing in a box are
     identifiable from the top edge. */
  .rg-label-card .rgc-foldname {
    position: absolute; left: 24px; right: 24px; top: 252px; height: 72px;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Noto Sans Display', sans-serif; font-weight: 700;
    font-size: 34px; color: #0d0d0f; letter-spacing: 0.2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    z-index: 2;
  }
  .rg-label-card .rgc-back {
    position: absolute; top: 0; left: 0; right: 0; height: 252px;
    transform: rotate(180deg);
  }
  /* element-right -> flat-left after the 180 rotation */
  .rg-label-card .rgc-robot {
    position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
    width: 150px; height: 150px; display: flex; align-items: center; justify-content: center;
  }
  .rg-label-card .rgc-robot img { max-width: 100%; max-height: 100%; object-fit: contain; }
  /* element-left -> flat-right; column is URL(top)+QR(bottom) so after the flip
     the QR sits on top with the URL directly beneath it */
  .rg-label-card .rgc-qrcol {
    position: absolute; left: 28px; top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 6px;
  }
  .rg-label-card .rgc-qr { width: 150px; height: 150px; }
  .rg-label-card .rgc-qr .qrc canvas, .rg-label-card .rgc-qr .qrc img { width: 150px !important; height: 150px !important; }
  .rg-label-card .rgc-qr-private { width: 150px; height: 150px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 13px; letter-spacing: 1.5px; color: #7a6a4a; font-weight: 700; }
  .rg-label-card .rgc-backurl {
    font-size: 13px; color: #5a6a4a; font-weight: 500; text-align: center;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .rg-label-card .rgc-front {
    position: absolute; top: 324px; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: 12px; padding: 8px 16px 10px;
  }
  .rg-label-card .rgc-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
  .rg-label-card .rgc-ttl {
    font-family: 'Noto Sans Display', sans-serif; font-size: 40px; font-weight: 900;
    color: #0d0d0f; line-height: 1.02; white-space: nowrap; overflow: hidden;
    transform: scaleX(0.68); transform-origin: left center;
  }
  .rg-label-card .rgc-sub {
    font-family: 'Noto Sans Display', sans-serif; font-size: 26px; font-weight: 600;
    color: #333; margin-top: 4px; white-space: nowrap;
    transform: scaleX(0.72); transform-origin: left center;
  }
  .rg-label-card .rgc-var { font-size: 19px; color: #5a5544; font-weight: 600; margin-top: 3px; white-space: nowrap; overflow: hidden; }
  .rg-label-card .rgc-meta { margin-top: 8px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .rg-label-card .rgc-meta .k { font-size: 13px; font-weight: 600; color: #7a8a5a; letter-spacing: 0.5px; }
  .rg-label-card .rgc-meta .v { font-size: 16px; font-weight: 800; color: #0d0d0f; font-family: 'Noto Sans Mono', monospace; }
  .rg-label-card .rgc-price { margin-top: 6px; font-family: 'Noto Sans Display', sans-serif; font-size: 26px; font-weight: 900; color: #0d0d0f; }
  .rg-label-card .rgc-price-ph { color: #9a8a5a; font-weight: 600; }
  .rg-label-card .rgc-score {
    width: 168px; height: 168px; flex-shrink: 0; position: relative;
    background: #1a2208; border-radius: 24px;
    display: flex; align-items: center; justify-content: center;
  }
  .rg-label-card .rgc-score.gold { background: linear-gradient(150deg,#fdeea0 0%,#f0c53a 34%,#d99e12 66%,#b57e0c 100%); }
  .rg-label-card .rgc-word { position: absolute; top: 10px; font-size: 13px; font-weight: 700; color: #6a8030; letter-spacing: 2px; }
  .rg-label-card .rgc-score.gold .rgc-word { color: #7a5a10; }
  .rg-label-card .rgc-stars { position: absolute; top: 32px; font-size: 15px; line-height: 1; opacity: 0.5; }
  .rg-label-card .rgc-num { font-family: 'Noto Sans Display', sans-serif; font-weight: 900; font-size: 100px; line-height: 1; display: inline-block; transform: scaleX(0.8); transform-origin: center; position: relative; }
  .rg-label-card .rgc-suf { font-size: 0.5em; font-weight: 600; position: absolute; left: 100%; top: 24px; }
  .rg-label-card .rgc-v { position: absolute; bottom: 9px; font-size: 12px; color: #5a7030; font-weight: 500; letter-spacing: 1px; }
  .rg-label-card .rgc-score.gold .rgc-v { color: #7a5a10; }
  /* Price pad — to the LEFT of the QR column. Width 200, right edge at
     x=854 (20px gap to the QR col at x=874) → left x=654. */
  /* S22: the shared art/price slot. Bottom-aligned with the QR and with the
     meta rule, so the figure stands on the line exactly as it does on Wide.
     The white price box is gone - Matt cut it on every size. */
  .rg-label-l .rg-art {
    position: absolute;
    right: 236px; bottom: 76px;
    width: 230px; height: 184px;
    display: flex; align-items: flex-end; justify-content: center;
  }
  .rg-label-l .rg-art.is-price { align-items: center; }
  .rg-label-l .rg-art img {
    max-width: 100%; max-height: 100%;
    width: auto; height: auto;
    object-fit: contain; display: block;
  }
  .rg-label-l .price-pad { display: none; }
  /* v6.25: the three .rg-label-l.has-price .price-pad rules are gone. The
     white price pad was replaced by the shared .rg-art slot in v6.17 and the
     class has not been emitted since - "price-pad" appears nowhere in the
     markup. Dead CSS describing a live-looking layout.
     The same is true of the .rg-label.has-price, .rg-label-square.has-price
     and .rg-label-large.has-price price-pad rules, and of EVERY
     .rg-label.has-price rule, because showPrice is hard-coded false for size
     "small". Left in place deliberately - see LABEL_SHARED_STYLES.md. */

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
    left: 170px;      /* S22: QR is back at bottom-left in this state */
    right: 526px;     /* S22: +8, tracks the wider score box */
  }
  /* S22: the mascot now fills the price pad's footprint, so .info has to yield
     the same column whether the box holds a price or the robot — otherwise the
     GRADED / GRADE ID rules run out behind the robot's feet. There is no third
     state: the template emits the price pad when priceTag is on and the badge
     when it is off, so "not .has-price" IS "robot showing". */
  .rg-label:not(.has-price) .info {
    /* S22: 530, not 526. The figure occupies x 622..862 (right:290, width:240)
       and the info box ended at 626 — a 4px overlap that only stayed invisible
       because the meta rows are right-justified and the title is clamped. 530
       lands the info edge exactly on the figure's left edge. */
    right: 486px;   /* S22: the info column takes back what the figure held */
  }
  /* S22 - THE FIGURE IS BACK, BESIDE THE CODE RATHER THAN AROUND IT.
     It was dropped entirely when the chest-QR idea was abandoned. It returns
     as a column of its own, LEFT of the QR and ABOVE the rule, drawn from
     assets/Robograder_Line.png - the filled-chest line art. The empty-chest
     Robograder_Line_QR.png it replaces existed only to frame a code inside the
     chest, which the physics ruled out, and is retired.
     x 505..665. right:487 is the info column's own right edge, so the figure
     ends exactly where GRADED and the ID row end and the rule runs under its
     tracks; 160 wide leaves an 11px gutter to the QR at x=676.
     The figure does NOT take its column by moving .info - the rule and the
     meta rows still want the full width, and narrowing .info would pull them
     left with it. Only .info-upper yields, through padding-right, so the
     title, the date line and the printing/Key Info line wrap short of the
     figure while everything below it stays full width. */
  .rg-label .rg-art {
    position: absolute;
    right: 487px; width: 160px;
    /* S22: the rule moved down 36px and the figure goes with it rather than
       growing into the gap - the same 184 of height, lower down.
       32, not 42: standing the figure exactly ON the rule read as an overlap
       in print, because the tracks' outline IS the figure's bottom edge and
       there is no visual gap between a 1px rule and a 1px outline touching it.
       Bottom is 216, which leaves 10px of air under the tracks. */
    top: 32px; height: 184px;
    /* flex-end, not end: html2canvas only knows the flex-* spellings. The
       figure stands ON the rule rather than floating above it. */
    display: flex; align-items: flex-end; justify-content: center;
  }
  .rg-label .rg-art img {
    max-width: 100%; max-height: 100%;
    width: auto; height: auto;
    object-fit: contain; display: block;
  }
  /* S22 - THE PRICE TAKES THE FIGURE'S SLOT, WITH NO BOX AROUND IT.
     Same 160px column, same vertical band; only the content changes. Centred
     rather than bottom-aligned, because a number has no feet to stand on the
     rule with.
     The SIZE is set inline, per label, from the string's own measured width -
     see the price block in renderLabelMarkup. It cannot be done in CSS: "$10"
     and "$1000" have to end up the same width on the label, and CSS has no way
     to ask how wide a string is. Nothing here fixes a font-size for that
     reason. */
  .rg-label .rg-art.is-price { align-items: center; }
  /* The price face/weight/colour now live in the SHARED block at the top. */
  /* 160 for the figure + a 12px gutter. */
  .rg-label .info-upper { padding-right: 172px; }

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
    background: linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);
    border: 1px solid #8a9a6a;
    border-radius: 8px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  .rg-label-square .score-box {
    width: 256px; height: 256px;
    background: #cfe8a8;
    border: 3px solid #0f1a05;
    box-sizing: border-box;
    border-radius: 36px;
    position: absolute;
    right: 14px; top: 14px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label-square .rg-word {
    font-size: 22px; font-weight: 700;
    color: #2a4010; letter-spacing: 2.5px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 12px;
  }
  .rg-label-square .rg-stars {
    opacity: 0.85;
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
    /* S22: 156 -> 172 (~10% up) and pushed down off the ±PM — it was sitting
       high in the 256px box rather than optically centred.
       S22 (2nd pass) BUG: the translateY was written in a transform property
       that a SECOND transform: scaleX(0.625) two lines below overrode, so
       the drop never rendered. One declaration now — the order matters, scaleX
       first then translateY, so the shift is in unscaled pixels. */
    font-size: 172px; font-weight: 900;
    color: #0d0d0f; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    /* v6.20: 17px, not 14 - real-font ink left only 5px over the stars. */
    transform: scaleX(0.78) translateY(17px);
    transform-origin: center;
  }
  /* S22: the (+) was rendering UNDER the number because Square had no rule
     for it and inherited a flow position. It belongs on the number's midline,
     to its right, which is where the app's own score box draws it. */
  .rg-label-square .rg-plus {
    position: absolute;
    top: 50%; right: 10px;
    margin-top: 14px;   /* tracks .rg-num's own translateY so it sits on the
                           NUMBER's midline, not the box's */
    transform: translateY(-50%);
    font-size: 54px; font-weight: 700;
    color: #0d0d0f; opacity: 0.85;
    font-family: 'Saira', 'Barlow Condensed', sans-serif;
    line-height: 1;
    white-space: nowrap;
  }
  .rg-label-square .rg-v {
    font-size: 22px;   /* S22: 18 -> 22, matching Wide's bump proportionally */
    color: #3a5010;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    position: absolute; bottom: 12px;
    letter-spacing: 1px;
  }
  /* Info column — TOP-LEFT corner, beside the score box. */
  /* S22 — SQUARE REBUILT FROM THE BOTTOM UP (576 x 576).
       meta band   y 514..562   GRADED left, ROBOGRADER.APP/ ID / right
       rule        y 514        the band's border-top
       QR          y 340..500   bottom-right, 14px of air under it to the rule
       art/price   y 320..500   bottom-left, bottom-aligned with the QR
       score box   y 14..270    unchanged, top-right
       info        y 14..306    top-left, stopping above the art slot
     The QR sits directly above the grade ID, which is the pairing Matt asked
     for: scan the code, or read the ID under it. */
  .rg-label-square .info {
    position: absolute;
    left: 18px; top: 14px; right: 292px; bottom: 270px;
    display: flex; flex-direction: column;
  }
  .rg-label-square .info-upper {
    padding-bottom: 0;
    border-bottom: none;   /* the only rule on this label is the meta band's */
  }
  .rg-label-square .ttl {
    /* S22: 46 -> 62, matching Wide. Square is a 2in label read at the same
       distance as a 4x1, so the title has no reason to be smaller on it. */
    width: 160%;   /* S22: see the note above - 1/0.625, so the line box is
                      the column's REAL width and the title stops wrapping
                      three words early. */
    font-size: 62px; font-weight: 900;
    color: #0d0d0f; line-height: 1.0;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    word-wrap: break-word;
    padding-bottom: 8px;   /* descenders survive any clamp */
  }
  .rg-label-square .iss {
    width: 160%;   /* S22: see the .ttl note */
    font-size: 48px; font-weight: 600;   /* S22: 32 -> 48, matching Wide */
    color: #333;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    /* v6.38: the flex row and its 14px gap were left from when this line was
       two elements. It is one string now - the comma does the separating -
       and flex was stopping .rg-any's wrap rule from applying. */
    margin-top: 2px;   /* v6.40: 4 -> 2, on top of the line-height fix */
  }
  .rg-label-square .prt {
    font-size: 32px; color: #555544;   /* S22: 25 -> 32, matching Wide */
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 500;
    margin-top: 4px;   /* v6.40: 6 -> 4 */
    line-height: 1.3;   /* S22: see the Case note - whole-line clamping */
    white-space: normal; overflow: hidden;
  }
  .rg-label-square .info-upper {
    display: flex; flex-direction: column;
    /* The column is y 14..306; the printing / My Notes / Key Info line wraps
       into whatever the title and date line leave, and fitLabelText clamps it
       to whole lines with a marked truncation. */
    max-height: 292px;
  }
  .rg-label-square .info-upper > .ttl,
  .rg-label-square .info-upper > .iss { flex: 0 0 auto; }
  .rg-label-square .info-upper > .prt { flex: 0 1 auto; min-height: 0; }
  .rg-label-square .info-lower { padding-top: 10px; }
  /* S22: the ID row is BACK on Square. It was hidden on the argument that the ID
     is already under the QR, but Square's .url is 150px wide at 13px mono and
     "robograder.app/id/XXXXXX" does not fit in it, so in practice the grade ID
     was not readable anywhere on the label. The meta row shows it plainly. */
  /* S22 (carried from Wide): see the Case note above. */
  /* The band is pinned to the LABEL, not to the info column - the column now
     stops at y=306 and the band belongs at the floor, full width under both
     the art slot and the QR. */
  .rg-label-square .info-lower {
    position: absolute;
    /* .info is the containing block (left:18 right:292 bottom:270), so the
       band reaches the LABEL's floor and right margin through negative insets:
       .info's right edge is x=284 and the band ends at 558, hence -274; .info's
       bottom is y=306 and the band's bottom is 562, hence -256. Negative
       insets rather than a second element, so there is one thing to move. */
    /* v6.36b: band full width (-274); the rule is a short background strip -
       see the Case note. 360px stops it at x=378, 20px short of the QR. */
    left: 0; right: -274px; bottom: -256px;
    height: 48px;
    box-sizing: border-box;
    border-top: none;
    background-image: linear-gradient(#2a3a18, #2a3a18);
    background-repeat: no-repeat;
    background-position: left top;
    background-size: 360px 1px;
    padding-top: 8px;
  }
  .rg-label-square .meta-grid {
    display: flex; align-items: baseline; flex-wrap: nowrap;
  }
  .rg-label-square .meta-grid .meta-val { margin-left: 8px; }
  .rg-label-square .meta-grid .meta-id-lbl { margin-left: auto; }
  .rg-label-square .url { display: none; }
  .rg-label-square .meta-lbl {
    font-size: 17px; font-weight: 600;   /* S22: one row, with air between the
                                            two groups rather than them meeting
                                            in the middle */
    color: #2a3a18;                      /* matches the rule, as on Wide */
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.5px;
  }
  .rg-label-square .meta-val {
    font-size: 19px; font-weight: 800;   /* S22: one row now */
    color: #0d0d0f;
    font-family: 'Noto Sans Mono', monospace;
  }
  /* QR cluster — BOTTOM-LEFT corner. SCAN TO VERIFY above (flex order:-1),
     QR, then URL beneath. */
  /* BOTTOM-RIGHT, directly above the grade ID in the band below it. Its
     bottom edge is 14px clear of the rule, which is the "some space" Matt
     asked for - flush would read as the code sitting ON the line. */
  .rg-label-square .qr-col {
    position: absolute;
    /* v6.36: 76 -> 62, so the QR rests on the rule (y=514: band bottom 562,
       height 48). Same correction as Case. */
    right: 18px; bottom: 62px;
    width: 160px; height: 160px;
    display: flex; align-items: center; justify-content: center;
  }
  .rg-label-square .qr-col .qrc canvas,
  .rg-label-square .qr-col .qrc img {
    width: 160px !important;
    height: 160px !important;
  }
  /* Art / price slot: bottom-LEFT, bottom-aligned with the QR. It is the
     space the QR vacated, so nothing new had to be found for it. */
  .rg-label-square .rg-art {
    position: absolute;
    /* v6.40: bottom 76 -> 73, height 180 -> 184. That is every pixel between
       the info column (ends y=306) and the meta rule (y=513) with clearance
       at both ends - the slot is y 319..503. The price is capped to the
       slot's INK, so a taller slot is a bigger price. */
    left: 18px; bottom: 73px;
    width: 230px; height: 184px;
    display: flex; align-items: flex-end; justify-content: center;
  }
  .rg-label-square .rg-art.is-price { align-items: center; }
  .rg-label-square .rg-art img {
    max-width: 100%; max-height: 100%;
    width: auto; height: auto;
    object-fit: contain; display: block;
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
    background: linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);
    border: 1px solid #8a9a6a;
    border-radius: 6px;
    position: relative;
    overflow: hidden;
    font-family: 'Barlow Condensed', sans-serif;
    box-sizing: border-box;
  }
  .rg-label-large .score-box {
    /* S22: was 396x396 at left/top 18, which left 18px on every side — the same
       PIXEL gap as Wide and Case, but those labels are 288px tall and this one is
       432px, so the identical margin read as noticeably tighter against a box
       half again as large. Matched on PROPORTION instead: Wide's gap is
       18/288 = 6.25% of the label height, and 6.25% of 432 is 27.
       27 top + 378 box + 27 bottom = 432 exactly, and left is 27 to match.
       The box shrank 396 -> 378 (x0.9545), so every hand-tuned child metric
       below is scaled by the same factor rather than left where it was — an
       unscaled interior in a smaller box is how the number ends up riding the
       edge it was just moved away from. */
    width: 378px; height: 378px;
    background: #1a2208;
    border-radius: 57px;
    position: absolute;
    left: 27px; top: 27px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  }
  .rg-label-large .rg-word {
    /* S22: x0.9545 with the box (38 -> 36, top 22 -> 21). */
    font-size: 36px; font-weight: 700;
    color: #6a8030; letter-spacing: 5px;
    font-family: 'Barlow Condensed', sans-serif;
    position: absolute; top: 21px;
  }
  .rg-label-large .rg-stars {
    opacity: 0.5;
    position: absolute; top: 66px; left: 0; right: 0;
    text-align: center; font-size: 35px; line-height: 1; letter-spacing: 3px;
  }
  .rg-label-large .rg-num-wrap {
    /* S22: same drop as Case — the ±PM sits at top:53px here. */
    transform: translateY(19px);
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
    /* S22: 240 -> 229 with the box (x0.9545). */
    font-size: 229px; font-weight: 900;
    color: #b8d820; line-height: 1;
    font-family: 'Noto Sans Display', sans-serif;
    display: inline-block;
    transform: scaleX(0.625);
    transform-origin: center;
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
  /* S22: same as Wide — the robot occupies the pad's box, so the text column
     stops at the same boundary in both states. */
  .rg-label-large:not(.has-price) .info {
    right: 652px;
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
    /* S22: Large had fallen behind Case's readability pass — it is 1.5x
       Case's height but its title was only 1.1x Case's size, so it read
       SMALLER than the 4x1 label. 64 -> 80, line-height 1.1 -> 1.0, plus
       Case's clamp (2 lines at 80 = 160px). Width check: info is 1064px
       (704 with a price pad); at 80px scaleX(0.625) that is ~34 chars per
       line (~22 with price), so two clamped lines hold any real title. */
    font-size: 80px; font-weight: 900;
    color: #0d0d0f; line-height: 1.0;
    font-family: 'Noto Sans Display', sans-serif;
    transform: scaleX(0.625);
    transform-origin: left center;
    white-space: normal;
    max-height: 160px;
    overflow: hidden;
  }
  .rg-label-large .iss {
    /* S22: 42 -> 60, proportional to Case's 52 on a 1.5x-taller label. */
    font-size: 60px; font-weight: 600;
    color: #333; line-height: 1.0;
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
    /* S22: 36 -> 40 and #7a8a5a -> Case's #2a3a18, same print-legibility
       fix applied to Wide. */
    font-size: 40px; font-weight: 600;
    color: #2a3a18;
    font-family: 'Barlow Condensed', sans-serif;
    text-align: right; letter-spacing: 0.7px;
  }
  .rg-label-large .meta-val {
    /* S22: 36 -> 44, proportional to Case's 34. */
    font-size: 44px; font-weight: 800;
    color: #0d0d0f;
    font-family: 'Noto Sans Mono', monospace;
  }
  .rg-label-large .qr-col {
    /* S14: shifted left 72px (0.25" @288DPI) — right:18 → right:90 — to
       guarantee right-side clearance so no QR is cut off near the trim
       edge. The price pad and .info right boundary shift by the same
       72px to keep the column relationships intact. */
    position: absolute;
    /* S22: bottom-anchored for the same reason as Wide — QR directly above its
       URL. bottom:62 clears the URL (bottom:26, ~24px tall) with a 12px gap,
       and frees the top-right corner for the robot badge below. */
    right: 90px; bottom: 62px;
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

  /* ══════════════════════════════════════════════════════════════════════
     THERMAL / MONOCHROME VARIANT (v5.91)

     One layer of overrides on top of whichever format is selected, switched by
     the 'mono' class on the wrapper. It is deliberately a LAYER and not a
     fourth set of geometry: every position, size and clamp is already tuned
     per format and none of that changes for thermal. Only the ink changes.

     Three rules it follows, and they are all consequences of a 1-bit head:
       1. NOTHING MID-TONE. Every colour here is #000 or #fff. A thermal driver
          turns anything between into a dither pattern, which at 203-300 dpi
          reads as dirt and eats small type.
       2. NO FILL BEHIND TEXT. The score box inverts from a filled panel to a
          4px outline. Knocking white type out of a black panel means burning
          the entire panel, which is slow, drains the ribbon-less head's duty
          cycle, and leaves the number as the one unburned shape - the first
          thing to close up as the head wears or the stock shifts.
       3. WEIGHT AND POSITION CARRY WHAT COLOUR USED TO. Nothing here is
          distinguished by hue alone, so nothing is lost converting it.

     !important throughout, because renderLabelMarkup sets several of these
     inline for restored books (purple box, purple numeral, purple check) and
     the stars take their fill from an inline SVG attribute.

     This does NOT replace the colour design. List view still prints Avery
     sheets on a colour laser or inkjet, unchanged. */
  .mono { background: #fff !important; border: 1px solid #000 !important; }
  .mono .face,
  .mono .wrap-strip { background: #fff !important; }
  /* S22: the fold-over back panel. It carried the orange gradient, which on a
     one-ink printer dithers the whole 0.67in into cross-hatch for no
     information at all - and it is the side that faces out on the shelf. */
  .mono .fold-back { background: #fff !important; }
  /* The upper fold rule is the chip row's border-top, so it needs its own
     override - the .fold-guide rule below does not reach it. Olive on a
     one-ink printer dithers to a grey hatch, which is exactly what a fold mark
     must not be. */
  .mono .wrap-strip { border-top-color: #000 !important; }
  /* S22: the chip row's score box moved to light green with the face's box in
     v6.15, and nothing here followed it, so the thermal label printed a green
     panel. Outline, not fill - same rule as the face's box, at the 2px this
     one uses. */
  .mono .wrap-strip .ws-score {
    background: #fff !important;
    border: 2px solid #000 !important;
  }
  .mono .fold-guide { background: #000 !important; opacity: 1 !important; }

  /* Score box: outline, not fill. The 4px border holds its own at 203 dpi
     where a 1px hairline can drop out entirely between passes. */
  .mono .score-box {
    background: #fff !important;
    border: 4px solid #000 !important;
  }
  .mono .rg-word,
  .mono .rg-num,
  .mono .rg-v,
  .mono .ttl,
  .mono .ttl-iss,
  .mono .iss,
  .mono .prt,
  .mono .meta-lbl,
  .mono .meta-val,
  .mono .url,
  .mono .url-id,
  .mono .verify,
  .mono .ws-ttl, .mono .ws-iss, .mono .ws-date, .mono .ws-prt,
  .mono .ws-id, .mono .ws-score {
    color: #000 !important;
    opacity: 1 !important;
  }
  /* Stars carry an inline fill from _labelTierStars, including the purple
     restoration star — all of them go black. */
  .mono .rg-stars { opacity: 1 !important; }
  .mono .rg-stars svg path { fill: #000 !important; }
  /* The restoration check mark is inline-styled purple. */
  .mono .rg-num-wrap span { color: #000 !important; }
  .mono .rg-plus { color: #000 !important; opacity: 1 !important; }

  /* Rules: the divider and the info-upper border, black and 2px so they
     survive the head. */
  /* v6.36b: Wide still draws its rule as a border; Case and Square draw a
     SHORT rule as a background strip, so mono overrides whichever the variant
     actually uses. */
  .mono .info-lower { border-top: 2px solid #000 !important; }
  .rg-label-l.mono .info-lower {
    border-top: none !important;
    background-image: linear-gradient(#000, #000) !important;
    background-size: 644px 2px !important;
  }
  .rg-label-square.mono .info-lower {
    border-top: none !important;
    background-image: linear-gradient(#000, #000) !important;
    background-size: 360px 2px !important;
  }
  .mono .info-upper { border-bottom-color: #000 !important; }

  /* QR: the stock is already white, so the white pad is redundant — drop it
     and let the code sit directly on the label. The quiet zone is still
     there; it is just the paper now. */
  .mono .qrc {
    background: none !important;
    padding: 0 !important;
    border-radius: 0 !important;
  }
  .mono .qr-private div { color: #000 !important; }

  /* Price pad: outline, same reasoning as the score box. */
  .mono .price-pad {
    background: #fff !important;
    border: 2px solid #000 !important;
  }
  .mono .price-placeholder,
  .mono .price-value { color: #000 !important; }

  /* The mascot is a photographic PNG with soft shading. There is no good
     1-bit rendering of it — it dithers into a grey smudge — so thermal drops
     it rather than printing something that looks like a fault. */
  .mono .robot-badge { display: none !important; }

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
  // S22: a card item always uses the Card format; a comic can't use the Card
  // label (would render blank card fields) -> fall back to Comic.
  opts.size = (comic && comic.type === 'card') ? 'card' : (opts.size === 'card' ? 'small-l' : opts.size);
  const fmt = _fmtFor(opts.size);

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
  // v6.36: in single-label mode neither of these is true. One label is being
  // printed, on its own stock, so "Queue: 1 / 14" counts toward a capacity
  // that is not being used and "Labels print 14 to a sheet" describes a sheet
  // that is not being printed. Both are sheet facts; they belong to the sheet
  // flow, which is List view.
  const subtitleText = _singleMode ? '' : `Labels print ${fmt.sheetCount} to a sheet`;

  // S12 May 6: 3-way size segmented control replaces the binary Small/Large
  // pill. Each segment is "active" when its size is the currently selected
  // option. Click handlers read the data-size attribute and persist.
  const seg = (size, label) =>
    `<button type="button" class="lvm-segment${opts.size === size ? ' active' : ''}" data-action="set-size" data-size="${size}">${label}</button>`;
  // S21: card items can only print the Card label; comic items get Comic +
  // Square (never Card, which would render blank card fields). opts.size is
  // already coerced above, so exactly one valid choice-set is offered here.
  const _isCardItem = !!(comic && comic.type === 'card');
  const sizeSegments = _isCardItem
    ? `<div class="lvm-segment-group">${seg('card', 'Card')}</div>`
    // v5.86, Matt: Large is RETIRED from the picker in both views. It was an
    // early experiment at matching CGC's own label size (OL5450, 7.5" x 1.5")
    // and nobody uses it. It is also the one format that cannot ever work on a
    // 4"-wide thermal printer, so leaving it on screen would promise something
    // the printing path can't deliver. The format definition and its renderer
    // stay in the file so existing saved options still resolve - see the
    // VALID_SIZES note - but there is no way to choose it any more.
    : `<div class="lvm-segment-group">${seg('small-l', 'Case')}${seg('small', 'Wide')}${seg('square', 'Square')}</div>`;

  const pricePillClass = opts.priceTag ? 'lvm-pill on' : 'lvm-pill';
  // v5.91: thermal toggle. Shown for every size — Case, Wide and Square are
  // all within a 4" roll printer's width, so any of them can land on one.
  // Cards keep it too; the renderer applies the same layer.
  const monoPillClass = opts.mono ? 'lvm-pill on' : 'lvm-pill';

  // S12: Include Asking Price secondary toggle. Conditional visibility — only shows
  // when BOTH:
  //   1. priceTag is on (no point asking about value if pad isn't shown)
  //   2. comic.askingPrice has a value (no value to include if not set)
  // When hidden, includePrice option is treated as effectively off regardless
  // of stored value. When shown, the toggle drives whether the asking-price
  // value renders inside the pad or the pad stays blank for hand-writing.
  const hasAskingPrice = comic.askingPrice != null && comic.askingPrice !== '' && Number(comic.askingPrice) > 0;
  // S22: WIDE HAS NO PRICE PAD ANY MORE. At 4x1 the pad took the slot the QR
  // now occupies and squeezed the info column to the point where a two-line
  // title stopped fitting. Offering a toggle that cannot be honoured is worse
  // than not offering it, so both price toggles are hidden on Wide and the
  // stored priceTag is ignored for this size rather than cleared - switch to
  // Case or Square and the setting is still there.
  // S22: ONE toggle, and it says which field it shows. "Include price tag"
  // did not name a source, which is how a typed field on this screen ever
  // seemed reasonable; "Include asking price" names the record field, so there
  // is nowhere else for the number to come from.
  // The Wide note above remains true about the PAD - a 220px white box cannot
  // fit at 4x1 beside the QR. A price needs no box, so Wide shows it in the
  // figure's 160px column instead. See _artSlot in renderLabelMarkup.
  const _isWideSize = opts.size === 'small';
  const showPriceToggle = true;
  // The secondary "include asking price" toggle is gone: it chose between a
  // blank pad and the record's price, and one toggle that means "show the
  // asking price, and leave the space blank if there is not one" covers both
  // without a second tap or a second thing to explain.
  const showIncludePriceToggle = false;
  const includePricePillClass = opts.includePrice ? 'lvm-pill on' : 'lvm-pill';

  // Effective options for rendering: includePrice only takes effect if the
  // toggle is visible (i.e. price tag on AND asking price exists). This way
  // a stored "true" value doesn't accidentally render a missing price.
  const effectiveOpts = {
    ...opts,
    // Always true now: with one toggle, "price tag on" means "show the asking
    // price". The non-Wide price pad reads this to decide value-vs-placeholder,
    // and the placeholder is the right thing when there is no price to show.
    includePrice: true
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
  // Roll stock when printing a SINGLE label, sheet stock for a sheet. Keyed on
  // single-label mode and not on thermal: a roll printer that prints in colour
  // is still a roll printer, and sending that user to an Avery sheet because
  // they did not tick "thermal" would be wrong. Thermal implies a roll; it is
  // not the only thing that does.
  // An entry with no ASIN falls through to the sheet link rather than
  // rendering a dead button.
  const _roll = _singleMode ? LABEL_ROLL_LINKS[opts.size] : null;
  const buyLink = (_roll && _roll.asin)
    ? { label: _roll.label, url: amazonProductUrl(_roll.asin), vendor: _roll.vendor }
    : LABEL_BUY_LINKS[opts.size];
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
          ${_singleMode ? '' : `<div class="${queueClass}">Queue: ${queueCount} / ${queueCap}</div>`}
          ${subtitleText ? `<div class="lvm-subtitle">${subtitleText}</div>` : ''}
        </div>
        <button type="button" class="lvm-close" data-action="close" aria-label="Close">\u00d7</button>
      </div>
      <div class="lvm-toggle-row lvm-toggle-row-sizes">
        ${sizeSegments}
      </div>
      ${showPriceToggle ? `
      <div class="lvm-toggle-row lvm-toggle-row-secondary">
        <div></div>
        <div class="lvm-toggle" data-action="toggle-price" role="button" tabindex="0">
          <span class="lvm-toggle-label">Include asking price</span>
          <span class="${pricePillClass}"></span>
        </div>
      </div>` : ''}
      ${showIncludePriceToggle ? `
      <div class="lvm-toggle-row lvm-toggle-row-secondary">
        <div></div>
        <div class="lvm-toggle" data-action="toggle-include-price" role="button" tabindex="0">
          <span class="lvm-toggle-label">Include asking price</span>
          <span class="${includePricePillClass}"></span>
        </div>
      </div>` : ''}
      <div class="lvm-toggle-row lvm-toggle-row-secondary">
        <div></div>
        <div class="lvm-toggle" data-action="toggle-mono" role="button" tabindex="0">
          <span class="lvm-toggle-label">Thermal printer (black only)</span>
          <span class="${monoPillClass}"></span>
        </div>
      </div>
      <div class="lvm-preview-area">
        <div class="lvm-preview-frame" style="--lvm-label-w: ${fmt.pixelW}px; --lvm-label-h: ${fmt.pixelH}px;">
          <div class="lvm-preview-wrap" style="--lvm-label-w: ${fmt.pixelW}px; --lvm-label-h: ${fmt.pixelH}px;">
            ${labelHTML}
          </div>
        </div>
      </div>
      <div class="lvm-actions">
        <button class="rg-btn rg-btn-primary rg-btn-md" data-action="print" ${printDisabled ? 'disabled' : ''}>Save as PDF</button>
        <button class="rg-btn rg-btn-secondary rg-btn-md" data-action="share" ${printDisabled ? 'disabled' : ''}>Share…</button>
      </div>
      ${buyLinkHTML}
    </div>
  `;

  // Render QR for the previewed label
  renderQRsIn(modal);
  // S22: snap the printing / Key Info line to whole lines. Run twice: once
  // now, and again once the label font has actually loaded - the fallback
  // face has different metrics and would snap to the wrong line count on the
  // very first open of a session.
  fitLabelText(modal);
  ensureLabelFontsReady().then(() => fitLabelText(modal)).catch(() => {});

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
  // S22: absent on Wide (no price pad at 4x1), so guard it the way the
  // include-price listener always has been.
  const priceToggleEl = modal.querySelector('[data-action="toggle-price"]');
  if (priceToggleEl) {
    priceToggleEl.addEventListener('click', () => {
      const cur = readOptions();
      writeOptions({ ...cur, priceTag: !cur.priceTag });
      renderModal(modal, comic, allItems);
    });
  }
  // v5.91: thermal toggle. Unconditional in the DOM, so no guard needed.
  modal.querySelector('[data-action="toggle-mono"]').addEventListener('click', () => {
    const cur = readOptions();
    writeOptions({ ...cur, mono: !cur.mono });
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
    handleSavePDF(modal, comic, allItems, 'save');
  });
  // v6.36: SAVE and SHARE are different intentions and were the same button.
  // "Save as PDF" opened the iOS share sheet, where Save to Files is behind
  // "View More" - so saving a label, the common case, cost three extra taps
  // and the thing the user wanted was the one option not on screen.
  const _shareBtn = modal.querySelector('[data-action="share"]');
  if (_shareBtn) _shareBtn.addEventListener('click', (e) => {
    if (e.currentTarget.disabled) return;
    handleSavePDF(modal, comic, allItems, 'share');
  });

  // v6.38: the explicit close. Same closeModal as the backdrop, so the queue
  // is preserved either way.
  const _closeBtn = modal.querySelector('[data-action="close"]');
  if (_closeBtn) _closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeModal(modal);
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
  // child of the area, so if the area hugs its content, shrinking the label
  // shrinks the area, which feeds back into a smaller scale on the next call
  // — the ratchet-to-micro bug. The old guard against that was a flat 38% of
  // the viewport, which is stable but is not the room that actually exists.
  //
  // v6.40: measure the room instead. The card's OTHER children — header,
  // toggle rows, actions, the buy link — are the only things competing with
  // the preview, and not one of their heights depends on the label's scale.
  // So they are safe to measure and the ratchet cannot start. What is left
  // after them is the budget.
  //
  // This is what v6.38 broke. Shortening the card to 100vh-88px (to leave a
  // band of backdrop to tap) took 64px out of a budget nothing was tracking;
  // the preview area is flex:1 with overflow:auto, so it absorbed the loss by
  // SCROLLING, and on Square - the one label as tall as it is wide - that
  // meant you could no longer see the whole thing at once.
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  const card = modal.querySelector('.lvm-card');
  let budget = card ? parseFloat(getComputedStyle(card).maxHeight) : NaN;
  if (!isFinite(budget) || budget <= 0) budget = vh - 88;   // mirrors the CSS
  let chrome = 0;
  if (card) {
    for (const kid of card.children) {
      if (kid !== area) chrome += kid.getBoundingClientRect().height;
    }
  }
  const padY = parseFloat(areaStyle.paddingTop) + parseFloat(areaStyle.paddingBottom);
  // The 8px is the same "don't touch the edges" courtesy the 0.96 gives width.
  const availH = Math.max(80, budget - chrome - padY - 8);
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

async function handleSavePDF(modal, currentComic, allItems, intent) {
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
  // v6.36: whichever button was pressed shows the progress, and BOTH are
  // disabled - a second tap on the other one while the first is rendering
  // would start a second PDF.
  const saveBtn = modal.querySelector(intent === 'share' ? '[data-action="share"]' : '[data-action="print"]');
  const otherBtn = modal.querySelector(intent === 'share' ? '[data-action="print"]' : '[data-action="share"]');
  const origLabel = saveBtn ? saveBtn.textContent : 'Save as PDF';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Generating…';
  }
  if (otherBtn) otherBtn.disabled = true;

  try {
    await ensurePdfLibsLoaded();
    await generatePDF(comicsToprint, modal, intent === 'share' ? 'share' : 'save');
    renderModal(modal, currentComic, allItems);
  } catch (err) {
    console.error('[label] PDF generation failed:', err);
    alert('PDF generation failed: ' + err.message);
    if (otherBtn) otherBtn.disabled = false;
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
async function generatePDF(comics, modal, intent) {
  const { jsPDF } = window.jspdf;
  // SINGLE MODE: the page IS the label. Declared AFTER opts/fmt are read below
  // in sheet mode, so the format lookup is duplicated here - cheap, and it
  // keeps the sheet path's logic untouched.
  const _singleFmt = _singleMode
    ? _fmtFor((() => {
        const o = readOptions();
        const f = comics && comics[0];
        return (f && f.type === 'card') ? 'card' : (o.size === 'card' ? 'small-l' : o.size);
      })())
    : null;
  const pdf = _singleFmt
    ? new jsPDF({
        // jsPDF takes [width, height] in the given unit. Orientation is implied
        // by the array, but state it so a square label (2x2) is unambiguous.
        orientation: _singleFmt.labelW >= _singleFmt.labelH ? 'landscape' : 'portrait',
        unit: 'in',
        format: [_singleFmt.labelW, _singleFmt.labelH]
      })
    : new jsPDF({
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
  // S22: match the render — card queue -> card sheet; stray 'card' on a comic
  // queue falls back to Comic.
  const _first = comics && comics[0];
  opts.size = (_first && _first.type === 'card') ? 'card' : (opts.size === 'card' ? 'small-l' : opts.size);
  const fmt = _fmtFor(opts.size);

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
      labelsHTML += `<div class="pdf-label-box" data-idx="${i}" style="width:${fmt.pixelW}px;height:${fmt.pixelH}px;display:block;background:linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);">${renderLabelMarkup(comics[i], opts)}</div>`;
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
    // S22: AFTER the font wait, never before - see fitLabelText's note. The
    // sheet path measures the same way the preview does, so what is captured
    // is what was shown.
    fitLabelText(offscreen);

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
      bandEl.style.cssText = `width:${Math.round(PAGE_W_IN * dpi)}px;height:${fmt.pixelH}px;background:linear-gradient(180deg, #c97a14 0%, #dd9430 38%, #e8b571 100%);`;
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

      // SINGLE MODE: one label per page, drawn at the origin, no margins and
      // no grid. Everything downstream still uses x/y and fmt.labelW/labelH,
      // so the drawing code below needs no branch of its own.
      let x, y;
      if (_singleMode) {
        if (i > 0) pdf.addPage([fmt.labelW, fmt.labelH], fmt.labelW >= fmt.labelH ? 'landscape' : 'portrait');
        x = 0; y = 0;
      } else {
      const cellIdx = i % perSheet;            // 0 .. perSheet-1
      const sheetIdx = Math.floor(i / perSheet);

      // Add a new page when starting a new sheet (skip on first sheet).
      if (cellIdx === 0 && sheetIdx > 0) {
        pdf.addPage('letter', 'portrait');
      }

      const col = cellIdx % fmt.cols;
      const row = Math.floor(cellIdx / fmt.cols);
      x = fmt.sheetLeftMargin + col * (fmt.labelW + fmt.colGap);
      y = fmt.sheetTopMargin + row * (fmt.labelH + fmt.rowGap);

      // S18: nudge the Small-L LEFT column right (see SMALL_L_LEFT_SHIFT_IN).
      if (opts.size === 'small-l' && col === 0) {
        x += SMALL_L_LEFT_SHIFT_IN;
      }

      // S20: lay the full-width gradient band for this row (Small L only), once
      // per row at col 0, BEFORE the label image so the label draws on top of it.
      if (bandImgData && col === 0) {
        pdf.addImage(bandImgData, 'JPEG', 0, y, 8.5, fmt.labelH);
      }
      }   // end sheet-placement branch (single mode set x/y above)

      // S22 - A HANG MUST NOT LOOK LIKE PROGRESS. Save PDF sat on
      // 'Generating 1/1...' in a greyed-out button forever. handleSavePDF has
      // always had a catch that alerts, so a THROW was never the problem:
      // html2canvas never SETTLED, and an unsettled promise cannot be caught.
      // It hangs waiting on a resource in the cloned document that neither
      // loads nor errors - most often an image, and the QR is the only image
      // on a Wide label. Racing it turns a dead button into a named failure,
      // which is the difference between no information and a bug report that
      // says which label and how far it got. 45s is generous: a 4x1 captures
      // in under a second on desktop, 2-3s on an older iPhone.
      // v6.38: the last word on what is in this box, in the same tick as the
      // capture. See settleLabelImagesSync.
      settleLabelImagesSync(boxes[i]);
      const _capture = window.html2canvas(boxes[i], {
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
      const canvas = await Promise.race([
        _capture,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          'Label ' + (i + 1) + ' of ' + total + ' never finished rendering (20s). '
          + 'This is almost always an image inside the label that will not load - '
          + 'the QR code or the watermark figure. Nothing was saved.'
        )), 20000))
      ]);
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
                  : opts.size === 'card' ? '94235'
                  : opts.size === 'small-l' ? '5162'
                  : '8161';
    const priceTag = opts.priceTag ? '-Price' : '';
    const monoTag = opts.mono ? '-Thermal' : '';
    // S22: ONE label -> name the file after the BOOK, not the stock. A folder
    // of Robograder-Labels-8161-2026-11-03.pdf, -(1), -(2) is unsearchable;
    // Amazing-Fantasy-15-2026-11-03.pdf is the thing you would look for.
    // The date is the GRADE date, not today - the label is a snapshot of an
    // assessment, and re-printing one next year should give the same name.
    // A SHEET keeps the old name: several books on one page have no single
    // title, and naming it after whichever happened to be first would be a
    // lie on the other nineteen.
    const _slug = (v) => String(v == null ? '' : v)
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    let filename;
    if (comics.length === 1) {
      const c0 = comics[0];
      const gd = c0.roboGradeDate ? new Date(c0.roboGradeDate) : null;
      const dateStr = (gd && !isNaN(gd)) ? gd.toISOString().slice(0, 10)
                                         : new Date().toISOString().slice(0, 10);
      const bits = [_slug(c0.title), _slug(c0.issue), dateStr].filter(Boolean);
      // Fall back to the old shape rather than emitting "--2026-11-03.pdf" for
      // a record with no title.
      filename = bits.length > 1
        ? bits.join('-') + monoTag + '.pdf'
        : `Robograder-Label-${sizeTag}${priceTag}${monoTag}-${dateStr}.pdf`;
    } else {
      filename = `Robograder-Labels-${sizeTag}${priceTag}${monoTag}-${new Date().toISOString().slice(0, 10)}.pdf`;
    }
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
    const _wantShare = intent === 'share';

    // v6.36 — SAVE WRITES STRAIGHT TO FILES.
    // The share sheet was the only delivery, and Save to Files lives behind
    // "View More" on it, so the common case - keep the label, print it from
    // the printer's own app - cost: Save as PDF, View More, Save to Files,
    // pick a folder, Save. Five taps for a file the user already said they
    // wanted. Writing to DOCUMENTS puts it in Files → On My iPhone →
    // Robograder in one.
    //
    // THIS NEEDS TWO Info.plist KEYS TO BE VISIBLE, and without them the file
    // is written to a private directory the user cannot reach:
    //     UIFileSharingEnabled            = YES
    //     LSSupportsOpeningDocumentsInPlace = YES
    // If they are missing, Share… is still there and still works.
    if (isNative && !_wantShare) {
      const P = (Cap && Cap.Plugins) || {};
      const FS = P.Filesystem;
      if (FS) {
        try {
          const b64 = pdf.output('datauristring').split(',')[1];
          await FS.writeFile({ path: filename, data: b64, directory: 'DOCUMENTS' });
          try {
            if (typeof window.appAlert === 'function') {
              await window.appAlert('Saved to Files → On My iPhone → Robograder\n\n' + filename);
            }
          } catch (e) {}
          return;
        } catch (e) {
          // Fall through to the share sheet rather than failing: a label the
          // user cannot get at is worse than an extra tap.
          console.warn('[label] save to Documents failed, falling back to share:', e);
        }
      }
    }

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
    // v6.36: on the web, SAVE is a download - which on iOS Safari lands in
    // Files → Downloads without a share sheet. Only Share… asks to share.
    if (_wantShare && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
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

// Card label (S22) — Avery 94235 fold-over. 2.625"x2" (756x576px @288DPI).
// Folds horizontally over the top edge of a raw-card case: BOTTOM half = FRONT
// (score box + identity + optional price), TOP half = BACK (QR + Robograder
// robot), rotated 180deg so the back reads upright when viewed from behind.
// Two thin fold lines flank the midline.
function renderCardLabelMarkup(comic, opts) {
  opts = opts || { size: 'card' };
  const showPrice = !!opts.priceTag;
  const includePrice = !!opts.includePrice;
  const rg = comic.roboGrade || {};
  const card = comic.cardData || {};
  const cd = card.robograde || rg.subscores || null;
  let grade = '';
  if (window.RGScoreV2 && cd) {
    const subs = { surface: cd.surface && cd.surface.total, corners: cd.corners && cd.corners.total, edges: cd.edges && cd.edges.total, centering: cd.centering && cd.centering.total };
    if ([subs.surface, subs.corners, subs.edges, subs.centering].some(v => v != null)) grade = window.RGScoreV2.fromSubscores(subs, 'card').grade;
  }
  if ((grade === '' || grade == null) && rg.score != null && window.RGScoreV2) grade = window.RGScoreV2.gradeFromScore(rg.score);
  if (window.RG_V3_DISPLAY && window.RoboScoreV3) { const _rc = window.RoboScoreV3.forCard(comic); if (_rc) grade = window.RoboScoreV3.formatGrade(_rc.grade); }  // card v3 wins
  const gradeStr = String(grade == null ? '' : grade);
  const gm = gradeStr.match(/^(\d+)([+\-]|\.\d)?$/);
  const gBase = gm ? gm[1] : gradeStr;
  const gSuf = (gm && gm[2]) ? gm[2] : '';
  const perfect10 = gBase === '10' && !gSuf;
  const numColor = perfect10 ? '#1a1206' : '#b8d820';

  const ident = card.cardIdentification || {};
  const name = esc(comic.title || 'Card');
  const number = esc(String(ident.number || comic.issue || '').replace(/^#/, ''));
  const year = esc(String(ident.year || '').trim());
  const variant = esc((ident.variant || comic.printing || '').toString().trim());
  const numYear = [number, year].filter(Boolean).join(', ');
  const gradeId = esc(comic.roboGradeId || 'XXXXXX');
  const _dateObj = comic.roboGradeDate ? new Date(comic.roboGradeDate) : new Date();
  const gradeDate = _dateObj.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });

  const _deep = !!comic.deepAssessmentRan;
  const _full = !!comic.fullAssessmentRan;
  let _t = 1; if (_full) _t = 3; else if (_deep) _t = 2;
  const _starFill = perfect10 ? '#5a3f06' : '#b8d820';
  const _star = () => `<svg viewBox="0 0 24 24" style="height:1em;width:1em;display:inline-block;vertical-align:middle"><path d="M12.00,2.00 15.64,6.98 21.51,8.91 17.90,13.92 17.88,20.09 12.00,18.20 6.12,20.09 6.10,13.92 2.49,8.91 8.36,6.98Z" fill="${_starFill}"/></svg>`;
  let _stars = ''; for (let i = 0; i < _t; i++) _stars += _star();

  let priceHTML = '';
  if (showPrice) {
    if (includePrice && comic.askingPrice != null) {
      const p = Number(comic.askingPrice);
      const ps = p % 1 === 0 ? `$${Math.round(p)}` : `$${p.toFixed(2)}`;
      priceHTML = `<div class="rgc-price">${ps}</div>`;
    } else {
      priceHTML = `<div class="rgc-price rgc-price-ph">Price</div>`;
    }
  }

  const backHTML = `
    <div class="rgc-back">
      <div class="rgc-robot"><img src="assets/Robograder_Charging.png" alt=""></div>
      <div class="rgc-qrcol">
        <div class="rgc-backurl">${comic.publicListing ? `robograder.app/id/${gradeId}` : `ID ${gradeId}`}</div>
        ${comic.publicListing
          ? `<div class="rgc-qr"><div class="qrc" data-qr-id="${gradeId}"></div></div>`
          : `<div class="rgc-qr rgc-qr-private">PRIVATE<br>LISTING</div>`}
      </div>
    </div>`;

  return `
    <div class="rg-label-card${perfect10 ? ' perfect10' : ''}${opts && opts.mono ? ' mono' : ''}" data-grade-id="${gradeId}">
      ${backHTML}
      <div class="rgc-foldtop"></div>
      <div class="rgc-foldbot"></div>
      <div class="rgc-foldname">${name}</div>
      <div class="rgc-front">
        <div class="rgc-score${perfect10 ? ' gold' : ''}">
          <div class="rgc-word">ROBOGRADE</div>
          <div class="rgc-stars">${_stars}</div>
          <div class="rgc-num" style="color:${numColor}">${gBase}${gSuf ? `<span class="rgc-suf" style="color:${numColor}">${gSuf}</span>` : ''}</div>
          <div class="rgc-v">V${window.RG_GRADING_VERSION || '4.70'}</div>
        </div>
        <div class="rgc-info">
          <div class="rgc-ttl">${name}</div>
          ${numYear ? `<div class="rgc-sub">${numYear}</div>` : ''}
          ${variant ? `<div class="rgc-var">${variant}</div>` : ''}
          <div class="rgc-meta"><span class="k">ID</span> <span class="v">${gradeId}</span> <span class="k">GRADED</span> <span class="v">${gradeDate}</span></div>
          ${priceHTML}
        </div>
      </div>
    </div>
  `;
}

export function renderLabelMarkup(comic, opts) {
  // S12: opts is { size, priceTag, includePrice }. Defaults to small + no
  // price tag + no included price if not supplied (preserves backward
  // compatibility for any caller still using the single-argument form).
  // Note: 'small' = the default Avery 8161 (4"×1", 20 per sheet) — it's the
  // long-standing "default size". 'large' is the OL5450 CGC-slab format
  // (7.5"×1.5", 7 per sheet).
  // includePrice (S12 May 6): when true AND comic has an askingPrice, the
  // value renders inside the price pad. Otherwise the pad shows the faint
  // "Price" placeholder for handwriting.
  opts = opts || { size: 'small-l', priceTag: false, includePrice: false };
  const isLarge  = opts.size === 'large';
  const isSquare = opts.size === 'square';
  const isSmallL = opts.size === 'small-l';
  // S22: Wide is the thermal-roll format and the only variant with a LIGHT
  // score box (see the .rg-label .score-box note in the CSS), so every colour
  // decision below has to branch on it.
  const isWide = !isLarge && !isSquare && !isSmallL;
  if (opts.size === 'card' || (comic && comic.type === 'card')) return renderCardLabelMarkup(comic, opts);
  // S22: Wide has no price pad. A priceTag stored from another size is ignored
  // here rather than cleared, so switching back to Case or Square keeps it.
  const showPrice = !!opts.priceTag && opts.size !== 'small';
  const includePrice = !!opts.includePrice;

  const rg = comic.roboGrade;
  let score = Math.round(rg.score ?? 0);
  // S16: Restoration state for purple coloring + check mark
  const _labelRestored = !!(comic.restorationHighConfidence || (comic.cgcNotes && /\b(RC|restored|restoration|conserved)\b/i.test(comic.cgcNotes)));
  const _labelRestoNeg = !!(comic.restorationCheckRan && !comic.restorationFlag && !_labelRestored);
  // S22: Wide's box is light (#cfe8a8 + black numerals), so the restoration
  // palette inverts for it — a pale lavender numeral that reads on #1a0a2a is
  // invisible on a light panel, and vice versa.
  // S22: Case and Square joined Wide on the light score box, so the LIGHT
  // palette is now the default and only Large (retired) keeps the dark one.
  // Restored books invert with it: a lavender numeral that reads on #1a0a2a is
  // invisible on a light panel.
  const _lightBox = !isLarge;
  const _labelScoreColor = _lightBox
    ? (_labelRestored ? '#3a1252' : '#0d0d0f')
    : (_labelRestored ? '#c8a8e8' : '#b8d820');
  const _labelBgColor = _lightBox
    ? (_labelRestored ? '#ead8f5' : '#cfe8a8')
    : (_labelRestored ? '#1a0a2a' : '#1a2208');
  const _labelBorderColor = _lightBox ? (_labelRestored ? '#2a0f3a' : '#0f1a05') : null;
  const _labelCheckColor = _lightBox ? '#5a3a7a' : '#9a7ab8';
  // S22: same rule the app's score box uses — the score hit the depth cap and a
  // deeper pass could still raise it. A 100 is already the ceiling, so it never
  // carries one, and neither does an unlocked high-grade run.
  const _labelShowPlus = !!(rg && rg.score != null
    && Math.round(rg.score) >= 90 && Math.round(rg.score) < 100
    && !comic.highGradeUnlocked);
  const _labelCheckHtml = _labelRestoNeg ? `<span style="color:${_labelCheckColor};font-size:9px;font-weight:900;margin-left:2px">\u2713</span>` : '';
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
    const _green = _labelRestored ? _labelScoreColor : (_lightBox ? '#2a4010' : '#b8d820');
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
  // ── PM (PRECISION MODIFIER) REMOVED — S22 ─────────────────────────────────
  // The +/- beside the grade is gone from every surface. What stood here was
  // ~45 lines computing it: a four-tier rule off rg.confidenceRange with mode
  // caps (high-grade <=6, standard <=16), a headroom clamp, and an age-widening
  // hook. The full removed block is kept in _ARCHIVE/PM_REMOVED_S22.md.
  //
  // Two things worth carrying forward about that code specifically:
  //   * widenPrecisionForAge NEVER EXISTED. The call here looked it up on
  //     window.RobograderPanel, which exports only buildDisplay,
  //     buildCardDisplay and pgCell - so the lookup always fell through to the
  //     identity function beside it. The comment above it described, in
  //     detail, a paper-aging behaviour that has never run once.
  //   * this file computed its OWN +/- on the old 0-100 scheme rather than
  //     using the panel's, so the label and the app could disagree about the
  //     same book. That is no longer possible, there being nothing to disagree
  //     about.
  let versionStr = `V${esc((typeof window!=='undefined' && window.RG_GRADING_VERSION) || '4.81')}`;  // APP version, not engine schema
  // Scoring v2 preview (?v2=1): the score box shows the 31-tier grade instead of
  // the 0-100 number. Every numeric use of `score` above already ran; this only
  // changes what prints. Precision (a 0-100-scale ±N) is dropped since it doesn't
  // apply to the tier grade.
  if (window.RG_V3_DISPLAY && window.RoboScoreV3 && comic && comic.type !== 'card' && rg && rg.frontScore != null) {
    // Scoring v3 (?v3=1): half-point grade + PM on the printed label.
    const _v3 = window.RoboScoreV3.forComic(comic);
    if (_v3) { score = window.RoboScoreV3.formatGrade(_v3.grade); }  // keep versionStr = app version (shown at bottom)
  } else if (window.RG_V2_DISPLAY && window.RGScoreV2 && rg) {
    let _v2g = null;
    if (rg.frontScore != null) _v2g = window.RGScoreV2.fromSubscores({ front: rg.frontScore, back: rg.backScore, spine: rg.spineScore, interior: rg.interiorScore }, 'comic').grade;
    else if (rg.score != null) _v2g = window.RGScoreV2.gradeFromScore(rg.score);
    if (_v2g != null) { score = _v2g; }  // keep versionStr = app version
  }
  const title = esc(comic.title || '');
  const issue = comic.issue ? `#${esc(comic.issue)}` : '';
  const issueDate = esc(comic.issueDate || '');
  const printing = comic.printing ? esc(comic.printing) : '';
  // S22: the printing line carries the Key Info after it when the book has
  // any. Key Info is written by the assessment and is routinely a paragraph,
  // so nothing is truncated HERE - the line is clamped and clipped in CSS at
  // the figure's left edge, which is the only place that knows how much room
  // there actually is. Newlines collapse to spaces so a multi-line Key Info
  // cannot force the line box taller than one line.
  const keyInfoRaw = String(comic.keyInfo == null ? '' : comic.keyInfo).replace(/\s+/g, ' ').trim();
  const keyInfo = keyInfoRaw ? esc(keyInfoRaw) : '';
  // ADDED LABEL NOTES - facts about THIS copy, between the printing and the Key
  // Info. A fact about this copy outranks the Key Info (a fact about the issue,
  // true of every copy) and so goes above it. Same wrap-and-clip treatment as
  // the rest of the line; nothing is truncated in JS.
  //
  // v6.26: this used to read comic.notes - the owner's PRIVATE "My Notes"
  // field - and print it on the label and on the public listing line. That is
  // free text on a public surface, which is the user-generated-content
  // exposure the Added Label Notes picker exists to avoid. My Notes is private
  // again and nothing public reads it.
  //
  // addedLabelNotes is a closed vocabulary chosen in Edit; the picker and its
  // list live in index.html (ADDED_LABEL_NOTES). Nothing here validates the
  // strings - a note the picker no longer offers still prints, so dropping an
  // option cannot silently rewrite a book that already carries it.
  const _aln = Array.isArray(comic.addedLabelNotes)
    ? comic.addedLabelNotes.filter(n => typeof n === 'string' && n.trim())
    : [];
  // Added by Robograder, not the user: the Main assessment flags a possible
  // signature and the owner filling a Signature slot confirms it is not a false
  // positive. It says nothing about WHERE the signature is or whether it was
  // witnessed - it may have been; we do not know. (The same string is in
  // index.html as SIGNATURE_LABEL_NOTE, for Detail and the public view.)
  if ((comic.signatureImages || []).some(Boolean)) _aln.push('Signature detected');
  const notesRaw = _aln.join(', ').replace(/\s+/g, ' ').trim();
  const notes = notesRaw ? esc(notesRaw) : '';
  // has-prt (which clamps the title to one line) now keys on this line
  // existing at all, not on the printing alone - a book with Key Info and no
  // printing still spends the row.
  const prtLine = [printing, notes, keyInfo].filter(Boolean).join(', ');

  // ── NUMERAL SIZE: MEASURED, NOT COUNTED ─────────────────────────────────
  // This used to be a .num-3 class - "three or more characters, use the small
  // size" - with a hand-picked px value per size. Two things were wrong with
  // it. Character count is not width: "10" is two characters but two FULL
  // digits, wider than the three characters of "9.5" (a period is about a
  // third of a digit), so "10" took the big size and ran into the (+). And
  // every size's big value was picked once and never re-measured after the
  // layouts moved underneath them.
  //
  // The size now comes from the string's own em width against the box's real
  // interior, which is the same method the price fit uses. A digit is 0.556em
  // in Noto Sans Display and a period 0.28em, measured off rendered glyphs.
  //
  //   interior  the usable width inside the box's border
  //   sx        the horizontal compression that size draws at
  //   max       the VERTICAL ceiling - what the stars above and the version
  //             below allow, measured per size by rasterising the box
  //   plusBudget  the RENDERED width the numeral may occupy when a (+) is
  //               showing. Not "interior minus the (+)": the numeral is CENTRED
  //               and the (+) is pinned right, so what binds is how far the ink
  //               may reach from the centre before it meets the (+). Measured
  //               per size by rasterising the box with a three-glyph score.
  const _NUMFIT = {
    'small':   { interior: 250, sx: 0.78,  max: 204, plusBudget: 128 },  // 212 overlapped the stars
    // v6.36: sx 0.625 -> 0.78 to match Wide. 0.625 squeezed the glyph 25%
    // harder, which thins every stroke - the numeral read as a lighter WEIGHT
    // than Wide's rather than a smaller one. Same compression and face on all
    // three now; only the size differs, which is the only thing that should.
    // The CAPS DO NOT CHANGE. Dropping them to preserve the drawn WIDTH would
    // have shrunk the numeral's HEIGHT by the same 25% - fixing the weight by
    // making the number smaller, which is not what was asked and left 21px of
    // dead air under the stars. Height follows font-size, so the size stays
    // and the glyph simply draws wider: "9.5" at 150px/0.78 is 163px against
    // a 246px interior, and still fits.
    'small-l': { interior: 246, sx: 0.78, max: 150, plusBudget: 112 },
    'square':  { interior: 250, sx: 0.78, max: 172, plusBudget: 102 },
  };
  const _nf = _NUMFIT[opts.size];
  let _numStyle = '';
  if (_nf) {
    const _numEm = String(score).split('').reduce((a, c) => a + (c === '.' ? 0.28 : 0.556), 0);
    const _avail = _labelShowPlus ? _nf.plusBudget : _nf.interior;
    // scaleX only shrinks what is DRAWN, so the unscaled text may be wider than
    // the box by exactly 1/sx and still fit once drawn.
    const _widthCap = Math.floor(_avail / _nf.sx / _numEm);
    _numStyle = 'font-size:' + Math.max(40, Math.min(_nf.max, _widthCap)) + 'px';
  }

  // ── THE SLOT: the figure, or a price in its place ────────────────────────
  // Every comic size has one: a fixed-width column that holds the Robograder
  // figure, or the book's Asking Price when the price toggle is on. It
  // replaces BOTH of the things that used to live there - the old white
  // price-pad (a box around a number, which Matt cut) and the per-size
  // robot-badge - so there is one rule for all of them.
  //
  // Which art depends on the RENDER, not the printer setting in general: mono
  // is a one-ink render on white stock, so it takes the black line version; a
  // colour label takes the painted one. Both files are 500x600, so the fit is
  // identical.
  const _artSrc = opts.mono ? 'assets/Robograder_Line.png' : 'assets/Robograder_Line_Colored.png';
  // Slot width per size, in label pixels. The price is fitted to THIS, so a
  // size with a wider slot gets a bigger price rather than the same one
  // floating in space.
  // v6.25: this is the width the FIGURE actually draws at, not the width of
  // the box it sits in. The asset is 500x600, and `.rg-art img` fits it with
  // object-fit:contain inside a box that is wider than it is tall - so the
  // figure is height-constrained and the box has empty air either side:
  //     small    160 x 184 -> 184 * (500/600) = 153
  //     small-l  230 x 184 -> 153   (77px of the box is empty)
  //     square   230 x 180 -> 150   (80px empty)
  // Sizing the price off the BOX made it 230px wide against a 153px figure,
  // which is what Matt saw: "the price is taking up more than the Robograder
  // watermark's width". The price and the figure are alternates in one slot;
  // they have to occupy the same space or the label changes shape with a
  // toggle.
  const _ART_ASPECT = 500 / 600;
  // v6.40: square 180 -> 184, matching its taller slot (see the .rg-art note).
  const _SLOT_BOX = { 'small': [160, 184], 'square': [230, 184], 'small-l': [230, 184] };
  const _box = _SLOT_BOX[opts.size] || _SLOT_BOX['small'];
  const _slotW = Math.round(Math.min(_box[0], _box[1] * _ART_ASPECT));
  const _askingRaw = comic.askingPrice;
  const _asking = (_askingRaw == null || _askingRaw === '')
    ? null
    : Number(String(_askingRaw).replace(/[^0-9.\-]/g, ''));
  const _priceOn = !!opts.priceTag;
  const _artSlot = (() => {
    // Toggle on with no price set: EMPTY. No figure, no placeholder - clear
    // label to write on, which is what happens at a table when the price is
    // decided in front of the customer.
    if (_priceOn && (_asking == null || !Number.isFinite(_asking) || _asking < 0)) {
      return '<div class="rg-art is-price"></div>';
    }
    if (!_priceOn) return '<div class="rg-art"><img src="' + _artSrc + '" alt=""></div>';
    const n = _asking;
    // Whole numbers lose the decimals; 12.5 becomes 12.50, because a price
    // reading "$12.5" looks like a typo.
    const txt = '$' + (n % 1 === 0 ? String(Math.round(n)) : n.toFixed(2));
    // THE FIT. Every price has to end up the same width, so the size comes from
    // the string's own width rather than its length: a comma and a period are a
    // third of a digit, and sizing on character COUNT makes "$1,250" the same
    // size as "$12345", which it visually is not. Em widths are Noto Sans
    // Display's, measured off rendered glyphs (a digit is 0.556em - the same
    // constant the three-glyph score size uses).
    // v6.25: MEASURED, not guessed. Noto Sans Display 900 via canvas
    // measureText at 100px: every digit AND the dollar sign are 0.558em, and
    // both the period and the comma are 0.274em. The old table had '$' at
    // 0.60 and digits at 0.556 - close enough to look right and wrong enough
    // to matter once the slot got tight.
    const EM = { '.': 0.274, ',': 0.274 };
    const em = txt.split('').reduce((a, c) => a + (EM[c] != null ? EM[c] : 0.558), 0);
    // The ceiling is proportional to the slot, not absolute: it stops a short
    // price coming out taller than the grade beside it.
      // v6.38 - SQUARE'S PRICE IS NO LONGER TIED TO THE WATERMARK'S WIDTH.
    // The price was budgeted at the width the FIGURE draws at, because the two
    // are alternates in one slot and a label should not change shape with a
    // toggle. That reasoning holds for the handled labels. Square is the WALL
    // label - read across a hall, not across a table - and its slot BOX is
    // 230 wide while the figure only draws 150 of it, so 80px was dead air
    // that the price was forbidden from using. 150 x 1.5 = 225 fills the box.
    const _PRICE_W = { 'square': 1.5 };
    const _priceW = Math.round(_slotW * (_PRICE_W[opts.size] || 1));
    // A SHORT price ("$5") is not width-limited at all, so without a second
    // wall it would now draw taller than the slot and run into the QR beneath
    // it. The box's own height is that wall - but THE LINE BOX IS NOT THE
    // INK. v6.38 capped at 0.95 of the slot, reasoning that line-height:1
    // makes the line box the type size. It does, and the GLYPHS overflow it:
    // measured in the harness against the real face, Noto Sans Display 900
    // paints 1.36x its font-size, so "$5" at 171px drew ink from y=292.5 to
    // y=525.5 - over the printing line above it (ink ends 302.6) and down
    // across the meta rule below. Matt reported it as the price "clipping
    // over" the printing text, and said it did not actually overlap. It did.
    // The cap is the INK now, so a painted price always fits its slot.
    const _PRICE_INK = 1.37;   // measured 1.356-1.363; rounded up for margin
    const _priceH = Math.floor(_box[1] / _PRICE_INK);
    const fs = Math.max(16, Math.min(Math.round(_priceW * 0.83), _priceH, Math.floor(_priceW / em)));
    return '<div class="rg-art is-price"><div class="rg-price" style="font-size:' + fs + 'px">' + esc(txt) + '</div></div>';
  })();
  // S22: the line under the title is "<pub date>, <publisher>". Either half can
  // be missing, so the comma only appears when both are present.
  const publisher = esc(comic.publisher || '');
  const issueLine = [issueDate, publisher].filter(Boolean).join(', ');
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
  // v6.22: `rg-any` rides along on EVERY comic label root (Wide, Case, Square,
  // Large). It is the hook for the SHARED block near the top of the stylesheet
  // - anything true of the price, the typography or the score-box interior on
  // all of them is written once against `.rg-any` instead of three times. A
  // variant that genuinely differs overrides it at equal specificity, which
  // works because the shared block is FIRST in source order.
  // The card label (`rg-label-card`) deliberately does NOT get this: it has its
  // own `rgc-*` element vocabulary and shares no selectors with these.
  const wrapClass = baseClass + ' rg-any' + (showPrice ? ' has-price' : '') + (opts.mono ? ' mono' : '')
    + ((isSmallL && _singleMode) ? ' tall' : '');

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
        <div class="ws-id">ID: <b>${gradeId}</b></div>
      </div>
      <div class="fold-guide"></div>
  ` : '';
  // For Small L, the face content lives inside a positioned wrapper so the
  // child element's absolute coords (still anchored at the face's top:0)
  // render correctly within the bottom 288px of the 384px canvas. For all
  // other sizes the face wrapper is omitted and the children sit directly
  // in the label canvas (unchanged behavior).
  // S22: the extra 0.67in of the 4x2 single-label stock. Blank by design.
  const foldBack = (isSmallL && _singleMode) ? '<div class="fold-back"></div>' : '';
  const faceOpen  = isSmallL ? '<div class="face">' : '';
  const faceClose = isSmallL ? '</div>'             : '';

  return `
    <div class="${wrapClass}" data-grade-id="${gradeId}">
      ${foldBack}
      ${smallLWrap}
      ${faceOpen}
      <div class="score-box${_labelShowPlus ? ' has-plus' : ''}"${_labelRestored ? ` style="background:${_labelBgColor}${_labelBorderColor ? `;border-color:${_labelBorderColor}` : ''}"` : ''}>
        <div class="rg-word">ROBOGRADE</div>
        ${_labelTierStars}
        <div class="rg-num-wrap"><span class="rg-num" style="${_numStyle}${_labelRestored ? `;color:${_labelScoreColor}` : ''}">${score}</span>${_labelCheckHtml}</div>
        ${_labelShowPlus ? `<div class="rg-plus"${_labelRestored ? ` style="color:${_labelScoreColor}"` : ''}>(+)</div>` : ''}
        <div class="rg-v">${versionStr}</div>
      </div>
      <div class="info${prtLine ? ' has-prt' : ''}">
        <div class="info-upper">
          <div class="ttl"><span class="ttl-name">${title}</span>${issue ? ` <span class="ttl-iss">${issue}</span>` : ''}</div>
          <div class="iss">${issueLine}</div>
          ${prtLine ? `<div class="prt">${prtLine}</div>` : ''}
        </div>
        <div class="info-lower">
          <div class="meta-grid">
            <span class="meta-lbl">GRADED</span><span class="meta-val">${gradeDate}</span>
            <span class="meta-lbl meta-id-lbl">ROBOGRADER.APP/ ID /</span><span class="meta-val meta-id-val">${gradeId}</span>
          </div>
        </div>
      </div>
      ${_artSlot}
      <div class="qr-col">
        ${comic.publicListing
          ? `<div class="qrc" data-qr-id="${gradeId}"></div>`
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

// ── fitLabelText: snap the printing / Key Info line to WHOLE lines ────────
//
// WHY THIS CANNOT BE CSS. .info-upper is a flex column with a hard ceiling and
// .prt is the only item allowed to shrink, which correctly gives the Key Info
// whatever the title left over. But flex shrinks to an arbitrary number of
// pixels, and overflow:hidden then cuts the last line THROUGH the glyphs -
// a half-height row of letter tops sitting on the rule, which reads as a
// printing fault. CSS has no way to round a height down to a line box.
//
// Two steps, in this order:
//   1. If there is not room for even ONE line of it, the TITLE gives way
//      instead: .squeeze clamps the title to one line and hands ~59px back.
//      The printing and the key fact are not optional; the second line of a
//      long title is.
//   2. Clamp .prt to a whole number of lines, plus its padding-bottom so the
//      descenders on the last visible line survive the cut.
//
// Must run AFTER the label font has loaded - the fallback face has different
// metrics and would snap to the wrong count. Both callers do that.
export function fitLabelText(container) {
  if (!container) return;
  // Every variant, not just Wide. The selector was '.rg-label .info', which is
  // the Wide class alone - so Case and Square carried the same wrapping
  // printing/notes/Key Info line with none of the clamping, and a long one
  // simply ran past whatever was under it.
  container.querySelectorAll('.rg-label .info, .rg-label-l .info, .rg-label-square .info, .rg-label-large .info').forEach(info => {
    const prt = info.querySelector('.prt');
    if (!prt) return;
    prt.style.maxHeight = '';
    info.classList.remove('squeeze');
    // Measure the FULL text, not a previous run's truncation.
    if (prt.hasAttribute('data-full')) prt.textContent = prt.getAttribute('data-full');
    const measure = () => {
      const cs = getComputedStyle(prt);
      const lh = parseFloat(cs.lineHeight);
      const pb = parseFloat(cs.paddingBottom) || 0;
      // clientHeight is the PADDING box, which is also where overflow:hidden
      // cuts. .prt carries no padding-bottom precisely so the two coincide;
      // pb is read anyway so this still holds if one is ever added.
      return { lh: lh, pb: pb, avail: prt.clientHeight - pb };
    };
    let m = measure();
    if (!isFinite(m.lh) || m.lh <= 0) return;
    // v6.37 - NEVER LEAVE A HALF LINE.
    // .prt is `flex: 0 1 auto`, so a title that takes most of the column can
    // shrink it BELOW one line - 23px against a 41.6px line box on Square -
    // and the overflow:hidden then cut straight through the glyphs. A clamp
    // that leaves half a letter row reads as a rendering fault, which is the
    // same reason the ellipsis exists.
    // A floor of one whole line, set before the squeeze is considered: if the
    // column genuinely cannot afford it, squeeze frees the room by tightening
    // the title, which is the thing that should give.
    if (m.avail < m.lh) {
      prt.style.minHeight = m.lh + 'px';
      m = measure();
    } else {
      prt.style.minHeight = '';
    }
    // +0.01 absorbs sub-pixel line heights (1.12 x 28 = 31.36) so a line that
    // exactly fits is not rounded away.
    if (Math.floor(m.avail / m.lh + 0.01) < 1) {
      info.classList.add('squeeze');
      m = measure();
    }
    const lines = Math.max(1, Math.floor(m.avail / m.lh + 0.01));
    // max-height sizes the CONTENT box, so the padding (if any) is added on
    // top of this and the clip lands at lines * lh + pb - the same boundary
    // avail was measured from.
    const _cap = lines * m.lh;
    prt.style.maxHeight = _cap + 'px';

    // ── MARK THE CUT ──────────────────────────────────────────────────────
    // A clamped block that simply stops reads as a rendering fault; an
    // ellipsis reads as a decision. text-overflow cannot do it - it only
    // marks a SINGLE clipped line - so the text is shortened here until it
    // fits with the ellipsis included.
    // Word-at-a-time from the end, not character-at-a-time: a cut mid-word
    // ("First appearance of Spider-M…") looks like damage, where a cut
    // between words looks deliberate. Trailing punctuation goes with the
    // word so it never reads ", …".
    // A plain loop over, at most, the number of words on the line. Binary
    // search would be fewer steps and a worse trade: each step is a reflow,
    // and the loop has to be obviously correct more than it has to be quick.
    if (prt.scrollHeight > _cap + 1) {
      const full = String(prt.getAttribute('data-full') || prt.textContent || '');
      prt.setAttribute('data-full', full);
      const words = full.split(' ');
      for (let n = words.length - 1; n >= 1; n--) {
        prt.textContent = words.slice(0, n).join(' ').replace(/[\s,;:.\-]+$/, '') + '\u2026';
        if (prt.scrollHeight <= _cap + 1) break;
      }
    } else if (prt.hasAttribute('data-full')) {
      // Re-running on a label that was clipped before and now is not - a
      // repaint after the figure moved, say - has to put the text back.
      prt.textContent = prt.getAttribute('data-full');
    }
  });
}

// ── v6.38: NOTHING UNRESOLVED GOES INTO A CAPTURE ──────────────────────────
// Save PDF freezes on 'Generating 1/1...' and comes back on a retry. A hang
// that clears when you try again is a RACE, and there is exactly one race in
// this file: qrcodejs builds a <canvas> synchronously and then, on its own
// setTimeout(0), may replace it with an <img> carrying a data: URL and hide
// the canvas. renderQRsImmediately re-asserts canvas-only across six ticks
// spanning about 400ms - but the capture does not wait for those ticks, it
// waits for the FONTS. When the fonts resolve quickly the capture starts
// first, and if qrcodejs's swap lands after the last re-assertion an <img>
// survives into html2canvas's cloned document, where on iOS its load neither
// completes nor errors. An unsettled promise is not a throw, so nothing is
// catchable and the button sits there.
//
// Guessing at the ordering is what the six ticks already do. This stops
// guessing: run the sweep ONE LAST TIME, synchronously, in the same tick as
// the capture call, after which nothing can be inserted before html2canvas
// reads the DOM.
//
// It also covers the OTHER image on a label - the watermark figure in the art
// slot - which has to be complete, or dropped, for the same reason. A label
// drawn without its watermark is a flaw; a label that never draws is a dead
// button at a convention table.
//
// GUESS, STATED AS ONE: the mechanism above fits every symptom (Square and
// Wide both carry a QR, it clears on retry, it never throws) but it has not
// been reproduced on a device - headless Chromium captures the exact DOM
// qrcodejs produces without complaint, which is why this was not caught
// before. If Save PDF still hangs after this, the next thing to look at is
// the art-slot image, not the QR.
function settleLabelImagesSync(box) {
  if (!box) return;
  try {
    // 1. QR: canvas wins, every time.
    box.querySelectorAll('.qrc').forEach(el => {
      const cv = el.querySelector('canvas');
      if (!cv) return;                       // no canvas: leave what is there
      el.querySelectorAll('img').forEach(im => im.remove());
      cv.style.display = 'block';
    });
    // 2. Any other image that has not finished loading is removed rather than
    //    waited on. naturalWidth is 0 both for 'still loading' and for
    //    'failed', and the capture must not depend on telling them apart.
    box.querySelectorAll('img').forEach(im => {
      if (!im.complete || !im.naturalWidth) {
        console.warn('[label] dropping an unloaded image from the capture:', im.getAttribute('src'));
        im.remove();
      }
    });
  } catch (e) {
    // Never let the guard be the thing that breaks the export.
    console.warn('[label] image settle failed (capturing anyway):', e);
  }
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
    // S22: Wide's code displays at 160 CSS px and is rasterised at 320, then
    // scaled down by the CSS above. A canvas drawn at its display size and then
    // printed at 288 DPI loses module edges, and a QR is nothing but module
    // edges — this is the single cheapest thing that improves scan rate.
    const isWideChest = !isLarge && !isSquare && !!el.closest('.rg-label');
    const qrPx = isLarge ? 178 : isSquare ? 174 : (isWideChest ? 320 : 118);
    new window.QRCode(el, {
      text: `https://robograder.app/id/${id}`,
      width: qrPx, height: qrPx,
      // S22: pure black on pure white for Wide. The old #1a2208 on #d4d9be was
      // tuned to sit on the olive score box; against the orange gradient it
      // costs contrast the code has no need to spend.
      colorDark:  isWideChest ? '#000000' : '#1a2208',
      colorLight: isWideChest ? '#ffffff' : '#d4d9be',
      correctLevel: window.QRCode.CorrectLevel.M
    });
    // S22 — CANVAS ONLY. qrcodejs builds BOTH a <canvas> and an <img>, then on
    // some platforms hides the canvas and shows the img with a base64 data URL
    // (its own iOS/Android branch). html2canvas must then LOAD that image
    // inside its cloned document before it can draw, and on iOS that load is
    // what hung Save PDF: the capture promise never settled, which is not a
    // throw and therefore not catchable - the button just said
    // "Generating 1/1..." forever.
    // Reproduced the exact DOM qrcodejs produces (CANVAS block + IMG display
    // none, then IMG block with a data: URL) in headless Chromium, where it
    // captures fine - so this is platform-specific and cannot be chased from
    // here. Removing the image removes the question: a <canvas> is drawn from
    // its own pixels with nothing to load and nothing to wait for, on every
    // platform. It is also the ONLY image on a Wide label.
    // Runs twice because qrcodejs swaps canvas for img on a 0ms timeout, so
    // the element may not exist yet when this returns.
    // v6.33 - WHY THIS IS A SEQUENCE AND NOT TWO CALLS.
    // qrcodejs builds the canvas synchronously and then, on its own
    // setTimeout(0), may build an <img> from the canvas's data URL and set the
    // canvas to display:none. Two zero-delay timers whose order depends on
    // which was registered first, on a main thread that is busy on the first
    // open of a session. When ours won, qrcodejs hid the canvas immediately
    // afterwards and the code vanished - which is exactly the reported bug:
    // missing on first open, present as soon as any toggle re-rendered the
    // preview, because by then nothing was racing.
    // Re-asserting across several frames makes the outcome independent of that
    // ordering. It stops as soon as it sees a visible canvas and no images,
    // and if a platform produced an img and no canvas it leaves the img alone
    // rather than deleting the only thing on screen.
    const _canvasOnly = () => {
      try {
        const cv = el.querySelector('canvas');
        if (!cv) return false;                 // no canvas: leave whatever is there
        el.querySelectorAll('img').forEach(im => im.remove());
        cv.style.display = 'block';
        return true;
      } catch (e) { return false; }            // never break label rendering over this
    };
    _canvasOnly();
    let _tries = 0;
    const _settle = () => {
      const ok = _canvasOnly();
      if (++_tries >= 6) return;
      // Keep going even once it looks right: the swap we are guarding against
      // happens AFTER a successful pass, not before it.
      setTimeout(_settle, _tries < 3 ? 16 : 120);
      if (!ok && _tries === 1 && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(_canvasOnly);
      }
    };
    setTimeout(_settle, 0);
  });
}
