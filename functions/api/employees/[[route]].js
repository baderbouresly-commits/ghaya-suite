// /api/employees/* — CRUD for company employees
import { requireAuth, requireRole, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);
  const route = params.route || [];
  const employeeId = Array.isArray(route) ? route[0] : route;

  // Only ghaya_admin, company_admin, manager can access employee data
  if (!['ghaya_admin','company_admin','manager','employee'].includes(user.role)) {
    return error('Forbidden', 403);
  }

  // Employees can only see their own record
  if (user.role === 'employee') {
    if (method !== 'GET') return error('Forbidden', 403);
    const emp = await db.prepare(
      'SELECT * FROM employees WHERE user_id = ? AND company_id = ?'
    ).bind(user.sub, user.company_id).first();
    return emp ? json({ employee: emp }) : error('Not found', 404);
  }

  // company scope
  const companyId = user.role === 'ghaya_admin'
    ? url.searchParams.get('company_id')
    : user.company_id;
  if (!companyId) return error('company_id required');

  // GET /api/employees
  if (method === 'GET' && !employeeId) {
    // Managers only see their own department
    const deptFilter = user.role === 'manager' && user.department_id
      ? 'AND e.department_id = ?' : '';
    const binds = deptFilter
      ? [companyId, user.department_id] : [companyId];
    const { results } = await db.prepare(`
      SELECT e.*, d.name_en as dept_name, j.title_en as job_title,
        u.email as login_email
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN job_titles j ON j.id = e.job_title_id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.company_id = ? AND e.status != 'terminated' ${deptFilter}
      ORDER BY e.first_name_en
    `).bind(...binds).all();
    return json({ employees: results, total: results.length });
  }

  // GET /api/employees/:id
  if (method === 'GET' && employeeId) {
    const emp = await db.prepare(`
      SELECT e.*, d.name_en as dept_name, j.title_en as job_title,
        u.email as login_email
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN job_titles j ON j.id = e.job_title_id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = ? AND e.company_id = ?
    `).bind(employeeId, companyId).first();
    if (!emp) return error('Employee not found', 404);
    return json({ employee: emp });
  }

  // POST /api/employees — create employee
  if (method === 'POST') {
    if (!['ghaya_admin','company_admin'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const {
      first_name_en, last_name_en, first_name_ar, last_name_ar,
      civil_id, nationality, is_kuwaiti, gender, date_of_birth,
      mobile, work_email, personal_email,
      department_id, job_title_id, direct_manager_id,
      employment_type, hire_date, probation_end_date,
      basic_salary, housing_allowance, transport_allowance, other_allowances,
      annual_leave_days, pifss_enrolled, pifss_start_date,
      employee_number, notes
    } = body;

    if (!first_name_en || !hire_date) return error('first_name_en and hire_date are required');

    // Get company settings for law minimums
    const settings = await db.prepare('SELECT * FROM company_settings WHERE company_id = ?').bind(companyId).first();
    const lawMinLeave = settings?.default_annual_leave ?? 30;
    const actualLeave = annual_leave_days ? Math.max(annual_leave_days, lawMinLeave) : lawMinLeave;

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO employees (
        id, company_id, employee_number,
        first_name_en, last_name_en, first_name_ar, last_name_ar,
        civil_id, nationality, is_kuwaiti, gender, date_of_birth,
        mobile, work_email, personal_email,
        department_id, job_title_id, direct_manager_id,
        employment_type, hire_date, probation_end_date,
        basic_salary, housing_allowance, transport_allowance, other_allowances,
        annual_leave_days, pifss_enrolled, pifss_start_date, notes, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')
    `).bind(
      id, companyId, employee_number || null,
      first_name_en, last_name_en || '', first_name_ar || null, last_name_ar || null,
      civil_id || null, nationality || null, is_kuwaiti ? 1 : 0, gender || null, date_of_birth || null,
      mobile || null, work_email || null, personal_email || null,
      department_id || null, job_title_id || null, direct_manager_id || null,
      employment_type || 'full_time', hire_date, probation_end_date || null,
      basic_salary || 0, housing_allowance || 0, transport_allowance || 0, other_allowances || 0,
      actualLeave, pifss_enrolled ? 1 : 0, pifss_start_date || null, notes || null
    ).run();

    // Create login user if work_email provided
    if (work_email) {
      const userId = crypto.randomUUID();
      // Temporary password = first name + hire year (e.g. Ahmed2024)
      const { hashPassword } = await import('../_lib/auth.js');
      const hireYear = hire_date.substring(0,4);
      const tempPass = `${first_name_en}${hireYear}!`;
      const hash = await hashPassword(tempPass);
      await db.prepare(
        "INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role, employee_id, is_active) VALUES (?,?,?,?,'employee',?,1)"
      ).bind(userId, companyId, work_email.toLowerCase(), hash, id).run();
      await db.prepare("UPDATE employees SET user_id = ? WHERE id = ?").bind(userId, id).run();
    }

    // Audit log
    await db.prepare(
      "INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, new_values) VALUES (?,?,?,?,?,?)"
    ).bind(companyId, user.sub, 'employee.create', 'employee', id, JSON.stringify(body)).run();

    const created = await db.prepare('SELECT * FROM employees WHERE id = ?').bind(id).first();
    return json({ employee: created, message: 'Employee created' }, 201);
  }

  // PUT /api/employees/:id — update
  if (method === 'PUT' && employeeId) {
    if (!['ghaya_admin','company_admin','manager'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const allowed = [
      'first_name_en','last_name_en','first_name_ar','last_name_ar',
      'civil_id','nationality','gender','date_of_birth','mobile',
      'work_email','personal_email','department_id','job_title_id',
      'direct_manager_id','employment_type','probation_end_date',
      'basic_salary','housing_allowance','transport_allowance','other_allowances',
      'annual_leave_days','pifss_enrolled','pifss_start_date','notes','status'
    ];
    const updates = Object.entries(body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return error('No valid fields to update');

    const setClause = updates.map(([k]) => `${k} = ?`).join(', ');
    const values = updates.map(([,v]) => v);
    values.push(employeeId, companyId);

    await db.prepare(
      `UPDATE employees SET ${setClause}, updated_at = datetime('now') WHERE id = ? AND company_id = ?`
    ).bind(...values).run();

    // Handle password update if provided
    if (body.initial_password && body.initial_password.trim().length >= 6) {
      const { hashPassword } = await import('../_lib/auth.js');
      const newHash = await hashPassword(body.initial_password.trim());
      // Find employee's linked user and update password + ensure is_active = 1
      const emp = await db.prepare('SELECT user_id FROM employees WHERE id = ? AND company_id = ?').bind(employeeId, companyId).first();
      if (emp?.user_id) {
        await db.prepare("UPDATE users SET password_hash = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?")
          .bind(newHash, emp.user_id).run();
      }
    }

    await db.prepare(
      "INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, new_values) VALUES (?,?,?,?,?,?)"
    ).bind(companyId, user.sub, 'employee.update', 'employee', employeeId, JSON.stringify(body)).run();

    const updated = await db.prepare('SELECT * FROM employees WHERE id = ?').bind(employeeId).first();
    return json({ employee: updated, message: 'Employee updated' });
  }

  // DELETE /api/employees/:id — soft delete (terminate)
  if (method === 'DELETE' && employeeId) {
    if (!['ghaya_admin','company_admin'].includes(user.role)) return error('Forbidden', 403);
    await db.prepare(
      "UPDATE employees SET status = 'terminated', termination_date = date('now'), updated_at = datetime('now') WHERE id = ? AND company_id = ?"
    ).bind(employeeId, companyId).run();
    return json({ message: 'Employee terminated' });
  }

  return error('Not found', 404);
}
