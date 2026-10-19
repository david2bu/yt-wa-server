// מציג התראות פוש של רשימת הקניות, ולחיצה עליהן פותחת את הרשימה
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (_) { msg = {body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(msg.title || '🛒 רשימת קניות', {
    body: msg.body || '',
    tag: msg.tag || 'shop',
    renotify: true,
    dir: 'rtl',
    lang: 'he',
    icon: '/icon.png',
    badge: '/icon.png',
    data: {url: msg.url || '/'},
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
