// api/register-push.js
// تسجيل جهاز المشرفة لإشعارات الحصص (Web Push) وربطه بحسابها.
// - مخصص للمشرفات فقط (حساب المالك يستخدم نظامه الحالي دون أي تغيير).
// - يُخزَّن في جدول منفصل supervisor_push_subscriptions حتى لا تصل إشعارات المالك (send-reminders / send-test) لأجهزة المشرفات.
const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const APP_URL = process.env.APP_URL || '';

// حماية: نقبل فقط عناوين خدمات الإشعارات المعروفة (Chrome / Firefox / Safari / Edge)
const ALLOWED_PUSH_HOSTS = ['googleapis.com', 'mozilla.com', 'apple.com', 'windows.com', 'microsoft.com'];
function endpointAllowed(ep) {
  try {
    const u = new URL(ep);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return ALLOWED_PUSH_HOSTS.some(d => h === d || h.endsWith('.' + d));
  } catch (e) { return false; }
}

const svcHeaders = (extra = {}) => ({
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra
});

async function verifySupervisor(token) {
  if (!token) return { error: 'غير مسجل الدخول' };
  const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
  });
  if (!uRes.ok) return { error: 'الجلسة غير صالحة، سجّل الدخول من جديد' };
  const user = await uRes.json();
  const pRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, { headers: svcHeaders() });
  const rows = await pRes.json();
  const role = rows && rows[0] && rows[0].role;
  if (role !== 'supervisor') return { error: 'هذه الخدمة مخصصة لحسابات المشرفات' };
  return { userId: user.id };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'يستخدم POST فقط' });
    if (!SUPABASE_URL || !SERVICE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { token, subscription, action } = body;

    const v = await verifySupervisor(token);
    if (v.error) return res.status(403).json({ ok: false, error: v.error });

    if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.keys) {
      return res.status(400).json({ ok: false, error: 'بيانات الاشتراك ناقصة' });
    }
    if (!endpointAllowed(subscription.endpoint)) {
      return res.status(400).json({ ok: false, error: 'عنوان الاشتراك غير مدعوم' });
    }

    if (action === 'remove') {
      await fetch(`${SUPABASE_URL}/rest/v1/supervisor_push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}&user_id=eq.${encodeURIComponent(v.userId)}`, {
        method: 'DELETE', headers: svcHeaders({ 'Prefer': 'return=minimal' })
      });
      return res.status(200).json({ ok: true, removed: true });
    }

    // تسجيل/تحديث الجهاز (نفس الجهاز لو سجّلت منه مشرفة أخرى يُربط بالمشرفة الحالية)
    const up = await fetch(`${SUPABASE_URL}/rest/v1/supervisor_push_subscriptions?on_conflict=endpoint`, {
      method: 'POST',
      headers: svcHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({ user_id: v.userId, endpoint: subscription.endpoint, subscription })
    });
    if (!up.ok) {
      const txt = await up.text();
      const missing = /supervisor_push_subscriptions/i.test(txt) && /(does not exist|Could not find|PGRST205|42P01)/i.test(txt);
      return res.status(500).json({ ok: false, error: missing ? 'جدول supervisor_push_subscriptions غير موجود - نفّذ كود SQL أولاً' : `تعذر الحفظ (${up.status})` });
    }

    // إشعار تأكيد فوري يثبت أن الإشعارات تصل لهذا الجهاز
    let pushed = false;
    try {
      webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);
      await webpush.sendNotification(subscription, JSON.stringify({
        title: '✅ تنبيهات الحصص مفعّلة',
        body: 'ستصلك إشعارات قبل كل حصة بـ 15 دقيقة حتى لو كان التطبيق مغلقًا',
        url: `${APP_URL}/`, tag: 'sup-activated'
      }), { TTL: 600, urgency: 'high' });
      pushed = true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await fetch(`${SUPABASE_URL}/rest/v1/supervisor_push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, {
          method: 'DELETE', headers: svcHeaders({ 'Prefer': 'return=minimal' })
        });
        return res.status(200).json({ ok: false, error: 'الاشتراك منتهي، أعيدي تفعيل الإشعارات' });
      }
    }
    return res.status(200).json({ ok: true, pushed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
