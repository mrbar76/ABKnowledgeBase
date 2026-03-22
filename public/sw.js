const CACHE_NAME = 'abkb-v30';
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

// Push notifications
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    e.waitUntil(
      self.registration.showNotification(data.title || 'AB Brain', {
        body: data.body || '',
        icon: data.icon || '/icons/brand/icon-app-180.png',
        badge: data.badge || '/icons/brand/icon-app-64.png',
        data: { url: data.url || '/' },
        vibrate: [100, 50, 100],
        tag: data.tag || 'ab-brain-notification',
        renotify: true,
      })
    );
  } catch {
    e.waitUntil(
      self.registration.showNotification('AB Brain', {
        body: e.data.text(),
        icon: '/icons/brand/icon-app-180.png',
      })
    );
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus existing window if available
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
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
