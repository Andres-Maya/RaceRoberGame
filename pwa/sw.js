// Service worker de Turbo Ratas: guarda el juego completo en el teléfono para
// que abra sin internet (por ejemplo, jugando por hotspot). El build rellena la
// versión y la lista de archivos generados (vite.config.ts).
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = `race-robber-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Borra las versiones anteriores del juego.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('race-robber-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === '/lan-info' || url.pathname === '/relay') return;

  // La página: primero la red (para recibir actualizaciones) y sin conexión, la guardada.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/', { ignoreSearch: true }).then((hit) => hit || caches.match('/index.html'))),
    );
    return;
  }

  // Archivos del juego (con nombre único por versión): primero la copia guardada.
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
