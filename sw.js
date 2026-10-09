// Service Worker لأكاديمية يسرنا - مسؤول عن استقبال إشعارات الدفع (Push) وعرضها حتى لو التطبيق مقفول
// + (جديد) مسح أي كاش قديم وإجبار الأجهزة على سحب آخر نسخة من التطبيق فور تثبيت هذا الملف.
// رقم الإصدار: غيّره (أو غيّر أي حرف في الملف) في أي تحديث قادم لتُجبر الأجهزة على التحديث من جديد.
const SW_BUILD = '20261009-1';

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

// ---------- التثبيت: تفعيل النسخة الجديدة فورًا بدون انتظار إغلاق التطبيق ----------
let isUpdateInstall = false;
self.addEventListener('install', () => {
  isUpdateInstall = !!self.registration.active; // true = يوجد Service Worker قديم يتم استبداله (تحديث) | false = أول تثبيت
  self.skipWaiting();
});

// ---------- التفعيل: مسح الكاش القديم + السيطرة على كل النوافذ + إجبار التحديث ----------
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 1) مسح أي كاش قديم نهائيًا
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (e) { /* تجاهل */ }

    // 2) السيطرة على كل النوافذ المفتوحة فورًا
    await self.clients.claim();

    // 3) عند التحديث فقط (وليس عند أول تثبيت): إجبار النوافذ على سحب آخر نسخة
    //    - النافذة المخفية (التطبيق في الخلفية): تُعاد تحميلها مباشرة بصمت.
    //    - النافذة الظاهرة: تصلها رسالة، والتطبيق يعيد التحميل في أول لحظة لا يكتب فيها المستخدم (حتى لا تضيع بياناته).
    if (!isUpdateInstall) return;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(wins.map(async c => {
      try {
        if (c.visibilityState === 'visible') c.postMessage({ type: 'FORCE_UPDATE', build: SW_BUILD });
        else await c.navigate(c.url);
      } catch (e) {
        try { c.postMessage({ type: 'FORCE_UPDATE', build: SW_BUILD }); } catch (e2) { /* تجاهل */ }
      }
    }));
  })());
});
