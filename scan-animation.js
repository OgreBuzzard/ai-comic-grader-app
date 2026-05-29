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
  // S13 v22 (May 13): debug OFF for production. v21 testing identified
  // the refinement pass in assess.js as the source of the long pause
  // between scan-complete and step buttons cycling green. With that
  // pass disabled, the freeze should be gone. Re-enable via
  // window.RobograderScan.setDebug(true) in console if anything else
  // needs diagnosis.
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
  // S13 v18: full retiming for the persistent-results-panel architecture.
  //   0:00 → tap Assess Grade.
  //   0:00.2 → chest cavity AND results panel begin sliding up together
  //            (2000ms ease-in-out).
  //   0:02.2 → chest landed. Results panel landed too. 1000ms pause.
  //   0:03.2 → photo 1 slides in (500ms ease-in-out)
  //            scan (2500ms down) — S15 May 29: was 3000ms
  //            slide out (500ms ease-in-out)
  //   0:06.7 → photo 2 starts. Same pattern, scan direction up.
  //   0:10.2 → photo 3 starts. Scan down.
  //   0:13.7 → photo 4 starts. Scan up.
  //   0:17.2 → photo loop ends.
  //   0:17.2 → progress overlay slides in from the RIGHT (2000ms).
  //   0:19.2 → overlay in place. Grid cycle + needle pulse start.
  //            POPULATING INFO lights green.
  //   0:20.7, 0:22.2, 0:23.7, 0:25.2 → remaining 4 buttons light at
  //   1500ms intervals (paced + API-gated; API has typically returned
  //   by now since it ran in parallel from t=0).
  //   0:25.2 → grid cycle stops, needle pulses stops, needle sweeps to
  //   final score angle (2000ms). Score boxes count up. PQ pill cycles
  //   through 7 designations (1800ms linear) and lands on final.
  //   0:30.0 → ASSESSING button becomes COMPLETE (in-place style change).
  //
  // Total: ~30 seconds animation, then holds on COMPLETE until tap.
  const CHEST_SLIDE_DELAY  = 200;
  const CHEST_SLIDE_TIME   = 2000;
  const POST_CHEST_PAUSE   = 1000;
  const DISPLAY_FADE_DELAY = 100;
  const SLIDE_DURATION     = 500;
  const SCAN_DURATION      = 2500;  // S15 May 29: was 3000. Trimmed 500ms per scan × 4 photos = 2s off total animation. CSS @keyframes durations on lines 484-487 changed in lockstep.
  const PAUSE_AFTER_SCAN   = 0;
  const FIRST_PHOTO_DELAY  = CHEST_SLIDE_DELAY + CHEST_SLIDE_TIME + POST_CHEST_PAUSE;
  const TRACKER_SLIDE_TIME = 2000;
  const RESULTS_SLIDE_TIME = 2000;  // Results panel slides up with the chest, same duration
  const OVERLAY_SLIDE_TIME = 2000;  // Progress overlay slides in from the right

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
      /* TRANSPARENT — do not change this back to an opaque color.
         History: S13 v18 deliberately made this transparent so the chest
         rises up OVER the live Edit view instead of hard-cutting to
         black. This took multiple sessions to get right and is the
         intended look. An S14 change briefly set this to #0a0d07 to kill
         a "sliver of Edit view visible / scrollable behind the overlay"
         bug — that was the wrong fix and it reverted the see-through
         rise. The CORRECT fix for the sliver/scroll bug is the body
         scroll lock (lockBodyScroll/unlockBodyScroll, added the same
         session): it freezes the page behind the overlay so nothing
         scrolls and the visible Edit view is static during the ~2s chest
         slide-up. Transparency + scroll lock together = the desired
         behavior. If a sliver bug ever recurs, fix the scroll lock, NOT
         this background. */
      background: transparent;
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
      /* S13 v18: ease-in-out so the chest doesn't pop into motion. The
         old ease-out (cubic-bezier 0.22, 1, 0.36, 1) was near-linear at
         the start, so frame 3 of the user's test recording showed the
         chest appearing well up the screen rather than emerging
         gradually from the bottom. ease-in-out gives a smooth on-ramp.
         Duration extended to 2000ms to match storyboard timing. */
      animation: rgShellSlideUp 2000ms cubic-bezier(0.65, 0, 0.35, 1) 0.2s forwards;
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
      /* S13 v18: chest slide is now 2000ms starting at 200ms, so it
         lands at 2200ms. Display fades in just after that. */
      animation: rgScanFadeIn 0.3s ease-out 2.3s forwards;
      pointer-events: none;
    }
    @keyframes rgScanFadeIn { to { opacity: 1; } }

    /* S13 v21: slit-to-slit clipping container. Positioned at the
       exact slit coordinates within the cavity (left:2.6% width:83.4%),
       full height of the cavity. overflow:hidden clips photos at the
       slit boundaries so they truly "disappear into the slit" rather
       than continuing visible past it. Lasers stay direct children of
       display (they need to extend wider than the slits). */
    .rg-scan-slot-wrap {
      position: absolute;
      left:   2.6%;
      top:    20.6%;
      width:  83.4%;
      height: 67.3%;
      overflow: hidden;
      pointer-events: none;
    }

    .rg-scan-photo {
      position: absolute;
      /* S13 v21: photo now fills 100% of its slot-wrap (which is itself
         positioned at the slit coords). The photo enters from the left
         slit at translateX(-100%) — its right edge AT the wrap's left
         edge (= left slit). At translateX(0) it fills the wrap. At
         translateX(+100%) its left edge is AT the wrap's right edge
         (= right slit) — fully outside the wrap and clipped to invisible.
         The math is now clean because the wrap's boundaries ARE the
         slits.

         OLD attempt (v18-v20): photo was positioned directly in the
         display with the same slit-coord left/width values. The display
         clipped at its own edges (cavity boundaries) which extended
         past the slits, so photo visuals leaked into the 14% strip
         between the right slit and the cavity edge. Fixed by adding
         the slot-wrap. */
      left:   0;
      top:    0;
      width:  100%;
      height: 100%;
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
      transform: translateX(-100%);
      transition: transform 500ms cubic-bezier(0.65, 0, 0.35, 1);
    }
    .rg-scan-photo.in-view  { transform: translateX(0);    }
    .rg-scan-photo.out-view { transform: translateX(100%); }
    .rg-scan-photo.reset    {
      transition: none !important;
      transform: translateX(-100%) !important;
    }

    /* Spine photo rotation — captured spine photos are landscape (the
       spine runs along the long edge of the captured image). To display
       it as a vertical strip reading top-to-bottom, we rotate.
       S13 v18: switched from -90deg (CCW) to +90deg (CW) because the
       previous orientation showed the spine upside-down in real device
       testing (the dust-flap side of comics is at the top after rotation,
       not bottom). The art-side of the spine should be at the top of
       the displayed photo, which means a +90 (clockwise) rotation. */
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
      /* S14 May 22: Fix rotated spine being too small.
         Problem: prior rule (width:100% height:100% + rotate(90deg))
         left the bounding box at container dimensions, then object-fit
         contained the LANDSCAPE spine image inside that box leaving
         most of the box empty above/below the strip. After rotation,
         the strip floated as a small vertical sliver instead of
         spanning the container.
         Fix: explicit pre-rotation dimensions. We want post-rotation
         vertical span to equal the container's height. Pre-rotation
         that means the element's HORIZONTAL axis (its width) should
         equal the container's height. Using height:100% as the
         container-height-derived value, then setting width to match
         via JS at runtime would be ideal, but for a pure CSS fix we
         can use the parent's height via absolute inset positioning:
         setting top:0 bottom:0 means the element's NATURAL height is
         the parent's full height; we then swap that into width via
         a 1:1 aspect ratio. After rotation the spine's content fills
         the height via object-fit:contain working against the square
         pre-rotation box. Tradeoff: the rotated spine occupies a
         container-height × container-height square area, which on
         a square container is correct; on a non-square container the
         rotated spine will be capped by the smaller dimension. */
      top: 50%;
      left: 50%;
      width: auto;
      height: 100%;
      aspect-ratio: 1 / 1;
      object-fit: contain;
      transform: translate(-50%, -50%) rotate(90deg);
    }

    .rg-scan-laser {
      position: absolute;
      pointer-events: none;
      opacity: 0;
      z-index: 11;
    }
    .rg-scan-laser.active { opacity: 1; }
    .rg-scan-laser.horizontal {
      /* S13 v18: laser horizontal extent now matches the slit-to-slit
         distance (same as photo width) so the beam appears to emit
         from one slit and reach the other. */
      left: 2.6%;
      width: 83.4%;
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
      /* S13 v18: vertical-scan extent matches slit Y range. */
      top:    20.6%;
      height: 67.3%;
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
    /* S13 v18: scan range = slit Y range (20.6% to 87.9% of cavity).
       Vertical scans (down/up) for the laser bar's top position.
       Scan duration 2500ms matches storyboard (S15 May 29: was 3000ms). */
    @keyframes rgScanDown  { from { top: 20.6%; } to { top: 87.9%;  } }
    @keyframes rgScanUp    { from { top: 87.9%; } to { top: 20.6%;  } }
    @keyframes rgScanRight { from { left: 2.6%; } to { left: 86.0%; } }
    @keyframes rgScanLeft  { from { left: 86.0%;} to { left: 2.6%;  } }
    .rg-scan-laser.scan-down  { animation: rgScanDown  2.5s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-up    { animation: rgScanUp    2.5s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-right { animation: rgScanRight 2.5s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-left  { animation: rgScanLeft  2.5s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }

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

    /* Results panel — sits in the brushed-steel area at the bottom of
       the chest. S13 v18: pre-rendered as part of buildDom so it slides
       up TOGETHER with the chest, eliminating the separate slide-in
       animation. The panel content is set via setResultsContent (which
       replaces innerHTML). On first render the content is placeholder
       score boxes + PQ pill + gray "ASSESSING" button; mountResults
       (in index.html) populates the real values and animates them. */
    .rg-scan-results {
      position: absolute;
      left:   ${RESULTS.leftPct}%;
      top:    ${RESULTS.topPct}%;
      width:  ${RESULTS.widthPct}%;
      height: ${RESULTS.heightPct}%;
      overflow: hidden;
      pointer-events: auto;
      z-index: 13;
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
      /* S13 v18: slides in from the right (translateX +110% → 0). */
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
       and the gauge. S13 v18: slides in from the right per storyboard. */
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

    /* S13 v18: cycling light grid (8 frames at 250ms each). Positioned
       inside the overlay at viewport-pixel X=57, Y=91 with size 160×160
       within the overlay's 474×755 bounding box.
         Left: 57/474 = 12.03%
         Top:  91/755 = 12.05%
         Width:  160/474 = 33.76%
         Height: 160/755 = 21.19%
       All 8 frames stacked at this position, opacity 0 until the active
       class is applied to one. The grid does NOT auto-start — it starts
       only when startGridCycle() is called (after overlay slide-in
       completes) and stops at mountResults time. */
    .rg-scan-grid {
      position: absolute;
      left:   12.03%;
      top:    12.05%;
      width:  33.76%;
      height: 21.19%;
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

    /* S13 v18: red needle. Single PNG, CSS-rotated via
       --rg-needle-rot. Pivot at bottom-center (transform-origin
       50% 100%). Pivot point in overlay coords: X=330, Y=206
       (lowered 16px from initial spec of Y=190 per user testing
       in frame 28). Wrap element extends UPWARD from pivot.
         pivot X: 330/474 = 69.62%
         pivot Y: 206/755 = 27.28%
         wrap width:  11/474 = 2.32%
         wrap height: 140/755 = 18.54%
       Off / score 0   → rotate(-48deg)
       Score 50        → rotate(0deg)
       Score 100       → rotate(+48deg)
       Default starting position: -48deg (off / pre-pulse). */
    .rg-scan-needle-wrap {
      position: absolute;
      left:   69.62%;
      top:    27.28%;
      width:  2.32%;
      height: 18.54%;
      transform: translate(-50%, -100%) rotate(var(--rg-needle-rot, -48deg));
      transform-origin: 50% 100%;
      /* S13 v19: removed CSS transition. The JS setInterval at 33ms
         (~30fps) drives the angle directly via --rg-needle-rot. The
         previous 200ms ease-out transition combined with 33ms JS
         updates was creating a backlog of 6+ overlapping transitions
         per cycle, choking the main thread enough that setTimeout
         callbacks for animateStepsFromDiagnostics were delayed by
         ~14s in v18 testing. The final-sweep class adds back a 2000ms
         transition for the single smooth sweep to the score-derived
         angle in Phase E. */
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
    // S14: sync decode + high priority so the chest bitmap is paint-ready
    // the instant the shell mounts. Combined with the sign-in preload's
    // decode() call, this stops the "overlay/chest pops in a few frames
    // late" bug — the CSS slide-up no longer races the image decode.
    chest.decoding = 'sync';
    try { chest.fetchPriority = 'high'; } catch (e) {}
    chest.setAttribute('fetchpriority', 'high');
    chest.src = 'assets/Robograder_Scan_Frame.webp';
    chest.alt = '';
    shell.appendChild(chest);

    const display = document.createElement('div');
    display.className = 'rg-scan-display';
    display.id = 'rg-scan-display';

    activeSlots.forEach(slot => {
      // S13 v21: wrap each photo in a slit-to-slit clipping container.
      // The .rg-scan-display fills the full cavity (so lasers can extend
      // beyond the slits as before), but the photos need to be clipped
      // at the slits — otherwise they slide past the visual slit-stripe
      // in the chest art and remain visible in the 14% strip between
      // the right slit and the cavity's right edge (which is what made
      // photos look like they were "disappearing too far to the right"
      // in v20 testing). The slot wrap is positioned at slit-to-slit
      // coordinates (cavity-X 2.6% to 86%), has overflow:hidden, and
      // contains the .rg-scan-photo. The photo now fills 100% of the
      // wrap (slit-to-slit width) and translates ±100% to enter/exit
      // through the slits — clean and self-clipping.
      const slotWrap = document.createElement('div');
      slotWrap.className = 'rg-scan-slot-wrap';

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
      slotWrap.appendChild(photo);
      display.appendChild(slotWrap);
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

    // S13 v18: Results panel mounted as part of the initial DOM so it
    // slides up TOGETHER with the chest (it's a child of the shell,
    // which is what slides). Initial content is the placeholder layout
    // — three 0-value score boxes, "White" PQ pill, gray ASSESSING
    // button. mountResults (called from index.html when the API
    // returns) replaces innerHTML with the real values and animations.
    const results = document.createElement('div');
    results.className = 'rg-scan-results';
    results.id = 'rg-scan-results';
    results.innerHTML = buildResultsPlaceholder();
    shell.appendChild(results);

    stage.appendChild(shell);
    document.body.appendChild(stage);
    return stage;
  }

  // S13 v18: Placeholder content for the results panel — shown from
  // the moment the chest starts sliding up. Three 0-value score boxes
  // (matching the same dimensions index.html's mountResults uses, +8px
  // per Matt's frame-37 feedback), a "White" PQ placeholder pill, and
  // a disabled gray "ASSESSING" button below. This is JUST the layout;
  // index.html's mountResults replaces this innerHTML at the end of
  // the animation with the real animated values, then transforms the
  // ASSESSING button into COMPLETE.
  function buildResultsPlaceholder() {
    return `
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3% 5%;box-sizing:border-box;gap:8px;">
        <div style="display:flex;gap:12px;justify-content:center;align-items:center;">
          <div style="width:64px;height:64px;border:1.5px solid #3a5010;background:#0f1a05;border-radius:8px;padding:4px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.4)">
            <div style="font-size:22px;font-weight:800;color:#aaee30;line-height:1">0</div>
            <div style="font-size:9px;color:#aaee30;opacity:0.75;margin-top:2px;letter-spacing:0.8px">RG</div>
          </div>
          <div style="width:64px;height:64px;background:#2a5a8a;border-radius:8px;padding:4px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.4)">
            <div style="font-size:22px;font-weight:800;color:#e0f0ff;line-height:1">0.0</div>
            <div style="font-size:9px;color:#e0f0ff;opacity:0.75;margin-top:2px;letter-spacing:0.8px">GRADE</div>
          </div>
        </div>
        <div id="result-pq" style="display:flex;align-items:center;justify-content:center;min-height:22px;">
          <div style="background:#ffffff;color:#5a4e3a;padding:6px 14px;border-radius:8px;font-size:13px;font-weight:600;letter-spacing:0.03em;display:inline-block">Page Quality</div>
        </div>
        <button id="assess-complete-btn" disabled
          style="align-self:center;width:auto;min-width:180px;max-width:260px;padding:0 24px;height:36px;background:#5a5a5a;color:#bbb;border:none;font-size:13px;font-weight:800;letter-spacing:2px;cursor:default;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.4);">
          ASSESSING…
        </button>
      </div>`;
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
  // S14: saved scroll Y for the body-scroll-lock. Null when not locked.
  let _scrollLockY = null;

  function lockBodyScroll() {
    if (_scrollLockY !== null) return;  // already locked
    _scrollLockY = window.scrollY || window.pageYOffset || 0;
    const b = document.body;
    b.style.position = 'fixed';
    b.style.top = `-${_scrollLockY}px`;
    b.style.left = '0';
    b.style.right = '0';
    b.style.width = '100%';
    b.style.overflow = 'hidden';
  }

  function unlockBodyScroll() {
    if (_scrollLockY === null) return;  // not locked
    const b = document.body;
    b.style.position = '';
    b.style.top = '';
    b.style.left = '';
    b.style.right = '';
    b.style.width = '';
    b.style.overflow = '';
    // Restore the exact pre-lock scroll position. Without this the page
    // jumps to the top on dismiss, which is its own disorientation bug.
    window.scrollTo(0, _scrollLockY);
    _scrollLockY = null;
  }

  function teardown() {
    // S13 v18: stop animation timers BEFORE removing DOM so they don't
    // run against a torn-down tree.
    stopGridCycle();
    stopNeedlePulse();
    if (_activeStage && _activeStage.parentNode) {
      _activeStage.parentNode.removeChild(_activeStage);
    }
    // S14: always release the scroll lock on teardown, even if the stage
    // was already gone — defends against the lock leaking and freezing
    // the whole app's scroll (which is exactly the "broken until restart"
    // class of bug we're fixing).
    unlockBodyScroll();
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
  // S13 v18: was slideResultsIntoPanel; the results panel is now
  // pre-mounted by buildDom and rides up with the chest, so there's
  // no separate slide. This function is the in-place update hook
  // used by mountResults (when final values are ready) and
  // showGateTerminatedPreview. Name retained for backward compat.
  function slideResultsIntoPanel(html) {
    debugLog(`slideResultsIntoPanel (in-place update) called, htmlLen=${(html||'').length}`);
    if (!_activeStage) {
      debugLog('  ⚠ no active stage');
      return null;
    }
    const results = _activeStage.querySelector('.rg-scan-results');
    if (!results) {
      debugLog('  ⚠ no results panel');
      return null;
    }
    results.innerHTML = html;
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

    // S13 v18: defensive — stop any prior grid cycle / needle pulse.
    // The overlay can be remounted (e.g. if assess errors and retries);
    // those timers must not survive across remounts.
    stopGridCycle();
    stopNeedlePulse();

    // Boxes layer FIRST (lower z-index) — opaque step boxes show through
    // alpha-carved holes in the overlay.
    const boxes = document.createElement('div');
    boxes.className = 'rg-scan-boxes';
    boxes.id = 'rg-scan-boxes';
    if (boxesHtml) boxes.innerHTML = boxesHtml;
    shell.appendChild(boxes);
    debugLog(`  boxes appended, transform=${debugTransform(boxes).substring(0,30)}`);

    // Overlay layer SECOND (higher z-index) — the artwork PNG with
    // baked-in step text. S13 v18: we also inject the cycling grid
    // (8 frame imgs, all initially opacity:0) and the needle as
    // children of the overlay so they ride along with the slide-in
    // and are part of the same alpha-positioned region.
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

  // ── S13 v18: cycling light grid (8 frames, 250ms each) ─────────────
  // Built as 8 stacked <img> elements, all opacity:0 until activated.
  // startGridCycle adds .active to one image at a time, rotating
  // every 250ms. stopGridCycle clears all .active so the grid goes
  // dark (no frame visible).
  function buildGridHtml() {
    let html = '<div class="rg-scan-grid" id="rg-scan-grid">';
    for (let i = 1; i <= 8; i++) {
      const idx = String(i).padStart(2, '0');
      // Filename casing matches the repo: frame_01.PNG ... frame_08.PNG.
      html += `<img src="assets/modal/frame_${idx}.PNG" alt="" />`;
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
    imgs[0].classList.add('active');
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
    }
    // S13 v18: also clear all .active so no frame is visible — matches
    // frame-35 spec (grid returns to off state when results appear).
    const grid = document.getElementById('rg-scan-grid');
    if (grid) {
      grid.querySelectorAll('img').forEach(img => img.classList.remove('active'));
    }
    debugLog('grid cycle stopped');
  }

  // ── S13 v18: red needle ────────────────────────────────────────────
  // Single PNG, CSS-rotated. Pulses during Phase D, sweeps to final
  // score angle during Phase E.
  function buildNeedleHtml() {
    return `<div class="rg-scan-needle-wrap" id="rg-scan-needle">
      <img src="assets/modal/Red_Needle.png" alt="" />
    </div>`;
  }
  function _scoreToAngle(score) {
    const s = Math.max(0, Math.min(100, Number(score) || 0));
    return -48 + (s / 100) * 96;
  }
  function setNeedleAngle(degrees) {
    const el = document.getElementById('rg-scan-needle');
    if (!el) return;
    el.style.setProperty('--rg-needle-rot', `${degrees}deg`);
  }
  let _needlePulseTimer = null;
  let _needlePulseStart = 0;
  let _needleCurrentAmp = 25;
  function startNeedlePulse() {
    if (_needlePulseTimer) return;
    const el = document.getElementById('rg-scan-needle');
    if (!el) {
      debugLog('  ⚠ startNeedlePulse: needle element not found');
      return;
    }
    debugLog('needle pulse started');
    _needlePulseStart = performance.now();
    _needleCurrentAmp = 25 + Math.random() * 20;
    _needlePulseTimer = setInterval(() => {
      const now = performance.now();
      const phase = ((now - _needlePulseStart) % 1000) / 1000;
      if (phase < 0.05 && (now - _needlePulseStart) > 100) {
        _needleCurrentAmp = 15 + Math.random() * 35;
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
  function sweepNeedleToScore(score) {
    const el = document.getElementById('rg-scan-needle');
    if (!el) return;
    const angle = _scoreToAngle(score);
    // S13 v20: add .final-sweep class FIRST so the CSS transition is
    // registered. Then in the next paint frame, set the angle so the
    // browser interpolates from the current angle to the new one.
    // Doing both in the same tick caused the browser to apply both
    // changes simultaneously and snap to the new angle (no visible
    // sweep). The pulse setInterval has been stopped before this is
    // called, so the angle written before this is whatever the last
    // pulse tick set — which is a real angle the browser can
    // transition from.
    el.classList.add('final-sweep');
    requestAnimationFrame(() => {
      el.style.setProperty('--rg-needle-rot', `${angle}deg`);
      debugLog(`needle sweep → score ${score} → ${angle.toFixed(1)}deg`);
    });
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

    // S14: lock body scroll while the scan stage is up. Two bugs this
    // fixes, both caused by the page staying scrollable behind the fixed
    // overlay:
    //   (1) A sliver of the Edit view showed through and the user could
    //       scroll it behind the transparent stage.
    //   (2) Scrolling the Edit view mid-animation shifted the layout the
    //       slide-in transform was computed against, so the chest could
    //       slide too far and the scan animation rendered cropped off the
    //       top — and stayed broken until app restart because the scroll
    //       offset never reset.
    // iOS Safari ignores `overflow:hidden` on body for touch scrolling,
    // so we use the position:fixed + negative-top technique and restore
    // the exact scroll position on teardown.
    lockBodyScroll();

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
    // S13 v18: grid + needle control
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
