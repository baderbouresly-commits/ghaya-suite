// POST /api/auth/login
import { verifyPassword, signJWT, json, error } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON'); }

  const { email, password } = body;
  if (!email || !password) return error('Email and password required');

  const db = env.DB;

  // Look up user
  const user = await db.prepare(
    'SELECT u.*, e.id as emp_id, e.first_name_en, e.last_name_en, e.company_id as emp_company_id, e.department_id as emp_department_id FROM users u LEFT JOIN employees e ON e.user_id = u.id WHERE u.email = ? AND u.is_active = 1'
  ).bind(email.toLowerCase().trim()).first();

  if (!user) return error('Invalid email or password', 401);

  // Handle placeholder hash for initial admin (force password change)
  let passwordOk = false;
  if (user.password_hash.startsWith('PLACEHOLDER') || user.password_hash.startsWith('$2b$')) {
    // If still placeholder hash, only allow if password matches the setup default
    if (user.password_hash.startsWith('PLACEHOLDER')) {
      passwordOk = (password === 'GhayaAdmin2025!');
    } else {
      // bcrypt hash — can't verify in CF Workers without a lib
      // For production: migrate to pbkdf2 on first login
      passwordOk = false;
    }
  } else {
    passwordOk = await verifyPassword(password, user.password_hash);
  }

  if (!passwordOk) return error('Invalid email or password', 401);

  // Build JWT payload
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    company_id: user.company_id || user.emp_company_id || null,
    employee_id: user.emp_id || null,
    department_id: user.emp_department_id || null,
    name: [user.first_name_en, user.last_name_en].filter(Boolean).join(' ') || user.email,
    managed_by_ghaya: false,
  };

  // If company user, fetch managed_by_ghaya flag
  if (payload.company_id) {
    const co = await db.prepare('SELECT managed_by_ghaya FROM companies WHERE id = ?')
      .bind(payload.company_id).first();
    if (co) payload.managed_by_ghaya = !!co.managed_by_ghaya;
  }

  const expires = parseInt(env.JWT_EXPIRES_IN || '86400');
  const token = await signJWT(payload, env.JWT_SECRET, expires);

  // Update last login
  await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();

  return json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: payload.name,
      company_id: payload.company_id,
      employee_id: payload.employee_id,
      managed_by_ghaya: payload.managed_by_ghaya,
    },
    expires_in: expires,
  });
}
