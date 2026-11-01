/* Service worker for the tablet app: keeps a copy of the app's files so it
   opens with no connection. Data is NOT here; it lives in IndexedDB.
   Strategy: serve the cached copy of this version. When a new version is
   published, the browser notices sw.js changed, caches the whole new set, and
   the app switches over on its next launch (never a mix of old and new). */

const VERSION = '2796ad77ab75';
const CACHE = 'maintenance-log-' + VERSION;
const FILES = ["./","app.js","boot-local.js","core.js","dashboard.js","engine.js","icon.svg","index.html","logform.js","manifest.webmanifest","orders.js","parts.js","reports.js","schedule.js","style.css","team.js","today.js","voice.js"];

self.addEventListener('install', (event) => {
  // cache: 'reload' so the new version's files come from the network, not an old HTTP cache.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('maintenance-log-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return (await cache.match('./')) || Response.error();
      }
    }),
  );
});
