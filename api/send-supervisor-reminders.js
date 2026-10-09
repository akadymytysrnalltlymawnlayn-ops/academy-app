// api/send-supervisor-reminders.js
// تذكير المشرفات قبل كل حصة بـ 15 دقيقة (Web Push) - يعمل حتى لو التطبيق مغلق.
// - يشمل الحصص العادية من "بيانات الطلاب" والحصص المؤجلة في موعدها الجديد.
// - كل مشرفة تصلها حصص طلابها هي فقط، وتُرسل لأجهزتها فقط. المالك لا يستقبل هذه التذكيرات.
// - يُستدعى كل دقيقة من خدمة خارجية (cron-job.org) أو Vercel Cron، بترويسة: Authorization: Bearer <CRON_SECRET>
// - آمن للتكرار: كل حصة تُرسل مرة واحدة فقط (مفتاح مُحجوز في sent_reminders).
const webpush = require('web-push');
const S = require('../lib/shared.js');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const APP_URL = process.env.APP_URL || '';
const LEAD_MIN = 15;

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
    const dates = `${today.dateStr},${tomorrow.dateStr}`;

    // المشرفات الحاليات فقط (حساب المالك لا يدخل هنا أبدًا)
    const [profiles, subs] = await Promise.all([
      S.sbAll('profiles?role=eq.supervisor&select=id&order=id'),
      S.sbAll('supervisor_push_subscriptions?select=id,user_id,endpoint,subscription&order=id')
    ]);
    const supIds = new Set(profiles.map(p => p.id));
    const subsByUser = new Map();
    subs.forEach(row => {
      if (!supIds.has(row.user_id)) return;
      if (!subsByUser.has(row.user_id)) subsByUser.set(row.user_id, []);
      subsByUser.get(row.user_id).push(row);
    });
    if (!subsByUser.size) return res.status(200).json({ ok: true, message: 'لا توجد أجهزة مشرفات مشتركة' });

    // سجلات طلاب المشرفات اللواتي لديهن أجهزة فقط
    const allRecords = await S.sbAll('student_records?archived=eq.false&supervisor_id=not.is.null&select=id,student_name,subject,teacher_name,slots,supervisor_id&order=id');
    const records = allRecords.filter(r => subsByUser.has(r.supervisor_id));

    const [fuRows, copyRows] = await Promise.all([
      S.sbAll(`class_followups?attend_date=in.(${dates})&select=student_record_id,attend_date,slot_time,status&order=id`),
      S.sbAll(`class_followups?status=eq.${encodeURIComponent('تأجيل')}&postponed_to_date=in.(${dates})&select=student_record_id,attend_date,postponed_to_date,postponed_to_time&order=id`)
    ]);

    const due = S.buildDueSessions({ nowMs, lead: LEAD_MIN, records, fuRows, copyRows });

    if (req.query && req.query.dry) {
      return res.status(200).json({
        ok: true, dry: true,
        due: due.map(d => ({ key: d.key, supervisor: d.record.supervisor_id, kind: d.kind, startsInMin: Math.round(d.deltaMin * 10) / 10 }))
      });
    }
    if (!due.length) return res.status(200).json({ ok: true, message: 'لا توجد حصص خلال 15 دقيقة', due: 0 });

    // تجميع: كل مشرفة × موعد بدء واحد = إشعار واحد
    const groups = new Map();
    for (const d of due) {
      const g = `${d.record.supervisor_id}|${d.startMs}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(d);
    }

    let sent = 0, failed = 0, skipped = 0, groupsSent = 0;
    for (const items of groups.values()) {
      const supId = items[0].record.supervisor_id;

      // حجز كل مفتاح قبل الإرسال (لو سبق حجزه = تم إرساله أو قيد الإرسال)
      const claimed = [];
      for (const it of items) {
        try {
          if (await S.claimKey(it.key)) claimed.push(it);
          else skipped++;
        } catch (e) { failed++; }
      }
      if (!claimed.length) continue;

      const first = claimed[0];
      const names = claimed.map(i => i.record.student_name || 'طالب');
      const shown = names.slice(0, 4).join('، ') + (names.length > 4 ? ` و${names.length - 4} آخرين` : '');
      const anyCopy = claimed.some(i => i.kind === 'copy');
      const mins = Math.max(1, Math.ceil(first.deltaMin));
      const title = (claimed.length === 1
        ? `⏰ حصتك تبدأ بعد ${S.minutesText(mins)}`
        : `⏰ ${S.classesText(claimed.length)} تبدأ بعد ${S.minutesText(mins)}`) + (anyCopy ? ' (مؤجلة)' : '');
      const body = claimed.length === 1
        ? `${names[0]}${first.record.subject ? ' • ' + first.record.subject : ''} — الساعة ${S.fmt12(first.hhmm)}`
        : `${shown} — الساعة ${S.fmt12(first.hhmm)}`;
      const payload = JSON.stringify({ title, body, url: `${APP_URL}/`, tag: `sup-${first.dateStr}-${first.hhmm}-${supId}` });

      let delivered = 0;
      for (const row of (subsByUser.get(supId) || [])) {
        try {
          await webpush.sendNotification(row.subscription, payload, { TTL: LEAD_MIN * 60, urgency: 'high' });
          delivered++;
        } catch (err) {
          failed++;
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            await S.sbReq(`supervisor_push_subscriptions?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
          }
        }
      }
      if (delivered) { sent += delivered; groupsSent++; }
      else {
        // لم يصل لأي جهاز: نفك الحجز لتتم المحاولة في الدقيقة التالية (طالما الحصة لم تبدأ بعد)
        for (const it of claimed) await S.releaseKey(it.key);
      }
    }

    return res.status(200).json({ ok: true, due: due.length, groups: groups.size, groupsSent, sent, skipped, failed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
