// /api/leaves — list, create, update status — self-contained
const enc = new TextEncoder();

function parseB64u(str) {
  str = str.replace(/-/g,'+').replace(/_/g,'/');
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

export async function onRequest({request, env, params}) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({error:'Unauthorized'}, 401);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return json({error:'Token expired or invalid'}, 401);

  const parts = params.route || [];
  const id = parts[0] || null;
  const method = request.method;
  const db = env.DB;
  const company_id = payload.company_id;
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status') || 'all';

  // GET /api/leaves
  if (method === 'GET' && !id) {
    let query, args;
    if (payload.role === 'ghaya_admin') {
      query = statusFilter === 'all'
        ? 'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id ORDER BY l.created_at DESC'
        : 'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.status = ? ORDER BY l.created_at DESC';
      args = statusFilter === 'all' ? [] : [statusFilter];
    } else if (payload.role === 'employee') {
      query = statusFilter === 'all'
        ? 'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.employee_id = ? ORDER BY l.created_at DESC'
        : 'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.employee_id = ? AND l.status = ? ORDER BY l.created_at DESC';
      args = statusFilter === 'all' ? [payload.employee_id] : [payload.employee_id, statusFilter];
    } else {
      if (!company_id) return json({error:'No company'}, 400);
      query = statusFilter === 'all'
        ? 'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE e.company_id = ? ORDER BY l.created_at DESC'
        : 'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE e.company_id = ? AND l.status = ? ORDER BY l.created_at DESC';
      args = statusFilter === 'all' ? [company_id] : [company_id, statusFilter];
    }
    const result = await db.prepare(query).bind(...args).all();
    return json({leaves: result.results ?? []});
  }

  // GET /api/leaves/:id
  if (method === 'GET' && id) {
    const leave = await db.prepare(
      'SELECT l.*, e.first_name_en || " " || e.last_name_en as employee_name FROM leave_requests l LEFT JOIN employees e ON e.id = l.employee_id WHERE l.id = ?'
    ).bind(id).first();
    if (!leave) return json({error:'Not found'}, 404);
    return json({leave});
  }

  // POST /api/leaves — employee submits leave request
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const emp_id = payload.employee_id || body.employee_id;
    if (!emp_id) return json({error:'employee_id required'}, 400);
    if (!body.leave_type || !body.start_date || !body.end_date) return json({error:'leave_type, start_date, end_date required'}, 400);

    const start = new Date(body.start_date);
    const end = new Date(body.end_date);
    const days = Math.ceil((end - start) / (1000*60*60*24)) + 1;

    const newId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO leave_requests (id, employee_id, leave_type, start_date, end_date, days_requested, reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).bind(newId, emp_id, body.leave_type, body.start_date, body.end_date, days, body.reason || null).run();

    return json({success: true, leave_id: newId, days_requested: days}, 201);
  }

  // PUT /api/leaves/:id — approve or reject
  if (method === 'PUT' && id) {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const allowed = ['ghaya_admin','company_admin','manager'];
    if (!allowed.includes(payload.role)) return json({error:'Forbidden'}, 403);

    const status = body.status || body.action;
    if (!['approved','rejected'].includes(status)) return json({error:'status must be approved or rejected'}, 400);

    await db.prepare(
      "UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?"
    ).bind(status, payload.sub, id).run();

    return json({success: true, status});
  }

  return json({error:'Method not allowed'}, 405);
}
