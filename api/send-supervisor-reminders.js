// api/send-supervisor-reminders.js
// تذكير المشرفات قبل موعد كل حصة بـ 15 دقيقة (Web Push) - يعمل حتى لو التطبيق مغلق.
// - يقرأ مواعيد الحصص من جدول student_records (نفس مواعيد "بيانات الطلاب" التي تظهر في الجدولة).
// - كل مشرفة تصلها حصص الطلاب الذين أضافتهم هي فقط (student_records.supervisor_id)، وتُرسل لأجهزتها فقط.
// - مستقل تمامًا عن send-reminders.js الخاص بالمالك (لا يقرأ ولا يكتب في جداوله ولا يرسل لأجهزته).
// - يجب استدعاؤه كل دقيقة (نفس طريقة استدعاء send-reminders).
const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Africa/Cairo';
const APP_URL = process.env.APP_URL || '';
const CRON_SECRET = process.env.CRON_SECRET || ''; // اختياري: لو ضبطته يُشترط ?key=... أو Authorization: Bearer ...

const LEAD_MIN = 15; // قبل بدء الحصة بكم دقيقة
const EN_TO_AR_DAY = {
  'Saturday': 'السبت', 'Sunday': 'الأحد', 'Monday': 'الاثنين', 'Tuesday': 'الثلاثاء',
  'Wednesday': 'الأربعاء', 'Thursday': 'الخميس', 'Friday': 'الجمعة'
};

