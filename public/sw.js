const CACHE = 'rbang-v1';

// Fichiers précachés au moment de l'installation
const PRECACHE = [
  '/',
  '/index.html',
  '/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Supprimer les anciens caches
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Exclure les requêtes cross-origin (analytics, cdn externes…)
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      // Toujours tenter une mise à jour en arrière-plan
      const fetched = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached); // fallback cache si hors-ligne

      // Servir depuis le cache immédiatement si disponible,
      // sinon attendre la réponse réseau
      return cached || fetched;
    })
  );
});
