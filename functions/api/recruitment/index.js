// /api/recruitment — list (GET) and create (POST)
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }
  });

  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;

  const db = env.DB;
  const method = request.method;
  const isGhaya = user.role === 'ghaya_admin';
  const isAdmin = ['company_admin', 'admin'].includes(user.role) || isGhaya;
  const companyId = user.company_id;

  if (!isAdmin) return error('Forbidden', 403);

  // ── GET /recruitment — list requests ──────────────────────────────────────
  if (method === 'GET') {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');

    let q = `SELECT rr.*, c.name_en as company_name,
      (SELECT COUNT(*) FROM recruitment_candidates rc WHERE rc.request_id = rr.id) as candidates_count,
      (SELECT COUNT(*) FROM recruitment_candidates rc WHERE rc.request_id = rr.id AND rc.selected_by_company = 1) as selected_count
      FROM recruitment_requests rr
      LEFT JOIN companies c ON c.id = rr.company_id
      WHERE 1=1`;
    const binds = [];

    if (!isGhaya) { q += ' AND rr.company_id = ?'; binds.push(companyId); }
    if (status) { q += ' AND rr.status = ?'; binds.push(status); }
    q += ' ORDER BY rr.created_at DESC';

    const { results } = await db.prepare(q).bind(...binds).all();

    let pendingCount = 0;
    if (isGhaya) {
      const pc = await db.prepare("SELECT COUNT(*) as c FROM recruitment_requests WHERE status = 'pending'").first();
      pendingCount = pc?.c || 0;
    }

    return json({ requests: results, pending_count: pendingCount });
  }

  // ── POST /recruitment — company creates a request ─────────────────────────
  if (method === 'POST') {
    if (isGhaya) return error('Ghaya admin cannot create requests', 400);
    const body = await request.json();
    const { job_title, department, positions_count, collar_type, work_type, gender,
            nationality, visa_status, experience_years, salary_budget, urgency, notes } = body;

    if (!job_title) return error('job_title required');
    if (!collar_type) return error('collar_type required');

    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO recruitment_requests
      (id, company_id, job_title, department, positions_count, collar_type, work_type,
       gender, nationality, visa_status, experience_years, salary_budget, urgency, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, companyId, job_title, department || null, parseInt(positions_count) || 1,
        collar_type, work_type || 'full_time', gender || 'any', nationality || 'any',
        visa_status || 'any', parseInt(experience_years) || 0,
        salary_budget ? parseFloat(salary_budget) : null, urgency || 'normal', notes || null)
      .run();

    const created = await db.prepare('SELECT * FROM recruitment_requests WHERE id = ?').bind(id).first();
    return json({ request: created }, 201);
  }

  return error('Method not allowed', 405);
}
