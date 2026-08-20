/* Offline shell.
   HTML is refreshed network-first. Fingerprinted Vite assets and the
   hand-versioned public files below are safe to serve cache-first. */
const CACHE_PREFIX = 'mdview-';
const CACHE = 'mdview-v9';

const SHELLS = ['/', '/en/', '/install/', '/en/install/'];
const CORE = [
  ...SHELLS,
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icon.svg',
  '/icon-96.png',
  '/icon-192.png',
  '/icon-512.png',
  '/samples/welcome.ko.md',
  '/samples/welcome.en.md',
];

const PUBLIC_STATIC = new Set([
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icon.svg',
  '/icon-96.png',
  '/icon-192.png',
  '/icon-512.png',
  '/og.png',
  '/og-en.png',
  '/shot-wide.png',
  '/shot-narrow.png',
  '/samples/welcome.ko.md',
  '/samples/welcome.en.md',
]);

const BUILT_ASSET = /^\/assets\/[a-zA-Z0-9_./-]+$/;

function shellFor(pathname) {
  const english = pathname === '/en' || pathname.startsWith('/en/');
  if (pathname.includes('/install')) return english ? '/en/install/' : '/install/';
  return english ? '/en/' : '/';
}

function isBuiltAsset(pathname) {
  return BUILT_ASSET.test(pathname) && !pathname.includes('..');
}

function isStatic(pathname) {
  return isBuiltAsset(pathname) || PUBLIC_STATIC.has(pathname);
}

function isCacheable(response, expectedType) {
  if (!response.ok || response.type !== 'basic') return false;
  if (new URL(response.url).origin !== self.location.origin) return false;
  if (!expectedType) return true;
  return (response.headers.get('content-type') || '').toLowerCase().includes(expectedType);
}

/* Vite fingerprints the JS and CSS filenames at build time. Discover
   those names from the HTML that was actually cached rather than
   duplicating build output in this hand-written worker. */
async function discoverBuiltAssets(cache) {
  const assets = new Set();

  for (const shell of SHELLS) {
    const response = await cache.match(shell);
    if (!response) throw new Error(`missing precached shell: ${shell}`);

    const html = await response.text();
    const base = new URL(shell, self.location.origin);
    const references = html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi);

    for (const match of references) {
      const url = new URL(match[1], base);
      if (url.origin === self.location.origin && isBuiltAsset(url.pathname)) {
        assets.add(url.pathname);
      }
    }
  }

  return [...assets];
}

/* Follow Vite's relative static/dynamic imports as well. The syntax
   highlighter is intentionally lazy, but a fresh installation should still
   be able to load it when the network disappears before first use. */
async function precacheBuiltGraph(cache, entryPaths, reload) {
  const seen = new Set();
  let pending = entryPaths.filter((path) => isBuiltAsset(path));

  while (pending.length) {
    const batch = [...new Set(pending.filter((path) => !seen.has(path)))];
    pending = [];
    if (!batch.length) break;

    batch.forEach((path) => seen.add(path));
    await cache.addAll(batch.map(reload));

    for (const path of batch) {
      if (!path.endsWith('.js')) continue;
      const response = await cache.match(path);
      if (!response) throw new Error(`missing precached asset: ${path}`);

      const source = await response.text();
      for (const match of source.matchAll(/["'`](\.\/[a-zA-Z0-9_./-]+\.(?:js|css))["'`]/g)) {
        const url = new URL(match[1], new URL(path, self.location.origin));
        if (url.origin === self.location.origin && isBuiltAsset(url.pathname) && !seen.has(url.pathname)) {
          pending.push(url.pathname);
        }
      }
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const reload = (url) => new Request(url, { cache: 'reload' });

      /* Any failed response rejects installation, leaving the currently
         active worker and its complete cache untouched. */
      await cache.addAll(CORE.map(reload));

      const assets = await discoverBuiltAssets(cache);
      await precacheBuiltGraph(cache, assets, reload);
    })(),
  );
});

/* Updates wait until the page's update affordance explicitly opts in.
   This prevents an in-progress document session from being replaced. */
self.addEventListener('message', (event) => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;
  if (type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

async function cacheFirstStatic(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (isCacheable(response)) await cache.put(request, response.clone());
  return response;
}

async function networkFirstNavigation(request, url) {
  const cache = await caches.open(CACHE);
  const shell = shellFor(url.pathname);

  try {
    const response = await fetch(request);

    if (response.status >= 500) {
      return (await cache.match(shell)) || response;
    }

    /* Only canonical app shells may replace an offline shell entry.
       Unknown same-origin routes are returned but never persisted. */
    if (SHELLS.includes(url.pathname) && isCacheable(response, 'text/html')) {
      await cache.put(shell, response.clone());
    }
    return response;
  } catch {
    return (await cache.match(shell)) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request, url));
    return;
  }

  /* Avoid caching arbitrary endpoints or query-key variants. All Vite
     assets are fingerprinted and the public resources are explicit. */
  if (!url.search && isStatic(url.pathname)) {
    event.respondWith(cacheFirstStatic(request));
  }
});
