export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.replace('/api/attendance', '').split('/').filter(Boolean);
  const method = request.method;

  // ── JWT verify ────────────────────────────────────────────
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return json({ error: 'Unauthorized' }, 401);
  let payload;
  try {
    const [h, p, s] = token.split('.');
    const sig = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', sig, b64url(s), new TextEncoder().encode(h + '.' + p));
    if (!valid) return json({ error: 'Unauthorized' }, 401);
    payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp < Math.floor(Date.now() / 1000)) return json({ error: 'Token expired' }, 401);
  } catch { return json({ error: 'Unauthorized' }, 401); }

  const isAdmin = ['company_admin', 'manager'].includes(payload.role);
  const companyId = payload.company_id;
  const employeeId = payload.employee_id || payload.id;

  // ── Helpers ───────────────────────────────────────────────
  function getKuwaitTime() {
    const s = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuwait', hour12: false });
    const [date, time] = s.split(', ');
    const [d, m, y] = date.split('/');
    return { date: `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`, time };
  }

  function getStatus(clockIn, workStart, lateThreshold) {
    if (!clockIn || !workStart) return 'present';
    const [ih, im] = clockIn.split(':').map(Number);
    const [wh, wm] = workStart.split(':').map(Number);
    const inMins = ih * 60 + im;
    const startMins = wh * 60 + wm;
    return inMins > startMins + (lateThreshold || 15) ? 'late' : 'present';
  }

  function calcHours(clockIn, clockOut) {
    if (!clockIn || !clockOut) return null;
    const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    return Math.round((toMins(clockOut) - toMins(clockIn)) / 60 * 10) / 10;
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function b64url(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  }

  function uid() { return crypto.randomUUID(); }
  function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }

  // ── GET company schedule ──────────────────────────────────
  async function getCompany() {
    const row = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(companyId).first();
    return row;
  }

  // ── ROUTES ────────────────────────────────────────────────

  // POST /api/attendance/clockin
  if (method === 'POST' && parts[0] === 'clockin') {
    const body = await request.json().catch(() => ({}));
    const { lat, lng } = body;
    const { date, time } = getKuwaitTime();
    const company = await getCompany();

    // Geofence check
    if (company?.geofence_enabled && company?.workplace_lat && company?.workplace_lng) {
      if (lat == null || lng == null) {
        return json({ error: 'Location required — workplace geofencing is enabled. Please allow location access and try again.' }, 403);
      }
      const distance = haversine(lat, lng, company.workplace_lat, company.workplace_lng);
      const radius = company.geofence_radius_meters || 200;
      if (distance > radius) {
        return json({ error: `You are ${Math.round(distance)}m from the workplace. Must be within ${radius}m to clock in.` }, 403);
      }
    }

    // Check existing record
    const existing = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date=?'
    ).bind(companyId, employeeId, date).first();

    if (existing?.clock_in) return json({ error: 'Already clocked in today' }, 400);

    const status = getStatus(time.slice(0,5), company?.work_start_time || '08:00', company?.late_threshold_minutes || 15);

    if (existing) {
      await env.DB.prepare(
        'UPDATE attendance_records SET clock_in=?,clock_in_lat=?,clock_in_lng=?,status=? WHERE id=?'
      ).bind(time.slice(0,8), lat, lng, status, existing.id).run();
    } else {
      await env.DB.prepare(
        'INSERT INTO attendance_records (id,company_id,employee_id,date,clock_in,clock_in_lat,clock_in_lng,status) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(uid(), companyId, employeeId, date, time.slice(0,8), lat, lng, status).run();
    }

    const record = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date=?'
    ).bind(companyId, employeeId, date).first();

    const msg = status === 'late' ? `Clocked in at ${time.slice(0,5)} — marked as Late` : `Clocked in at ${time.slice(0,5)}`;
    return json({ message: msg, record });
  }

  // POST /api/attendance/clockout
  if (method === 'POST' && parts[0] === 'clockout') {
    const body = await request.json().catch(() => ({}));
    const { lat, lng } = body;
    const { date, time } = getKuwaitTime();
    const company = await getCompany();

    // Geofence check
    if (company?.geofence_enabled && company?.workplace_lat && company?.workplace_lng) {
      if (lat == null || lng == null) {
        return json({ error: 'Location required — workplace geofencing is enabled. Please allow location access and try again.' }, 403);
      }
      const distance = haversine(lat, lng, company.workplace_lat, company.workplace_lng);
      const radius = company.geofence_radius_meters || 200;
      if (distance > radius) {
        return json({ error: `You are ${Math.round(distance)}m from the workplace. Must be within ${radius}m to clock out.` }, 403);
      }
    }

    const existing = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date=?'
    ).bind(companyId, employeeId, date).first();

    if (!existing?.clock_in) return json({ error: 'Not clocked in yet' }, 400);
    if (existing?.clock_out) return json({ error: 'Already clocked out today' }, 400);

    const hours = calcHours(existing.clock_in.slice(0,5), time.slice(0,5));
    const status = hours != null && hours < 4 ? 'half_day' : (existing.status || 'present');

    await env.DB.prepare(
      'UPDATE attendance_records SET clock_out=?,clock_out_lat=?,clock_out_lng=?,hours_worked=?,status=? WHERE id=?'
    ).bind(time.slice(0,8), lat, lng, hours, status, existing.id).run();

    const record = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE id=?'
    ).bind(existing.id).first();

    return json({ message: `Clocked out at ${time.slice(0,5)} — ${hours} hrs worked`, record });
  }

  // GET /api/attendance/today
  if (method === 'GET' && parts[0] === 'today') {
    const { date } = getKuwaitTime();
    const company = await getCompany();
    const record = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date=?'
    ).bind(companyId, employeeId, date).first();
    return json({ record: record || null, date, company });
  }

  // GET /api/attendance
  if (method === 'GET' && parts.length === 0) {
    const dateParam = url.searchParams.get('date');
    const monthParam = url.searchParams.get('month');
    const empParam = url.searchParams.get('employee_id');

    let query, params;

    if (isAdmin) {
      if (dateParam) {
        query = `SELECT ar.*, e.first_name_en, e.last_name_en FROM attendance_records ar LEFT JOIN employees e ON ar.employee_id=e.id WHERE ar.company_id=? AND ar.date=? ORDER BY e.first_name_en`;
        params = [companyId, dateParam];
      } else if (monthParam) {
        query = `SELECT ar.*, e.first_name_en, e.last_name_en FROM attendance_records ar LEFT JOIN employees e ON ar.employee_id=e.id WHERE ar.company_id=? AND ar.date LIKE ? ${empParam ? 'AND ar.employee_id=?' : ''} ORDER BY ar.date DESC, e.first_name_en`;
        params = empParam ? [companyId, monthParam + '%', empParam] : [companyId, monthParam + '%'];
      } else {
        const { date } = getKuwaitTime();
        query = `SELECT ar.*, e.first_name_en, e.last_name_en FROM attendance_records ar LEFT JOIN employees e ON ar.employee_id=e.id WHERE ar.company_id=? AND ar.date=? ORDER BY e.first_name_en`;
        params = [companyId, date];
      }
    } else {
      if (monthParam) {
        query = `SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date LIKE ? ORDER BY date DESC`;
        params = [companyId, employeeId, monthParam + '%'];
      } else {
        const { date } = getKuwaitTime();
        query = `SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date=?`;
        params = [companyId, employeeId, date];
      }
    }

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return json({ records: results });
  }

  // PUT /api/attendance/:id
  if (method === 'PUT' && parts[0] && parts[0] !== 'clockin' && parts[0] !== 'clockout') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const body = await request.json().catch(() => ({}));
    const { clock_in, clock_out, status, notes } = body;
    const hours = calcHours(clock_in?.slice(0,5), clock_out?.slice(0,5));
    await env.DB.prepare(
      'UPDATE attendance_records SET clock_in=?,clock_out=?,hours_worked=?,status=?,notes=? WHERE id=? AND company_id=?'
    ).bind(clock_in || null, clock_out || null, hours, status || 'present', notes || null, parts[0], companyId).run();
    const record = await env.DB.prepare('SELECT * FROM attendance_records WHERE id=?').bind(parts[0]).first();
    return json({ record });
  }

  // POST /api/attendance (admin manual insert)
  if (method === 'POST' && parts.length === 0) {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const body = await request.json().catch(() => ({}));
    const { employee_id, date, clock_in, clock_out, status, notes } = body;
    if (!employee_id || !date) return json({ error: 'employee_id and date required' }, 400);
    const hours = calcHours(clock_in?.slice(0,5), clock_out?.slice(0,5));
    await env.DB.prepare(
      `INSERT INTO attendance_records (id,company_id,employee_id,date,clock_in,clock_out,hours_worked,status,notes)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(company_id,employee_id,date) DO UPDATE SET clock_in=excluded.clock_in,clock_out=excluded.clock_out,hours_worked=excluded.hours_worked,status=excluded.status,notes=excluded.notes`
    ).bind(uid(), companyId, employee_id, date, clock_in || null, clock_out || null, hours, status || 'present', notes || null).run();
    const record = await env.DB.prepare(
      'SELECT * FROM attendance_records WHERE company_id=? AND employee_id=? AND date=?'
    ).bind(companyId, employee_id, date).first();
    return json({ record });
  }

  return json({ error: 'Not found' }, 404);
}
