/* Offline shell.
   Vite fingerprints everything under /assets/, so those are safe to
   serve from cache forever. The HTML shells are not — a deploy
   changes them at the same URL, so they always go to the network
   first and fall back to the cache only when offline. Bump CACHE
   whenever the hand-made images in /public change. */
const CACHE = 'mdview-v5';
const SHELL = ['/', '/en/', '/install/', '/en/install/'];

/* Content-addressed or hand-versioned: safe to serve from cache. */
const IMMUTABLE = /^\/(assets\/|icon\.svg$|icon-\d+\.png$|og(-en)?\.png$|shot-[a-z]+\.png$)/;

function shellFor(pathname) {
  const english = pathname.startsWith('/en');
  if (pathname.includes('/install')) return english ? '/en/install/' : '/install/';
  return english ? '/en/' : '/';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function put(key, response) {
  if (!response.ok || response.type !== 'basic') return;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(key, copy));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            put(request, response);
            return response;
          }),
      ),
    );
    return;
  }

  /* Everything else — HTML, manifest, robots, sitemap — is
     network-first. A navigation is stored under its shell path so
     any URL in the scope has something to fall back to offline. */
  const key = request.mode === 'navigate' ? shellFor(url.pathname) : request;

  event.respondWith(
    fetch(request)
      .then((response) => {
        put(key, response);
        return response;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error())),
  );
});
