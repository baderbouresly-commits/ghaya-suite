// /api/managers/* — company_admin manages department manager accounts
// GET    /api/managers           — list all managers for the company
// POST   /api/managers           — create a manager (user + employee record)
// PUT    /api/managers/:id       — update name, department, active status
// DELETE /api/managers/:id       — delete manager account

import { requireAuth, hashPassword, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  if (user.role !== 'company_admin') return error('Forbidden', 403);

  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const managerId = Array.isArray(route) ? route[0] : route;

  // ── GET /api/managers ─────────────────────────────────────────
  if (method === 'GET') {
    const { results } = await db.prepare(`
      SELECT u.id, u.email, u.is_active, u.created_at,
             e.first_name_en, e.last_name_en, e.department_id,
             d.name_en as department_name
      FROM users u
      LEFT JOIN employees e ON e.user_id = u.id AND e.company_id = ?
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE u.company_id = ? AND u.role = 'manager'
      ORDER BY e.first_name_en
    `).bind(user.company_id, user.company_id).all();
    return json({ managers: results });
  }

  // ── POST /api/managers — create ───────────────────────────────
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const { first_name, last_name, email: mgEmail, password, department_id } = body;
    if (!first_name?.trim()) return error('First name is required');
    if (!mgEmail?.trim()) return error('Email is required');
    if (!password || password.length < 6) return error('Password must be at least 6 characters');
    if (!department_id) return error('Department is required');

    // Check email not already used
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?')
      .bind(mgEmail.toLowerCase().trim()).first();
    if (existing) return error('This email is already registered');

    // Check department belongs to this company
    const dept = await db.prepare('SELECT id FROM departments WHERE id = ? AND company_id = ?')
      .bind(department_id, user.company_id).first();
    if (!dept) return error('Department not found');

    const pwdHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const empId = crypto.randomUUID();

    // Create user
    await db.prepare(`
      INSERT INTO users (id, company_id, email, password_hash, role, employee_id, is_active)
      VALUES (?, ?, ?, ?, 'manager', ?, 1)
    `).bind(userId, user.company_id, mgEmail.toLowerCase().trim(), pwdHash, empId).run();

    // Create minimal employee record (for department link + display name)
    await db.prepare(`
      INSERT INTO employees (id, company_id, user_id, first_name_en, last_name_en, department_id, hire_date, status, basic_salary)
      VALUES (?, ?, ?, ?, ?, ?, date('now'), 'active', 0)
    `).bind(empId, user.company_id, userId, first_name.trim(), (last_name||'').trim(), department_id).run();

    return json({
      message: 'Manager created',
      id: userId,
      name: `${first_name.trim()} ${(last_name||'').trim()}`.trim(),
    }, 201);
  }

  // ── PUT /api/managers/:id ─────────────────────────────────────
  if (method === 'PUT' && managerId) {
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    // Confirm this manager belongs to this company
    const mgr = await db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND role = ?')
      .bind(managerId, user.company_id, 'manager').first();
    if (!mgr) return error('Manager not found', 404);

    const { first_name, last_name, department_id, is_active, password } = body;

    // Update user fields
    if (typeof is_active !== 'undefined') {
      await db.prepare('UPDATE users SET is_active = ? WHERE id = ?')
        .bind(is_active ? 1 : 0, managerId).run();
    }
    if (password && password.length >= 6) {
      const pwdHash = await hashPassword(password);
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .bind(pwdHash, managerId).run();
    }

    // Update employee fields
    const empUpdates = [];
    const empVals = [];
    if (first_name) { empUpdates.push('first_name_en = ?'); empVals.push(first_name.trim()); }
    if (last_name !== undefined) { empUpdates.push('last_name_en = ?'); empVals.push(last_name.trim()); }
    if (department_id) { empUpdates.push('department_id = ?'); empVals.push(department_id); }
    if (empUpdates.length) {
      empVals.push(managerId);
      await db.prepare(`UPDATE employees SET ${empUpdates.join(', ')} WHERE user_id = ? AND company_id = ?`)
        .bind(...empVals, user.company_id).run();
    }

    return json({ message: 'Updated' });
  }

  // ── DELETE /api/managers/:id ──────────────────────────────────
  if (method === 'DELETE' && managerId) {
    const mgr = await db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ? AND role = ?')
      .bind(managerId, user.company_id, 'manager').first();
    if (!mgr) return error('Manager not found', 404);

    // Delete employee record first, then user
    await db.prepare('DELETE FROM employees WHERE user_id = ? AND company_id = ?')
      .bind(managerId, user.company_id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(managerId).run();

    return json({ success: true });
  }

  return error('Not found', 404);
}
