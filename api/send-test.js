// api/send-test.js
// إشعار تجريبي لأجهزة المالك فقط (زر "تجربة الإشعارات" في الإعدادات).
// - POST مع توكن الجلسة في الجسم { token }. بدون توكن المالك لا يُرسَل شيء.
const webpush = require('web-push');
const S = require('../lib/shared.js');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'يستخدم POST فقط' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const user = await S.verifyUser(body.token);
    if (!user || (await S.getRole(user.id)) !== 'owner') {
      return res.status(403).json({ ok: false, error: 'هذه الخدمة للمالك فقط' });
    }
    if (!S.envOk() || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    }
    webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);

    const subs = await S.sbAll('push_subscriptions?select=id,endpoint,subscription&order=id');
    if (!subs.length) return res.status(200).json({ ok: false, error: 'مفيش أي جهاز مسجل في جدول push_subscriptions' });

    const payload = JSON.stringify({ title: '✅ إشعار تجريبي', body: 'لو وصلك الإشعار ده، يبقى كل حاجة شغالة تمام!', url: '/', tag: 'test-notif' });
    let success = 0, failed = 0;
    const errors = [];
    for (const row of subs) {
      try {
        await webpush.sendNotification(row.subscription, payload);
        success++;
      } catch (err) {
        failed++;
        errors.push({ endpoint: String(row.endpoint || '').slice(-20), statusCode: err && err.statusCode });
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await S.sbReq(`push_subscriptions?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
        }
      }
    }
    return res.status(200).json({ ok: success > 0, success, failed, errors });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
