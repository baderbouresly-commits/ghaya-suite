// GET /api/dashboard — Ghaya Super Admin stats, self-contained
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

export async function onRequestGet({request, env}) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({error:'Unauthorized'}, 401);
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return json({error:'Token expired or invalid'}, 401);
  if (payload.role !== 'ghaya_admin') return json({error:'Forbidden'}, 403);

  const db = env.DB;

  const [total_companies, managed, active, total_employees, recent] = await Promise.all([
    db.prepare('SELECT COUNT(*) as n FROM companies').first(),
    db.prepare('SELECT COUNT(*) as n FROM companies WHERE managed_by_ghaya = 1').first(),
    db.prepare('SELECT COUNT(*) as n FROM companies WHERE subscription_active = 1').first(),
    db.prepare('SELECT COUNT(*) as n FROM employees WHERE is_active = 1').first(),
    db.prepare('SELECT id, name_en, name_ar, industry, subscription_tier, subscription_active, managed_by_ghaya FROM companies ORDER BY created_at DESC LIMIT 5').all(),
  ]);

  return json({
    total_companies: total_companies?.n ?? 0,
    managed_companies: managed?.n ?? 0,
    active_subscriptions: active?.n ?? 0,
    total_employees: total_employees?.n ?? 0,
    recent_companies: recent?.results ?? [],
  });
}
