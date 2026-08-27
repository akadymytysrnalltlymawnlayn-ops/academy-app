const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

module.exports = async (req, res) => {
  const diag = { envCheck: {}, steps: [] };
  try {
    diag.envCheck = {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_ANON_KEY: !!SUPABASE_KEY,
      VAPID_PUBLIC_KEY: !!VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: !!VAPID_PRIVATE
    };
    if (!SUPABASE_URL || !SUPABASE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel', diag });
    }

    webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);

    const subs = await sb('push_subscriptions?select=*');
    diag.subscriptionsFound = subs ? subs.length : 0;

    if (!subs || !subs.length) {
      return res.status(200).json({ ok: false, error: 'مفيش أي جهاز مسجل في جدول push_subscriptions', diag });
    }

    const payload = JSON.stringify({
      title: '✅ إشعار تجريبي',
      body: 'لو وصلك الإشعار ده، يبقى كل حاجة شغالة تمام!',
      url: '/', tag: 'test-notif'
    });

    let success = 0, failed = 0;
    const errors = [];
    for (const row of subs) {
      try {
        await webpush.sendNotification(row.subscription, payload);
        success++;
      } catch (err) {
        failed++;
        errors.push({ endpoint: row.endpoint.slice(-20), statusCode: err.statusCode, message: err.message });
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sb(`push_subscriptions?id=eq.${row.id}`, { method: 'DELETE', prefer: 'return=minimal' });
        }
      }
    }

    return res.status(200).json({ ok: success > 0, success, failed, errors, diag });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, diag });
  }
};
