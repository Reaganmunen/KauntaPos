/* Kaunta service worker: shows a notification when a shopper messages the shop, even if Kaunta is closed.
   No caching on purpose: pages always come fresh from the server. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New customer message', {
    body: d.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/favicon-32.png',
    tag: d.tag || 'kaunta-chat',      /* a second message from the same shopper replaces the first */
    renotify: true,
    data: { url: d.url || '/chat.html' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/chat.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
        return c.focus().then(function (w) { return w && 'navigate' in w ? w.navigate(url) : null; });
      }
    }
    return self.clients.openWindow(url);
  }));
});