async function sbRaw(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, ok: res.ok, data };
}
async function sb(path, opts) {
  const r = await sbRaw(path, opts);
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`);
  return r.data;
}
// جلب كل الصفوف على دفعات (Supabase يقص النتيجة عند 1000 صف)
async function sbAll(path) {
  const out = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const rows = await sb(`${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${offset}`);
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function tzParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour12: false,
    weekday: 'long', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const m = {};
  parts.forEach(p => { m[p.type] = p.value; });
  return {
    dayAr: EN_TO_AR_DAY[m.weekday],
    minutes: (parseInt(m.hour, 10) % 24) * 60 + parseInt(m.minute, 10), // % 24 لأن بعض الإصدارات ترجع 24 عند منتصف الليل
    dateStr: `${m.year}-${m.month}-${m.day}`
  };
}
function parseMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  return (h > 23 || mi > 59) ? null : h * 60 + mi;
}
function fmt12(min) {
  let h = Math.floor(min / 60) % 24; const m = min % 60;
  const ap = h >= 12 ? 'م' : 'ص';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
function minutesText(n) { if (n <= 1) return 'دقيقة واحدة'; if (n === 2) return 'دقيقتين'; if (n <= 10) return `${n} دقائق`; return `${n} دقيقة`; }
function classesText(n) { if (n === 2) return 'حصتان'; if (n <= 10) return `${n} حصص`; return `${n} حصة`; }

module.exports = async (req, res) => {
  try {
    if (CRON_SECRET) {
      const given = (req.query && req.query.key) || '';
      const bearer = (req.headers && req.headers.authorization) || '';
      if (given !== CRON_SECRET && bearer !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'غير مصرح' });
    }
    if (!SUPABASE_URL || !SUPABASE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
      return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    }
    webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);
    const dry = !!(req.query && req.query.dry);

    const now = new Date();
    const today = tzParts(now);
    const tomorrow = tzParts(new Date(now.getTime() + 24 * 3600 * 1000));

    // المشرفات الحاليات فقط (سجلات المالك أو مشرفة محذوفة لا يُرسل لها شيء)
    const sups = await sb('profiles?role=eq.supervisor&select=id');
    const supIds = new Set((sups || []).map(p => p.id));

    let subsRows = [];
    const subsRes = await sbRaw('supervisor_push_subscriptions?select=*');
    if (!subsRes.ok) {
      return res.status(200).json({ ok: false, error: 'جدول supervisor_push_subscriptions غير موجود أو غير متاح - نفّذ كود SQL أولاً', status: subsRes.status });
    }
    subsRows = subsRes.data || [];
    const subsByUser = new Map();
    subsRows.forEach(r => { if (!subsByUser.has(r.user_id)) subsByUser.set(r.user_id, []); subsByUser.get(r.user_id).push(r); });
    if (!subsByUser.size) return res.status(200).json({ ok: true, message: 'لا توجد أجهزة مشرفات مشتركة بعد' });

    const records = await sbAll('student_records?archived=eq.false&supervisor_id=not.is.null&select=id,student_name,subject,teacher_name,slots,supervisor_id&order=id');

    // متابعات اليوم وغدًا: لو الحصة مسجّلة بحالة (مثل تأجيل مسبق) لا داعي للتنبيه
    const doneSet = new Set();
    const fuRes = await sbRaw(`class_followups?attend_date=in.(${today.dateStr},${tomorrow.dateStr})&select=student_record_id,attend_date,slot_time,status`);
    if (fuRes.ok && Array.isArray(fuRes.data)) {
      fuRes.data.forEach(f => { if (f.status) doneSet.add(`${f.student_record_id}|${f.attend_date}|${String(f.slot_time || '').slice(0, 5)}`); });
    }

    // الحصص المستحقة: تبدأ خلال (0 - 15] دقيقة من الآن (تغطية اليوم وغدًا لحصص ما بعد منتصف الليل)
    const due = [];
    for (const r of records) {
      if (!supIds.has(r.supervisor_id) || !subsByUser.has(r.supervisor_id)) continue;
      for (const sl of (r.slots || [])) {
        const S = parseMin(sl && sl.time);
        if (S == null) continue;
        for (const d of [{ p: today, off: 0 }, { p: tomorrow, off: 1440 }]) {
          if (sl.day !== d.p.dayAr) continue;
          const delta = S + d.off - today.minutes;
          if (delta <= 0 || delta > LEAD_MIN) continue;
          const hhmm = String(sl.time).slice(0, 5);
          if (doneSet.has(`${r.id}|${d.p.dateStr}|${hhmm}`)) continue;
          due.push({ r, startMin: S, delta, date: d.p.dateStr, hhmm, key: `sup-${r.id}-${d.p.dateStr}-${hhmm}` });
        }
      }
    }
    if (!due.length) return res.status(200).json({ ok: true, message: 'لا توجد حصص خلال 15 دقيقة', today: today.dayAr, nowMin: today.minutes });

    // استبعاد ما سبق إرساله
    const keysIn = due.map(x => `"${x.key}"`).join(',');
    const sentRes = await sbRaw(`sent_reminders?reminder_key=in.(${encodeURIComponent(keysIn)})&select=reminder_key`);
    const already = new Set(((sentRes.ok && sentRes.data) || []).map(x => x.reminder_key));
    const fresh = due.filter(x => !already.has(x.key));

    // تجميع: كل مشرفة × موعد بدء واحد = إشعار واحد
    const groups = new Map();
    fresh.forEach(x => {
      const g = `${x.r.supervisor_id}|${x.date}|${x.hhmm}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    });

    if (dry) {
      return res.status(200).json({ ok: true, dry: true, groups: [...groups.entries()].map(([k, items]) => ({ group: k, students: items.map(i => i.r.student_name), minutesLeft: items[0].delta })) });
    }

    let sent = 0, failed = 0, skipped = 0;
    for (const [gk, items] of groups) {
      const supId = gk.split('|')[0];
      // حجز مفاتيح التذكير قبل الإرسال لمنع التكرار (409 = مرسل من قبل)
      const claimed = [];
      for (const it of items) {
        const c = await sbRaw('sent_reminders', { method: 'POST', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ reminder_key: it.key }) });
        if (c.status === 409) { skipped++; continue; }
        if (!c.ok) throw new Error(`Supabase ${c.status}: ${JSON.stringify(c.data)}`);
        claimed.push(it);
      }
      if (!claimed.length) continue;

      const first = claimed[0];
      const names = claimed.map(i => i.r.student_name || 'طالب');
      const shown = names.slice(0, 4).join('، ') + (names.length > 4 ? ` و${names.length - 4} آخرين` : '');
      const title = claimed.length === 1
        ? `⏰ حصتك تبدأ بعد ${minutesText(first.delta)}`
        : `⏰ ${classesText(claimed.length)} تبدأ بعد ${minutesText(first.delta)}`;
      const body = claimed.length === 1
        ? `${names[0]}${first.r.subject ? ' • ' + first.r.subject : ''} — الساعة ${fmt12(first.startMin)}`
        : `${shown} — الساعة ${fmt12(first.startMin)}`;
      const payload = JSON.stringify({ title, body, url: `${APP_URL}/`, tag: `sup-${first.date}-${first.hhmm}` });

      let ok = 0;
      for (const row of (subsByUser.get(supId) || [])) {
        try {
          await webpush.sendNotification(row.subscription, payload, { TTL: LEAD_MIN * 60, urgency: 'high' });
          ok++;
        } catch (err) {
          failed++;
          if (err.statusCode === 410 || err.statusCode === 404) {
            await sbRaw(`supervisor_push_subscriptions?id=eq.${row.id}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
          }
        }
      }
      sent += ok;
      if (!ok) {
        // لم يصل لأي جهاز: نفك الحجز لتتم إعادة المحاولة في الدقيقة التالية (طالما الحصة لم تبدأ)
        for (const it of claimed) await sbRaw(`sent_reminders?reminder_key=eq.${encodeURIComponent(it.key)}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
      }
    }
    return res.status(200).json({ ok: true, groups: groups.size, sent, failed, skipped });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
