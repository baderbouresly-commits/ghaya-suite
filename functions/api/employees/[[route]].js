// /api/employees — self-contained, no imports
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

  const route = params.route || [];
  const id = route[0] || null;
  const method = request.method;

  // GET /api/employees
  if (!id && method === 'GET') {
    if (!['ghaya_admin','company_admin','manager'].includes(payload.role)) return json({error:'Forbidden'}, 403);
    let q;
    if (payload.role === 'ghaya_admin') {
      q = await env.DB.prepare('SELECT * FROM employees ORDER BY created_at DESC').all();
    } else {
      q = await env.DB.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY created_at DESC').bind(payload.company_id).all();
    }
    return json({employees: q.results || []});
  }

  // GET /api/employees/:id
  if (id && method === 'GET') {
    const emp = await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
    if (!emp) return json({error:'Employee not found'}, 404);
    const isSelf = payload.employee_id === id;
    const isAdmin = payload.role === 'ghaya_admin';
    const isCompanyStaff = ['company_admin','manager'].includes(payload.role) && emp.company_id === payload.company_id;
    if (!isSelf && !isAdmin && !isCompanyStaff) return json({error:'Forbidden'}, 403);
    return json({employee: emp});
  }

  // POST /api/employees
  if (!id && method === 'POST') {
    if (!['ghaya_admin','company_admin','manager'].includes(payload.role)) return json({error:'Forbidden'}, 403);
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const {
      first_name_en, last_name_en, first_name_ar, last_name_ar,
      civil_id, nationality, job_title_en, department, basic_salary,
      employment_start_date, work_email, phone, contract_type,
      company_id: bodyCompanyId
    } = body;

    if (!first_name_en || !last_name_en) return json({error:'First and last name required'}, 400);
    const company_id = payload.role === 'ghaya_admin' ? bodyCompanyId : payload.company_id;
    if (!company_id) return json({error:'company_id required'}, 400);

    // Determine is_kuwaiti from nationality
    const isKuwaiti = (nationality||'').toLowerCase() === 'kuwaiti' ? 1 : 0;

    const newId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO employees
        (id, company_id, first_name_en, last_name_en, first_name_ar, last_name_ar,
         civil_id, nationality, is_kuwaiti, job_title_en, department, basic_salary,
         hire_date, work_email, mobile, employment_type, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      newId, company_id,
      first_name_en, last_name_en,
      first_name_ar||null, last_name_ar||null,
      civil_id||null, nationality||null, isKuwaiti,
      job_title_en||null, department||null,
      basic_salary ? parseFloat(basic_salary) : 0,
      employment_start_date||null,
      work_email||null,
      phone||null,
      contract_type||'full_time',
      'active'
    ).run();

    const emp = await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(newId).first();
    return json({employee: emp, message:'Employee created'}, 201);
  }

  // PUT /api/employees/:id
  if (id && method === 'PUT') {
    if (!['ghaya_admin','company_admin','manager'].includes(payload.role)) return json({error:'Forbidden'}, 403);
    const emp = await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
    if (!emp) return json({error:'Employee not found'}, 404);
    if (payload.role !== 'ghaya_admin' && emp.company_id !== payload.company_id) return json({error:'Forbidden'}, 403);

    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const fieldMap = {
      first_name_en:'first_name_en', last_name_en:'last_name_en',
      first_name_ar:'first_name_ar', last_name_ar:'last_name_ar',
      job_title_en:'job_title_en', department:'department',
      basic_salary:'basic_salary', work_email:'work_email',
      phone:'mobile', contract_type:'employment_type',
      is_active: null, // handled below
      nationality:'nationality', civil_id:'civil_id',
      employment_start_date:'hire_date', status:'status'
    };

    const sets = [], vals = [];
    for (const [inputKey, dbKey] of Object.entries(fieldMap)) {
      if (inputKey in body && dbKey) { sets.push(`${dbKey} = ?`); vals.push(body[inputKey]); }
    }
    if ('is_active' in body) { sets.push('status = ?'); vals.push(body.is_active ? 'active' : 'inactive'); }
    if (!sets.length) return json({error:'Nothing to update'}, 400);
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    await env.DB.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    const updated = await env.DB.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
    return json({employee: updated, message:'Employee updated'});
  }

  return json({error:'Method not allowed'}, 405);
}
