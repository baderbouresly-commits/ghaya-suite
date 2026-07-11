// GET /api/auth/me — returns current user from JWT
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  // Optionally refresh data from DB
  const db = env.DB;
  const user = await db.prepare(
    'SELECT id, email, role, company_id, is_active FROM users WHERE id = ? AND is_active = 1'
  ).bind(result.user.sub).first();

  if (!user) return error('User not found', 404);

  return json({ user: result.user });
}
