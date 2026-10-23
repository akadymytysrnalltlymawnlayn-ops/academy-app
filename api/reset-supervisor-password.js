// api/reset-supervisor-password.js  (الإصدار 16)
// مسار مستقل لتغيير كلمة سر المشرفة — للمالك فقط.
// ملف لوحده عشان يشتغل حتى لو api/manage-supervisors.js على السيرفر نسخة قديمة
// ومش فيها action === 'resetPassword' (اللي كانت ترجع «إجراء غير معروف»).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
const MIN_PASSWORD = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function envOk() { return !!(SUPABASE_URL && SERVICE_KEY); }
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function authErr(data, status) {
  const raw = data && typeof data === 'object'
    ? (data.msg || data.message || data.error_description || (typeof data.error === 'string' ? data.error : '') || data.error_code || '')
    : String(data || '');
  const low = String(raw).toLowerCase();
  if ((data && data.error_code === 'weak_password') || /weak|pwned|easy to guess/.test(low)) {
    return 'كلمة السر ضعيفة أو شائعة جدًا. اختاري كلمة أقوى (يفضّل 8 حروف فيها حروف وأرقام)';
  }
  if (/same password|should be different/.test(low)) return 'كلمة السر الجديدة لازم تختلف عن القديمة';
  if (/at least \d+ character/.test(low)) return 'كلمة السر أقصر من الحد الأدنى في إعدادات الدخول. جرّبي 8 حروف على الأقل';
  return raw || `تعذر حفظ كلمة السر (HTTP ${status})`;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'يستخدم POST فقط' });
    if (!envOk()) return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const token = body.token;
    const id = body.id;
    const password = body.password;

    if (!token || typeof token !== 'string') return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يغيّر كلمة السر' });
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!uRes.ok) return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يغيّر كلمة السر' });
    const user = await uRes.json().catch(() => null);
    if (!user || !user.id) return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يغيّر كلمة السر' });

    const roleRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    const roleText = await roleRes.text();
    let roleData = null;
    if (roleText) { try { roleData = JSON.parse(roleText); } catch (e) { roleData = null; } }
    if (!roleRes.ok) return res.status(500).json({ ok: false, error: `تعذر التحقق من صلاحيتك (${roleRes.status})` });
    const ownerId = Array.isArray(roleData) && roleData[0] && roleData[0].role === 'owner' ? user.id : null;
    if (!ownerId) return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يغيّر كلمة السر' });

    if (!isUuid(id)) return res.status(400).json({ ok: false, error: 'معرّف المشرفة غير صالح' });
    if (id === ownerId) return res.status(400).json({ ok: false, error: 'لا يمكن تعديل حساب المالك من هنا' });
    if (!password || String(password).length < MIN_PASSWORD) {
      return res.status(400).json({ ok: false, error: `كلمة السر لازم تكون ${MIN_PASSWORD} حروف على الأقل` });
    }

    const foundRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&role=eq.supervisor&select=id`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    const foundText = await foundRes.text();
    let foundData = null;
    if (foundText) { try { foundData = JSON.parse(foundText); } catch (e) { foundData = null; } }
    if (!foundRes.ok) return res.status(500).json({ ok: false, error: `تعذر التحقق من المشرفة (${foundRes.status})` });
    if (!Array.isArray(foundData) || !foundData.length) return res.status(404).json({ ok: false, error: 'المشرفة غير موجودة' });

    const pwdPath = `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`;
    const pwdBody = JSON.stringify({ password: String(password) });
    const pwdHeaders = { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

    let pwdRes = await fetch(pwdPath, { method: 'PUT', headers: pwdHeaders, body: pwdBody });
    let pwdText = await pwdRes.text();
    if (!pwdRes.ok && (pwdRes.status === 404 || pwdRes.status === 405)) {
      pwdRes = await fetch(pwdPath, { method: 'PATCH', headers: pwdHeaders, body: pwdBody });
      pwdText = await pwdRes.text();
    }
    let pwdData = null;
    if (pwdText) { try { pwdData = JSON.parse(pwdText); } catch (e) { pwdData = pwdText; } }
    if (!pwdRes.ok) {
      const status = (pwdRes.status === 400 || pwdRes.status === 422) ? 400 : 500;
      return res.status(status).json({ ok: false, error: authErr(pwdData, pwdRes.status) });
    }

    try {
      await fetch(pwdPath + '/logout', {
        method: 'POST',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
      });
    } catch (e) { /* تحديث كلمة السر نفسه يلغي الجلسات */ }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'خطأ غير متوقع' });
  }
};
