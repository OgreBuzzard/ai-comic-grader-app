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
  // scanDir is the direction the laser travels for each photo type.
  const SLOTS = [
    { idx: 0, slotName: 'front',    scanDir: 'down'  },
    { idx: 1, slotName: 'back',     scanDir: 'up'    },
    { idx: 2, slotName: 'pq',       scanDir: 'right' },
    { idx: 3, slotName: 'spine',    scanDir: 'left'  },
  ];

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
    // background-image of its actual photo.
    activeSlots.forEach(slot => {
      const photo = document.createElement('div');
      photo.className = 'rg-scan-photo';
      photo.id = 'rg-scan-photo-' + slot.slotName;
      photo.style.backgroundImage = `url('${escapeUrl(slot.url)}')`;
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

  async function scanPhoto(slot, cancelToken) {
    if (cancelToken.cancelled) throw new Error('cancelled');
    const photoEl = document.getElementById('rg-scan-photo-' + slot.slotName);
    if (!photoEl) return;  // defensive — shouldn't happen, but safe

    const isVerticalScan = slot.scanDir === 'down' || slot.scanDir === 'up';
    const laser = document.getElementById(isVerticalScan ? 'rg-scan-laser-h' : 'rg-scan-laser-v');

    photoEl.classList.add('in-view');
    await wait(SLIDE_DURATION, cancelToken);

    laser.classList.add('active', 'scan-' + slot.scanDir);
    await wait(SCAN_DURATION, cancelToken);
    laser.classList.remove('scan-' + slot.scanDir, 'active');
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
    for (const slot of activeSlots) {
      if (cancelToken.cancelled) throw new Error('cancelled');
      await scanPhoto(slot, cancelToken);
    }
  }

  function teardown() {
    const stage = document.getElementById('rg-scan-stage');
    if (stage && stage.parentNode) stage.parentNode.removeChild(stage);
  }

  // ── Public API ─────────────────────────────────────────────────────
  function runScanAnimation(photoUrls) {
    injectStyles();

    // Filter to only slots that have photos. Per Matt's spec: skip
    // missing slots, only animate ones that exist.
    const activeSlots = SLOTS
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
