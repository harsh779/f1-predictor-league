const CACHE_NAME = 'f1-strategy-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Installs the background worker
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

// Intercepts requests to ensure the app loads fast
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});