// service-worker.js
// "No-cache" service worker.
//
// Purpose:
// - Keep the app installable as a PWA.
// - Avoid stale-asset bugs by NOT caching or serving cached responses.
//
// This SW only does lifecycle management (skipWaiting + claim) and clears any
// old caches created by previous versions.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean up any leftover caches from earlier caching versions.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// No fetch handler => browser default network behavior.
