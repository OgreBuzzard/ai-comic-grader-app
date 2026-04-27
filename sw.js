const CACHE = 'cgc-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API requests — they're dynamic, per-user, often POST with
  // bodies that can't be cached safely. Letting them pass through to the
  // network avoids the "Returned response is null" error class.
  if (url.pathname.startsWith('/api/')) {
    return; // no respondWith — browser handles the fetch normally
  }

  // ... rest of existing handler
});
