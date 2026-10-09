// api/send-reminders.js
// تذكير المالك قبل الحصص القديمة (sessions) والحصص التجريبية (trials) بـ 10 دقائق.
// - يتطلب CRON_SECRET (ترويسة Authorization: Bearer <CRON_SECRET>).
// - تذكيرات المشرفات (15 دقيقة) منفصلة تمامًا في send-supervisor-reminders.js.
const webpush = require('web-push');
const S = require('../lib/shared.js');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const APP_URL = process.env.APP_URL || '';
const LEAD_MIN = 10;

module.exports = async (req, res) => {
  try {
    const auth = S.requireCron(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    if (!S.envOk() || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    }
    webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);

    const nowMs = Date.now();
    const today = S.zonedParts(new Date(nowMs));
    const tomorrow = S.zonedParts(new Date(nowMs + 24 * 3600 * 1000));

    const [sessions, trials, subs] = await Promise.all([
      S.sbAll('sessions?archived=eq.false&select=id,student_name,subjects,slots&order=id'),
      S.sbAll('trials?archived=eq.false&select=id,student_name,subject,slots&order=id'),
      S.sbAll('push_subscriptions?select=id,endpoint,subscription&order=id')
    ]);
    if (!subs.length) return res.status(200).json({ ok: true, message: 'لا يوجد أجهزة مشتركة في الإشعارات' });

    const items = [];
    const consider = (type, obj, name, subjects) => {
      for (const sl of (obj.slots || [])) {
        const hhmm = S.parseHHMM(sl && sl.time);
        if (!hhmm) continue;
        for (const d of [today, tomorrow]) {
          if (sl.day !== d.dayAr) continue;
          const deltaMin = (S.zonedToEpoch(d.dateStr, hhmm) - nowMs) / 60000;
          if (deltaMin <= 0 || deltaMin > LEAD_MIN) continue;
          items.push({ type, id: obj.id, name, subjects, hhmm, key: `${type}-${obj.id}-${d.dateStr}-${hhmm}` });
        }
      }
    };
    sessions.forEach(s => consider('session', s, s.student_name, (s.subjects || []).join('، ')));
    trials.forEach(t => consider('trial', t, t.student_name, t.subject || ''));

    if (!items.length) return res.status(200).json({ ok: true, message: 'لا توجد حصص خلال 10 دقائق', matched: 0 });

    let sentCount = 0, failed = 0, skipped = 0;
    for (const it of items) {
      let claimed = false;
      try { claimed = await S.claimKey(it.key); } catch (e) { failed++; continue; }
      if (!claimed) { skipped++; continue; }

      const payload = JSON.stringify({
        title: '🔔 تذكير: حصة بعد 10 دقائق',
        body: `${it.name || 'طالب'}${it.subjects ? ' — ' + it.subjects : ''} — الساعة ${S.fmt12(it.hhmm)}`,
        url: `${APP_URL}/?open=${it.type === 'trial' ? 'trial' : 'session'}&id=${it.id}`,
        tag: it.key, sessionId: it.id, sessionType: it.type === 'trial' ? 'trial' : 'session'
      });

      let delivered = 0;
      for (const row of subs) {
        try {
          await webpush.sendNotification(row.subscription, payload);
          delivered++; sentCount++;
        } catch (err) {
          failed++;
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            await S.sbReq(`push_subscriptions?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
          }
        }
      }
      if (!delivered) await S.releaseKey(it.key);
    }

    return res.status(200).json({ ok: true, matched: items.length, sentCount, failed, skipped });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
