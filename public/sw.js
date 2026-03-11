const CACHE_NAME = 'abkb-v13';
const SHELL_FILES = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json'
];

// Install — cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches and take control immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network-first for everything, cache as fallback (offline support)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Pass through API calls without interception
  if (url.pathname.startsWith('/api')) {
    return;
  }

  // Network-first: try network, fall back to cache for offline
  e.respondWith(
    fetch(e.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(e.request);
    })
  );
});
