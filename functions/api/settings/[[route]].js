// /api/settings — company_settings CRUD (company_admin + ghaya_admin)
import { requireAuth, json, error } from '../_lib/auth.js';

// Kuwait Labour Law defaults — used for reset and for seeding new rows
const KLL_DEFAULTS = {
  default_annual_leave:    30,
  default_sick_leave:      15,
  default_maternity_leave: 70,
  default_paternity_leave: 3,
  default_unpaid_leave:    0,
  work_hours_per_day:      8.0,
  work_days_per_week:      5,
  overtime_rate_day:       1.25,
  overtime_rate_night:     1.50,
  overtime_rate_holiday:   2.00,
  indemnity_year1_rate:    15.0,
  indemnity_year6_rate:    30.0,
  pifss_employee_rate:     0.105,
  pifss_employer_rate:     0.115,
  pifss_salary_cap:        2750,
  show_salary_to_employee:         1,
  show_leave_balance_to_employee:  1,
  show_payslips_to_employee:       1,
  show_org_chart_to_employee:      0,
  show_colleagues_to_employee:     0,
  show_manager_to_employee:        1,
  show_documents_to_employee:      1,
  allowances_enabled:              1,
};

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }
  });

  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;

  if (!['company_admin', 'admin', 'ghaya_admin'].includes(user.role)) return error('Forbidden', 403);

  const db = env.DB;
  const companyId = user.company_id;
  if (!companyId) return error('No company associated with this account', 400);

  // ── GET /api/settings — fetch current settings ──
  if (request.method === 'GET') {
    let settings = await db.prepare(
      'SELECT * FROM company_settings WHERE company_id = ?'
    ).bind(companyId).first();

    // Auto-create row if it doesn't exist yet
    if (!settings) {
      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO company_settings (id, company_id) VALUES (?, ?)`)
        .bind(id, companyId).run();
      settings = await db.prepare('SELECT * FROM company_settings WHERE company_id = ?')
        .bind(companyId).first();
    }

    return json({ settings, kll_defaults: KLL_DEFAULTS });
  }

  // ── PUT /api/settings — update settings ──
  if (request.method === 'PUT') {
    const body = await request.json();
    const n  = v => v !== undefined ? v : null;
    const ni = v => v !== undefined && v !== null ? parseInt(v) : null;
    const nf = v => v !== undefined && v !== null ? parseFloat(v) : null;
    const nb = v => v !== undefined ? (v ? 1 : 0) : null;

    // Reset to KLL defaults if requested
    if (body.reset_to_kll) {
      await db.prepare(`UPDATE company_settings SET
        default_annual_leave    = 30,
        default_sick_leave      = 15,
        default_maternity_leave = 70,
        default_paternity_leave = 3,
        overtime_rate_day       = 1.25,
        overtime_rate_night     = 1.50,
        overtime_rate_holiday   = 2.00,
        indemnity_year1_rate    = 15.0,
        indemnity_year6_rate    = 30.0,
        pifss_employee_rate     = 0.105,
        pifss_employer_rate     = 0.115
        WHERE company_id = ?`).bind(companyId).run();
      const settings = await db.prepare('SELECT * FROM company_settings WHERE company_id = ?').bind(companyId).first();
      return json({ settings, kll_defaults: KLL_DEFAULTS, reset: true });
    }

    await db.prepare(`UPDATE company_settings SET
      default_annual_leave    = COALESCE(?, default_annual_leave),
      default_sick_leave      = COALESCE(?, default_sick_leave),
      default_maternity_leave = COALESCE(?, default_maternity_leave),
      default_paternity_leave = COALESCE(?, default_paternity_leave),
      default_unpaid_leave    = COALESCE(?, default_unpaid_leave),
      overtime_rate_day       = COALESCE(?, overtime_rate_day),
      overtime_rate_night     = COALESCE(?, overtime_rate_night),
      overtime_rate_holiday   = COALESCE(?, overtime_rate_holiday),
      indemnity_year1_rate    = COALESCE(?, indemnity_year1_rate),
      indemnity_year6_rate    = COALESCE(?, indemnity_year6_rate),
      pifss_employee_rate     = COALESCE(?, pifss_employee_rate),
      pifss_employer_rate     = COALESCE(?, pifss_employer_rate),
      show_salary_to_employee          = CASE WHEN ? IS NOT NULL THEN ? ELSE show_salary_to_employee END,
      show_leave_balance_to_employee   = CASE WHEN ? IS NOT NULL THEN ? ELSE show_leave_balance_to_employee END,
      show_payslips_to_employee        = CASE WHEN ? IS NOT NULL THEN ? ELSE show_payslips_to_employee END,
      show_org_chart_to_employee       = CASE WHEN ? IS NOT NULL THEN ? ELSE show_org_chart_to_employee END,
      show_colleagues_to_employee      = CASE WHEN ? IS NOT NULL THEN ? ELSE show_colleagues_to_employee END,
      show_manager_to_employee         = CASE WHEN ? IS NOT NULL THEN ? ELSE show_manager_to_employee END,
      show_documents_to_employee       = CASE WHEN ? IS NOT NULL THEN ? ELSE show_documents_to_employee END,
      allowances_enabled               = CASE WHEN ? IS NOT NULL THEN ? ELSE allowances_enabled END
      WHERE company_id = ?`)
      .bind(
        ni(body.default_annual_leave),
        ni(body.default_sick_leave),
        ni(body.default_maternity_leave),
        ni(body.default_paternity_leave),
        ni(body.default_unpaid_leave),
        nf(body.overtime_rate_day),
        nf(body.overtime_rate_night),
        nf(body.overtime_rate_holiday),
        nf(body.indemnity_year1_rate),
        nf(body.indemnity_year6_rate),
        nf(body.pifss_employee_rate),
        nf(body.pifss_employer_rate),
        nb(body.show_salary_to_employee), nb(body.show_salary_to_employee),
        nb(body.show_leave_balance_to_employee), nb(body.show_leave_balance_to_employee),
        nb(body.show_payslips_to_employee), nb(body.show_payslips_to_employee),
        nb(body.show_org_chart_to_employee), nb(body.show_org_chart_to_employee),
        nb(body.show_colleagues_to_employee), nb(body.show_colleagues_to_employee),
        nb(body.show_manager_to_employee), nb(body.show_manager_to_employee),
        nb(body.show_documents_to_employee), nb(body.show_documents_to_employee),
        nb(body.allowances_enabled), nb(body.allowances_enabled),
        companyId
      ).run();

    const settings = await db.prepare('SELECT * FROM company_settings WHERE company_id = ?').bind(companyId).first();
    return json({ settings, kll_defaults: KLL_DEFAULTS });
  }

  return error('Method not allowed', 405);
}
