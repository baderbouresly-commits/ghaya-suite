// /api/announcements/* — company admins post, employees read
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const annId = Array.isArray(route) ? route[0] : route;

  // GET
  if (method === 'GET') {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (user.role === 'ghaya_admin') {
      const { results } = await db.prepare(`SELECT a.*, c.name_en as company_name FROM announcements a LEFT JOIN companies c ON c.id = a.company_id ORDER BY a.is_pinned DESC, a.created_at DESC`).all();
      return json({ announcements: results, total: results.length });
    }
    if (!user.company_id) return error('Forbidden', 403);
    if (['company_admin', 'manager'].includes(user.role)) {
      const { results } = await db.prepare(`SELECT * FROM announcements WHERE company_id = ? ORDER BY is_pinned DESC, created_at DESC`).bind(user.company_id).all();
      return json({ announcements: results, total: results.length });
    }
    if (user.role === 'employee') {
      const { results } = await db.prepare(`SELECT * FROM announcements WHERE company_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY is_pinned DESC, created_at DESC`).bind(user.company_id, now).all();
      return json({ announcements: results, total: results.length });
    }
    return error('Forbidden', 403);
  }

  // POST
  if (method === 'POST') {
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }
    const { type, title, body: msgBody, is_pinned, expires_at } = body;
    if (!title?.trim()) return error('Title is required');
    if (!msgBody?.trim()) return error('Body is required');
    const validTypes = ['general', 'urgent', 'holiday', 'policy'];
    const annType = validTypes.includes(type) ? type : 'general';
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO announcements (id, company_id, created_by, type, title, body, is_pinned, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user.company_id, user.sub, annType, title.trim(), msgBody.trim(), is_pinned ? 1 : 0, expires_at || null).run();
    return json({ message: 'Announcement posted', id }, 201);
  }

  // PUT
  if (method === 'PUT' && annId) {
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }
    const allowed = ['type', 'title', 'body', 'is_pinned', 'expires_at'];
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return error('No valid fields');
    const existing = await db.prepare('SELECT company_id FROM announcements WHERE id = ?').bind(annId).first();
    if (!existing) return error('Not found', 404);
    if (existing.company_id !== user.company_id) return error('Forbidden', 403);
    const setClause = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = [...updates.map(([, v]) => v), annId];
    await db.prepare(`UPDATE announcements SET ${setClause} WHERE id = ?`).bind(...values).run();
    return json({ message: 'Updated' });
  }

  // DELETE
  if (method === 'DELETE' && annId) {
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);
    const existing = await db.prepare('SELECT company_id FROM announcements WHERE id = ?').bind(annId).first();
    if (!existing) return error('Not found', 404);
    if (existing.company_id !== user.company_id) return error('Forbidden', 403);
    await db.prepare('DELETE FROM announcements WHERE id = ?').bind(annId).run();
    return json({ success: true });
  }

  return error('Not found', 404);
}
