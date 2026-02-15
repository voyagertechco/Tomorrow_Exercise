// static/js/sw.js (replace your file with this)
const CACHE_NAME = 'tomorrow-shell-v1';
const RUNTIME_CACHE = 'tomorrow-runtime-v1';
const PRECACHE_URLS = [
  '/',
  '/static/css/styles.css',
  '/static/js/main.js',
  '/static/js/idb.js',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png'
];

self.addEventListener('install', evt => {
  self.skipWaiting();
  evt.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', evt => {
  // clean old caches if you want (optional)
  evt.waitUntil(
    (async () => {
      clients.claim();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => {
        if (![CACHE_NAME, RUNTIME_CACHE].includes(k)) return caches.delete(k);
      }));
    })()
  );
});

self.addEventListener('fetch', evt => {
  const req = evt.request;
  const url = new URL(req.url);

  // 1) Navigation requests (SPA shell): network-first, fallback to cache (so index.html is served offline)
  if (req.mode === 'navigate') {
    evt.respondWith(
      fetch(req)
        .then(resp => {
          // Update shell cache with fresh version
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return resp;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // 2) Cache-first for same-origin video requests or .mp4 paths (avoid re-downloading)
  if (req.destination === 'video' || url.pathname.endsWith('.mp4')) {
    evt.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(req).then(cached => cached || fetch(req).then(fetchResp => {
          // only cache successful responses
          if (fetchResp && fetchResp.status === 200) cache.put(req, fetchResp.clone());
          return fetchResp;
        }))
      )
    );
    return;
  }

  // 3) For other same-origin requests: cache-first then network fallback
  if (url.origin === location.origin) {
    evt.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(networkResp => {
        // Optionally cache static GET responses (css/js/images)
        if (req.method === 'GET' && networkResp && networkResp.status === 200) {
          const ct = networkResp.headers.get('content-type') || '';
          if (ct.includes('text') || ct.includes('javascript') || ct.includes('css') || ct.includes('image')) {
            caches.open(RUNTIME_CACHE).then(cache => cache.put(req, networkResp.clone()));
          }
        }
        return networkResp;
      }).catch(() => {
        // last resort: fallback to cached shell file for navigations handled above
        return caches.match(req);
      }))
    );
    return;
  }

  // Default: network
});
// add this to the bottom of your sw.js

// helper to send a message to all clients (pages controlled by SW)
async function broadcastMessage(msg) {
  const all = await self.clients.matchAll({includeUncontrolled: true});
  for (const c of all) {
    try { c.postMessage(msg); } catch (e) { /* ignore */ }
  }
}

self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (!data || !data.cmd) return;

  if (data.cmd === 'cacheVideos' && Array.isArray(data.urls)) {
    (async () => {
      const urls = data.urls.slice(); // copy
      const cache = await caches.open('tomorrow-runtime-v1');
      broadcastMessage({ type: 'cache-start', total: urls.length });
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
          const resp = await fetch(url, {mode:'cors', credentials: 'same-origin'});
          if (resp && resp.ok) {
            await cache.put(url, resp.clone());
            broadcastMessage({ type: 'cache-progress', index: i + 1, total: urls.length, url });
          } else {
            broadcastMessage({ type: 'cache-error', index: i + 1, url, status: resp ? resp.status : 'no-response' });
          }
        } catch (err) {
          broadcastMessage({ type: 'cache-error', index: i + 1, url, error: String(err) });
        }
      }
      broadcastMessage({ type: 'cache-complete', total: urls.length });
    })();
  }
});
