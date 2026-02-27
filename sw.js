const CACHE_NAME = 'folio-v1.0';
const PRECACHE_URLS = [
  '/folio/',
  '/folio/index.html',
  '/folio/manifest.json'
];

const RUNTIME_CACHE_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://www.gstatic.com/firebasejs'
];

const IMAGE_CACHE = 'folio-images-v1';
const IMAGE_CACHE_LIMIT = 100;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== IMAGE_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('firebaseauth') || url.hostname.includes('firestore') || url.hostname.includes('googleapis.com/identitytoolkit') || url.hostname.includes('securetoken')) return;
  if (url.hostname.includes('api.unsplash.com')) return;

  if (url.hostname.includes('images.unsplash.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(IMAGE_CACHE).then(async cache => {
              cache.put(event.request, clone);
              const keys = await cache.keys();
              if (keys.length > IMAGE_CACHE_LIMIT) await cache.delete(keys[0]);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  if (RUNTIME_CACHE_ORIGINS.some(origin => event.request.url.startsWith(origin))) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
});
