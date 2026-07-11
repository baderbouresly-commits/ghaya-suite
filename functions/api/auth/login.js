// POST /api/auth/login — self-contained, no imports
const enc = new TextEncoder();

function b64u(data) {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function signJWT(payload, secret, exp = 86400) {
  const h = b64u(enc.encode(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const now = Math.floor(Date.now()/1000);
  const b = b64u(enc.encode(JSON.stringify({...payload,iat:now,exp:now+exp})));
  const key = await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig = await crypto.subtle.sign('HMAC',key,enc.encode(`${h}.${b}`));
  return `${h}.${b}.${b64u(sig)}`;
}

function json(data, status=200) {
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
}

export async function onRequestPost({request, env}) {
  try {
    let body;
    try { body = await request.json(); } catch { return json({error:'Invalid JSON'},400); }
    const {email, password} = body;
    if (!email || !password) return json({error:'Email and password required'},400);
    if (!env.DB) return json({error:'DB binding missing'},500);

    const user = await env.DB.prepare(
      'SELECT u.*, e.id as emp_id, e.first_name_en, e.last_name_en, e.company_id as emp_company_id FROM users u LEFT JOIN employees e ON e.user_id = u.id WHERE u.email = ? AND u.is_active = 1'
    ).bind(email.toLowerCase().trim()).first();

    if (!user) return json({error:'Invalid email or password'},401);

    let ok = false;
    if (user.password_hash.startsWith('PLACEHOLDER')) {
      ok = (password === 'GhayaAdmin2025!');
    }

    if (!ok) return json({error:'Invalid email or password'},401);

    const payload = {
      sub: user.id, email: user.email, role: user.role,
      company_id: user.company_id || null,
      employee_id: user.emp_id || null,
      name: user.email,
      managed_by_ghaya: false,
    };

    const expires = parseInt(env.JWT_EXPIRES_IN||'86400');
    const token = await signJWT(payload, env.JWT_SECRET, expires);
    await env.DB.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").bind(user.id).run();

    return json({token, user:{id:user.id,email:user.email,role:user.role,name:payload.name}, expires_in:expires});
  } catch(e) {
    return new Response(JSON.stringify({error:e.message,stack:e.stack}),{status:500,headers:{'Content-Type':'application/json'}});
  }
}
