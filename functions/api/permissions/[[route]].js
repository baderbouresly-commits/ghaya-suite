// functions/api/permissions/[[route]].js — self-contained, no imports
const enc = new TextEncoder();

function parseB64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function verifyJWT(token, secret) {
  try {
    const [h, b, sig] = token.split('.');
    if (!h || !b || !sig) return null;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, parseB64u(sig), enc.encode(`${h}.${b}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(parseB64u(b)));
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
}

// Send a push notification via OneSignal REST API (non-blocking)
async function sendPush(env, { userIds, heading, content, url }) {
  const appId = env.ONESIGNAL_APP_ID;
  const apiKey = env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) { console.log('[OneSignal] missing env vars'); return; }
  const body = { app_id: appId, headings: { en: heading }, contents: { en: content } };
  if (userIds && userIds.length > 0) {
    body.include_aliases = { external_id: userIds.map(String) };
    body.target_channel = 'push';
  } else {
    body.included_segments = ['All'];
  }
  if (url) body.url = url;
  try {
    const res = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log('[OneSignal]', res.status, JSON.stringify(data));
  } catch(e) { console.log('[OneSignal error]', e.message); }
}

function getMonthRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth()+1).padStart(2,'0');
  const start = `${year}-${month}-01`;
  const end = `${year}-${month}-31`;
  return { start, end, label: `${year}-${month}` };
}

export async function onRequest({request, env, params}) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({error:'Unauthorized'}, 401);
  const user = await verifyJWT(token, env.JWT_SECRET);
  if (!user) return json({error:'Token expired or invalid'}, 401);

  const route = params.route || [];
  const seg = route[0] || null;
  const method = request.method;

  const isAdmin = ['ghaya_admin','company_admin','manager'].includes(user.role);
  const isEmployee = user.role === 'employee';

  // GET /api/permissions/balance
  if (seg === 'balance' && method === 'GET') {
    const url = new URL(request.url);
    let employeeId = user.employee_id;
    if (isAdmin && url.searchParams.get('employee_id')) {
      employeeId = url.searchParams.get('employee_id');
    }
    if (!employeeId) return json({error:'No employee linked'}, 404);

    // Get company monthly limit
    const emp = await env.DB.prepare('SELECT company_id FROM employees WHERE id = ?').bind(employeeId).first();
    if (!emp) return json({error:'Employee not found'}, 404);
    const company = await env.DB.prepare('SELECT permission_hours_monthly FROM companies WHERE id = ?').bind(emp.company_id).first();
    const monthlyLimit = company?.permission_hours_monthly ?? 4;

    // Get used hours this month (approved only)
    const { start, end, label } = getMonthRange();
    const used = await env.DB.prepare(
      `SELECT COALESCE(SUM(hours),0) as total FROM permission_requests
       WHERE employee_id = ? AND status = 'approved' AND date >= ? AND date <= ?`
    ).bind(employeeId, start, end).first();

    const usedHours = parseFloat(used?.total || 0);
    return json({
      month: label,
      monthly_limit: monthlyLimit,
      used: usedHours,
      remaining: Math.max(0, monthlyLimit - usedHours)
    });
  }

  // GET /api/permissions
  if (!seg && method === 'GET') {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || null;
    const month = url.searchParams.get('month') || null;

    let q, results;
    if (isAdmin) {
      let sql = `SELECT pr.*, e.first_name_en, e.last_name_en, e.first_name_ar, e.last_name_ar
                 FROM permission_requests pr
                 JOIN employees e ON pr.employee_id = e.id
                 WHERE pr.company_id = ?`;
      const binds = [user.company_id];
      if (status) { sql += ' AND pr.status = ?'; binds.push(status); }
      if (month) { sql += ' AND pr.date LIKE ?'; binds.push(`${month}%`); }
      sql += ' ORDER BY pr.created_at DESC';
      q = await env.DB.prepare(sql).bind(...binds).all();
    } else {
      // Employee sees own
      if (!user.employee_id) return json({error:'No employee linked'}, 404);
      let sql = `SELECT * FROM permission_requests WHERE employee_id = ?`;
      const binds = [user.employee_id];
      if (status) { sql += ' AND status = ?'; binds.push(status); }
      if (month) { sql += ' AND date LIKE ?'; binds.push(`${month}%`); }
      sql += ' ORDER BY created_at DESC';
      q = await env.DB.prepare(sql).bind(...binds).all();
    }
    return json({requests: q.results || []});
  }

  // POST /api/permissions — employee submits request
  if (!seg && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const { date, start_time, end_time, reason, employee_id: bodyEmpId } = body;
    if (!date || !start_time || !end_time) return json({error:'date, start_time, end_time required'}, 400);

    // Resolve employee
    let employeeId = user.employee_id;
    if (isAdmin && bodyEmpId) employeeId = bodyEmpId;
    if (!employeeId) return json({error:'No employee linked'}, 404);

    // Calculate hours
    const [sh, sm] = start_time.split(':').map(Number);
    const [eh, em] = end_time.split(':').map(Number);
    const hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
    if (hours <= 0) return json({error:'End time must be after start time'}, 400);
    if (hours > 8) return json({error:'Cannot request more than 8 hours at once'}, 400);

    // Check monthly limit
    const emp = await env.DB.prepare('SELECT company_id, first_name_en, last_name_en FROM employees WHERE id = ?').bind(employeeId).first();
    if (!emp) return json({error:'Employee not found'}, 404);
    const company = await env.DB.prepare('SELECT permission_hours_monthly FROM companies WHERE id = ?').bind(emp.company_id).first();
    const monthlyLimit = company?.permission_hours_monthly ?? 4;

    const monthPrefix = date.substring(0, 7);
    const used = await env.DB.prepare(
      `SELECT COALESCE(SUM(hours),0) as total FROM permission_requests
       WHERE employee_id = ? AND status != 'rejected' AND date LIKE ?`
    ).bind(employeeId, `${monthPrefix}%`).first();

    const usedHours = parseFloat(used?.total || 0);
    if (usedHours + hours > monthlyLimit) {
      return json({error:`Monthly limit of ${monthlyLimit} hours exceeded. Used: ${usedHours}, Requesting: ${hours}`}, 400);
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO permission_requests (id, company_id, employee_id, date, start_time, end_time, hours, reason, status)
       VALUES (?,?,?,?,?,?,?,?,'pending')`
    ).bind(id, emp.company_id, employeeId, date, start_time, end_time, hours, reason||null).run();

    // Notify company admins/managers (non-blocking)
    try {
      const { results: admins } = await env.DB.prepare(
        "SELECT id FROM users WHERE company_id = ? AND role IN ('company_admin','manager') AND is_active = 1"
      ).bind(emp.company_id).all();
      const adminIds = (admins || []).map(a => a.id);
      const empName = `${emp.first_name_en || ''} ${emp.last_name_en || ''}`.trim() || 'An employee';
      if (adminIds.length) {
        await sendPush(env, {
          userIds: adminIds,
          heading: 'New Permission Request 🕐',
          content: `${empName} requested ${hours} hour${hours !== 1 ? 's' : ''} of time off on ${date}.`,
          url: 'https://ghaya-suite.pages.dev/admin/',
        });
      }
    } catch(e) { console.log('[NOTIF ERROR]', e?.message); }

    const req = await env.DB.prepare('SELECT * FROM permission_requests WHERE id = ?').bind(id).first();
    return json({request: req, message:'Permission request submitted'}, 201);
  }

  // PUT /api/permissions/:id — approve or reject
  if (seg && method === 'PUT') {
    if (!isAdmin) return json({error:'Forbidden'}, 403);
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const { action } = body; // 'approve' or 'reject'
    if (!['approve','reject'].includes(action)) return json({error:'action must be approve or reject'}, 400);

    const perm = await env.DB.prepare('SELECT * FROM permission_requests WHERE id = ?').bind(seg).first();
    if (!perm) return json({error:'Request not found'}, 404);
    if (perm.company_id !== user.company_id && user.role !== 'ghaya_admin') return json({error:'Forbidden'}, 403);

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await env.DB.prepare(
      `UPDATE permission_requests SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?`
    ).bind(newStatus, user.sub, seg).run();

    // Notify the employee (non-blocking)
    try {
      const emp = await env.DB.prepare('SELECT user_id FROM employees WHERE id = ?').bind(perm.employee_id).first();
      if (emp?.user_id) {
        const emoji = newStatus === 'approved' ? '✅' : '❌';
        await sendPush(env, {
          userIds: [emp.user_id],
          heading: `Permission ${newStatus === 'approved' ? 'Approved' : 'Rejected'} ${emoji}`,
          content: `Your permission request (${perm.hours} hour${perm.hours !== 1 ? 's' : ''} on ${perm.date}) has been ${newStatus}.`,
          url: 'https://ghaya-suite.pages.dev/employee/',
        });
      }
    } catch(e) { console.log('[NOTIF ERROR]', e?.message); }

    const updated = await env.DB.prepare('SELECT * FROM permission_requests WHERE id = ?').bind(seg).first();
    return json({request: updated, message:`Request ${newStatus}`});
  }

  return json({error:'Method not allowed'}, 405);
}
