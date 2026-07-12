// GET /api/dashboard — returns role-appropriate dashboard data
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db = env.DB;
  const companyId = user.company_id;

  // ── EMPLOYEE DASHBOARD ──────────────────────
  if (user.role === 'employee') {
    const empId = user.employee_id;
    if (!empId) return error('No employee record linked to this account');

    const emp = await db.prepare('SELECT * FROM employees WHERE id = ?').bind(empId).first();

    // Leave balances this year
    const year = new Date().getFullYear();
    const { results: balances } = await db.prepare(`
      SELECT lb.entitled_days, lb.used_days, lb.pending_days,
             lt.name_en as type_name, lt.name_ar as type_name_ar
      FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.employee_id = ? AND lb.year = ?
    `).bind(empId, year).all();

    // Recent leave requests
    const { results: recentLeaves } = await db.prepare(`
      SELECT lr.start_date, lr.end_date, lr.days_count, lr.status,
             lt.name_en as type_name
      FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.employee_id = ? ORDER BY lr.created_at DESC LIMIT 5
    `).bind(empId).all();

    // Latest payslip
    const payslip = await db.prepare(`
      SELECT pe.net_salary, pe.gross_salary, pe.payslip_published_at,
             pr.period_month, pr.period_year
      FROM payroll_entries pe JOIN payroll_runs pr ON pr.id = pe.payroll_run_id
      WHERE pe.employee_id = ? AND pe.payslip_published = 1
      ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 1
    `).bind(empId).first();

    // Expiring documents (next 30 days)
    const { results: expiringDocs } = await db.prepare(`
      SELECT ed.expiry_date, dt.name_en as doc_type
      FROM employee_documents ed JOIN document_types dt ON dt.id = ed.document_type_id
      WHERE ed.employee_id = ? AND ed.expiry_date IS NOT NULL
        AND date(ed.expiry_date) <= date('now', '+30 days')
        AND date(ed.expiry_date) >= date('now')
      ORDER BY ed.expiry_date ASC
    `).bind(empId).all();

    // Company settings for visibility
    const settings = await db.prepare('SELECT * FROM company_settings WHERE company_id = ?').bind(companyId).first();

    return json({
      role: 'employee',
      employee: {
        id: emp.id,
        name_en: `${emp.first_name_en} ${emp.last_name_en}`,
        name_ar: emp.first_name_ar ? `${emp.first_name_ar} ${emp.last_name_ar}` : null,
        hire_date: emp.hire_date,
        status: emp.status,
      },
      leave_balances: settings?.show_leave_balance_to_employee ? balances : [],
      recent_leaves: recentLeaves,
      latest_payslip: settings?.show_payslips_to_employee ? payslip : null,
      expiring_documents: expiringDocs,
      visibility: {
        show_salary: !!settings?.show_salary_to_employee,
        show_leave: !!settings?.show_leave_balance_to_employee,
        show_payslips: !!settings?.show_payslips_to_employee,
        show_documents: !!settings?.show_documents_to_employee,
      }
    });
  }

  // ── COMPANY ADMIN / MANAGER DASHBOARD ──────
  if (['company_admin','manager'].includes(user.role)) {
    if (!companyId) return error('No company linked');

    const [headcount, onLeave, pending, departments] = await Promise.all([
      db.prepare("SELECT COUNT(*) as total FROM employees WHERE company_id = ? AND status = 'active'").bind(companyId).first(),
      db.prepare("SELECT COUNT(*) as total FROM employees WHERE company_id = ? AND status = 'on_leave'").bind(companyId).first(),
      db.prepare("SELECT COUNT(*) as total FROM leave_requests WHERE company_id = ? AND status = 'pending'").bind(companyId).first(),
      db.prepare("SELECT d.name_en, COUNT(e.id) as count FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status='active' WHERE d.company_id = ? GROUP BY d.id ORDER BY count DESC").bind(companyId).all(),
    ]);

    const { results: pendingLeaves } = await db.prepare(`
      SELECT lr.id, lr.start_date, lr.end_date, lr.days_count,
             e.first_name_en || ' ' || e.last_name_en as employee_name,
             lt.name_en as type_name
      FROM leave_requests lr
      JOIN employees e ON e.id = lr.employee_id
      JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.company_id = ? AND lr.status = 'pending'
      ORDER BY lr.created_at ASC LIMIT 10
    `).bind(companyId).all();

    // Latest payroll run
    const payrollRun = await db.prepare(
      "SELECT * FROM payroll_runs WHERE company_id = ? ORDER BY period_year DESC, period_month DESC LIMIT 1"
    ).bind(companyId).first();

    // Documents expiring in 30 days
    const { results: expiringDocs } = await db.prepare(`
      SELECT ed.expiry_date, dt.name_en as doc_type,
             e.first_name_en || ' ' || e.last_name_en as employee_name
      FROM employee_documents ed
      JOIN document_types dt ON dt.id = ed.document_type_id
      JOIN employees e ON e.id = ed.employee_id
      WHERE e.company_id = ? AND ed.expiry_date IS NOT NULL
        AND date(ed.expiry_date) <= date('now', '+30 days')
        AND date(ed.expiry_date) >= date('now')
      ORDER BY ed.expiry_date ASC LIMIT 10
    `).bind(companyId).all();

    // Probations ending soon
    const { results: probationEnding } = await db.prepare(`
      SELECT first_name_en || ' ' || last_name_en as name, probation_end_date
      FROM employees WHERE company_id = ? AND status = 'probation'
        AND probation_end_date IS NOT NULL
        AND date(probation_end_date) <= date('now', '+14 days')
        AND date(probation_end_date) >= date('now')
      ORDER BY probation_end_date ASC
    `).bind(companyId).all();

    const company = await db.prepare('SELECT name_en, managed_by_ghaya, subscription_tier FROM companies WHERE id = ?').bind(companyId).first();

    return json({
      role: user.role,
      company,
      stats: {
        headcount: headcount?.total || 0,
        on_leave: onLeave?.total || 0,
        pending_leaves: pending?.total || 0,
      },
      departments: departments.results || [],
      pending_leaves: pendingLeaves,
      latest_payroll: payrollRun,
      expiring_documents: expiringDocs,
      probation_ending: probationEnding,
    });
  }

  // ── GHAYA SUPER ADMIN DASHBOARD ─────────────
  if (user.role === 'ghaya_admin') {
    const [companies, users, managed] = await Promise.all([
      db.prepare("SELECT COUNT(*) as total FROM companies").first(),
      db.prepare("SELECT COUNT(*) as total FROM employees WHERE status = 'active'").first(),
      db.prepare("SELECT COUNT(*) as total FROM companies WHERE managed_by_ghaya = 1").first(),
    ]);

    const { results: recentCompanies } = await db.prepare(
      "SELECT id, name_en, name_ar, subscription_tier, subscription_active, managed_by_ghaya, created_at FROM companies ORDER BY created_at DESC LIMIT 10"
    ).all();

    const { results: pendingLeaves } = await db.prepare(`
      SELECT lr.id, lr.days_count, lr.status, c.name_en as company_name,
             e.first_name_en || ' ' || e.last_name_en as employee_name
      FROM leave_requests lr
      JOIN employees e ON e.id = lr.employee_id
      JOIN companies c ON c.id = lr.company_id
      WHERE lr.status = 'pending' ORDER BY lr.created_at ASC LIMIT 20
    `).all();

    return json({
      role: 'ghaya_admin',
      stats: {
        total_companies: companies?.total || 0,
        total_employees: users?.total || 0,
        managed_companies: managed?.total || 0,
      },
      recent_companies: recentCompanies,
      pending_leaves: pendingLeaves.results || [],
    });
  }

  return error('Unauthorized', 401);
}
