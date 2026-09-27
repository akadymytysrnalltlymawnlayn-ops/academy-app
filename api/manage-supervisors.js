const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;

async function verifyOwnerId(token){
  if(!token) return null;
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
  });
  if(!userRes.ok) return null;
  const user = await userRes.json();
  const pRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  });
  const rows = await pRes.json();
  return (rows[0] && rows[0].role === 'owner') ? user.id : null;
}

async function admin(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.msg || data.message)) || `HTTP ${res.status}`);
  return data;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'يستخدم POST فقط' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { token, action } = body || {};

    const ownerId = await verifyOwnerId(token);
    if (!ownerId) return res.status(403).json({ ok:false, error:'غير مصرح لك - المالك فقط يقدر يدير المشرفين' });

    if (action === 'list') {
      const profiles = await admin(`/rest/v1/profiles?role=eq.supervisor&select=*`);
      const withEmails = [];
      for (const p of profiles) {
        let email = '';
        try {
          const u = await admin(`/auth/v1/admin/users/${p.id}`);
          email = u && u.email ? u.email : '';
        } catch (e) {}
        withEmails.push({ id: p.id, fullName: p.full_name || '', email, assignedTeacherIds: p.assigned_teacher_ids || [] });
      }
      return res.status(200).json({ ok:true, supervisors: withEmails });
    }

    if (action === 'create') {
      const { email, password, fullName, teacherIds } = body;
      if (!email || !password) return res.status(400).json({ ok:false, error:'الإيميل وكلمة السر مطلوبين' });
      const newUser = await admin(`/auth/v1/admin/users`, {
        method: 'POST',
        body: JSON.stringify({ email, password, email_confirm: true })
      });
      await admin(`/rest/v1/profiles`, {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ id: newUser.id, role: 'supervisor', full_name: fullName || '', assigned_teacher_ids: teacherIds || [] })
      });
      return res.status(200).json({ ok:true, id: newUser.id });
    }

    if (action === 'update') {
      const { id, fullName, teacherIds } = body;
      if (!id) return res.status(400).json({ ok:false, error:'معرّف المشرفة مطلوب' });
      await admin(`/rest/v1/profiles?id=eq.${id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({ full_name: fullName, assigned_teacher_ids: teacherIds || [] })
      });
      return res.status(200).json({ ok:true });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return res.status(400).json({ ok:false, error:'معرّف المشرفة مطلوب' });
      await admin(`/rest/v1/profiles?id=eq.${id}`, { method:'DELETE', prefer:'return=minimal' });
      try { await admin(`/auth/v1/admin/users/${id}`, { method:'DELETE' }); } catch(e) {}
      return res.status(200).json({ ok:true });
    }

    return res.status(400).json({ ok:false, error:'إجراء غير معروف' });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
};
