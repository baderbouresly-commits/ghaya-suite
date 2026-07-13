import { requireAuth, json, error } from './_lib/auth.js';
function calcEOS(hireDate, basicSalary, type) {
  const now = new Date();
  const hire = new Date(hireDate);
  if (isNaN(hire)) return null;

  const msPerDay = 1000 * 60 * 60 * 24;
  const totalDays = (now - hire) / msPerDay;
  const years = totalDays / 365.25;
  const dailyWage = basicSalary / 30;

  if (years < 1) {
    return {
      years_of_service: Math.round(years * 100) / 100,
      daily_wage: Math.round(dailyWage * 1000) / 1000,
      first_5_years_amount: 0,
      beyond_5_years_amount: 0,
      full_indemnity: 0,
      factor: 0,
      factor_reason: 'Less than 1 year of service — no entitlement',
      final_indemnity: 0
    };
  }

  const first5 = Math.min(years, 5);
  const beyond5 = Math.max(0, years - 5);
  const first5Amount = first5 * 15 * dailyWage;
  const beyond5Amount = beyond5 * 30 * dailyWage;
  const fullIndemnity = first5Amount + beyond5Amount;

  let factor = 1;
  let factorReason = 'Full indemnity — terminated by employer';

  if (type === 'resignation') {
    if (years < 3) {
      factor = 0;
      factorReason = 'Resigned < 3 years — no entitlement';
    } else if (years < 5) {
      factor = 0.5;
      factorReason = 'Resigned 3–5 years — 50% of indemnity';
    } else if (years < 10) {
      factor = 2 / 3;
      factorReason = 'Resigned 5–10 years — 66.7% of indemnity';
    } else {
      factor = 1;
      factorReason = 'Resigned 10+ years — full indemnity';
    }
  }

  const finalIndemnity = fullIndemnity * factor;

  return {
    years_of_service: Math.round(years * 100) / 100,
    total_days: Math.round(totalDays),
    daily_wage: Math.round(dailyWage * 1000) / 1000,
    first_5_years: Math.round(first5 * 100) / 100,
    beyond_5_years: Math.round(beyond5 * 100) / 100,
    first_5_years_amount: Math.round(first5Amount * 1000) / 1000,
    beyond_5_years_amount: Math.round(beyond5Amount * 1000) / 1000,
    full_indemnity: Math.round(fullIndemnity * 1000) / 1000,
    factor,
    factor_reason: factorReason,
    final_indemnity: Math.round(finalIndemnity * 1000) / 1000
  };
}

export async function onRequestGet(ctx) {
  try {
    const user = await requireAuth(ctx);
    if (!user) return error('Unauthorized', 401);
    const { DB } = ctx.env;
    const url = new URL(ctx.request.url);
    const type = url.searchParams.get('type') || 'termination';

    let employeeId = user.employee_id;
    const empParam = url.searchParams.get('employee_id');
    if (empParam && ['company_admin', 'manager'].includes(user.role)) employeeId = empParam;
    if (!employeeId) return error('No employee record', 404);

    const emp = await DB.prepare(
      'SELECT id, first_name_en, last_name_en, hire_date, basic_salary FROM employees WHERE id = ?'
    ).bind(employeeId).first();

    if (!emp) return error('Employee not found', 404);
    if (!emp.hire_date) return error('No hire date set', 400);

    const result = calcEOS(emp.hire_date, parseFloat(emp.basic_salary || 0), type);
    if (!result) return error('Calculation error', 500);

    return json({
      employee: {
        id: emp.id,
        name: `${emp.first_name_en} ${emp.last_name_en}`,
        hire_date: emp.hire_date,
        basic_salary: parseFloat(emp.basic_salary || 0)
      },
      ...result
    });
  } catch (e) {
    return error(e.message || 'Server error', 500);
  }
}
