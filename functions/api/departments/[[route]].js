// /api/departments/* — CRUD for company departments
const JWT_SECRET_KEY = 'ghaya-jwt-secret';

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function parseB64u(s) {
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  while(s.length%4) s+='=';
  return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
}
async function verifyJWT(token, secret) {
  const [h,p,sig] = token.split('.');
  if(!h||!p||!sig) throw new Error('Invalid token');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, parseB64u(sig), new TextEncoder().encode(`${h}.${p}`));
  if(!ok) throw new Error('Invalid signature');
  return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
}
function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
}
function err(msg, status=400) { return json({error:msg}, status); }

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization')||'';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if(!token) return {error:'Unauthorized', status:401};
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET||JWT_SECRET_KEY);
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return {error:'Token expired', status:401};
    return {user: payload};
  } catch { return {error:'Invalid token', status:401}; }
}

export async function onRequest({ request, env, params }) {
  if(request.method === 'OPTIONS') return new Response(null, {headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE','Access-Control-Allow-Headers':'Content-Type,Authorization'}});

  const auth = await requireAuth(request, env);
  if(auth.error) return err(auth.error, auth.status);
  const { user } = auth;

  if(!['ghaya_admin','company_admin','manager','employee'].includes(user.role)) return err('Forbidden', 403);

  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const deptId = Array.isArray(route) ? route[0] : route;
  const companyId = user.role === 'ghaya_admin'
    ? new URL(request.url).searchParams.get('company_id')
    : user.company_id;
  if(!companyId) return err('company_id required');

  // GET /api/departments
  if(method === 'GET' && !deptId) {
    const { results } = await db.prepare('SELECT * FROM departments WHERE company_id = ? ORDER BY name_en').bind(companyId).all();
    return json({ departments: results });
  }

  // GET /api/departments/:id
  if(method === 'GET' && deptId) {
    const dept = await db.prepare('SELECT * FROM departments WHERE id = ? AND company_id = ?').bind(deptId, companyId).first();
    if(!dept) return err('Not found', 404);
    return json({ department: dept });
  }

  // POST /api/departments
  if(method === 'POST') {
    if(!['ghaya_admin','company_admin'].includes(user.role)) return err('Forbidden', 403);
    const body = await request.json();
    const { name_en, name_ar } = body;
    if(!name_en) return err('name_en required');
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO departments (id, company_id, name_en, name_ar, created_at) VALUES (?,?,?,?,datetime(\'now\'))').bind(id, companyId, name_en, name_ar||null).run();
    const dept = await db.prepare('SELECT * FROM departments WHERE id = ?').bind(id).first();
    return json({ department: dept }, 201);
  }

  // PUT /api/departments/:id
  if(method === 'PUT' && deptId) {
    if(!['ghaya_admin','company_admin'].includes(user.role)) return err('Forbidden', 403);
    const body = await request.json();
    const { name_en, name_ar } = body;
    await db.prepare('UPDATE departments SET name_en=?, name_ar=? WHERE id=? AND company_id=?').bind(name_en, name_ar||null, deptId, companyId).run();
    return json({ success: true });
  }

  // DELETE /api/departments/:id
  if(method === 'DELETE' && deptId) {
    if(!['ghaya_admin','company_admin'].includes(user.role)) return err('Forbidden', 403);
    await db.prepare('DELETE FROM departments WHERE id=? AND company_id=?').bind(deptId, companyId).run();
    return json({ success: true });
  }

  return err('Method not allowed', 405);
}
