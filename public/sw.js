// v4 — forces reload on all open clients when SW updates
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(cacheNames.map(function(c) { return caches.delete(c); }));
    }).then(function() {
      // Force all open tabs/PWA windows to reload with fresh content
      return self.clients.matchAll({ type: 'window' }).then(function(clients) {
        clients.forEach(function(client) { client.navigate(client.url); });
      });
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Network-first: always fetch live, fall back to cache only if offline
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});
