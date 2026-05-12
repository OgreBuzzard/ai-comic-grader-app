// Robograder — Laser scan animation module (S13 v9 — unified-modal architecture)
// Loaded statically. Plays the chest-cavity scan animation while an
// assessment is in flight, and now also serves as the persistent shell
// that holds onscreen until the user taps COMPLETE on the assessment
// results.
//
// Public API:
//   runScanAnimation(photoUrls, kind?) -> { promise, cancel }
//     photoUrls: array of up to 4 photo URLs in slot order
//       For kind='main' (default):   [front, back, pq, spine]
//       For kind='corner':           [corner-tl, corner-tr, corner-bl, corner-br]
//     Falsy entries are skipped.
//     promise: resolves when the scan-photo sequence completes. The shell
//       REMAINS ONSCREEN after this resolves — it does NOT auto-dismiss.
//       Caller is responsible for calling RobograderScan.dismiss() when
//       the user taps COMPLETE on the results panel.
//     cancel(): aborts the in-flight scan AND tears down the shell.
//       Use this only for hard cancellation (modal exit, errors that
//       should kill the whole flow). Normal flow uses dismiss() at the
//       end instead.
//
//   slideTrackerIntoCavity(html) -> {element}
//     Renders `html` inside the cavity area as an overlay that slides in
//     from the left. Replaces the laser-scan animation visuals. Used to
//     show the 6-step progress tracker while the API call is in flight
//     and after it returns. Returns a reference to the inserted element
//     so the caller can update its contents (e.g. mark steps green).
//
//   slideResultsIntoPanel(html) -> {element}
//     Renders `html` inside the brushed-steel results panel at the bottom
//     of the chest image. Used to show score badges, PQ pill, and the
//     COMPLETE button after assessment completes. Slides up from below.
//
//   dismiss() -> void
//     Tears down the entire shell. Called when the user taps COMPLETE
//     and the assessment has been saved.
//
// Asset dependency: assets/Robograder_Scan_Frame.png (the new tall version,
// 577×1830, with chest face on top and brushed-steel results panel on
// bottom). Cavity coordinates are computed as % of the image.

