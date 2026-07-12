// /api/job-titles/* — CRUD for company job titles
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
  const titleId = Array.isArray(route) ? route[0] : route;
  const companyId = user.role === 'ghaya_admin'
    ? new URL(request.url).searchParams.get('company_id')
    : user.company_id;
  if(!companyId) return err('company_id required');

  // GET /api/job-titles
  if(method === 'GET' && !titleId) {
    const { results } = await db.prepare('SELECT * FROM job_titles WHERE company_id = ? ORDER BY title_en').bind(companyId).all();
    return json({ job_titles: results });
  }

  // GET /api/job-titles/:id
  if(method === 'GET' && titleId) {
    const jt = await db.prepare('SELECT * FROM job_titles WHERE id = ? AND company_id = ?').bind(titleId, companyId).first();
    if(!jt) return err('Not found', 404);
    return json({ job_title: jt });
  }

  // POST /api/job-titles
  if(method === 'POST') {
    if(!['ghaya_admin','company_admin'].includes(user.role)) return err('Forbidden', 403);
    const body = await request.json();
    const { title_en, title_ar } = body;
    if(!title_en) return err('title_en required');
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO job_titles (id, company_id, title_en, title_ar, created_at) VALUES (?,?,?,?,datetime(\'now\'))').bind(id, companyId, title_en, title_ar||null).run();
    const jt = await db.prepare('SELECT * FROM job_titles WHERE id = ?').bind(id).first();
    return json({ job_title: jt }, 201);
  }

  // PUT /api/job-titles/:id
  if(method === 'PUT' && titleId) {
    if(!['ghaya_admin','company_admin'].includes(user.role)) return err('Forbidden', 403);
    const body = await request.json();
    const { title_en, title_ar } = body;
    await db.prepare('UPDATE job_titles SET title_en=?, title_ar=? WHERE id=? AND company_id=?').bind(title_en, title_ar||null, titleId, companyId).run();
    return json({ success: true });
  }

  // DELETE /api/job-titles/:id
  if(method === 'DELETE' && titleId) {
    if(!['ghaya_admin','company_admin'].includes(user.role)) return err('Forbidden', 403);
    await db.prepare('DELETE FROM job_titles WHERE id=? AND company_id=?').bind(titleId, companyId).run();
    return json({ success: true });
  }

  return err('Method not allowed', 405);
}
