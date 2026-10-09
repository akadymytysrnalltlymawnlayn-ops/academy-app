// api/manage-supervisors.js
// إدارة حسابات المشرفات - للمالك فقط.
// - list / create / update / delete تعمل على سجلات role = supervisor فقط.
// - لا يمكن للمالك حذف حسابه أو تعديله من هنا.
// - الإنشاء يتراجع تلقائيًا (يحذف المستخدم) لو فشل حفظ الملف الشخصي، فلا يبقى حساب يتيم.
const S = require('../lib/shared.js');

const MIN_PASSWORD = 6; // الحد الأدنى الافتراضي لـ Supabase Auth

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'يستخدم POST فقط' });
    if (!S.envOk()) return res.status(500).json({ ok: false, error: 'متغيرات البيئة ناقصة على Vercel' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { token, action } = body;

    const user = await S.verifyUser(token);
    const ownerId = user && (await S.getRole(user.id)) === 'owner' ? user.id : null;
    if (!ownerId) return res.status(403).json({ ok: false, error: 'غير مصرح لك - المالك فقط يقدر يدير المشرفين' });

    if (action === 'list') {
      const profiles = await S.sbAll('profiles?role=eq.supervisor&select=id,full_name,assigned_teacher_ids&order=id');
      const supervisors = await Promise.all(profiles.map(async p => {
        let email = '';
        try {
          const u = await S.authAdmin('GET', `/auth/v1/admin/users/${encodeURIComponent(p.id)}`);
          email = (u && u.email) || '';
        } catch (e) { /* يظهر بدون إيميل */ }
        return { id: p.id, fullName: p.full_name || '', email, assignedTeacherIds: S.cleanIds(p.assigned_teacher_ids) };
      }));
      return res.status(200).json({ ok: true, supervisors });
    }

    if (action === 'create') {
      const { email, password, fullName, teacherIds } = body;
      if (!email || !password) return res.status(400).json({ ok: false, error: 'الإيميل وكلمة السر مطلوبين' });
      if (String(password).length < MIN_PASSWORD) return res.status(400).json({ ok: false, error: `كلمة السر لازم تكون ${MIN_PASSWORD} حروف على الأقل` });

      const created = await S.authAdmin('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
      const newId = created && created.id;
      if (!S.isUuid(newId)) return res.status(500).json({ ok: false, error: 'تعذر إنشاء المستخدم' });

      const ins = await S.sbReq('profiles', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ id: newId, role: 'supervisor', full_name: fullName || '', assigned_teacher_ids: S.cleanIds(teacherIds) })
      });
      if (!ins.ok) {
        // تراجع: لا نترك حساب دخول بلا ملف شخصي
        try { await S.authAdmin('DELETE', `/auth/v1/admin/users/${encodeURIComponent(newId)}`); } catch (e) { /* نُبلغ بالخطأ الأصلي */ }
        return res.status(500).json({ ok: false, error: `تعذر حفظ بيانات المشرفة (${ins.status}) - تم التراجع عن إنشاء الحساب` });
      }
      return res.status(200).json({ ok: true, id: newId });
    }

    if (action === 'update') {
      const { id, fullName, teacherIds } = body;
      if (!S.isUuid(id)) return res.status(400).json({ ok: false, error: 'معرّف المشرفة غير صالح' });
      if (id === ownerId) return res.status(400).json({ ok: false, error: 'لا يمكن تعديل حساب المالك من هنا' });
      const patch = { assigned_teacher_ids: S.cleanIds(teacherIds) };
      if (typeof fullName === 'string') patch.full_name = fullName;
      const r = await S.sbReq(`profiles?id=eq.${encodeURIComponent(id)}&role=eq.supervisor`, {
        method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch)
      });
      if (!r.ok) return res.status(500).json({ ok: false, error: `تعذر الحفظ (${r.status})` });
      if (!Array.isArray(r.data) || !r.data.length) return res.status(404).json({ ok: false, error: 'المشرفة غير موجودة' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!S.isUuid(id)) return res.status(400).json({ ok: false, error: 'معرّف المشرفة غير صالح' });
      if (id === ownerId) return res.status(400).json({ ok: false, error: 'لا يمكن حذف حساب المالك' });
      const d = await S.sbReq(`profiles?id=eq.${encodeURIComponent(id)}&role=eq.supervisor`, { method: 'DELETE', prefer: 'return=representation' });
      if (!d.ok) return res.status(500).json({ ok: false, error: `تعذر الحذف (${d.status})` });
      if (!Array.isArray(d.data) || !d.data.length) return res.status(404).json({ ok: false, error: 'المشرفة غير موجودة' });
      try {
        await S.authAdmin('DELETE', `/auth/v1/admin/users/${encodeURIComponent(id)}`);
      } catch (e) {
        return res.status(200).json({ ok: true, warning: 'تم حذف الملف الشخصي، لكن تعذر حذف حساب الدخول: ' + e.message });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'إجراء غير معروف' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
