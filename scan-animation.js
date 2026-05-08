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
    leftPct:   0,
    topPct:    86.34,
    widthPct:  100,
    heightPct: 13.66,
  };
  // S13 v10: Overlay panel — the Progress_Overlay.png artwork (474×755
  // native pixels in the 577×1830 chest image's coordinate system).
  // Final position pinned at chest-image X=46, Y=684 per Matt's spec.
  // Slides in from the left (starting fully off-screen at X=-474).
  // Holds the 5 progress step boxes plus the working-indicator graphics
  // (4×4 light grid, gauge needle).
  const OVERLAY = {
    leftPct:   46 / 577 * 100,    //  7.97%
    topPct:    684 / 1830 * 100,  // 37.38%
    widthPct:  474 / 577 * 100,   // 82.15%
    heightPct: 755 / 1830 * 100,  // 41.26%
  };

  // ── Timing (ms) ─────────────────────────────────────────────────────
  const CHEST_SLIDE_DELAY  = 200;
  const CHEST_SLIDE_TIME   = 3000;
  const DISPLAY_FADE_DELAY = 100;
  const SLIDE_DURATION     = 1000;
  const SCAN_DURATION      = 2000;
  const PAUSE_AFTER_SCAN   = 200;
  const FIRST_PHOTO_DELAY  = CHEST_SLIDE_DELAY + CHEST_SLIDE_TIME + DISPLAY_FADE_DELAY;
  const TRACKER_SLIDE_TIME = 500;  // step tracker slides in from left
  const RESULTS_SLIDE_TIME = 400;  // results panel slides up from below
  const OVERLAY_SLIDE_TIME = 600;  // overlay panel slides in from left

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
      /* Initial position: shell starts BELOW the viewport (bottom edge
         offscreen by its own full height). The slide-up animation
         translates it to bottom = 0 so its bottom edge lines up with
         viewport bottom. */
      bottom: calc(-1 * (100vw / 0.3153));
      transform: translateX(-50%);
      animation: rgShellSlideUp 3s cubic-bezier(0.22, 1, 0.36, 1) 0.2s forwards;
      pointer-events: none;
    }
    @keyframes rgShellSlideUp {
      from { bottom: calc(-1 * (100vw / 0.3153)); }
      /* Final position: bottom = 0 anchors the chest to the viewport
         bottom. The brushed-steel results panel (last 13.66% of the
         chest image) ends up flush with viewport bottom; the cavity
         (38-75% of the chest) sits in the upper visible region.
         Head extends above viewport, which is fine. */
      to   { bottom: 0; }
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
      animation: rgScanFadeIn 0.3s ease-out 3.3s forwards;
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
         than against its borders. */
      left: 10%; top: 10%;
      width: 80%; height: 80%;
      background-size: contain;
      background-position: center;
      background-repeat: no-repeat;
      transform: translateX(-110%);
      transition: transform 1s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .rg-scan-photo.in-view  { transform: translateX(0);    }
    .rg-scan-photo.out-view { transform: translateX(110%); }
    .rg-scan-photo.reset    {
      transition: none !important;
      transform: translateX(-110%) !important;
    }

    /* Spine photo rotation — captured spine photos are wide-landscape
       (spine length runs horizontally). In the portrait-oriented cavity
       display container, the wide image renders short with empty space
       above and below. Solution: render via <img> with pre-rotation
       dimensions swapped, then rotate -90° around center. The contained
       image fills the cavity's height after rotation. */
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
      /* S13 v12: corrected pre-rotation dimensions. The image needs to
         be sized so that AFTER rotation, it fills the cavity. If cavity
         is W×H, the pre-rotation image is H×W (transposed). In percent-
         of-parent terms (parent = cavity, so 100%×100% = cavity), the
         pre-rotation width = (H/W) of parent's width — but expressed as
         a percentage of the parent's *width*, that's H/W × 100. Since
         W/H of cavity in absolute pixels matches widthPct/heightPct,
         the right formula is:
           width  = widthPct/heightPct  × 100  (so post-rotate visual width = cavity width)
           height = heightPct/widthPct  × 100
         Earlier code had these swapped, leaving the rotated image
         shorter than the cavity. */
      width:  ${(CAVITY.widthPct / CAVITY.heightPct * 100).toFixed(2)}%;
      height: ${(CAVITY.heightPct / CAVITY.widthPct * 100).toFixed(2)}%;
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
    .rg-scan-laser.scan-down  { animation: rgScanDown  2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-up    { animation: rgScanUp    2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-right { animation: rgScanRight 2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-left  { animation: rgScanLeft  2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }

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
       steel area. Slides UP from below to enter. */
    .rg-scan-results {
      position: absolute;
      left:   ${RESULTS.leftPct}%;
      top:    ${RESULTS.topPct}%;
      width:  ${RESULTS.widthPct}%;
      height: ${RESULTS.heightPct}%;
      overflow: hidden;
      transform: translateY(110%);
      transition: transform ${RESULTS_SLIDE_TIME}ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      z-index: 13;
    }
    .rg-scan-results.in-view {
      transform: translateY(0);
    }

    /* Overlay panel — the Progress_Overlay.png artwork that slides in
       from the left over the cavity area. Wider than the cavity itself
       (extends from X=46 to X=520 in chest image coords; the cavity
       runs roughly X=120 to X=500). The overlay is the artwork; child
       elements (progress step boxes, light grid, gauge) are positioned
       inside its coordinate system as percentages of the overlay's
       own bounding box. Slides in from translateX(-110%) → 0 (the
       -110% intentionally clears the chest's left edge entirely so
       the overlay is offscreen-left at start). */
    .rg-scan-overlay {
      position: absolute;
      left:   ${OVERLAY.leftPct}%;
      top:    ${OVERLAY.topPct}%;
      width:  ${OVERLAY.widthPct}%;
      height: ${OVERLAY.heightPct}%;
      overflow: visible;
      transform: translateX(-110%);
      transition: transform ${OVERLAY_SLIDE_TIME}ms cubic-bezier(0.22, 1, 0.36, 1);
      pointer-events: auto;
      z-index: 14;
    }
    .rg-scan-overlay.in-view {
      transform: translateX(0);
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
    const photoEl = document.getElementById('rg-scan-photo-' + slot.slotName);
    if (!photoEl) return;

    const isVerticalScan = scanDir === 'down' || scanDir === 'up';
    const laser = document.getElementById(isVerticalScan ? 'rg-scan-laser-h' : 'rg-scan-laser-v');

    photoEl.classList.add('in-view');
    await wait(SLIDE_DURATION, cancelToken);

    laser.classList.add('active', 'scan-' + scanDir);
    await wait(SCAN_DURATION, cancelToken);
    laser.classList.remove('scan-' + scanDir, 'active');
    await wait(PAUSE_AFTER_SCAN, cancelToken);

    photoEl.classList.remove('in-view');
    photoEl.classList.add('out-view');
    await wait(SLIDE_DURATION, cancelToken);

    photoEl.classList.remove('out-view');
    photoEl.classList.add('reset');
    photoEl.offsetHeight;  // force reflow
    requestAnimationFrame(() => {
      if (!cancelToken.cancelled) {
        photoEl.classList.remove('reset');
      }
    });
  }

  async function runSequence(activeSlots, cancelToken) {
    await wait(FIRST_PHOTO_DELAY, cancelToken);
    for (let i = 0; i < activeSlots.length; i++) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      const scanDir = (i % 2 === 0) ? 'down' : 'up';
      await scanPhoto(activeSlots[i], scanDir, cancelToken);
    }
  }

  // ── Public lifecycle ────────────────────────────────────────────────
  // Held state for the active session.
  let _activeStage = null;
  let _activeCancelToken = null;

  function teardown() {
    if (_activeStage && _activeStage.parentNode) {
      _activeStage.parentNode.removeChild(_activeStage);
    }
    _activeStage = null;
    _activeCancelToken = null;
  }

  function dismiss() {
    // Graceful end-of-flow teardown. Same as the destructive teardown but
    // semantically meaningful — caller is saying "we're done with the
    // shell now, results have been saved."
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
  function slideResultsIntoPanel(html) {
    if (!_activeStage) return null;
    const shell = _activeStage.querySelector('.rg-scan-shell');
    if (!shell) return null;

    const existing = shell.querySelector('.rg-scan-results');
    if (existing) existing.remove();

    const results = document.createElement('div');
    results.className = 'rg-scan-results';
    results.id = 'rg-scan-results';
    results.innerHTML = html;
    shell.appendChild(results);

    results.offsetHeight;
    requestAnimationFrame(() => {
      results.classList.add('in-view');
    });

    return results;
  }

  // Slide the Progress_Overlay artwork in from the left, positioned at
  // chest-image (X=46, Y=684) per Matt's spec. The overlay extends
  // beyond the cavity rectangle on both sides (left-aligned at 7.97%,
  // ending at ~90% — the cavity itself is centered around 53.75% with
  // width 65.9%). This is intentional: the overlay is its own artwork
  // and frames the cavity from outside, not within.
  //
  // The caller passes HTML that will be rendered INSIDE the overlay
  // container. Typically that's an <img> for the overlay PNG plus
  // progress boxes/light-grid/gauge children positioned over it.
  // Returns the overlay element so the caller can manipulate it (e.g.
  // swap step-box images on state changes).
  function slideOverlayIntoChest(html) {
    if (!_activeStage) return null;
    const shell = _activeStage.querySelector('.rg-scan-shell');
    if (!shell) return null;

    const existing = shell.querySelector('.rg-scan-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'rg-scan-overlay';
    overlay.id = 'rg-scan-overlay';
    overlay.innerHTML = html;
    shell.appendChild(overlay);

    // Force reflow so the initial offscreen-left transform is applied
    // before we add the in-view class (which triggers the slide-in).
    overlay.offsetHeight;
    requestAnimationFrame(() => {
      overlay.classList.add('in-view');
    });

    // Fade out the laser-scan display under the overlay (parallel to
    // what slideTrackerIntoCavity does — the cavity content is now
    // covered by the overlay artwork).
    const display = shell.querySelector('.rg-scan-display');
    if (display) {
      display.style.transition = 'opacity 300ms ease-out';
      display.style.opacity = '0';
    }

    return overlay;
  }

  // ── Public API ─────────────────────────────────────────────────────
  // photoUrls: flat array of up to 4 URLs in slot order.
  // kind:      'main' (default) or 'corner'. Selects which slot table.
  function runScanAnimation(photoUrls, kind) {
    injectStyles();

    // Defensive: if a previous shell wasn't dismissed (e.g. error path),
    // tear it down before starting a fresh one.
    if (_activeStage) teardown();

    const slotTable = (kind === 'corner') ? SLOTS_CORNER : SLOTS_MAIN;

    const activeSlots = slotTable
      .filter(s => photoUrls && photoUrls[s.idx])
      .map(s => ({ ...s, url: photoUrls[s.idx] }));

    // Edge case: no photos. Build the shell anyway so the persistent
    // mode works for callers that wanted the shell up regardless. The
    // promise resolves immediately because there's nothing to scan.
    _activeStage = buildDom(activeSlots);

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
            // Already torn down by the cancel() call.
            return;
          }
          // Unexpected error — tear down to avoid leaving the shell stuck.
          teardown();
          throw err;
        });
    }

    return {
      promise,
      cancel: () => {
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
    // Constants exposed for caller diagnostics / testing
    _CAVITY: CAVITY,
    _OVERLAY: OVERLAY,
    _RESULTS: RESULTS,
  };
})();