(function() {
  'use strict';

  // ── Diagnostic logger (S13 v14) ─────────────────────────────────────
  // On-screen debug overlay so we can see what the runtime is actually
  // doing during the assessment animation. Independent of console logs
  // because we can't open DevTools on the phone. Pinned to top-right of
  // viewport, semi-transparent, scrolls if needed.
  //
  // Toggle with window.RobograderScan.setDebug(true|false).
  // S13 v16: defaulted OFF for production. Flip to true to re-enable
  // when debugging the modal flow. The debug code stays in place so
  // we can turn it back on without re-instrumenting everything.
  let _debugEnabled = false;
  let _debugStartTime = 0;
  let _debugPanel = null;

  function debugInit() {
    if (!_debugEnabled) return;
    if (_debugPanel && _debugPanel.parentNode) _debugPanel.remove();
    _debugStartTime = performance.now();
    _debugPanel = document.createElement('div');
    _debugPanel.id = 'rg-debug-panel';
    _debugPanel.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0);right:0;width:240px;max-height:50vh;overflow-y:auto;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:9px;line-height:1.3;padding:6px 8px;z-index:9999;pointer-events:none;border-bottom-left-radius:6px;';
    document.body.appendChild(_debugPanel);
    debugLog('=== DEBUG START ===');
  }

  function debugLog(msg) {
    if (!_debugEnabled || !_debugPanel) return;
    const t = ((performance.now() - _debugStartTime) / 1000).toFixed(2);
    const line = document.createElement('div');
    line.textContent = `[+${t}s] ${msg}`;
    _debugPanel.appendChild(line);
    _debugPanel.scrollTop = _debugPanel.scrollHeight;
  }

  // Inspect an element's computed transform — useful for confirming
  // whether a slide-in animation is firing or stuck. Returns the
  // matrix value as a string or 'none'.
  function debugTransform(el) {
    if (!el) return 'null';
    try {
      const t = window.getComputedStyle(el).transform;
      return t || 'none';
    } catch (e) {
      return 'err:' + e.message;
    }
  }

  function debugCleanup() {
    // Leave the debug panel onscreen even after dismiss so the user can
    // screenshot it. They'll see it disappear when they navigate away.
    // (Or we can remove it explicitly via setDebug(false).)
  }

  function setDebug(enabled) {
    _debugEnabled = !!enabled;
    if (!_debugEnabled && _debugPanel && _debugPanel.parentNode) {
      _debugPanel.remove();
      _debugPanel = null;
    }
  }


  // ── Slot definitions ────────────────────────────────────────────────
  // Index in the photoUrls array MUST match the slot order from the
  // image upload UI: front=0, back=1, interior=2, raking/spine=3.
  // Scan direction is assigned by playback position in runSequence
  // (1st down, 2nd up, 3rd down, 4th up) — photocopier-style alternation.
  // rotate: true on the spine slot triggers the 90° vertical rotation of
  // the captured spine photo so its long dimension fills the cavity height.
  const SLOTS_MAIN = [
    { idx: 0, slotName: 'front',    rotate: false },
    { idx: 1, slotName: 'back',     rotate: false },
    { idx: 2, slotName: 'pq',       rotate: false },
    { idx: 3, slotName: 'spine',    rotate: true  },
  ];
  const SLOTS_CORNER = [
    { idx: 0, slotName: 'corner-tl', rotate: false },
    { idx: 1, slotName: 'corner-tr', rotate: false },
    { idx: 2, slotName: 'corner-bl', rotate: false },
    { idx: 3, slotName: 'corner-br', rotate: false },
  ];

  // ── Region coordinates (% of chest image) ───────────────────────────
  // Measured from the new 577×1830 Robograder_Scan_Frame.png. These
  // numbers are the source of truth for where the cavity (laser-scan
  // display, step tracker) and the results panel (score badges, PQ
  // pill, COMPLETE button) appear on the shell.
  //
  // Cavity window — the metal-framed dark rectangle in the middle of
  // the chest. Holds the laser-scan animation, then the step tracker.
  //   x: 20.8% to 86.7%  (width 65.9%, centered at 53.75%)
  //   y: 38.25% to 75.41% (height 37.16%)
  //
  // Results panel — the brushed-steel area at the bottom of the chest.
  // Holds score badges, PQ pill, and the COMPLETE button.
  //   x: 0% to 100%       (full image width)
  //   y: 86.34% to 100%   (height 13.66%)
  const CAVITY = {
    leftPct:   20.8,
    topPct:    38.25,
    widthPct:  65.9,
    heightPct: 37.16,
  };
  const RESULTS = {
    // S13 v16: brushed-steel band stretched upward by 85px in the chest
    // art (now spans y=1495 to y=1830 in chest image coords). Total
    // panel is now 335px tall (was 250). Gives content room without
    // crowding the COMPLETE button.
    leftPct:   0,
    topPct:    81.69,    // 1495/1830
    widthPct:  100,
    heightPct: 18.31,    // 335/1830
  };
  // S13 v10: Overlay panel — the Progress_Overlay.png artwork
  // S13 v16: shortened from 755px to 747px tall (Matt's update). Top-
  // left position unchanged at chest-image (X=46, Y=684); buttons inside
  // the overlay are at the same percentage positions.
  const OVERLAY = {
    leftPct:   46 / 577 * 100,    //  7.97%
    topPct:    684 / 1830 * 100,  // 37.38%
    widthPct:  474 / 577 * 100,   // 82.15%
    heightPct: 747 / 1830 * 100,  // 40.82%
  };

  // ── Timing (ms) ─────────────────────────────────────────────────────
  // S13 v17: retimed against storyboard.
  //   0:00 → tap Assess Grade. Chest cavity begins sliding up (2000ms).
  //   0:02 → chest landed. 1000ms pause.
  //   0:03 → image1 slides in (500ms). Scan (3000ms). Slide out (500ms).
  //          Sequential, NOT overlapping with image2 slide-in.
  //   0:07 → image2 slides in. (Same per-photo pattern.)
  //   0:11 → image3 slides in.
  //   0:15 → image4 slides in.
  //   0:19 → photo loop ends.
  // Per-photo total: 4000ms (500 in + 3000 scan + 500 out). 4 photos × 4s
  // = 16s. Plus 2s chest + 1s pause + 0s after last photo = 19s, matches
  // the storyboard exactly.
  const CHEST_SLIDE_DELAY  = 200;
  const CHEST_SLIDE_TIME   = 2000;
  const POST_CHEST_PAUSE   = 1000;
  const DISPLAY_FADE_DELAY = 100;
  const SLIDE_DURATION     = 500;   // S13 v17: was 1000 — storyboard calls for 500ms slides
  const SCAN_DURATION      = 3000;  // S13 v17: was 2000 — storyboard scan is 3000ms
  const PAUSE_AFTER_SCAN   = 0;     // S13 v17: was 200 — slide-out runs immediately after scan
  const FIRST_PHOTO_DELAY  = CHEST_SLIDE_DELAY + CHEST_SLIDE_TIME + POST_CHEST_PAUSE;
  const TRACKER_SLIDE_TIME = 2000;  // S13 v17: storyboard calls for 2000ms overlay slide-in
  const RESULTS_SLIDE_TIME = 400;   // results panel slides up from below
  const OVERLAY_SLIDE_TIME = 2000;  // S13 v17: was 600 — overlay slide is now 2000ms from right

  // ── CSS injection ───────────────────────────────────────────────────
  // Self-contained .rg-scan-* prefix avoids any class collision.
  //
  // S13 v11: shell sizing changed from height-fit to width-fit anchored
  // to the bottom of the viewport. Earlier height-fit math (height:
  // 100vh; width: 100vh * 0.3153) made the chest only ~63% of viewport
  // width on iPhone — the cavity ended up tiny and the photo scan looked
  // like a thumbnail in the middle of the screen. The chest's aspect
  // ratio (0.315) is much narrower than a phone viewport (~0.46), so
  // ANY full-image fit would either letterbox horizontally or extend
  // vertically beyond the viewport.
  //
  // Width-fit + bottom-anchor is the right trade-off: the chest fills
  // the viewport horizontally (cavity + results panel render at full
  // useful size), and the head/face extends offscreen above. The user
  // doesn't need to see the head during assessment — what matters is
  // the cavity (laser scan + overlay) and the brushed-steel results
  // panel, both of which now occupy the visible viewport area.
  const STYLES = `
    .rg-scan-stage {
      position: fixed;
      inset: 0;
      background: #000;
      overflow: hidden;
      z-index: 8500;
    }
    .rg-scan-shell {
      position: absolute;
      left: 50%;
      /* Width-fit: chest fills viewport width. Aspect-derived height
         (100vw / 0.3153) is taller than viewport on phones — that's
         intentional. The head extends above viewport top; cavity and
         results panel sit comfortably in the visible area. */
      width: 100vw;
      height: calc(100vw / 0.3153);
      /* Anchor to bottom of viewport. */
      bottom: 0;
      /* S13 v13: switched slide-up from animating bottom to transform
         translateY(). Animating bottom triggers a layout recalculation
         on every frame on iOS Safari, which caused the chest to "pop"
         halfway through the slide instead of moving smoothly. Transform
         is GPU-composited and animates buttery-smooth. The shell starts
         translated DOWN by 100% (so it's positioned a full chest-height
         below its anchor, offscreen below the viewport) and animates to
         translateY(0) which puts it at the anchored bottom. The X
         translation (-50%) for centering must stay in the transform
         throughout — combine into a single transform. */
      transform: translate(-50%, 100%);
      animation: rgShellSlideUp 2s cubic-bezier(0.22, 1, 0.36, 1) 0.2s forwards;
      pointer-events: none;
    }
    @keyframes rgShellSlideUp {
      from { transform: translate(-50%, 100%); }
      to   { transform: translate(-50%, 0);    }
    }

    /* The chest image itself fills the shell. */
    .rg-scan-chest {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    /* Cavity display — where photos slide and lasers scan. Positioned
       as % of the shell so it stays aligned regardless of viewport size.
       During the scan animation, this is where photos appear. After the
       scan completes (and the API has returned), the step tracker slides
       in from the left and covers this area. */
    .rg-scan-display {
      position: absolute;
      left:   ${CAVITY.leftPct}%;
      top:    ${CAVITY.topPct}%;
      width:  ${CAVITY.widthPct}%;
      height: ${CAVITY.heightPct}%;
      overflow: hidden;
      opacity: 0;
      /* S13 v17: chest slide is now 2000ms starting at 200ms, so it
         lands at 2200ms. Display fades in just after chest arrives, so
         the cavity is visible during the 1s pre-photo-1 pause. */
      animation: rgScanFadeIn 0.3s ease-out 2.3s forwards;
      pointer-events: none;
    }
    @keyframes rgScanFadeIn { to { opacity: 1; } }

    .rg-scan-photo {
      position: absolute;
      /* S13 v12: cap photo at 80% of cavity dimensions, centered. With
         the bottom-anchored width-fit chest, the cavity now renders much
         larger (~460px tall on iPhone 14) than under the previous height-
         fit math (~313px). Photos filling 100% of that felt visually
         oversized — they dominated the screen. The 80% cap leaves a
         margin around the photo so it sits within the cavity rather
      /* S13 v13: cap further reduced from 80% to 60% of cavity. The
         80% cap from v12 was an improvement but still left photos
         dominating the screen on phones — the cavity itself is large
         (~390×460 on iPhone 14). 60% gives ~234×276 photo area, which
         reads as a "preview" rather than overwhelming the chest. */
      left: 20%; top: 20%;
      width: 60%; height: 60%;
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
      transform: translateX(-110%);
      transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .rg-scan-photo.in-view  { transform: translateX(0);    }
    .rg-scan-photo.out-view { transform: translateX(110%); }
    .rg-scan-photo.reset    {
      transition: none !important;
      transform: translateX(-110%) !important;
    }

    /* Spine photo rotation — captured spine photos are landscape (the
       spine runs along the long edge of the captured image). To display
       it as a vertical strip reading top-to-bottom, rotate -90°
       (counter-clockwise). The .rg-scan-photo parent is now ~60% × 60%
       of cavity (roughly square), so the rotated image fits naturally
       inside without complex pre-rotation sizing math.
       S13 v13: simplified after multiple wrong-direction iterations.
       Using -90deg (CCW) which is the standard for spine display. */
    .rg-scan-photo.is-spine {
      background-image: none !important;
    }
    .rg-scan-photo-img {
      position: absolute;
      top: 50%;
      left: 50%;
      width:  100%;
      height: 100%;
      object-fit: contain;
      object-position: center;
      transform: translate(-50%, -50%);
    }
    .rg-scan-photo-img.rotated {
      /* The parent container is roughly square (60% × 60% of cavity).
         For a landscape source image, swapping pre-rotation dimensions
         lets the contained image fill the parent's "long edge" after
         rotation. Since the parent is square-ish, the practical effect
         is just a -90° rotation of a contain-fit image. */
      width:  100%;
      height: 100%;
      transform: translate(-50%, -50%) rotate(-90deg);
    }

    .rg-scan-laser {
      position: absolute;
      pointer-events: none;
      opacity: 0;
      z-index: 11;
    }
    .rg-scan-laser.active { opacity: 1; }
    .rg-scan-laser.horizontal {
      left: -5%;
      width: 110%;
      height: 4px;
      background: linear-gradient(to right,
        rgba(83, 179, 230, 0)   0%,
        rgba(83, 179, 230, 0.6) 15%,
        rgba(255, 255, 255, 1)  50%,
        rgba(83, 179, 230, 0.6) 85%,
        rgba(83, 179, 230, 0)   100%);
      box-shadow:
        0 0 8px  rgba(83, 179, 230, 0.9),
        0 0 16px rgba(83, 179, 230, 0.7),
        0 0 32px rgba(83, 179, 230, 0.4);
    }
    .rg-scan-laser.vertical {
      top: -5%;
      height: 110%;
      width: 4px;
      background: linear-gradient(to bottom,
        rgba(83, 179, 230, 0)   0%,
        rgba(83, 179, 230, 0.6) 15%,
        rgba(255, 255, 255, 1)  50%,
        rgba(83, 179, 230, 0.6) 85%,
        rgba(83, 179, 230, 0)   100%);
      box-shadow:
        0 0 8px  rgba(83, 179, 230, 0.9),
        0 0 16px rgba(83, 179, 230, 0.7),
        0 0 32px rgba(83, 179, 230, 0.4);
    }
    @keyframes rgScanFlicker {
      0% {
        box-shadow:
          0 0 8px  rgba(83, 179, 230, 0.9),
          0 0 16px rgba(83, 179, 230, 0.7),
          0 0 32px rgba(83, 179, 230, 0.4);
        filter: brightness(1);
      }
      100% {
        box-shadow:
          0 0 12px rgba(150, 210, 240, 1),
          0 0 24px rgba(83, 179, 230, 0.95),
          0 0 48px rgba(83, 179, 230, 0.6);
        filter: brightness(1.3);
      }
    }
    @keyframes rgScanDown  { from { top: 0%;   } to { top: 100%;  } }
    @keyframes rgScanUp    { from { top: 100%; } to { top: 0%;    } }
    @keyframes rgScanRight { from { left: 0%;  } to { left: 100%; } }
    @keyframes rgScanLeft  { from { left: 100%;} to { left: 0%;   } }
    .rg-scan-laser.scan-down  { animation: rgScanDown  3s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-up    { animation: rgScanUp    3s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-right { animation: rgScanRight 3s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-left  { animation: rgScanLeft  3s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }

    /* Step tracker overlay — slides into the cavity from the left after
       the laser-scan completes. Same coordinates as .rg-scan-display
       (it's a sibling that takes over the same physical region). */
    .rg-scan-tracker {
      position: absolute;
      left:   ${CAVITY.leftPct}%;
      top:    ${CAVITY.topPct}%;
      width:  ${CAVITY.widthPct}%;
      height: ${CAVITY.heightPct}%;
      overflow: hidden;
      transform: translateX(-110%);
      transition: transform ${TRACKER_SLIDE_TIME}ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      z-index: 12;
    }
    .rg-scan-tracker.in-view {
      transform: translateX(0);
    }

    /* Results panel — appears at the bottom of the chest in the brushed-
       steel area. Slides UP from below to enter. S13 v13: switched to
       @keyframes for the same iOS reliability reason as the overlay. */
    .rg-scan-results {
      position: absolute;
      left:   ${RESULTS.leftPct}%;
      top:    ${RESULTS.topPct}%;
      width:  ${RESULTS.widthPct}%;
      height: ${RESULTS.heightPct}%;
      overflow: hidden;
      transform: translateY(110%);
      pointer-events: auto;
      z-index: 13;
    }
    .rg-scan-results.slide-in {
      animation: rgResultsSlideUp ${RESULTS_SLIDE_TIME}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes rgResultsSlideUp {
      from { transform: translateY(110%); }
      to   { transform: translateY(0);    }
    }

    /* Step boxes layer — siblings of the overlay, positioned at the same
       bounding box, but BEHIND the overlay (lower z-index). The overlay
       PNG has alpha-carved holes where the buttons should appear; the box
       PNGs (default/success/failure) live in this layer at the carved
       positions and show through those holes. Boxes are 100% opaque so
       the overlay's baked-in step text stays readable.
       Slides in from the left in lockstep with the overlay.
       S13 v15: added initial transform: translateX(-110%) so the boxes
       don't flash visible at their final position before the @keyframes
       animation starts. Without this, there was a one-frame gap between
       DOM append and class-add where the boxes rendered at translateX(0)
       briefly. */
    .rg-scan-boxes {
      position: absolute;
      left:   ${OVERLAY.leftPct}%;
      top:    ${OVERLAY.topPct}%;
      width:  ${OVERLAY.widthPct}%;
      height: ${OVERLAY.heightPct}%;
      overflow: visible;
      /* S13 v17: slide IN from the RIGHT (per storyboard frame 12).
         Earlier versions slid in from the left; new design slides from
         right. Initial transform is translateX(+110%) so the element
         starts off-screen to the right and animates to translateX(0). */
      transform: translateX(110%);
      pointer-events: none;
      z-index: 13;
    }
    .rg-scan-boxes.slide-in {
      animation: rgOverlaySlideIn ${OVERLAY_SLIDE_TIME}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    /* Overlay panel — the Progress_Overlay.png artwork. Sits ABOVE the
       boxes layer; carved-out alpha holes in the overlay artwork let the
       box PNGs show through. The overlay holds the step text (baked into
       the artwork), the green chest panel, screws, the 4×4 light grid,
       and the gauge. S13 v13: switched from CSS transition + class-toggle
       to @keyframes animation. iOS Safari was inconsistent about applying
       transform transitions when the element was added and mutated in
       the same paint frame; @keyframes runs reliably because it doesn't
       depend on a state-change observation.
       S13 v17: slide direction flipped from left to right. */
    .rg-scan-overlay {
      position: absolute;
      left:   ${OVERLAY.leftPct}%;
      top:    ${OVERLAY.topPct}%;
      width:  ${OVERLAY.widthPct}%;
      height: ${OVERLAY.heightPct}%;
      overflow: visible;
      transform: translateX(110%);
      pointer-events: auto;
      z-index: 14;
    }
    .rg-scan-overlay.slide-in {
      animation: rgOverlaySlideIn ${OVERLAY_SLIDE_TIME}ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes rgOverlaySlideIn {
      from { transform: translateX(110%); }
      to   { transform: translateX(0);    }
    }

    /* S13 v17: 4×4 light grid — 8 frames cycling at 250ms. Positioned
       inside the overlay at X=57, Y=91 (overlay bounding box 474×755),
       160×160 px. Active during Phase D (overlay arrival through end
       of progress buttons); stopped at start of Phase E (score reveal).
       Position is set in percentages so it scales with the overlay. */
    .rg-scan-grid {
      position: absolute;
      left:   12.03%;     /* 57/474 */
      top:    12.05%;     /*  91/755 */
      width:  33.76%;     /* 160/474 */
      height: 21.19%;     /* 160/755 */
      pointer-events: none;
      z-index: 1;
    }
    .rg-scan-grid img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      opacity: 0;
    }
    .rg-scan-grid img.active {
      opacity: 1;
    }

    /* S13 v17: Red needle. Single PNG, CSS-rotated. Pivot at
       bottom-center of the needle (transform-origin: 50% 100%). Needle
       PNG is 11px wide and tall — sized as % of overlay so it scales
       with the chest. Positioned so the pivot point is at X=330, Y=190
       within the 474×755 overlay (left=69.62%, top=25.17%).
       The visible needle extends UP from the pivot. We give the element
       a height equal to the needle's visible length and anchor its
       bottom at the pivot; the PNG fills that box (object-fit:contain)
       so rotation visually swings the needle's tip.
       Off / score 0  → rotate(-48deg)
       Score 50       → rotate(0deg)
       Score 100      → rotate(+48deg)
       Default starting position: -48deg (off).
       Animation during Phase D: sine pulse, 1s per cycle, varying
       amplitudes (driven by JS via setting --rg-needle-rot per frame).
       Phase E: smoothly transitions to its final score-derived angle. */
    .rg-scan-needle-wrap {
      position: absolute;
      /* The wrap is anchored so its bottom-center is at the pivot. We
         draw a box that extends UPWARD from the pivot. The needle PNG
         is ~140px tall in the artwork's coordinates (visually scaled),
         which is 18.54% of the 755-tall overlay. */
      left:   69.62%;     /* 330/474 — pivot X */
      top:    25.17%;     /* 190/755 — pivot Y (bottom of wrap) */
      width:  2.32%;      /*  11/474 */
      height: 18.54%;     /* 140/755 — needle visible length */
      transform: translate(-50%, -100%) rotate(var(--rg-needle-rot, -48deg));
      transform-origin: 50% 100%;
      transition: transform 200ms ease-out;
      pointer-events: none;
      z-index: 2;
    }
    .rg-scan-needle-wrap img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      object-position: bottom center;
      pointer-events: none;
    }
    /* During Phase E the needle does a single smooth sweep to its
       final angle. Class .final-sweep extends the transition duration. */
    .rg-scan-needle-wrap.final-sweep {
      transition: transform 2000ms cubic-bezier(0.22, 1, 0.36, 1);
    }
  `;

  let _stylesInjected = false;
  function injectStyles() {
    if (_stylesInjected) return;
    const style = document.createElement('style');
    style.id = 'rg-scan-animation-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
    _stylesInjected = true;
  }

  // ── DOM construction ────────────────────────────────────────────────
  function buildDom(activeSlots) {
    const stage = document.createElement('div');
    stage.className = 'rg-scan-stage';
    stage.id = 'rg-scan-stage';

    const shell = document.createElement('div');
    shell.className = 'rg-scan-shell';
    shell.id = 'rg-scan-shell';

    const chest = document.createElement('img');
    chest.className = 'rg-scan-chest';
    chest.src = 'assets/Robograder_Scan_Frame.png';
    chest.alt = '';
    shell.appendChild(chest);

    const display = document.createElement('div');
    display.className = 'rg-scan-display';
    display.id = 'rg-scan-display';

    activeSlots.forEach(slot => {
      const photo = document.createElement('div');
      photo.className = 'rg-scan-photo';
      photo.id = 'rg-scan-photo-' + slot.slotName;
      if (slot.rotate) {
        photo.classList.add('is-spine');
        const img = document.createElement('img');
        img.className = 'rg-scan-photo-img rotated';
        img.src = slot.url;
        img.alt = '';
        photo.appendChild(img);
      } else {
        photo.style.backgroundImage = `url('${escapeUrl(slot.url)}')`;
      }
      display.appendChild(photo);
    });

    const laserH = document.createElement('div');
    laserH.className = 'rg-scan-laser horizontal';
    laserH.id = 'rg-scan-laser-h';
    display.appendChild(laserH);
    const laserV = document.createElement('div');
    laserV.className = 'rg-scan-laser vertical';
    laserV.id = 'rg-scan-laser-v';
    display.appendChild(laserV);

    shell.appendChild(display);
    stage.appendChild(shell);
    document.body.appendChild(stage);
    return stage;
  }

  function escapeUrl(url) {
    return String(url).replace(/'/g, "%27");
  }

  // ── Animation orchestration ────────────────────────────────────────
  function wait(ms, cancelToken) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cancelToken._timers.delete(t);
        if (cancelToken.cancelled) reject(new Error('cancelled'));
        else resolve();
      }, ms);
      cancelToken._timers.add(t);
    });
  }

  async function scanPhoto(slot, scanDir, cancelToken) {
    if (cancelToken.cancelled) throw new Error('cancelled');
    debugLog(`scanPhoto start: ${slot.slotName} dir=${scanDir}`);
    const photoEl = document.getElementById('rg-scan-photo-' + slot.slotName);
    if (!photoEl) {
      debugLog(`  ⚠ photo element missing: ${slot.slotName}`);
      return;
    }

    const isVerticalScan = scanDir === 'down' || scanDir === 'up';
    const laser = document.getElementById(isVerticalScan ? 'rg-scan-laser-h' : 'rg-scan-laser-v');

    photoEl.classList.add('in-view');
    debugLog(`  ${slot.slotName}: in-view added, transform=${debugTransform(photoEl).substring(0,30)}`);
    await wait(SLIDE_DURATION, cancelToken);

    laser.classList.add('active', 'scan-' + scanDir);
    await wait(SCAN_DURATION, cancelToken);
    laser.classList.remove('scan-' + scanDir, 'active');
    await wait(PAUSE_AFTER_SCAN, cancelToken);

    photoEl.classList.remove('in-view');
    photoEl.classList.add('out-view');
    debugLog(`  ${slot.slotName}: out-view added, transform=${debugTransform(photoEl).substring(0,30)}`);
    await wait(SLIDE_DURATION, cancelToken);

    photoEl.classList.remove('out-view');
    photoEl.classList.add('reset');
    photoEl.offsetHeight;  // force reflow
    requestAnimationFrame(() => {
      if (!cancelToken.cancelled) {
        photoEl.classList.remove('reset');
      }
    });
    debugLog(`  ${slot.slotName}: scan done`);
  }

  async function runSequence(activeSlots, cancelToken) {
    debugLog(`runSequence start, waiting FIRST_PHOTO_DELAY=${FIRST_PHOTO_DELAY}ms`);
    await wait(FIRST_PHOTO_DELAY, cancelToken);
    debugLog('first photo delay elapsed, starting photo loop');
    for (let i = 0; i < activeSlots.length; i++) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      const scanDir = (i % 2 === 0) ? 'down' : 'up';
      await scanPhoto(activeSlots[i], scanDir, cancelToken);
    }
    debugLog('runSequence done');
  }

  // ── Public lifecycle ────────────────────────────────────────────────
  // Held state for the active session.
  let _activeStage = null;
  let _activeCancelToken = null;

  function teardown() {
    // S13 v17: stop grid + needle animation timers so they don't run
    // against a torn-down DOM.
    stopGridCycle();
    stopNeedlePulse();
    if (_activeStage && _activeStage.parentNode) {
      _activeStage.parentNode.removeChild(_activeStage);
    }
    _activeStage = null;
    _activeCancelToken = null;
  }

  function dismiss() {
    debugLog('dismiss called');
    teardown();
  }

  // Slide a step-tracker overlay into the cavity from the left. Replaces
  // (visually) the laser-scan display, which fades out as the tracker
  // covers it. Returns the element so the caller can update its contents.
  function slideTrackerIntoCavity(html) {
    if (!_activeStage) return null;
    const shell = _activeStage.querySelector('.rg-scan-shell');
    if (!shell) return null;

    // Remove any existing tracker (safety; this should be called once)
    const existing = shell.querySelector('.rg-scan-tracker');
    if (existing) existing.remove();

    const tracker = document.createElement('div');
    tracker.className = 'rg-scan-tracker';
    tracker.id = 'rg-scan-tracker';
    tracker.innerHTML = html;
    shell.appendChild(tracker);

    // Force reflow so the initial off-screen transform is applied before
    // we add the in-view class (which triggers the slide-in transition).
    tracker.offsetHeight;
    requestAnimationFrame(() => {
      tracker.classList.add('in-view');
    });

    // Fade out the laser-scan display under the tracker.
    const display = shell.querySelector('.rg-scan-display');
    if (display) {
      display.style.transition = 'opacity 300ms ease-out';
      display.style.opacity = '0';
    }

    return tracker;
  }

  // Slide a results panel up from the bottom into the brushed-steel area.
  // Returns the element so the caller can populate or update it.
  // S13 v13: uses @keyframes animation (slide-in class) for iOS
  // reliability; same reason as the overlay change.
  function slideResultsIntoPanel(html) {
    debugLog(`slideResultsIntoPanel called, htmlLen=${(html||'').length}`);
    if (!_activeStage) {
      debugLog('  ⚠ no active stage');
      return null;
    }
    const shell = _activeStage.querySelector('.rg-scan-shell');
    if (!shell) {
      debugLog('  ⚠ no shell');
      return null;
    }

    const existing = shell.querySelector('.rg-scan-results');
    if (existing) existing.remove();

    const results = document.createElement('div');
    results.className = 'rg-scan-results';
    results.id = 'rg-scan-results';
    results.innerHTML = html;
    shell.appendChild(results);
    debugLog(`  results appended, transform=${debugTransform(results).substring(0,30)}`);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        results.classList.add('slide-in');
        debugLog('  slide-in class added (rAF×2)');
        setTimeout(() => {
          debugLog(`  results transform @+50ms: ${debugTransform(results).substring(0,40)}`);
        }, 50);
        setTimeout(() => {
          debugLog(`  results transform @+500ms: ${debugTransform(results).substring(0,40)}`);
        }, 500);
      });
    });

    return results;
  }

  // Slide the Progress_Overlay artwork in from the left, positioned at
  // chest-image (X=46, Y=684) per Matt's spec. Mount also includes a
  // step-boxes layer that sits BEHIND the overlay (lower z-index).
  //
  // The caller passes html (the overlay's inner HTML) and an optional
  // boxesHtml (the inner HTML of the boxes layer). The boxes are
  // siblings of the overlay (peer DOM elements in the shell), not
  // children. Both share the same bounding box (OVERLAY coordinates),
  // and both slide-in together via the same @keyframes animation
  // applied to both elements simultaneously.
  //
  // S13 v13: switched from class-toggle CSS transition to @keyframes
  // animation. The previous approach was unreliable on iOS Safari —
  // the transform transition wouldn't fire when the element was added
  // to the DOM and the in-view class added in the same paint frame,
  // even with a forced reflow + rAF. @keyframes runs reliably because
  // the animation is triggered when the class is present at attachment
  // time, not when the class transitions.
  function slideOverlayIntoChest(html, boxesHtml) {
    debugLog(`slideOverlayIntoChest called, htmlLen=${(html||'').length}, boxesLen=${(boxesHtml||'').length}`);
    if (!_activeStage) {
      debugLog('  ⚠ no active stage, aborting');
      return null;
    }
    const shell = _activeStage.querySelector('.rg-scan-shell');
    if (!shell) {
      debugLog('  ⚠ no shell element, aborting');
      return null;
    }

    const existingOverlay = shell.querySelector('.rg-scan-overlay');
    if (existingOverlay) existingOverlay.remove();
    const existingBoxes = shell.querySelector('.rg-scan-boxes');
    if (existingBoxes) existingBoxes.remove();

    // Stop any prior grid cycle (in case overlay is remounted)
    stopGridCycle();

    // Boxes layer FIRST (lower z-index) — opaque step boxes show through
    // alpha-carved holes in the overlay.
    const boxes = document.createElement('div');
    boxes.className = 'rg-scan-boxes';
    boxes.id = 'rg-scan-boxes';
    if (boxesHtml) boxes.innerHTML = boxesHtml;
    shell.appendChild(boxes);
    debugLog(`  boxes appended, transform=${debugTransform(boxes).substring(0,30)}`);

    // Overlay layer SECOND (higher z-index) — the artwork PNG with
    // baked-in step text. S13 v17: we also inject the cycling grid
    // frames and the rotating needle as children of the overlay so they
    // ride along with the slide-in animation.
    const overlay = document.createElement('div');
    overlay.className = 'rg-scan-overlay';
    overlay.id = 'rg-scan-overlay';
    overlay.innerHTML = html + buildGridHtml() + buildNeedleHtml();
    shell.appendChild(overlay);
    debugLog(`  overlay appended, transform=${debugTransform(overlay).substring(0,30)}`);

    // Trigger the slide-in @keyframes animation by adding the slide-in
    // class to BOTH elements. They animate in lockstep because they
    // share the same keyframes definition.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        boxes.classList.add('slide-in');
        overlay.classList.add('slide-in');
        debugLog('  slide-in class added (rAF×2)');
        // Sample transform 50ms in to confirm animation is running
        setTimeout(() => {
          debugLog(`  overlay transform @+50ms: ${debugTransform(overlay).substring(0,40)}`);
        }, 50);
        setTimeout(() => {
          debugLog(`  overlay transform @+700ms: ${debugTransform(overlay).substring(0,40)}`);
        }, 700);
      });
    });

    // Fade out the laser-scan display under the overlay.
    const display = shell.querySelector('.rg-scan-display');
    if (display) {
      display.style.transition = 'opacity 300ms ease-out';
      display.style.opacity = '0';
    }

    return overlay;
  }

  // ── S13 v17: 4×4 light grid (8-frame cycle) ─────────────────────────
  // Builds the DOM for the grid — 8 stacked <img> elements, all
  // absolutely positioned and overlapping. Active frame's <img> gets
  // class 'active' (opacity 1); others stay opacity 0. We cycle the
  // active class via a setInterval; the DOM stays static once built.
  function buildGridHtml() {
    let html = '<div class="rg-scan-grid" id="rg-scan-grid">';
    for (let i = 1; i <= 8; i++) {
      const idx = String(i).padStart(2, '0');
      // S13 v17: PNG extension preserved as Matt uploaded the files
      // (frame_01.PNG ... frame_08.PNG). Linux file systems are case-
      // sensitive on Vercel; if Matt's files are .png lowercase this
      // line is the one to change.
      html += `<img src="assets/modal/frame_${idx}.PNG" alt="" class="${i === 1 ? 'active' : ''}" />`;
    }
    html += '</div>';
    return html;
  }

  let _gridCycleTimer = null;
  let _gridCycleIdx = 0;
  function startGridCycle() {
    if (_gridCycleTimer) return; // already running
    const grid = document.getElementById('rg-scan-grid');
    if (!grid) {
      debugLog('  ⚠ startGridCycle: grid element not found');
      return;
    }
    const imgs = grid.querySelectorAll('img');
    if (imgs.length === 0) return;
    debugLog('grid cycle started');
    _gridCycleIdx = 0;
    _gridCycleTimer = setInterval(() => {
      imgs.forEach(img => img.classList.remove('active'));
      _gridCycleIdx = (_gridCycleIdx + 1) % imgs.length;
      imgs[_gridCycleIdx].classList.add('active');
    }, 250);
  }
  function stopGridCycle() {
    if (_gridCycleTimer) {
      clearInterval(_gridCycleTimer);
      _gridCycleTimer = null;
      debugLog('grid cycle stopped');
    }
  }

  // ── S13 v17: Red needle ─────────────────────────────────────────────
  // Single PNG, CSS-rotated via --rg-needle-rot. Pulses during Phase D
  // (driven by JS sine wave at varying amplitudes), then sweeps to its
  // final score-derived angle during Phase E.
  function buildNeedleHtml() {
    return `<div class="rg-scan-needle-wrap" id="rg-scan-needle">
      <img src="assets/modal/Red_Needle.png" alt="" />
    </div>`;
  }

  // Map score 0..100 to angle -48..+48 degrees. Score is clamped.
  function _scoreToAngle(score) {
    const s = Math.max(0, Math.min(100, Number(score) || 0));
    return -48 + (s / 100) * 96;
  }
  // Set the needle angle directly (instant), in degrees. Useful for the
  // off / starting state and for testing.
  function setNeedleAngle(degrees) {
    const el = document.getElementById('rg-scan-needle');
    if (!el) return;
    el.style.setProperty('--rg-needle-rot', `${degrees}deg`);
  }

  // Pulse animation: oscillates the needle around 0deg with varying
  // amplitudes, one full pulse per ~1 second. The driver is JS, not CSS,
  // so we can vary amplitude per pulse for a more organic feel.
  let _needlePulseTimer = null;
  let _needlePulseStart = 0;
  let _needleCurrentAmp = 25;  // current pulse amplitude (degrees)
  function startNeedlePulse() {
    if (_needlePulseTimer) return; // already pulsing
    const el = document.getElementById('rg-scan-needle');
    if (!el) {
      debugLog('  ⚠ startNeedlePulse: needle element not found');
      return;
    }
    debugLog('needle pulse started');
    _needlePulseStart = performance.now();
    _needleCurrentAmp = 25 + Math.random() * 20; // 25..45 deg first pulse
    // Use a 33ms tick (~30fps) so the sine motion is smooth; transition
    // CSS smooths between ticks. Phase: 0..1 over 1s; sin(phase*2π) gives
    // a full +→0→-→0 cycle. After each 1s cycle, randomize amplitude.
    _needlePulseTimer = setInterval(() => {
      const now = performance.now();
      const phase = ((now - _needlePulseStart) % 1000) / 1000;
      if (phase < 0.05 && (now - _needlePulseStart) > 100) {
        // New pulse starting — vary amplitude
        _needleCurrentAmp = 15 + Math.random() * 35; // 15..50 deg
      }
      const angle = Math.sin(phase * 2 * Math.PI) * _needleCurrentAmp;
      el.style.setProperty('--rg-needle-rot', `${angle}deg`);
    }, 33);
  }
  function stopNeedlePulse() {
    if (_needlePulseTimer) {
      clearInterval(_needlePulseTimer);
      _needlePulseTimer = null;
      debugLog('needle pulse stopped');
    }
  }

  // Phase E: smoothly sweep the needle to its final score-derived angle.
  // Caller passes the final score (0..100). Uses CSS transition for a
  // single smooth sweep. Does NOT stop the pulse — caller must call
  // stopNeedlePulse() first or the pulse will immediately resume
  // overwriting the angle.
  function sweepNeedleToScore(score) {
    const el = document.getElementById('rg-scan-needle');
    if (!el) return;
    el.classList.add('final-sweep');
    const angle = _scoreToAngle(score);
    el.style.setProperty('--rg-needle-rot', `${angle}deg`);
    debugLog(`needle sweep → score ${score} → ${angle.toFixed(1)}deg`);
  }

  // ── Public API ─────────────────────────────────────────────────────
  // photoUrls: flat array of up to 4 URLs in slot order.
  // kind:      'main' (default) or 'corner'. Selects which slot table.
  function runScanAnimation(photoUrls, kind) {
    debugInit();
    debugLog(`runScanAnimation called: kind=${kind||'main'}, photos=${(photoUrls||[]).filter(Boolean).length}`);
    injectStyles();

    // Defensive: if a previous shell wasn't dismissed (e.g. error path),
    // tear it down before starting a fresh one.
    if (_activeStage) {
      debugLog('teardown previous shell');
      teardown();
    }

    const slotTable = (kind === 'corner') ? SLOTS_CORNER : SLOTS_MAIN;

    const activeSlots = slotTable
      .filter(s => photoUrls && photoUrls[s.idx])
      .map(s => ({ ...s, url: photoUrls[s.idx] }));

    debugLog(`activeSlots: [${activeSlots.map(s => s.slotName).join(',')}]`);

    // Edge case: no photos. Build the shell anyway so the persistent
    // mode works for callers that wanted the shell up regardless. The
    // promise resolves immediately because there's nothing to scan.
    _activeStage = buildDom(activeSlots);
    debugLog('shell mounted to DOM');

    // After mount, log what the shell's transform is. If iOS isn't
    // honoring our keyframe animation we'll see the transform stuck at
    // matrix(...,100%,...) → didn't move.
    setTimeout(() => {
      const shell = document.querySelector('.rg-scan-shell');
      debugLog(`shell transform @100ms: ${debugTransform(shell).substring(0,40)}`);
    }, 100);
    setTimeout(() => {
      const shell = document.querySelector('.rg-scan-shell');
      debugLog(`shell transform @1500ms: ${debugTransform(shell).substring(0,40)}`);
    }, 1500);
    setTimeout(() => {
      const shell = document.querySelector('.rg-scan-shell');
      debugLog(`shell transform @3500ms: ${debugTransform(shell).substring(0,40)}`);
    }, 3500);

    const cancelToken = {
      cancelled: false,
      _timers: new Set()
    };
    _activeCancelToken = cancelToken;

    // The scan sequence (when there are photos to scan).
    let promise;
    if (activeSlots.length === 0) {
      promise = Promise.resolve();
    } else {
      promise = runSequence(activeSlots, cancelToken)
        .catch(err => {
          // S13 v9: do NOT teardown on success — the shell persists until
          // dismiss() is called. Teardown on cancel/error only.
          if (err.message === 'cancelled') {
            debugLog('scan cancelled');
            return;
          }
          // Unexpected error — tear down to avoid leaving the shell stuck.
          debugLog(`scan error: ${err.message}`);
          teardown();
          throw err;
        });
    }

    return {
      promise,
      cancel: () => {
        debugLog('cancel called externally');
        cancelToken.cancelled = true;
        cancelToken._timers.forEach(t => clearTimeout(t));
        cancelToken._timers.clear();
        teardown();
      }
    };
  }

  // Expose
  window.RobograderScan = {
    runScanAnimation,
    slideTrackerIntoCavity,
    slideOverlayIntoChest,
    slideResultsIntoPanel,
    dismiss,
    setDebug,
    debugLog,  // exposed so index.html can log mountStepTracker, setStep, etc.
    // S13 v17: grid + needle control
    startGridCycle,
    stopGridCycle,
    startNeedlePulse,
    stopNeedlePulse,
    sweepNeedleToScore,
    setNeedleAngle,
    // Constants exposed for caller diagnostics / testing
    _CAVITY: CAVITY,
    _OVERLAY: OVERLAY,
    _RESULTS: RESULTS,
  };
})();
