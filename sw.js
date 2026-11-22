/* Ваш Доктор — Service Worker.  __BUILD__ подставляется при публикации (см. .github/workflows/site.yml) */
const BUILD = '__BUILD__';
const SHELL = 'vd-shell-' + BUILD;
const DATA = 'vd-data';          // данные врачей живут отдельно и переживают обновления оболочки
const PRECACHE = [
  './', 'index.html', 'pwa-extras.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'data/doctors.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL).then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('vd-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const networkFirst = async (req, cacheName, timeoutMs) => {
  const cache = await caches.open(cacheName);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(req, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
};

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // внешние сайты (запись, vash-doc.ru) не трогаем

  // Данные врачей: сначала сеть (свежее), при отсутствии связи — последняя сохранённая копия
  if (url.pathname.includes('/data/')) {
    e.respondWith(networkFirst(req, DATA, 5000).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // Страница: сеть → кэш (чтобы обновления доходили сразу), офлайн — из кэша
  if (req.mode === 'navigate') {
    e.respondWith(
      networkFirst(new Request('index.html'), SHELL, 4000)
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }
  // Остальное (картинки, иконки, скрипты): из кэша, при промахе — сеть и сохранение
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
