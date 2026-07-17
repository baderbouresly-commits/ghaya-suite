// ============================================================
// GHAYA SUITE — Auth Helpers
// JWT signing/verification using Web Crypto API (CF Workers)
// ============================================================

const encoder = new TextEncoder();

function base64url(data) {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function parseBase64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function getKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signJWT(payload, secret, expiresInSeconds = 86400) {
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(encoder.encode(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })));
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, parseBase64url(sig), encoder.encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(parseBase64url(body)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getTokenFromRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/ghaya_token=([^;]+)/);
  return match ? match[1] : null;
}

export async function requireAuth(request, env) {
  const token = getTokenFromRequest(request);
  if (!token) return { error: 'Unauthorized', status: 401 };
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return { error: 'Token expired or invalid', status: 401 };
  return { user: payload };
}

export async function requireRole(request, env, ...allowedRoles) {
  const result = await requireAuth(request, env);
  if (result.error) return result;
  if (!allowedRoles.includes(result.user.role)) {
    return { error: 'Forbidden', status: 403 };
  }
  return result;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, hash: 'SHA-256', iterations: 100000 }, keyMaterial, 256);
  return `pbkdf2:${base64url(salt)}:${base64url(bits)}`;
}

export async function verifyPassword(password, hash) {
  try {
    const [, saltB64, hashB64] = hash.split(':');
    const salt = parseBase64url(saltB64);
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, hash: 'SHA-256', iterations: 100000 }, keyMaterial, 256);
    return base64url(bits) === hashB64;
  } catch {
    return false;
  }
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}

export async function sendPushNotification(env, { userIds, heading, content, url }) {
  const appId = env.ONESIGNAL_APP_ID;
  const apiKey = env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) { console.log('[OneSignal] missing env vars'); return; }

  const body = {
    app_id: appId,
    headings: { en: heading },
    contents: { en: content },
  };

  if (userIds && userIds.length > 0) {
    body.include_aliases = { external_id: userIds.map(String) };
    body.target_channel = 'push';
  } else {
    body.included_segments = ['All'];
  }

  if (url) body.url = url;

  try {
    const res = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    console.log('[OneSignal]', res.status, JSON.stringify(data));
  } catch(e) {
    console.log('[OneSignal error]', e.message);
  }
}
