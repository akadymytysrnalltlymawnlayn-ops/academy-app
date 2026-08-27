// Service Worker لأكاديمية يسرنا - مسؤول عن استقبال إشعارات الدفع (Push) وعرضها حتى لو التطبيق مقفول

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'تذكير', body: event.data ? event.data.text() : '' }; }

  const title = data.title || '🔔 تذكير بموعد حصة';
  const options = {
    body: data.body || '',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    dir: 'rtl',
    lang: 'ar',
    tag: data.tag || 'session-reminder',
    data: { url: data.url || '/', sessionId: data.sessionId || null, sessionType: data.sessionType || null },
    requireInteraction: true
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// عند الضغط على الإشعار: افتح التطبيق (أو ركّز عليه لو مفتوح بالفعل) على تفاصيل الحصة
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_SESSION', payload: event.notification.data });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
