// Service worker для «Мой Бюджет».
// Сеть в приоритете, кэш — только офлайн-подстраховка: так уже открытое
// приложение не залипает на старой версии после обновления кода.
const C = 'mb-v3';
const ASSETS = ['.', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== C).map(k => caches.delete(k)))),
  ]));
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(C).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
