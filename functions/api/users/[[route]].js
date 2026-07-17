// /api/users/* — list all admin users across all companies (ghaya_admin only)
import { requireAuth, json, error, hashPassword } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }
  });

  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;

  if (user.role !== 'ghaya_admin') return error('Forbidden', 403);

  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const userId = Array.isArray(route) ? route[0] : route;

  // ── GET /api/users — list all admin users with their company ──
  if (method === 'GET' && !userId) {
    const { results } = await db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.created_at,
             c.id AS company_id, c.name_en AS company_name_en, c.name_ar AS company_name_ar,
             c.subscription_active
      FROM users u
      LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.role IN ('admin','ghaya_admin')
      ORDER BY u.created_at DESC
    `).all();
    return json({ users: results });
  }

  // ── PUT /api/users/:id — reset password or update name ──
  if (method === 'PUT' && userId) {
    const body = await request.json();
    if (body.password) {
      const hash = await hashPassword(body.password);
      await db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`)
        .bind(hash, userId).run();
    }
    if (body.name) {
      await db.prepare(`UPDATE users SET name=?, updated_at=datetime('now') WHERE id=?`)
        .bind(body.name, userId).run();
    }
    if (body.role && ['admin','ghaya_admin'].includes(body.role)) {
      await db.prepare(`UPDATE users SET role=?, updated_at=datetime('now') WHERE id=?`)
        .bind(body.role, userId).run();
    }
    const updated = await db.prepare(`SELECT id, email, name, role, created_at FROM users WHERE id=?`).bind(userId).first();
    return json({ user: updated });
  }

  // ── DELETE /api/users/:id — remove a user ──
  if (method === 'DELETE' && userId) {
    if (userId === user.sub) return error('Cannot delete your own account', 400);
    await db.prepare(`DELETE FROM users WHERE id=?`).bind(userId).run();
    return json({ deleted: true });
  }

  return error('Method not allowed', 405);
}
