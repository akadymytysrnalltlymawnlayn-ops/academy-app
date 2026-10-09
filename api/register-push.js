// api/register-push.js
// تسجيل جهاز المشرفة لإشعارات الحصص (Web Push) وربطه بحسابها.
// - للمشرفات فقط. التخزين في supervisor_push_subscriptions (منفصل عن أجهزة المالك).
// - action: 'enable'  => تفعيل صريح من الزر (يرسل إشعار تأكيد)
//           'refresh' => تحديث صامت عند فتح التطبيق (بدون إشعار)
//           'remove'  => إلغاء الاشتراك لهذا الجهاز
const webpush = require('web-push');
const S = require('../lib/shared.js');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const APP_URL = process.env.APP_URL || '';

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'يستخدم POST فقط' });
    if (!S.envOk() || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { token, subscription, action } = body;

    const user = await S.verifyUser(token);
    if (!user) return res.status(403).json({ ok: false, error: 'الجلسة غير صالحة، سجّل الدخول من جديد' });
    const role = await S.getRole(user.id);
    if (role !== 'supervisor') return res.status(403).json({ ok: false, error: 'هذه الخدمة مخصصة لحسابات المشرفات' });

    if (action === 'remove') {
      const endpoint = subscription && subscription.endpoint;
      if (typeof endpoint !== 'string') return res.status(400).json({ ok: false, error: 'عنوان الاشتراك ناقص' });
      await S.sbReq(`supervisor_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${encodeURIComponent(user.id)}`, {
        method: 'DELETE', prefer: 'return=minimal'
      });
      return res.status(200).json({ ok: true, removed: true });
    }

    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys
        || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
      return res.status(400).json({ ok: false, error: 'بيانات الاشتراك ناقصة' });
    }
    if (!S.endpointAllowed(subscription.endpoint)) {
      return res.status(400).json({ ok: false, error: 'عنوان الاشتراك غير مدعوم' });
    }

    const prev = await S.sbReq(`supervisor_push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}&select=user_id`);
    const existed = prev.ok && Array.isArray(prev.data) && prev.data.length > 0;

    const up = await S.sbReq('supervisor_push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ user_id: user.id, endpoint: subscription.endpoint, subscription })
    });
    if (!up.ok) {
      const txt = typeof up.data === 'string' ? up.data : JSON.stringify(up.data || {});
      const missing = /supervisor_push_subscriptions/i.test(txt) && /(does not exist|Could not find|PGRST205|42P01)/i.test(txt);
      return res.status(500).json({ ok: false, error: missing ? 'جدول supervisor_push_subscriptions غير موجود - شغّل ملف SQL أولاً' : `تعذر الحفظ (${up.status})` });
    }

    // إشعار التأكيد: عند الضغط الصريح على التفعيل، أو عند أول تسجيل لجهاز جديد (توافق مع الإصدارات القديمة)
    const wantConfirm = action === 'enable' || (action !== 'refresh' && !existed);
    let pushed = false;
    if (wantConfirm) {
      try {
        webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);
        await webpush.sendNotification(subscription, JSON.stringify({
          title: '✅ تنبيهات الحصص مفعّلة',
          body: 'ستصلك إشعارات قبل كل حصة بـ 15 دقيقة، حتى لو كان التطبيق مغلقًا',
          url: `${APP_URL}/`, tag: 'sup-activated'
        }), { TTL: 600, urgency: 'high' });
        pushed = true;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await S.sbReq(`supervisor_push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: 'DELETE', prefer: 'return=minimal' });
          return res.status(200).json({ ok: false, error: 'الاشتراك منتهي، أعيدي تفعيل الإشعارات' });
        }
      }
    }
    return res.status(200).json({ ok: true, pushed, existed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
