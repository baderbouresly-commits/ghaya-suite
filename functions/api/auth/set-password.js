// POST /api/auth/set-password — used on first login to replace placeholder hash
import { requireAuth, hashPassword, verifyPassword, json, error } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON'); }

  const { current_password, new_password } = body;
  if (!new_password || new_password.length < 8) return error('New password must be at least 8 characters');

  const db = env.DB;
  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(result.user.sub).first();
  if (!user) return error('User not found', 404);

  // If not placeholder, verify current password
  if (!user.password_hash.startsWith('PLACEHOLDER') && !user.password_hash.startsWith('$2b$')) {
    if (!current_password) return error('Current password required');
    const ok = await verifyPassword(current_password, user.password_hash);
    if (!ok) return error('Current password incorrect', 401);
  }

  const newHash = await hashPassword(new_password);
  await db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(newHash, result.user.sub).run();

  return json({ message: 'Password updated successfully' });
}
