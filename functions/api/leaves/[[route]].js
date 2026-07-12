// /api/leaves/* — Leave requests & balances
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);
  const route = Array.isArray(params.route) ? params.route : (params.route ? [params.route] : []);
  const subResource = route[0]; // 'request', 'balance', 'types', or request ID

  const companyId = user.role === 'ghaya_admin'
    ? url.searchParams.get('company_id')
    : user.company_id;
  if (!companyId) return error('company_id required');

  // ── GET /api/leaves/types ──────────────────
  if (method === 'GET' && subResource === 'types') {
    const { results } = await db.prepare(
      'SELECT * FROM leave_types WHERE company_id = ? AND is_active = 1 ORDER BY name_en'
    ).bind(companyId).all();
    return json({ leave_types: results });
  }

  // ── GET /api/leaves/balance?employee_id=&year= ──
  if (method === 'GET' && subResource === 'balance') {
    const empId = url.searchParams.get('employee_id') || user.employee_id;
    const year = url.searchParams.get('year') || new Date().getFullYear();
    if (user.role === 'employee' && empId !== user.employee_id) return error('Forbidden', 403);
    const { results } = await db.prepare(`
      SELECT lb.*, lt.name_en as type_name, lt.name_ar as type_name_ar, lt.is_paid
      FROM leave_balances lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = ? AND lb.year = ?
    `).bind(empId, year).all();
    return json({ balances: results, year: parseInt(year) });
  }

  // ── GET /api/leaves — list requests ────────
  if (method === 'GET' && !subResource) {
    const empId = url.searchParams.get('employee_id');
    const status = url.searchParams.get('status');
    let query, binds;

    if (user.role === 'employee') {
      query = `SELECT lr.*, lt.name_en as type_name, lt.name_ar as type_name_ar
               FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
               WHERE lr.employee_id = ? AND lr.company_id = ? ORDER BY lr.created_at DESC`;
      binds = [user.employee_id, companyId];
    } else if (empId) {
      query = `SELECT lr.*, lt.name_en as type_name, e.first_name_en, e.last_name_en
               FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
               JOIN employees e ON e.id = lr.employee_id
               WHERE lr.employee_id = ? AND lr.company_id = ? ORDER BY lr.created_at DESC`;
      binds = [empId, companyId];
    } else {
      const statusClause = status ? `AND lr.status = '${status.replace(/'/g,"''")}' ` : '';
      query = `SELECT lr.*, lt.name_en as type_name,
               e.first_name_en || ' ' || e.last_name_en as employee_name
               FROM leave_requests lr
               JOIN leave_types lt ON lt.id = lr.leave_type_id
               JOIN employees e ON e.id = lr.employee_id
               WHERE lr.company_id = ? ${statusClause}
               ORDER BY lr.created_at DESC LIMIT 100`;
      binds = [companyId];
    }
    const { results } = await db.prepare(query).bind(...binds).all();
    return json({ requests: results, total: results.length });
  }

  // ── POST /api/leaves — submit leave request ──
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

const { employee_id, start_date, end_date, reason } = body;
const leave_type_id = body.leave_type_id || body.leave_type;
    const empId = user.role === 'employee' ? user.employee_id : employee_id;
    if (!empId || !leave_type_id || !start_date || !end_date) {
      return error('employee_id, leave_type_id, start_date, end_date required');
    }

    // Calculate days count (simple calendar days for now)
    const start = new Date(start_date);
    const end = new Date(end_date);
    if (end < start) return error('end_date must be after start_date');
    const days = Math.round((end - start) / (1000*60*60*24)) + 1;

    // Check balance
    const year = start.getFullYear();
    const balance = await db.prepare(
      'SELECT * FROM leave_balances WHERE employee_id = ? AND leave_type_id = ? AND year = ?'
    ).bind(empId, leave_type_id, year).first();

    if (balance) {
      const available = balance.entitled_days - balance.used_days - balance.pending_days;
      if (days > available) return error(`Insufficient leave balance. Available: ${available} days`);
    }

const id = crypto.randomUUID();
    try {
      await db.prepare(`
        INSERT INTO leave_requests (id, company_id, employee_id, leave_type_id, start_date, end_date, days_count, reason, status)
        VALUES (?,?,?,?,?,?,?,?,'pending')
      `).bind(id, companyId, empId, leave_type_id, start_date, end_date, days, reason || null).run();
    } catch(e) {
      return error(`DB error: ${e.message} | cid=${companyId} eid=${empId} ltid=${leave_type_id}`, 500);
    }

    // Update pending balance
    if (balance) {
      await db.prepare(
        'UPDATE leave_balances SET pending_days = pending_days + ? WHERE employee_id = ? AND leave_type_id = ? AND year = ?'
      ).bind(days, empId, leave_type_id, year).run();
    }

    return json({ request_id: id, days_count: days, message: 'Leave request submitted' }, 201);
  }

  // ── PUT /api/leaves/:id — approve/reject ──
  if (method === 'PUT' && subResource) {
    if (!['ghaya_admin','company_admin','manager'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const { action, rejection_reason } = body;
    if (!['approve','reject','cancel'].includes(action)) return error('action must be approve, reject, or cancel');

    const lr = await db.prepare('SELECT * FROM leave_requests WHERE id = ? AND company_id = ?').bind(subResource, companyId).first();
    if (!lr) return error('Leave request not found', 404);
    if (lr.status !== 'pending') return error(`Cannot ${action} a ${lr.status} request`);

    const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
    await db.prepare(`
      UPDATE leave_requests SET status = ?, approved_by = ?, approved_at = datetime('now'), rejection_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newStatus, user.sub, rejection_reason || null, subResource).run();

    // Update leave balances
    if (action === 'approve') {
      await db.prepare(
        "UPDATE leave_balances SET pending_days = MAX(0, pending_days - ?), used_days = used_days + ? WHERE employee_id = ? AND leave_type_id = ? AND year = ?"
      ).bind(lr.days_count, lr.days_count, lr.employee_id, lr.leave_type_id, new Date(lr.start_date).getFullYear()).run();
    } else {
      await db.prepare(
        "UPDATE leave_balances SET pending_days = MAX(0, pending_days - ?) WHERE employee_id = ? AND leave_type_id = ? AND year = ?"
      ).bind(lr.days_count, lr.employee_id, lr.leave_type_id, new Date(lr.start_date).getFullYear()).run();
    }

    return json({ message: `Leave request ${newStatus}` });
  }

  return error('Not found', 404);
}
