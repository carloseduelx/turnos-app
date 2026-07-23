const CACHE = 'turnos-v14';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Dominios de librerías externas que queremos guardar para uso sin conexión
const CDN_HOSTS = [
  'www.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Llamadas a la base de datos: siempre red (no tiene sentido cachearlas)
  const isDatabase = url.hostname.includes('firebaseio.com')
    || url.hostname.includes('firebasedatabase.app')
    || url.hostname.includes('googleapis.com');

  if (isDatabase) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Librerías externas (Firebase SDK, Chart.js, fuentes...): cache primero, y refresca en segundo plano
  if (CDN_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(resp => {
          if (resp && (resp.status === 200 || resp.type === 'opaque')) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Archivos propios de la app: cache primero
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) {
        // Refrescar en segundo plano
        fetch(e.request).then(resp => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
