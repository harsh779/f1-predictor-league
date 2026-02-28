// CACHE KILLER: Forces all devices to delete old UI and fetch live from server
self.addEventListener('install', function(e) {
  self.skipWaiting(); // Take over immediately
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          console.log('Deleting out of date cache:', cacheName);
          return caches.delete(cacheName);
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Completely bypass cache, go straight to network
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});