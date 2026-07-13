import { requireAuth, json, error } from '../_lib/auth.js';
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function calcLeaveBalance(hireDate, approvedAnnualDays, approvedSickDays) {
  const now = new Date();
  const hire = new Date(hireDate);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  // Years of total service
  const msPerYear = 1000 * 60 * 60 * 24 * 365.25;
  const yearsOfService = (now - hire) / msPerYear;

  // Kuwait Labour Law: 30 days < 5 years, 35 days >= 5 years
  const annualEntitlement = yearsOfService >= 5 ? 35 : 30;

  // Pro-rata: accrual starts from hire date OR Jan 1 (whichever is later)
  const accrualStart = hire > yearStart ? hire : yearStart;
  const daysAccruing = Math.max(0, (now - accrualStart) / (1000 * 60 * 60 * 24));
  const daysInYear = isLeapYear(now.getFullYear()) ? 366 : 365;

  const accrued = (daysAccruing / daysInYear) * annualEntitlement;
  const annualBalance = Math.max(0, accrued - approvedAnnualDays);

  // Sick leave — Kuwait law: 15 days full pay per year
  const sickEntitlement = 15;
  const sickBalance = Math.max(0, sickEntitlement - approvedSickDays);

  return {
    years_of_service: Math.round(yearsOfService * 10) / 10,
    annual: {
      entitlement: annualEntitlement,
      accrued: Math.round(accrued * 10) / 10,
      taken: approvedAnnualDays,
      remaining: Math.round(annualBalance * 10) / 10
    },
    sick: {
      entitlement: sickEntitlement,
      taken: approvedSickDays,
      remaining: sickBalance
    }
  };
}

export async function onRequestGet(ctx) {
  try {
    const user = await requireAuth(ctx);
    if (!user) return error('Unauthorized', 401);

    const { DB } = ctx.env;
    const url = new URL(ctx.request.url);
    const year = new Date().getFullYear().toString();

    // Determine which employee to check
    let employeeId = user.employee_id;
    const empParam = url.searchParams.get('employee_id');
    if (empParam && ['company_admin', 'manager'].includes(user.role)) {
      employeeId = empParam;
    }

    if (!employeeId) return error('No employee record linked to this user', 404);

    // Get employee
    const emp = await DB.prepare(
      'SELECT id, first_name_en, last_name_en, hire_date, nationality FROM employees WHERE id = ?'
    ).bind(employeeId).first();
    if (!emp) return error('Employee not found', 404);
    if (!emp.hire_date) return error('Employee has no hire date set', 400);

    // Get approved leaves this year grouped by type
    const { results: leaves } = await DB.prepare(`
      SELECT leave_type,
             COALESCE(SUM(days_count), SUM(days_requested), 0) as total_days
      FROM leave_requests
      WHERE employee_id = ?
        AND status = 'approved'
        AND strftime('%Y', start_date) = ?
      GROUP BY leave_type
    `).bind(employeeId, year).all();

    const annualTaken = (leaves.find(l => l.leave_type === 'annual')?.total_days) || 0;
    const sickTaken   = (leaves.find(l => l.leave_type === 'sick')?.total_days)   || 0;

    const balance = calcLeaveBalance(emp.hire_date, annualTaken, sickTaken);

    return json({
      employee: {
        id: emp.id,
        name: `${emp.first_name_en} ${emp.last_name_en}`,
        hire_date: emp.hire_date
      },
      ...balance
    });
  } catch (e) {
    return error(e.message || 'Server error', 500);
  }
}
