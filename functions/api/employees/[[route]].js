// /api/employees — list, create, update — self-contained
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

  const allowed = ['ghaya_admin','company_admin','manager'];
  if (!allowed.includes(payload.role)) return json({error:'Forbidden'}, 403);

  const parts = params.route || [];
  const id = parts[0] || null;
  const method = request.method;
  const db = env.DB;
  const company_id = payload.company_id;

  // GET /api/employees
  if (method === 'GET' && !id) {
    let query, args;
    if (payload.role === 'ghaya_admin') {
      query = 'SELECT * FROM employees ORDER BY created_at DESC';
      args = [];
    } else {
      if (!company_id) return json({error:'No company associated'}, 400);
      query = 'SELECT * FROM employees WHERE company_id = ? ORDER BY created_at DESC';
      args = [company_id];
    }
    const result = await db.prepare(query).bind(...args).all();
    return json({employees: result.results ?? []});
  }

  // GET /api/employees/:id
  if (method === 'GET' && id) {
    const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
    if (!emp) return json({error:'Not found'}, 404);
    if (payload.role !== 'ghaya_admin' && emp.company_id !== company_id) return json({error:'Forbidden'}, 403);
    return json({employee: emp});
  }

  // POST /api/employees
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const coId = payload.role === 'ghaya_admin' ? (body.company_id || company_id) : company_id;
    if (!coId) return json({error:'company_id required'}, 400);
    if (!body.first_name_en || !body.last_name_en) return json({error:'first_name_en and last_name_en required'}, 400);

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO employees
        (id, company_id, first_name_en, last_name_en, first_name_ar, last_name_ar,
         civil_id, nationality, job_title_en, department, basic_salary,
         employment_start_date, work_email, phone, contract_type, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
    `).bind(
      id, coId,
      body.first_name_en, body.last_name_en,
      body.first_name_ar || null, body.last_name_ar || null,
      body.civil_id || null, body.nationality || null,
      body.job_title_en || null, body.department || null,
      body.basic_salary || 0,
      body.employment_start_date || null,
      body.work_email || null, body.phone || null,
      body.contract_type || 'full_time'
    ).run();

    return json({success: true, employee_id: id}, 201);
  }

  // PUT /api/employees/:id
  if (method === 'PUT' && id) {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const emp = await db.prepare('SELECT company_id FROM employees WHERE id = ?').bind(id).first();
    if (!emp) return json({error:'Not found'}, 404);
    if (payload.role !== 'ghaya_admin' && emp.company_id !== company_id) return json({error:'Forbidden'}, 403);

    const allowed_fields = ['first_name_en','last_name_en','first_name_ar','last_name_ar','civil_id','nationality','job_title_en','department','basic_salary','employment_start_date','work_email','phone','contract_type','is_active'];
    const fields = [], values = [];
    for (const key of allowed_fields) {
      if (key in body) { fields.push(`${key} = ?`); values.push(body[key]); }
    }
    if (!fields.length) return json({error:'No fields to update'}, 400);
    values.push(id);
    await db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    return json({success: true});
  }

  return json({error:'Method not allowed'}, 405);
}
