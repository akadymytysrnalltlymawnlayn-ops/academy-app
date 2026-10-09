// api/manage-supervisors.js  (الإصدار 11)
// إدارة حسابات المشرفات - للمالك فقط.
// - ملف مستقل بالكامل (لا يعتمد على lib/)، فيعمل حتى لو لم يُرفع مجلد lib/.
// - كل الردود JSON في كل الحالات (حتى الأخطاء)، حتى لا تبقى الواجهة في "جاري التحميل".
// - list: نفس استعلام الإصدار الأصلي (profiles?role=eq.supervisor&select=*).
// - update: تحديث جزئي: يكتب فقط ما أُرسل فعلاً، ولا يمسح اسمًا موجودًا باسم فارغ،
//   ولا يمسح تعيينات المعلمات إذا لم تُرسل teacherIds.
// - create: يتراجع تلقائيًا (يحذف المستخدم) لو فشل حفظ الملف الشخصي، فلا يبقى حساب يتيم.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;

const MIN_PASSWORD = 6; // الحد الأدنى الافتراضي لـ Supabase Auth
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function envOk() { return !!(SUPABASE_URL && SERVICE_KEY); }
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function cleanIds(arr) { return Array.isArray(arr) ? [...new Set(arr.map(String).filter(Boolean))] : []; }
function cleanName(v) { return typeof v === 'string' ? v.trim() : ''; }

// طلب إلى REST بمفتاح السيرفر فقط (لا يُرسل للمتصفح)
async function rest(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    body: opts.body,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation'
    }
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  return { ok: res.ok, status: res.status, data };
}

// طلب إلى Auth admin بمفتاح السيرفر فقط - يرمي خطأ عند الفشل
async function authAdmin(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
  if (!res.ok) throw new Error((data && (data.msg || data.message || data.error_description)) || `HTTP ${res.status}`);
  return data;
}

// هوية المستخدم من توكن الجلسة القادم من المتصفح
async function verifyUser(token) {
  if (!token || typeof token !== 'string') return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? u : null;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'يستخدم POST فقط' });
    if (!envOk()) return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { token, action } = body;

    // المالك فقط (فشل قاعدة البيانات هنا يظهر كخطأ حقيقي، لا كرفض صلاحية)
    const user = await verifyUser(token);
    if (!user) return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يدير المشرفين' });
    const roleRes = await rest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role`);
    if (!roleRes.ok) return res.status(500).json({ ok: false, error: `تعذر التحقق من صلاحيتك (${roleRes.status})` });
    const ownerId = Array.isArray(roleRes.data) && roleRes.data[0] && roleRes.data[0].role === 'owner' ? user.id : null;
    if (!ownerId) return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يدير المشرفين' });

    if (action === 'list') {
      // نفس استعلام الإصدار الأصلي للمشرفات
      const r = await rest('profiles?role=eq.supervisor&select=*');
      if (!r.ok) return res.status(500).json({ ok: false, error: `تعذر قراءة المشرفات (${r.status})` });
      const profiles = Array.isArray(r.data) ? r.data : [];
      const supervisors = await Promise.all(profiles.map(async p => {
        let email = '';
        try {
          const u = await authAdmin('GET', `/auth/v1/admin/users/${encodeURIComponent(p.id)}`);
          email = (u && u.email) || '';
        } catch (e) { /* يظهر بدون إيميل */ }
        return { id: p.id, fullName: p.full_name || '', email, assignedTeacherIds: cleanIds(p.assigned_teacher_ids) };
      }));
      return res.status(200).json({ ok: true, supervisors });
    }

    if (action === 'create') {
      const { email, password, fullName, teacherIds } = body;
      if (!email || !password) return res.status(400).json({ ok: false, error: 'الإيميل وكلمة السر مطلوبين' });
      if (String(password).length < MIN_PASSWORD) return res.status(400).json({ ok: false, error: `كلمة السر لازم تكون ${MIN_PASSWORD} حروف على الأقل` });

      const created = await authAdmin('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
      const newId = created && created.id;
      if (!isUuid(newId)) return res.status(500).json({ ok: false, error: 'تعذر إنشاء المستخدم' });

      const ins = await rest('profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: newId, role: 'supervisor', full_name: cleanName(fullName), assigned_teacher_ids: cleanIds(teacherIds) })
      });
      if (!ins.ok) {
        // تراجع: لا نترك حساب دخول بلا ملف شخصي
        try { await authAdmin('DELETE', `/auth/v1/admin/users/${encodeURIComponent(newId)}`); } catch (e) { /* نُبلغ بالخطأ الأصلي */ }
        return res.status(500).json({ ok: false, error: `تعذر حفظ بيانات المشرفة (${ins.status}) - تم التراجع عن إنشاء الحساب` });
      }
      return res.status(200).json({ ok: true, id: newId });
    }

    if (action === 'update') {
      const { id, fullName, teacherIds } = body;
      if (!isUuid(id)) return res.status(400).json({ ok: false, error: 'معرّف المشرفة غير صالح' });
      if (id === ownerId) return res.status(400).json({ ok: false, error: 'لا يمكن تعديل حساب المالك من هنا' });
      // تحديث جزئي: نكتب ما أُرسل فقط، ولا نمسح اسمًا موجودًا باسم فارغ
      const patch = {};
      if (Array.isArray(teacherIds)) patch.assigned_teacher_ids = cleanIds(teacherIds);
      // الاسم يُكتب كما أُرسل بالضبط (بدون تغيير)، والاسم الفارغ/المسافات وحدها لا تكتب شيئاً
      if (cleanName(fullName)) patch.full_name = fullName;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'لا توجد بيانات للحفظ' });
      const r = await rest(`profiles?id=eq.${encodeURIComponent(id)}&role=eq.supervisor`, {
        method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch)
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: `تعذر الحفظ (${r.status})` });
      if (!Array.isArray(r.data) || !r.data.length) return res.status(404).json({ ok: false, error: 'المشرفة غير موجودة' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!isUuid(id)) return res.status(400).json({ ok: false, error: 'معرّف المشرفة غير صالح' });
      if (id === ownerId) return res.status(400).json({ ok: false, error: 'لا يمكن حذف حساب المالك' });
      const d = await rest(`profiles?id=eq.${encodeURIComponent(id)}&role=eq.supervisor`, { method: 'DELETE', prefer: 'return=representation' });
      if (!d.ok) return res.status(500).json({ ok: false, error: `تعذر الحذف (${d.status})` });
      if (!Array.isArray(d.data) || !d.data.length) return res.status(404).json({ ok: false, error: 'المشرفة غير موجودة' });
      try {
        await authAdmin('DELETE', `/auth/v1/admin/users/${encodeURIComponent(id)}`);
      } catch (e) {
        return res.status(200).json({ ok: true, warning: 'تم حذف الملف الشخصي، لكن تعذر حذف حساب الدخول: ' + e.message });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'إجراء غير معروف' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || 'خطأ غير متوقع' });
  }
};
