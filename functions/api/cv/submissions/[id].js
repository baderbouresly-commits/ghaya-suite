import { json, error, requireAuth } from '../../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status || 401);
  if (!['company_admin', 'ghaya', 'ghaya_admin'].includes(auth.user.role)) {
    return error('Forbidden', 403);
  }
  const id = parseInt(params.id, 10);
  if (!id) return error('Invalid ID', 400);

  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT * FROM cv_submissions WHERE id = ?').bind(id).first();
    if (!row) return error('Not found', 404);
    return json({ submission: row });
  }

  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON', 400); }
    const { status, notes } = body;
    if (status) {
      const allowed = ['active', 'reviewed', 'shortlisted', 'rejected', 'hired'];
      if (!allowed.includes(status)) return error('Invalid status', 400);
    }
    await env.DB.prepare(
      "UPDATE cv_submissions SET status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?"
    ).bind(status || null, notes !== undefined ? notes : null, id).run();
    return json({ success: true });
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM cv_submissions WHERE id = ?').bind(id).run();
    return json({ success: true });
  }

  return error('Method not allowed', 405);
}
