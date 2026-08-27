const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Africa/Cairo';
const APP_URL = process.env.APP_URL || '';

const DAYS = ["الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"]; // ترتيب getDay() الأصلي (0=الأحد)

webpush.setVapidDetails('mailto:admin@yusrana.com', VAPID_PUBLIC, VAPID_PRIVATE);

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
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

function nowInTimezone() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour12: false,
    weekday: 'long', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  return { weekdayEn: map.weekday, hour: map.hour, minute: map.minute, dateStr: `${map.year}-${map.month}-${map.day}` };
}

const EN_TO_AR_DAY = {
  'Saturday': 'السبت', 'Sunday': 'الأحد', 'Monday': 'الاثنين', 'Tuesday': 'الثلاثاء',
  'Wednesday': 'الأربعاء', 'Thursday': 'الخميس', 'Friday': 'الجمعة'
};

function addMinutes(hour, minute, addMin) {
  let total = parseInt(hour, 10) * 60 + parseInt(minute, 10) + addMin;
  total = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = async (req, res) => {
  try {
    const { weekdayEn, hour, minute, dateStr } = nowInTimezone();
    const todayAr = EN_TO_AR_DAY[weekdayEn];
    const targetTime = addMinutes(hour, minute, 10); // الوقت بعد 10 دقايق من دلوقتي

    const [sessions, trials, subs] = await Promise.all([
      sb(`sessions?archived=eq.false&select=*`),
      sb(`trials?archived=eq.false&select=*`),
      sb(`push_subscriptions?select=*`)
    ]);

    if (!subs || !subs.length) {
      return res.status(200).json({ ok: true, message: 'لا يوجد أجهزة مشتركة في الإشعارات بعد' });
    }

    const dueItems = [];
    (sessions || []).forEach(s => {
      (s.slots || []).forEach(sl => {
        if (sl.day === todayAr && sl.time === targetTime) {
          dueItems.push({ type: 'session', id: s.id, studentName: s.student_name, subjects: (s.subjects || []).join('، '), time: sl.time });
        }
      });
    });
    (trials || []).forEach(t => {
      (t.slots || []).forEach(sl => {
        if (sl.day === todayAr && sl.time === targetTime) {
          dueItems.push({ type: 'trial', id: t.id, studentName: t.student_name, subjects: t.subject || '', time: sl.time });
        }
      });
    });

    if (!dueItems.length) {
      return res.status(200).json({ ok: true, message: 'لا توجد حصص خلال 10 دقائق', targetTime, todayAr });
    }

    let sentCount = 0;
    for (const item of dueItems) {
      const reminderKey = `${item.type}-${item.id}-${dateStr}-${item.time}`;
      // تحقق إننا مبعتناش التذكير ده قبل كده
      const exists = await sb(`sent_reminders?reminder_key=eq.${encodeURIComponent(reminderKey)}&select=reminder_key`);
      if (exists && exists.length) continue;

      const payload = JSON.stringify({
        title: '🔔 تذكير: حصة بعد 10 دقائق',
        body: `${item.studentName || 'طالب'} — ${item.subjects || ''} — الساعة ${item.time}`,
        url: `${APP_URL}/?open=${item.type}&id=${item.id}`,
        tag: reminderKey,
        sessionId: item.id,
        sessionType: item.type
      });

      for (const row of subs) {
        try {
          await webpush.sendNotification(row.subscription, payload);
          sentCount++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // الاشتراك ده بقى منتهي (الجهاز مسح التطبيق أو ألغى الإذن) - نشيله
            await sb(`push_subscriptions?id=eq.${row.id}`, { method: 'DELETE', prefer: 'return=minimal' });
          }
        }
      }

      await sb('sent_reminders', { method: 'POST', body: JSON.stringify({ reminder_key: reminderKey }), prefer: 'return=minimal' });
    }

    return res.status(200).json({ ok: true, matched: dueItems.length, sentCount });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
