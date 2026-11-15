const VERSION = 'memesignals-v15';
const SHELL = ['./', './index.html', './styles.css', './app.js', './bot-strategy.js', './fresh-strategy.js', './fx.js', './bot.js',
  './vendor/lightweight-charts.standalone.production.js', './vendor/solana.bundle.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const IMG_CACHE = 'coinsignals-img';

async function trim(cache, max = 250) { const keys = await cache.keys(); for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); }

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION && k !== IMG_CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // v14: network-first (3 s timeout) for the app shell so a new version loads on the first open; cache when offline/slow.
    e.respondWith(caches.open(VERSION).then(async cache => {
      const cachedP = cache.match(req, { ignoreSearch: true }).then(c => c || (req.mode === 'navigate' ? cache.match('./index.html') : null));
      const net = fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) cache.put(req, r.clone()); return r; });
      const timeout = new Promise(res => setTimeout(() => res(null), 3000));
      try { const r = await Promise.race([net, timeout]); if (r) return r; } catch {}
      const cached = await cachedP;
      return cached || net.catch(() => new Response('offline', { status: 503 }));
    }));
    return;
  }
  // Coin logos: cache-first
  if (req.destination === 'image') {
    e.respondWith(caches.open(IMG_CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') { await cache.put(req, r.clone()); trim(cache); } return r; }
      catch { return new Response('', { status: 504 }); }
    }));
  }
  // API calls (DexScreener, GeckoTerminal, CoinGecko, Binance) go straight to network; the app caches data in localStorage.
});
