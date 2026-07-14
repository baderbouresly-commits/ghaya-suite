// functions/api/eos.js — self-contained, no imports
const enc = new TextEncoder();

function parseB64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

async function verifyJWT(token, secret) {
  try {
    const [h, b, sig] = token.split('.');
    if (!h || !b || !sig) return null;
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, parseB64u(sig), enc.encode(`${h}.${b}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(parseB64u(b)));
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
}

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
      years_of_service: Math.round(years*100)/100, total_days: Math.round(totalDays),
      daily_wage: Math.round(dailyWage*1000)/1000,
      first_5_years:0, beyond_5_years:0,
      first_5_years_amount:0, beyond_5_years_amount:0,
      full_indemnity:0, factor:0,
      factor_reason:'Less than 1 year of service — no entitlement',
      final_indemnity:0
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
    if (years < 3)       { factor = 0;   factorReason = 'Resigned < 3 years — no entitlement'; }
    else if (years < 5)  { factor = 0.5; factorReason = 'Resigned 3–5 years — 50% of indemnity'; }
    else if (years < 10) { factor = 2/3; factorReason = 'Resigned 5–10 years — 66.7% of indemnity'; }
    else                 { factor = 1;   factorReason = 'Resigned 10+ years — full indemnity'; }
  }
  return {
    years_of_service: Math.round(years*100)/100,
    total_days: Math.round(totalDays),
    daily_wage: Math.round(dailyWage*1000)/1000,
    first_5_years: Math.round(first5*100)/100,
    beyond_5_years: Math.round(beyond5*100)/100,
    first_5_years_amount: Math.round(first5Amount*1000)/1000,
    beyond_5_years_amount: Math.round(beyond5Amount*1000)/1000,
    full_indemnity: Math.round(fullIndemnity*1000)/1000,
    factor, factor_reason: factorReason,
    final_indemnity: Math.round(fullIndemnity*factor*1000)/1000
  };
}

export async function onRequestGet({request, env}) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json({error:'Unauthorized'}, 401);
  const user = await verifyJWT(token, env.JWT_SECRET);
  if (!user) return json({error:'Token expired or invalid'}, 401);

  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'termination';

  let employeeId = user.employee_id;
  const empParam = url.searchParams.get('employee_id');
  if (empParam && ['company_admin','manager','ghaya_admin'].includes(user.role)) {
    employeeId = empParam;
  }
  if (!employeeId) return json({error:'No employee record linked to your account'}, 404);

  const emp = await env.DB.prepare(
    'SELECT id, first_name_en, last_name_en, hire_date, basic_salary FROM employees WHERE id = ?'
  ).bind(employeeId).first();

  if (!emp) return json({error:'Employee not found'}, 404);
  if (!emp.hire_date) return json({error:'No hire date set for this employee'}, 400);

  const result = calcEOS(emp.hire_date, parseFloat(emp.basic_salary||0), type);
  if (!result) return json({error:'Invalid hire date format'}, 500);

  return json({
    employee: {
      id: emp.id,
      name: `${emp.first_name_en} ${emp.last_name_en}`,
      hire_date: emp.hire_date,
      basic_salary: parseFloat(emp.basic_salary||0)
    },
    ...result
  });
}

