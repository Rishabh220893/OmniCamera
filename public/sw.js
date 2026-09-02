self.addEventListener('install', (e) => {
  console.log('[Service Worker] Install');
});

// Only substitutes an offline page for top-level page navigations. Doing
// this for every fetch (as before) turned a failed API/WHEP request into a
// 200 OK response with body "Offline" instead of a rejected promise — the
// client code's .catch()/retry/backoff paths never saw it, since a 200 with
// a truthy body reads as success, not failure.
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(() => {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
