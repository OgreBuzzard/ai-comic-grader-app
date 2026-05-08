// Robograder — Laser scan animation module (S12)
// Loaded statically. Plays the chest-cavity scan animation while an
// assessment is in flight. The animation can be cancelled (via the
// returned controller) but normally runs to completion regardless of
// API timing — Matt's spec is that the user always sees the full
// animation even if the API completes early.
//
// Public API:
//   runScanAnimation(photoUrls) -> { promise, cancel }
//     photoUrls: array of up to 4 photo URLs in slot order:
//       [0]=front, [1]=back, [2]=interior/PQ, [3]=spine/raking
//       Falsy entries (null/undefined/'') are skipped — the animation
//       only scans slots that have photos.
//     returns: { promise, cancel }
//       promise: resolves when the animation completes (or rejects on cancel)
//       cancel(): aborts the animation, removes DOM, rejects the promise
//
// Asset dependency: assets/Robograder_Scan_Frame.png (chest frame with
// vertical slits at x=130 and x=448 of source 577×1536)

(function() {
  'use strict';

  // ── Slot definitions ────────────────────────────────────────────────
  // Index in the photoUrls array MUST match the slot order from the
  // image upload UI: front=0, back=1, interior=2, raking/spine=3.
  //
  // S13 v6: scan direction is NOT a per-slot property anymore — it's
  // assigned by playback position in runSequence (1st down, 2nd up,
  // 3rd down, 4th up). Mimics a photocopier alternating its lamp pass
  // direction on each successive page. So a slot's scanDir comes from
  // when it plays in the animation, not from which slot it is.
  //
  // rotate: true on the spine slot triggers the 90° vertical rotation of
  // the captured spine photo so its long dimension fills the animation
  // display height (the spine photo is captured landscape-wide).
  const SLOTS_MAIN = [
    { idx: 0, slotName: 'front',    rotate: false },
    { idx: 1, slotName: 'back',     rotate: false },
    { idx: 2, slotName: 'pq',       rotate: false },
    { idx: 3, slotName: 'spine',    rotate: true  },
  ];

  // S13 v7: corner-macro slot table for high-grade scan animation. HG
  // sends the 4 corner macros to the model and the user expects to see
  // those 4 photos scanned — NOT the 4 main slots they already saw on
  // the standard pass. Each corner macro is a portrait close-up of a
  // single corner of the cover; no rotation needed and no special
  // per-slot treatment. Photocopier-alternating scan direction (the
  // position-based rule in runSequence) applies as usual.
  const SLOTS_CORNER = [
    { idx: 0, slotName: 'corner-tl', rotate: false },
    { idx: 1, slotName: 'corner-tr', rotate: false },
    { idx: 2, slotName: 'corner-bl', rotate: false },
    { idx: 3, slotName: 'corner-br', rotate: false },
  ];

  // Backwards-compatible alias — older code may still reference SLOTS.
  const SLOTS = SLOTS_MAIN;

  // ── Timing (ms) ─────────────────────────────────────────────────────
  // All values match the v4 prototype Matt approved. Don't change without
  // re-watching the prototype to confirm the feel still works.
  const CHEST_SLIDE_DELAY  = 200;
  const CHEST_SLIDE_TIME   = 3000;
  const DISPLAY_FADE_DELAY = 100;
  const SLIDE_DURATION     = 1000;
  const SCAN_DURATION      = 2000;
  const PAUSE_AFTER_SCAN   = 200;
  const FIRST_PHOTO_DELAY  = CHEST_SLIDE_DELAY + CHEST_SLIDE_TIME + DISPLAY_FADE_DELAY;

  // ── CSS injection ───────────────────────────────────────────────────
  // We inject styles at module-init time rather than including them in
  // index.html so the scan-animation module is self-contained. The
  // .rg-scan-* prefix avoids any class collision with the rest of the app.
  const STYLES = `
    .rg-scan-stage {
      position: fixed;
      inset: 0;
      background: #000;
      overflow: hidden;
      z-index: 8500;
    }
    .rg-scan-chest {
      position: absolute;
      left: 50%;
      top: 100vh;
      transform: translateX(-50%);
      height: 130vh;
      width: auto;
      z-index: 5;
      pointer-events: none;
      animation: rgScanChestSlideUp 3s cubic-bezier(0.22, 1, 0.36, 1) 0.2s forwards;
    }
    @keyframes rgScanChestSlideUp {
      from { top: 100vh; }
      to   { top: -55vh; }
    }
    .rg-scan-display {
      position: absolute;
      left: calc(50% - 13.44vh);
      top: 15.7vh;
      width: 26.94vh;
      height: 39.3vh;
      z-index: 10;
      overflow: hidden;
      opacity: 0;
      animation: rgScanFadeIn 0.3s ease-out 3.3s forwards;
    }
    @keyframes rgScanFadeIn { to { opacity: 1; } }

    .rg-scan-photo {
      position: absolute;
      inset: 0;
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

    /* S13 v6: spine photo rotation. The captured spine photo is wide-
       landscape (the spine length runs horizontally across the frame).
       In the portrait-oriented animation display container, that wide
       landscape image renders only ~38% of the container height with
       lots of empty space top and bottom — visually small.
       Solution: render the spine photo via an <img> element (instead of
       background-image) with pre-rotation dimensions that swap container
       width and height, then rotate 90° around center. Result: the
       contained image fits within the rotated bounds, which after rotation
       align exactly with the container — visually filling the height.
       The wrapper div continues to handle the slide-in via translateX. */
    .rg-scan-photo.is-spine {
      background-image: none !important;
    }
    .rg-scan-photo-img {
      position: absolute;
      top: 50%;
      left: 50%;
      /* Pre-rotation dimensions match the container exactly.
         Container is 26.94vh wide × 39.3vh tall. */
      width: 26.94vh;
      height: 39.3vh;
      object-fit: contain;
      object-position: center;
      transform: translate(-50%, -50%);
    }
    .rg-scan-photo-img.rotated {
      /* Pre-rotation bounds are SWAPPED so post-rotation they match the
         container. Pre-rotation: 39.3vh wide × 26.94vh tall (landscape
         box, fits a wide spine photo nicely with object-fit:contain).
         Post-rotation by -90°: visual bounds are 26.94vh wide × 39.3vh
         tall — exactly fills the container, with the spine photo now
         oriented vertically. */
      width: 39.3vh;
      height: 26.94vh;
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
    .rg-scan-laser.scan-down  { animation: rgScanDown  2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-up    { animation: rgScanUp    2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-right { animation: rgScanRight 2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
    .rg-scan-laser.scan-left  { animation: rgScanLeft  2s cubic-bezier(0.42, 0, 0.58, 1) forwards, rgScanFlicker 0.15s infinite alternate; }
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

    const chest = document.createElement('img');
    chest.className = 'rg-scan-chest';
    chest.src = 'assets/Robograder_Scan_Frame.png';
    chest.alt = '';
    stage.appendChild(chest);

    const display = document.createElement('div');
    display.className = 'rg-scan-display';

    // Build photo elements only for slots with photos. Each one gets the
    // background-image of its actual photo. Spine slot (rotate:true) gets
    // an inner <img> element instead so the photo can be rotated 90° to
    // fill the portrait animation display container.
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

    // Two lasers (one per orientation). Reused across photos.
    const laserH = document.createElement('div');
    laserH.className = 'rg-scan-laser horizontal';
    laserH.id = 'rg-scan-laser-h';
    display.appendChild(laserH);
    const laserV = document.createElement('div');
    laserV.className = 'rg-scan-laser vertical';
    laserV.id = 'rg-scan-laser-v';
    display.appendChild(laserV);

    stage.appendChild(display);
    document.body.appendChild(stage);
    return stage;
  }

  function escapeUrl(url) {
    // Defensive — URLs with single quotes would break the CSS string.
    // Photo URLs from Cloud Storage are signed, can contain any chars.
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
    if (!photoEl) return;  // defensive — shouldn't happen, but safe

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

    // Snap back to start position WITHOUT animating (avoids the visible
    // "fly back across the screen" artifact). See v4 prototype notes.
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
    // S13 v6: scan direction alternates by playback position, mimicking
    // a photocopier lamp's alternating pass direction. Position 0 (1st
    // photo to play) = down, position 1 = up, position 2 = down, etc.
    // This is independent of which slot is in which position — only
    // the order matters.
    for (let i = 0; i < activeSlots.length; i++) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      const scanDir = (i % 2 === 0) ? 'down' : 'up';
      await scanPhoto(activeSlots[i], scanDir, cancelToken);
    }
  }

  function teardown() {
    const stage = document.getElementById('rg-scan-stage');
    if (stage && stage.parentNode) stage.parentNode.removeChild(stage);
  }

  // ── Public API ─────────────────────────────────────────────────────
  // photoUrls: flat array of up to 4 URLs in slot order.
  // kind:      'main' (default) or 'corner'. Selects which slot table to
  //            iterate over. Standard assessment uses 'main' (front, back,
  //            pq, spine); high-grade assessment uses 'corner' (the 4
  //            corner macros). The two flows visually look identical
  //            except for which photos slide through and the spine
  //            rotation (only present in 'main').
  function runScanAnimation(photoUrls, kind) {
    injectStyles();

    const slotTable = (kind === 'corner') ? SLOTS_CORNER : SLOTS_MAIN;

    // Filter to only slots that have photos. Per Matt's spec: skip
    // missing slots, only animate ones that exist.
    const activeSlots = slotTable
      .filter(s => photoUrls && photoUrls[s.idx])
      .map(s => ({ ...s, url: photoUrls[s.idx] }));

    // Edge case: no photos. Resolve immediately so caller doesn't hang.
    if (activeSlots.length === 0) {
      return {
        promise: Promise.resolve(),
        cancel: () => {}
      };
    }

    // Cancel token shared across all the wait() promises so a single
    // cancel() call short-circuits everything in flight.
    const cancelToken = {
      cancelled: false,
      _timers: new Set()
    };

    buildDom(activeSlots);

    const promise = runSequence(activeSlots, cancelToken)
      .then(() => {
        teardown();
      })
      .catch(err => {
        teardown();
        // Don't propagate cancellation as an error to the caller —
        // they explicitly asked for it.
        if (err.message === 'cancelled') return;
        throw err;
      });

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
  window.RobograderScan = { runScanAnimation };
})();
