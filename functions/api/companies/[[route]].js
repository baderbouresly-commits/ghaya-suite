// /api/companies — list + create, self-contained
const enc = new TextEncoder();

function b64u(data) {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

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

function requireAdmin(payload) {
  return payload?.role === 'ghaya_admin';
}

function uuid() {
  return crypto.randomUUID();
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2', salt, hash:'SHA-256', iterations:100000}, keyMaterial, 256);
  return `pbkdf2:${b64u(salt)}:${b64u(bits)}`;
}

export async function onRequest({request, env, params}) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({error:'Unauthorized'}, 401);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return json({error:'Token expired or invalid'}, 401);
  if (!requireAdmin(payload)) return json({error:'Forbidden'}, 403);

  const url = new URL(request.url);
  const parts = (params.route || []);
  const id = parts[0] || null;
  const method = request.method;
  const db = env.DB;

  // GET /api/companies
  if (method === 'GET' && !id) {
    const result = await db.prepare(
      'SELECT id, name_en, name_ar, cr_number, industry, subscription_tier, subscription_active, managed_by_ghaya, size_tier, created_at FROM companies ORDER BY created_at DESC'
    ).all();
    return json({companies: result.results ?? []});
  }

  // GET /api/companies/:id
  if (method === 'GET' && id) {
    const co = await db.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();
    if (!co) return json({error:'Not found'}, 404);
    return json({company: co});
  }

  // POST /api/companies — create company + admin user
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const {name_en, name_ar, cr_number, industry, subscription_tier, size_tier, managed_by_ghaya, admin_email, admin_password} = body;
    if (!name_en) return json({error:'name_en is required'}, 400);
    if (!admin_email) return json({error:'admin_email is required'}, 400);

    const coId = uuid();
    const userId = uuid();
    const passHash = await hashPassword(admin_password || 'TempPass2025!');

    await db.prepare(
      `INSERT INTO companies (id, name_en, name_ar, cr_number, industry, subscription_tier, size_tier, managed_by_ghaya, subscription_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(coId, name_en, name_ar||null, cr_number||null, industry||null, subscription_tier||'starter', size_tier||'small', managed_by_ghaya?1:0).run();

    await db.prepare(
      `INSERT INTO users (id, company_id, email, password_hash, role, is_active)
       VALUES (?, ?, ?, ?, 'company_admin', 1)`
    ).bind(userId, coId, admin_email.toLowerCase().trim(), passHash).run();

    return json({success:true, company_id: coId, user_id: userId}, 201);
  }

  // PUT /api/companies/:id — update fields
  if (method === 'PUT' && id) {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'}, 400); }

    const fields = [];
    const values = [];
    const allowed = ['name_en','name_ar','cr_number','industry','subscription_tier','size_tier','managed_by_ghaya','subscription_active'];
    for (const key of allowed) {
      if (key in body) { fields.push(`${key} = ?`); values.push(body[key]); }
    }
    if (!fields.length) return json({error:'No fields to update'}, 400);
    values.push(id);
    await db.prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    return json({success:true});
  }

  return json({error:'Method not allowed'}, 405);
}
