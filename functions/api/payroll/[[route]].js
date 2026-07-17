// /api/payroll/* — payroll runs, entries, publish
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    }
  });

  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;

  if (!['company_admin', 'admin', 'ghaya_admin'].includes(user.role)) return error('Forbidden', 403);

  const db = env.DB;
  const companyId = user.company_id;
  if (!companyId) return error('No company associated', 400);

  // Route segment after /payroll/
  const slug = (params.route || []).join('/');

  // ── GET /api/payroll — list all runs ──
  if (request.method === 'GET' && !slug) {
    const runs = await db.prepare(`
      SELECT id, period_month, period_year, status,
             total_gross, total_net, total_pifss_employee, total_pifss_employer,
             created_at, approved_at, paid_at,
             (SELECT COUNT(*) FROM payroll_entries WHERE payroll_run_id = payroll_runs.id) AS employee_count
      FROM payroll_runs
      WHERE company_id = ?
      ORDER BY period_year DESC, period_month DESC
    `).bind(companyId).all();
    return json({ runs: runs.results || [] });
  }

  // ── GET /api/payroll/:id — single run with entries ──
  if (request.method === 'GET' && slug) {
    const run = await db.prepare(
      `SELECT * FROM payroll_runs WHERE id = ? AND company_id = ?`
    ).bind(slug, companyId).first();
    if (!run) return error('Not found', 404);

    const entries = await db.prepare(`
      SELECT pe.*,
             e.first_name_en || ' ' || e.last_name_en AS employee_name,
             e.first_name_ar || ' ' || e.last_name_ar AS employee_name_ar,
             e.is_kuwaiti, e.pifss_enrolled
      FROM payroll_entries pe
      JOIN employees e ON e.id = pe.employee_id
      WHERE pe.payroll_run_id = ? AND pe.company_id = ?
      ORDER BY employee_name
    `).bind(slug, companyId).all();

    return json({ run, entries: entries.results || [] });
  }

  // ── POST /api/payroll — run payroll for a period ──
  if (request.method === 'POST') {
    const body = await request.json();
    const { period_month, period_year, apply_pifss = true } = body;

    if (!period_month || !period_year) return error('period_month and period_year required', 400);

    // Check for duplicate
    const existing = await db.prepare(
      `SELECT id FROM payroll_runs WHERE company_id = ? AND period_month = ? AND period_year = ?`
    ).bind(companyId, period_month, period_year).first();
    if (existing) return error(`Payroll for ${period_month}/${period_year} already exists`, 409);

    // Get company PIFSS settings
    let settings = await db.prepare(
      `SELECT pifss_employee_rate, pifss_employer_rate, pifss_salary_cap FROM company_settings WHERE company_id = ?`
    ).bind(companyId).first();
    if (!settings) settings = { pifss_employee_rate: 0.105, pifss_employer_rate: 0.115, pifss_salary_cap: 2750 };

    // Get active employees
    const empRows = await db.prepare(`
      SELECT id, first_name_en, last_name_en,
             basic_salary, housing_allowance, transport_allowance, other_allowances,
             is_kuwaiti, pifss_enrolled
      FROM employees
      WHERE company_id = ? AND status = 'active'
    `).bind(companyId).all();
    const employees = empRows.results || [];

    if (!employees.length) return error('No active employees found', 400);

    // Get approved overtime for the period
    const overtimeRows = await db.prepare(`
      SELECT employee_id, SUM(overtime_pay) AS total_overtime
      FROM overtime_requests
      WHERE company_id = ? AND status = 'approved'
        AND strftime('%m', date) = printf('%02d', ?)
        AND strftime('%Y', date) = ?
      GROUP BY employee_id
    `).bind(companyId, period_month, String(period_year)).all();
    const overtimeMap = {};
    for (const ot of (overtimeRows.results || [])) {
      overtimeMap[ot.employee_id] = ot.total_overtime || 0;
    }

    // Create payroll run
    const runId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO payroll_runs (id, company_id, period_month, period_year, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, datetime('now'), datetime('now'))
    `).bind(runId, companyId, period_month, period_year, user.sub).run();

    // Calculate and insert entries
    let totalGross = 0, totalNet = 0, totalPifssEmp = 0, totalPifssEmr = 0;

    for (const emp of employees) {
      const gross = (emp.basic_salary || 0)
        + (emp.housing_allowance || 0)
        + (emp.transport_allowance || 0)
        + (emp.other_allowances || 0);
      const overtimePay = overtimeMap[emp.id] || 0;
      const totalGrossEmp = gross + overtimePay;

      let pifssEmployee = 0, pifssEmployer = 0;
      if (apply_pifss && emp.is_kuwaiti && emp.pifss_enrolled) {
        const base = Math.min(gross, settings.pifss_salary_cap);
        pifssEmployee = Math.round(base * settings.pifss_employee_rate * 1000) / 1000;
        pifssEmployer = Math.round(base * settings.pifss_employer_rate * 1000) / 1000;
      }

      const netSalary = totalGrossEmp - pifssEmployee;

      await db.prepare(`
        INSERT INTO payroll_entries
          (id, company_id, payroll_run_id, employee_id,
           basic_salary, housing_allowance, transport_allowance, other_allowances,
           gross_salary, overtime_pay, overtime_hours,
           pifss_employee, pifss_employer,
           net_salary, payslip_published)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)
      `).bind(
        crypto.randomUUID(), companyId, runId, emp.id,
        emp.basic_salary || 0, emp.housing_allowance || 0,
        emp.transport_allowance || 0, emp.other_allowances || 0,
        totalGrossEmp, overtimePay,
        pifssEmployee, pifssEmployer,
        netSalary
      ).run();

      totalGross += totalGrossEmp;
      totalNet += netSalary;
      totalPifssEmp += pifssEmployee;
      totalPifssEmr += pifssEmployer;
    }

    // Update run totals
    await db.prepare(`
      UPDATE payroll_runs SET
        total_gross = ?, total_net = ?,
        total_pifss_employee = ?, total_pifss_employer = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      Math.round(totalGross * 1000) / 1000,
      Math.round(totalNet * 1000) / 1000,
      Math.round(totalPifssEmp * 1000) / 1000,
      Math.round(totalPifssEmr * 1000) / 1000,
      runId
    ).run();

    const run = await db.prepare(`SELECT * FROM payroll_runs WHERE id = ?`).bind(runId).first();
    return json({ run, employees_processed: employees.length }, 201);
  }

  // ── PUT /api/payroll/:id — publish / update status ──
  if (request.method === 'PUT' && slug) {
    const body = await request.json();
    const { status } = body;

    const run = await db.prepare(
      `SELECT * FROM payroll_runs WHERE id = ? AND company_id = ?`
    ).bind(slug, companyId).first();
    if (!run) return error('Not found', 404);

    // Map 'published' → 'approved' (schema allows: draft/processing/approved/paid/locked)
    const newStatus = status === 'published' ? 'approved' : status;
    const allowed = ['draft', 'processing', 'approved', 'paid', 'locked'];
    if (!allowed.includes(newStatus)) return error('Invalid status', 400);

    if (newStatus === 'approved') {
      // Mark all payslips as published (visible to employees)
      await db.prepare(`
        UPDATE payroll_entries SET
          payslip_published = 1,
          payslip_published_at = datetime('now')
        WHERE payroll_run_id = ? AND company_id = ?
      `).bind(slug, companyId).run();

      await db.prepare(`
        UPDATE payroll_runs SET
          status = 'approved',
          approved_by = ?,
          approved_at = datetime('now'),
          updated_at = datetime('now')
        WHERE id = ? AND company_id = ?
      `).bind(user.sub, slug, companyId).run();
    } else {
      await db.prepare(`
        UPDATE payroll_runs SET status = ?, updated_at = datetime('now')
        WHERE id = ? AND company_id = ?
      `).bind(newStatus, slug, companyId).run();
    }

    const updated = await db.prepare(`SELECT * FROM payroll_runs WHERE id = ?`).bind(slug).first();
    return json({ run: updated });
  }

  // ── DELETE /api/payroll/:id — delete draft run ──
  if (request.method === 'DELETE' && slug) {
    const run = await db.prepare(
      `SELECT status FROM payroll_runs WHERE id = ? AND company_id = ?`
    ).bind(slug, companyId).first();
    if (!run) return error('Not found', 404);
    if (run.status !== 'draft') return error('Can only delete draft payroll runs', 400);

    await db.prepare(`DELETE FROM payroll_runs WHERE id = ? AND company_id = ?`).bind(slug, companyId).run();
    return json({ deleted: true });
  }

  return error('Method not allowed', 405);
}
