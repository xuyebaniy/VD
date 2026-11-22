/* Public offline shell only. Patient API, credentials and documents are never cached. */
const VERSION = 'vd-shell-2026-11-22-demo-v15';
const DATA_CACHE = 'vd-public-directory-v5';
const SHELL = [
  '', 'index.html', 'manifest.webmanifest', 'icons/app-icon.svg', 'icons/apple-touch-icon.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'data/doctors.json', 'booking-widget.html',
  'pwa-updates.js', 'cabinet-demo.js', 'doctor-cabinet.js', 'doctor-cabinet.css', 'patient-cabinet.js', 'patient-cabinet.css'
];
const SCOPE = new URL(self.registration.scope);
function publicPath(url) {
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
  const path = url.pathname.slice(SCOPE.pathname.length);
  return SHELL.includes(path) || /^assets\/doctors\/[a-f0-9]{18}\.webp$/.test(path) ? path : null;
}
function cacheable(response) {
  return response.ok && response.type !== 'opaque' &&
    !/\b(no-store|private)\b/i.test(response.headers.get('Cache-Control') || '');
}
function canonical(url) { const clean = new URL(url); clean.search = ''; clean.hash = ''; return clean.href; }
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const results = await Promise.allSettled(SHELL.map(async path => {
      const url = new URL(path || './', SCOPE).href;
      const response = await fetch(url,{cache:'no-store',credentials:'omit'});
      if (!cacheable(response)) throw new Error('Public shell unavailable: ' + path);
      await cache.put(url,response);
    }));
    for (const required of ['', 'index.html', 'cabinet-demo.js', 'doctor-cabinet.js', 'doctor-cabinet.css', 'patient-cabinet.js', 'patient-cabinet.css']) {
      if (results[SHELL.indexOf(required)].status !== 'fulfilled') throw new Error('Required shell missing: ' + required);
    }
    try {
      const response = await fetch(new URL('data/doctors.json',SCOPE),{cache:'no-store',credentials:'omit'});
      const catalog = await response.json();
      const photos = (catalog.doctors || []).map(d => d.photo).filter(p => /^assets\/doctors\/[a-f0-9]{18}\.webp$/.test(p));
      await Promise.allSettled(photos.map(async path => {
        const url = new URL(path,SCOPE).href, photo = await fetch(url,{credentials:'omit'});
        if (cacheable(photo)) await cache.put(url,photo);
      }));
    } catch (_) {}
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k =>
      (k.startsWith('vd-shell-') || k.startsWith('vd-original-') || k.startsWith('vd-public-directory-')) &&
      k !== VERSION && k !== DATA_CACHE).map(k => caches.delete(k)));
    const directory = await caches.open(DATA_CACHE);
    for (const request of await directory.keys()) {
      if (publicPath(new URL(request.url)) !== 'data/doctors.json') await directory.delete(request);
    }
    await self.clients.claim();
  })());
});
async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName), key = canonical(request.url);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),timeoutMs);
  try {
    const response = await fetch(request,{signal:controller.signal,cache:'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (cacheable(response)) await cache.put(key,response.clone());
    return response;
  } catch (error) {
    const prior = await cache.match(key) || await caches.match(key);
    if (prior) return prior;
    throw error;
  } finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url), path = publicPath(url);
  if (path === null) return;
  if (path === 'data/doctors.json') {
    event.respondWith(networkFirst(request,DATA_CACHE,5500).catch(() =>
      new Response('{"ok":false,"doctors":[]}',{status:503,headers:{'Content-Type':'application/json; charset=utf-8'}})));
    return;
  }
  if (request.mode === 'navigate' || /\.(js|css|webmanifest)$/.test(path)) {
    event.respondWith(networkFirst(request,VERSION,5500).catch(async () => {
      if (path === '' || path === 'index.html') {
        const fallback = await caches.match(new URL('index.html',SCOPE).href);
        if (fallback) return fallback;
      }
      return new Response('Откройте приложение с интернетом, чтобы загрузить обновление.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(VERSION), key = canonical(request.url);
    const prior = await cache.match(key);
    if (prior) return prior;
    const response = await fetch(request);
    if (cacheable(response)) await cache.put(key,response.clone());
    return response;
  })());
});
