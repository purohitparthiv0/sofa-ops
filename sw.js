self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (e) => {
  // Network-first pass-through so Supabase realtime/queries are always fresh
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
