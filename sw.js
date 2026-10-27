/* Service worker: caches the whole app so it opens with no internet at all. */
const CACHE = 'habits-v3';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Serve from cache first (works offline), refresh the cache in the
   background when the internet happens to be available. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => null);
      if (cached) { e.waitUntil(fresh); return cached; }
      return (await fresh) || (await cache.match('index.html')) || Response.error();
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('./');
    })
  );
});
