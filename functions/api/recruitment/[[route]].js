// /api/recruitment/* — recruitment requests & candidates
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }
  });

  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;

  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const [seg0, seg1, seg2] = Array.isArray(route) ? route : [route];

  const isGhaya = user.role === 'ghaya_admin';
  const isAdmin = ['company_admin', 'admin'].includes(user.role) || isGhaya;
  const companyId = user.company_id;

  if (!isAdmin) return error('Forbidden', 403);

  // ── GET /recruitment — list requests ──────────────────────────────────────
  if (method === 'GET' && !seg0) {
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

    // Pending count for badge
    let pendingCount = 0;
    if (isGhaya) {
      const pc = await db.prepare("SELECT COUNT(*) as c FROM recruitment_requests WHERE status = 'pending'").first();
      pendingCount = pc?.c || 0;
    }

    return json({ requests: results, pending_count: pendingCount });
  }

  // ── GET /recruitment/:id — single request with candidates ─────────────────
  if (method === 'GET' && seg0 && !seg1) {
    const req = await db.prepare(`
      SELECT rr.*, c.name_en as company_name
      FROM recruitment_requests rr
      LEFT JOIN companies c ON c.id = rr.company_id
      WHERE rr.id = ?`).bind(seg0).first();
    if (!req) return error('Not found', 404);
    if (!isGhaya && req.company_id !== companyId) return error('Forbidden', 403);

    // Get candidates — contact info only visible after selection if not ghaya
    let { results: candidates } = await db.prepare(
      'SELECT * FROM recruitment_candidates WHERE request_id = ? ORDER BY created_at ASC'
    ).bind(seg0).all();

    // Company only sees contact details if contact_shared = 1
    if (!isGhaya) {
      candidates = candidates.map(c => ({
        ...c,
        contact_phone: c.contact_shared ? c.contact_phone : null,
        contact_email: c.contact_shared ? c.contact_email : null,
        cv_file_data: c.cv_file_data || null,
      }));
    }

    return json({ request: req, candidates });
  }

  // ── POST /recruitment — company creates a request ─────────────────────────
  if (method === 'POST' && !seg0) {
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

  // ── PUT /recruitment/:id — update request (ghaya updates status/notes, company can't edit after submit) ──
  if (method === 'PUT' && seg0 && !seg1) {
    const req = await db.prepare('SELECT * FROM recruitment_requests WHERE id = ?').bind(seg0).first();
    if (!req) return error('Not found', 404);
    if (!isGhaya && req.company_id !== companyId) return error('Forbidden', 403);

    const body = await request.json();

    // Ghaya actions: reject, add notes, mark completed
    if (isGhaya) {
      const { status, ghaya_notes, rejection_reason } = body;
      const validStatuses = ['pending', 'candidates_sent', 'selection_made', 'completed', 'rejected'];
      if (status && !validStatuses.includes(status)) return error('Invalid status');

      await db.prepare(`UPDATE recruitment_requests SET
        status = COALESCE(?, status),
        ghaya_notes = CASE WHEN ? IS NOT NULL THEN ? ELSE ghaya_notes END,
        rejection_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE rejection_reason END,
        rejected_at = CASE WHEN ? = 'rejected' THEN datetime('now') ELSE rejected_at END,
        updated_at = datetime('now')
        WHERE id = ?`)
        .bind(
          status || null,
          ghaya_notes !== undefined ? ghaya_notes : null, ghaya_notes !== undefined ? ghaya_notes : null,
          rejection_reason || null, rejection_reason || null,
          status || null,
          seg0
        ).run();
    } else {
      // Company can only cancel pending requests
      if (body.status === 'cancelled' && req.status === 'pending') {
        await db.prepare("UPDATE recruitment_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").bind(seg0).run();
      } else {
        return error('Cannot modify this request', 403);
      }
    }

    const updated = await db.prepare('SELECT * FROM recruitment_requests WHERE id = ?').bind(seg0).first();
    return json({ request: updated });
  }

  // ── POST /recruitment/:id/candidates — ghaya adds a candidate ─────────────
  if (method === 'POST' && seg0 && seg1 === 'candidates') {
    if (!isGhaya) return error('Forbidden', 403);
    const req = await db.prepare('SELECT * FROM recruitment_requests WHERE id = ?').bind(seg0).first();
    if (!req) return error('Request not found', 404);

    const body = await request.json();
    const { full_name, nationality, experience_years, current_location, visa_status,
            expected_salary, notes, cv_file_name, cv_file_data,
            contact_phone, contact_email } = body;

    if (!full_name) return error('full_name required');

    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO recruitment_candidates
      (id, request_id, company_id, full_name, nationality, experience_years, current_location,
       visa_status, expected_salary, notes, cv_file_name, cv_file_data, contact_phone, contact_email)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, seg0, req.company_id, full_name, nationality || null,
        parseInt(experience_years) || 0, current_location || null,
        visa_status || null, expected_salary ? parseFloat(expected_salary) : null,
        notes || null, cv_file_name || null, cv_file_data || null,
        contact_phone || null, contact_email || null)
      .run();

    // Auto-update request status to candidates_sent
    if (['pending'].includes(req.status)) {
      await db.prepare("UPDATE recruitment_requests SET status = 'candidates_sent', updated_at = datetime('now') WHERE id = ?").bind(seg0).run();
    }

    const candidate = await db.prepare('SELECT * FROM recruitment_candidates WHERE id = ?').bind(id).first();
    return json({ candidate }, 201);
  }

  // ── PUT /recruitment/:id/candidates/:cid — select / share contact ─────────
  if (method === 'PUT' && seg0 && seg1 === 'candidates' && seg2) {
    const req = await db.prepare('SELECT * FROM recruitment_requests WHERE id = ?').bind(seg0).first();
    if (!req) return error('Request not found', 404);

    const body = await request.json();

    // Company selects a candidate
    if (!isGhaya) {
      if (req.company_id !== companyId) return error('Forbidden', 403);
      if (req.status !== 'candidates_sent') return error('Cannot select yet');
      await db.prepare(`UPDATE recruitment_candidates SET selected_by_company = 1, selected_at = datetime('now') WHERE id = ? AND request_id = ?`)
        .bind(seg2, seg0).run();
      // Update request status
      await db.prepare("UPDATE recruitment_requests SET status = 'selection_made', updated_at = datetime('now') WHERE id = ?").bind(seg0).run();
    }

    // Ghaya shares contact details
    if (isGhaya && body.share_contact) {
      await db.prepare('UPDATE recruitment_candidates SET contact_shared = 1 WHERE id = ? AND request_id = ?')
        .bind(seg2, seg0).run();
      // If all selected candidates have contact shared, mark completed
      await db.prepare("UPDATE recruitment_requests SET status = 'completed', updated_at = datetime('now') WHERE id = ? AND status = 'selection_made'").bind(seg0).run();
    }

    const candidate = await db.prepare('SELECT * FROM recruitment_candidates WHERE id = ?').bind(seg2).first();
    return json({ candidate });
  }

  // ── DELETE /recruitment/:id/candidates/:cid — ghaya removes a candidate ───
  if (method === 'DELETE' && seg0 && seg1 === 'candidates' && seg2) {
    if (!isGhaya) return error('Forbidden', 403);
    await db.prepare('DELETE FROM recruitment_candidates WHERE id = ? AND request_id = ?').bind(seg2, seg0).run();
    return json({ success: true });
  }

  // ── DELETE /recruitment/:id — ghaya or company deletes pending request ────
  if (method === 'DELETE' && seg0 && !seg1) {
    const req = await db.prepare('SELECT * FROM recruitment_requests WHERE id = ?').bind(seg0).first();
    if (!req) return error('Not found', 404);
    if (!isGhaya && req.company_id !== companyId) return error('Forbidden', 403);
    if (!isGhaya && req.status !== 'pending') return error('Can only delete pending requests');
    await db.prepare('DELETE FROM recruitment_requests WHERE id = ?').bind(seg0).run();
    return json({ success: true });
  }

  return error('Method not allowed', 405);
}
