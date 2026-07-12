// /api/companies/* — company info (read-only for company_admin)
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
  if(request.method === 'OPTIONS') return new Response(null, {headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,PUT','Access-Control-Allow-Headers':'Content-Type,Authorization'}});

  const auth = await requireAuth(request, env);
  if(auth.error) return err(auth.error, auth.status);
  const { user } = auth;

  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const companyId = Array.isArray(route) ? route[0] : route;

  // GET /api/companies/:id
  if(method === 'GET' && companyId) {
    // Only allow fetching your own company (unless ghaya_admin)
    if(user.role !== 'ghaya_admin' && user.company_id !== companyId) return err('Forbidden', 403);
    const company = await db.prepare(
      'SELECT id, name_en, name_ar, subscription_tier, subscription_active, managed_by_ghaya, created_at FROM companies WHERE id = ?'
    ).bind(companyId).first();
    if(!company) return err('Not found', 404);
    return json({ company });
  }

  // GET /api/companies (ghaya_admin only)
  if(method === 'GET' && !companyId) {
    if(user.role !== 'ghaya_admin') return err('Forbidden', 403);
    const { results } = await db.prepare(
      'SELECT id, name_en, name_ar, subscription_tier, subscription_active, managed_by_ghaya, created_at FROM companies ORDER BY created_at DESC'
    ).all();
    return json({ companies: results });
  }

  // PUT /api/companies/:id — update basic company info (company_admin or ghaya_admin)
  if(method === 'PUT' && companyId) {
    if(user.role !== 'ghaya_admin' && user.company_id !== companyId) return err('Forbidden', 403);
    const body = await request.json();
    const { name_en, name_ar } = body;
    if(!name_en) return err('name_en required');
    await db.prepare('UPDATE companies SET name_en=?, name_ar=? WHERE id=?').bind(name_en, name_ar||null, companyId).run();
    const company = await db.prepare('SELECT id, name_en, name_ar, subscription_tier, subscription_active, managed_by_ghaya FROM companies WHERE id=?').bind(companyId).first();
    return json({ company });
  }

  return err('Method not allowed', 405);
}
