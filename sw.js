// Robograder service worker — minimal pass-through.
//
// This SW exists to satisfy PWA install-prompt eligibility (Chrome and other
// browsers require a registered SW with a fetch handler before showing the
// "Add to Home Screen" prompt). It does NOT provide offline support or
// caching; the previous version had a partial fetch handler that intercepted
// every non-API request and then did nothing, which forced the browser to
// apply stricter CORS rules to mediated requests and broke the Firestore
// Listen channel. That breakage cascaded into 14-second cold loads on phone.
//
// If/when real offline support is wanted, it should be a proper cache-first
// strategy with explicit allow-listing of static assets and pass-through for
// everything else (Firestore, Google Fonts, /api/, Cloud Storage URLs).
//
// Cache version history:
//   v2 → v3: invalidated the buggy fetch-intercepting SW
//   v3 → v4: invalidated cached manifest.json after RoboGrader → Robograder
//            app-name correction. Existing installs need eviction so re-add
//            picks up the corrected home-screen label.

const CACHE = 'robograder-v4';

self.addEventListener('install', e => {
  // Skip the wait-for-existing-client step. New SW takes over immediately.
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Wipe any older caches (notably v2 and v3). Then claim clients so the
  // new SW handles fetches without requiring a reload.
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch handler is intentionally a no-op pass-through. Listening for the
// event satisfies install-prompt requirements; not calling respondWith()
// lets the browser handle the fetch directly with no SW mediation. This
// avoids the cross-origin checks that were blocking Firestore and fonts.
self.addEventListener('fetch', () => {});
