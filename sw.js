/* PocketBard service worker.
   The HTML shell is fetched NETWORK-FIRST: every launch gets the current
   index.html, so it always points at asset hashes that actually exist on the
   server. (The old stale-while-revalidate served a cached shell first, and
   after a deploy that shell referenced hashes the force-push had purged —
   which loaded a blank app. Network-first can't strand itself that way.)
   Hashed assets and samples are cache-first: their names are content hashes,
   so a name maps to exactly one body and caching it forever is safe and fast.
   Offline, both fall back to whatever is cached. */
const CACHE = 'pocketbard-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    /* network-first: fresh shell when online, cached shell when offline */
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        /* cache:'no-store' bypasses the browser HTTP cache, which GitHub Pages
           sets to ~10min on index.html. Without it, "network-first" can still
           hand back a 10-min-old shell that a force-push has since stranded on
           purged asset hashes — the very blank-app bug this file exists to kill. */
        const res = await fetch(req, {cache: 'no-store'});
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) ||
               (await cache.match(url.pathname)) ||
               Response.error();
      }
    })());
    return;
  }

  /* cache-first for immutable hashed assets + samples, refresh in background */
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  })());
});
