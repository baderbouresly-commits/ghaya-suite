// functions/api/attendance/[[route]].js — self-contained, no imports
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getKuwaitTime() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function calcHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return null;
  const [ih, im, is_] = clockIn.split(':').map(Number);
  const [oh, om, os] = clockOut.split(':').map(Number);
  return Math.round(((oh * 3600 + om * 60 + os) - (ih * 3600 + im * 60 + is_)) / 36) / 100;
}

function getStatus(clockIn, workStart, lateThreshold) {
  if (!clockIn) return 'absent';
  const [ih, im] = clockIn.split(':').map(Number);
  const [wh, wm] = workStart.split(':').map(Number);
  const diffMinutes = (ih * 60 + im) - (wh * 60 + wm);
  if (diffMinutes > (lateThreshold || 15)) return 'late';
  return 'present';
}

export async function onRequest({ request, env, params }) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({ error: 'Unauthorized' }, 401);
  const user = await verifyJWT(token, env.JWT_SECRET);
  if (!user) return json({ error: 'Token expired or invalid' }, 401);

  const route = params.route || [];
  const seg = route[0] || null;
  const method = request.method;
  const isAdmin = ['ghaya_admin', 'company_admin', 'manager'].includes(user.role);
  const url = new URL(request.url);

  // POST /api/attendance/clockin
  if (seg === 'clockin' && method === 'POST') {
    if (!user.employee_id) return json({ error: 'No employee linked' }, 404);
    let body = {};
    try { body = await request.json(); } catch {}
    const today = getToday();
    const time = getKuwaitTime();

    // Check already clocked in today
    const existing = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE employee_id = ? AND date = ?'
    ).bind(user.employee_id, today).first();
    if (existing?.clock_in) return json({ error: 'Already clocked in today' }, 400);

    // Get company schedule
    const emp = await env.DB.prepare('SELECT company_id FROM employees WHERE id = ?').bind(user.employee_id).first();
    const company = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(emp.company_id).first();
    const status = getStatus(time, company?.work_start_time || '08:00', company?.late_threshold_minutes || 15);

    const id = crypto.randomUUID();
    if (existing) {
      await env.DB.prepare(
        'UPDATE attendance_records SET clock_in = ?, clock_in_lat = ?, clock_in_lng = ?, status = ? WHERE id = ?'
      ).bind(time, body.lat || null, body.lng || null, status, existing.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO attendance_records (id, company_id, employee_id, date, clock_in, clock_in_lat, clock_in_lng, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, emp.company_id, user.employee_id, today, time, body.lat || null, body.lng || null, status).run();
    }

    const record = await env.DB.prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND date = ?').bind(user.employee_id, today).first();
    return json({ record, message: 'Clocked in at ' + time });
  }

  // POST /api/attendance/clockout
  if (seg === 'clockout' && method === 'POST') {
    if (!user.employee_id) return json({ error: 'No employee linked' }, 404);
    let body = {};
    try { body = await request.json(); } catch {}
    const today = getToday();
    const time = getKuwaitTime();

    const existing = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE employee_id = ? AND date = ?'
    ).bind(user.employee_id, today).first();
    if (!existing?.clock_in) return json({ error: 'You have not clocked in today' }, 400);
    if (existing?.clock_out) return json({ error: 'Already clocked out today' }, 400);

    const hours = calcHours(existing.clock_in, time);
    let status = existing.status;
    if (status === 'present' || status === 'late') {
      if (hours !== null && hours < 4) status = 'half_day';
    }

    await env.DB.prepare(
      'UPDATE attendance_records SET clock_out = ?, clock_out_lat = ?, clock_out_lng = ?, hours_worked = ?, status = ? WHERE id = ?'
    ).bind(time, body.lat || null, body.lng || null, hours, status, existing.id).run();

    const record = await env.DB.prepare('SELECT * FROM attendance_records WHERE id = ?').bind(existing.id).first();
    return json({ record, message: 'Clocked out at ' + time + ' · ' + hours + ' hrs worked' });
  }

  // GET /api/attendance/today
  if (seg === 'today' && method === 'GET') {
    if (!user.employee_id) return json({ error: 'No employee linked' }, 404);
    const today = getToday();
    const record = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE employee_id = ? AND date = ?'
    ).bind(user.employee_id, today).first();

    const emp = await env.DB.prepare('SELECT company_id FROM employees WHERE id = ?').bind(user.employee_id).first();
    const company = await env.DB.prepare('SELECT work_start_time, work_end_time, work_days FROM companies WHERE id = ?').bind(emp.company_id).first();

    return json({ record: record || null, schedule: company });
  }

  // GET /api/attendance
  if (!seg && method === 'GET') {
    const date = url.searchParams.get('date') || getToday();
    const month = url.searchParams.get('month') || null;
    const employeeId = url.searchParams.get('employee_id') || null;

    if (isAdmin) {
      let sql = `SELECT ar.*, e.first_name_en, e.last_name_en, e.first_name_ar, e.last_name_ar
                 FROM attendance_records ar
                 JOIN employees e ON ar.employee_id = e.id
                 WHERE ar.company_id = ?`;
      const binds = [user.company_id];
      if (month) { sql += ' AND ar.date LIKE ?'; binds.push(month + '%'); }
      else if (!employeeId) { sql += ' AND ar.date = ?'; binds.push(date); }
      if (employeeId) { sql += ' AND ar.employee_id = ?'; binds.push(employeeId); }
      sql += ' ORDER BY ar.date DESC, ar.clock_in ASC';
      const result = await env.DB.prepare(sql).bind(...binds).all();
      return json({ records: result.results || [] });
    } else {
      if (!user.employee_id) return json({ error: 'No employee linked' }, 404);
      let sql = 'SELECT * FROM attendance_records WHERE employee_id = ?';
      const binds = [user.employee_id];
      if (month) { sql += ' AND date LIKE ?'; binds.push(month + '%'); }
      else { sql += ' AND date = ?'; binds.push(date); }
      sql += ' ORDER BY date DESC';
      const result = await env.DB.prepare(sql).bind(...binds).all();
      return json({ records: result.results || [] });
    }
  }

  // PUT /api/attendance/:id — admin manual edit
  if (seg && method === 'PUT') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    const record = await env.DB.prepare('SELECT * FROM attendance_records WHERE id = ?').bind(seg).first();
    if (!record) return json({ error: 'Record not found' }, 404);
    if (record.company_id !== user.company_id && user.role !== 'ghaya_admin') return json({ error: 'Forbidden' }, 403);

    const clockIn = body.clock_in || record.clock_in;
    const clockOut = body.clock_out || record.clock_out;
    const hours = calcHours(clockIn, clockOut);

    await env.DB.prepare(
      `UPDATE attendance_records SET clock_in = ?, clock_out = ?, hours_worked = ?, status = ?, notes = ? WHERE id = ?`
    ).bind(clockIn, clockOut || null, hours, body.status || record.status, body.notes || record.notes || null, seg).run();

    const updated = await env.DB.prepare('SELECT * FROM attendance_records WHERE id = ?').bind(seg).first();
    return json({ record: updated });
  }

  // POST /api/attendance — admin manual insert
  if (!seg && method === 'POST') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    let body = {};
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    const { employee_id, date, clock_in, clock_out, status, notes } = body;
    if (!employee_id || !date) return json({ error: 'employee_id and date required' }, 400);

    const emp = await env.DB.prepare('SELECT company_id FROM employees WHERE id = ?').bind(employee_id).first();
    if (!emp) return json({ error: 'Employee not found' }, 404);

    const hours = calcHours(clock_in, clock_out);
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO attendance_records (id, company_id, employee_id, date, clock_in, clock_out, hours_worked, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, employee_id, date) DO UPDATE SET
       clock_in = excluded.clock_in, clock_out = excluded.clock_out,
       hours_worked = excluded.hours_worked, status = excluded.status, notes = excluded.notes`
    ).bind(id, emp.company_id, employee_id, date, clock_in || null, clock_out || null, hours, status || 'present', notes || null).run();

    const record = await env.DB.prepare('SELECT * FROM attendance_records WHERE employee_id = ? AND date = ?').bind(employee_id, date).first();
    return json({ record }, 201);
  }

  return json({ error: 'Method not allowed' }, 405);
}
