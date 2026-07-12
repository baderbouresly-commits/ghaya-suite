// /api/payroll/* — Payroll management
import { requireAuth, json, error } from '../_lib/auth.js';

// Kuwait PIFSS rates — private sector
const PIFSS_EMP  = 0.08;  // 8%  — employee deduction (Kuwaiti nationals)
const PIFSS_EMPR = 0.11;  // 11% — employer cost      (Kuwaiti nationals)

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function round3(n){ return Math.round(n * 1000) / 1000; }

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db = env.DB;
  const method = request.method;
  const route = Array.isArray(params.route) ? params.route : (params.route ? [params.route] : []);
  const runId = route[0];

  const companyId = user.role === 'ghaya_admin'
    ? new URL(request.url).searchParams.get('company_id')
    : user.company_id;
  if (!companyId) return error('company_id required');

  // ── Employee: GET /api/payroll → my payslips ──────────────────
  if (method === 'GET' && !runId && user.role === 'employee') {
    const { results } = await db.prepare(`
      SELECT pe.*, pr.period_month, pr.period_year, pr.status as run_status
      FROM payroll_entries pe
      JOIN payroll_runs pr ON pr.id = pe.payroll_run_id
      WHERE pe.employee_id = ? AND pe.payslip_published = 1
      ORDER BY pr.period_year DESC, pr.period_month DESC
    `).bind(user.employee_id).all();
    return json({ payslips: results });
  }

  // ── Admin: GET /api/payroll → list all runs ───────────────────
  if (method === 'GET' && !runId) {
    if (!['ghaya_admin','company_admin','manager'].includes(user.role)) return error('Forbidden', 403);
    const { results } = await db.prepare(
      'SELECT * FROM payroll_runs WHERE company_id = ? ORDER BY period_year DESC, period_month DESC'
    ).bind(companyId).all();
    return json({ runs: results });
  }

  // ── GET /api/payroll/:id → run detail ────────────────────────
  if (method === 'GET' && runId) {
    const run = await db.prepare(
      'SELECT * FROM payroll_runs WHERE id = ? AND company_id = ?'
    ).bind(runId, companyId).first();
    if (!run) return error('Not found', 404);

    if (user.role === 'employee') {
      const entry = await db.prepare(`
        SELECT pe.*, e.first_name_en, e.last_name_en, e.nationality
        FROM payroll_entries pe JOIN employees e ON e.id = pe.employee_id
        WHERE pe.payroll_run_id = ? AND pe.employee_id = ? AND pe.payslip_published = 1
      `).bind(runId, user.employee_id).first();
      if (!entry) return error('Payslip not available', 404);
      return json({ run, entry });
    }

    const { results: entries } = await db.prepare(`
      SELECT pe.*, e.first_name_en, e.last_name_en, e.nationality, e.civil_id
      FROM payroll_entries pe JOIN employees e ON e.id = pe.employee_id
      WHERE pe.payroll_run_id = ? ORDER BY e.first_name_en
    `).bind(runId).all();
    return json({ run, entries });
  }

  // ── POST /api/payroll → run payroll for a month ───────────────
  if (method === 'POST' && !runId) {
    if (!['ghaya_admin','company_admin'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }

    const month = parseInt(body.month) || (new Date().getMonth() + 1);
    const year  = parseInt(body.year)  || new Date().getFullYear();
    if (month < 1 || month > 12) return error('Invalid month');

    // Prevent duplicate
    const existing = await db.prepare(
      'SELECT id FROM payroll_runs WHERE company_id = ? AND period_month = ? AND period_year = ?'
    ).bind(companyId, month, year).first();
    if (existing) return error(`Payroll for ${MONTHS[month-1]} ${year} already exists`, 409);

    // Get active employees
    const { results: employees } = await db.prepare(
      "SELECT * FROM employees WHERE company_id = ? AND status = 'active'"
    ).bind(companyId).all();
    if (!employees.length) return error('No active employees found');

    // Calculate
    let totalGross = 0, totalNet = 0, totalPifssEmp = 0, totalPifssEmpr = 0;
const apply_pifss = body.apply_pifss !== false;
    const calcs = employees.map(emp => {
      const basic    = parseFloat(emp.basic_salary || 0);
      const kuwaiti  = (emp.nationality || '').toLowerCase() === 'kuwaiti';
      const pifssE   = (kuwaiti && apply_pifss) ? round3(basic * PIFSS_EMP)  : 0;
      const pifssEr  = (kuwaiti && apply_pifss) ? round3(basic * PIFSS_EMPR) : 0;
      const net      = round3(basic - pifssE);
      totalGross    += basic;
      totalNet      += net;
      totalPifssEmp  += pifssE;
      totalPifssEmpr += pifssEr;
      return { emp, basic, pifssE, pifssEr, net };
    });

    // Create run
    const newRunId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO payroll_runs
        (id, company_id, period_month, period_year, status,
         total_gross, total_net, total_pifss_employee, total_pifss_employer, created_by)
      VALUES (?,?,?,?,'draft',?,?,?,?,?)
    `).bind(newRunId, companyId, month, year,
      round3(totalGross), round3(totalNet),
      round3(totalPifssEmp), round3(totalPifssEmpr),
      user.sub
    ).run();

    // Create entries
    for (const { emp, basic, pifssE, pifssEr, net } of calcs) {
      await db.prepare(`
        INSERT INTO payroll_entries
          (id, company_id, payroll_run_id, employee_id,
           basic_salary, gross_salary, pifss_employee, pifss_employer, net_salary)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(crypto.randomUUID(), companyId, newRunId, emp.id,
        basic, basic, pifssE, pifssEr, net
      ).run();
    }

    return json({
      run_id: newRunId,
      period: `${MONTHS[month-1]} ${year}`,
      employee_count: employees.length,
      total_gross: round3(totalGross),
      total_net: round3(totalNet),
      total_pifss_employee: round3(totalPifssEmp),
      total_pifss_employer: round3(totalPifssEmpr),
    }, 201);
  }

  // ── PUT /api/payroll/:id → publish / pay / delete ─────────────
  if (method === 'PUT' && runId) {
    if (!['ghaya_admin','company_admin'].includes(user.role)) return error('Forbidden', 403);
    let body;
    try { body = await request.json(); } catch { return error('Invalid JSON'); }
    const { action } = body;

    const run = await db.prepare(
      'SELECT * FROM payroll_runs WHERE id = ? AND company_id = ?'
    ).bind(runId, companyId).first();
    if (!run) return error('Not found', 404);

    if (action === 'publish') {
      await db.prepare(
        "UPDATE payroll_entries SET payslip_published=1, payslip_published_at=datetime('now') WHERE payroll_run_id=?"
      ).bind(runId).run();
      await db.prepare(
        "UPDATE payroll_runs SET status='approved', updated_at=datetime('now') WHERE id=?"
      ).bind(runId).run();
      return json({ message: 'Payslips published to employees ✓' });
    }

    if (action === 'pay') {
      await db.prepare(
        "UPDATE payroll_runs SET status='paid', paid_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
      ).bind(runId).run();
      return json({ message: 'Payroll marked as paid ✓' });
    }

    return error('Unknown action');
  }

  // ── DELETE /api/payroll/:id → delete draft ────────────────────
  if (method === 'DELETE' && runId) {
    if (!['ghaya_admin','company_admin'].includes(user.role)) return error('Forbidden', 403);
    const run = await db.prepare(
      'SELECT * FROM payroll_runs WHERE id = ? AND company_id = ?'
    ).bind(runId, companyId).first();
    if (!run) return error('Not found', 404);
    if (run.status === 'paid') return error('Cannot delete a paid payroll run');
    await db.prepare('DELETE FROM payroll_entries WHERE payroll_run_id=?').bind(runId).run();
    await db.prepare('DELETE FROM payroll_runs WHERE id=?').bind(runId).run();
    return json({ message: 'Deleted' });
  }

  return error('Not found', 404);
}
