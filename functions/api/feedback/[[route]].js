// /api/feedback/*
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const feedbackId = Array.isArray(route) ? route[0] : route;

  // POST — company admin submits
  if (method === 'POST') {
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const { type, title, message } = body;
    if (!title?.trim()) return error('Title is required');
    if (!message?.trim()) return error('Message is required');

    const validTypes = ['suggestion', 'bug', 'complaint', 'idea'];
    const feedType = validTypes.includes(type) ? type : 'suggestion';

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO feedback (id, company_id, submitted_by, type, title, message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, user.company_id, user.sub, feedType, title.trim(), message.trim()).run();

    return json({ message: 'Feedback submitted successfully', id }, 201);
  }

  // GET — ghaya_admin sees all; company_admin sees their own
  if (method === 'GET') {
    if (user.role === 'ghaya_admin') {
      const { results } = await db.prepare(`
        SELECT f.*, c.name_en as company_name
        FROM feedback f
        LEFT JOIN companies c ON c.id = f.company_id
        ORDER BY
          CASE f.status WHEN 'unread' THEN 0 WHEN 'read' THEN 1 ELSE 2 END,
          f.created_at DESC
      `).all();
      const unread = results.filter(r => r.status === 'unread').length;
      return json({ feedback: results, unread_count: unread, total: results.length });

    } else if (['company_admin', 'manager'].includes(user.role)) {
      const { results } = await db.prepare(`
        SELECT * FROM feedback WHERE company_id = ? ORDER BY created_at DESC
      `).bind(user.company_id).all();
      return json({ feedback: results, total: results.length });

    } else {
      return error('Forbidden', 403);
    }
  }

  // PUT — ghaya_admin marks read/resolved or replies
  if (method === 'PUT' && feedbackId) {
    if (user.role !== 'ghaya_admin') return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const allowed = ['status', 'admin_reply'];
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return error('No valid fields');

    const setClause = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = [...updates.map(([, v]) => v), feedbackId];

    await db.prepare(
      `UPDATE feedback SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values).run();

    return json({ message: 'Updated' });
  }

  return error('Not found', 404);
}
