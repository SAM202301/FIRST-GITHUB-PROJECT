/* Service worker: keeps a complete copy of the app so it opens with no
   internet at all, and installs new versions only when you tap
   "Install update" in the app.

   RELEASING A NEW VERSION: bump VERSION here, APP_VERSION in app.js and
   "version" in version.json (all three must match). */
const VERSION = '1.5.0';
const CACHE = 'habits-' + VERSION;
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
// Caches made before the in-app update button existed (v1.0–1.3).
const LEGACY = /^habits-v\d+$/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' skips the browser's HTTP cache so we never store a stale file.
    await cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })));
    // Older versions have no update button, so move them over straight away.
    if ((await caches.keys()).some(k => LEGACY.test(k))) self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const fromLegacy = keys.some(k => LEGACY.test(k));
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    if (fromLegacy) {
      // Reload open windows that are still running the old code. Not awaited:
      // the reload's requests can't be served until activation has finished.
      self.clients.matchAll({ type: 'window' })
        .then(wins => wins.forEach(w => w.navigate(w.url).catch(() => {})));
    }
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // version.json is how the app learns about updates, so always ask the network.
  if (url.pathname.endsWith('/version.json')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(e.request);
    } catch (err) {
      if (e.request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
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
