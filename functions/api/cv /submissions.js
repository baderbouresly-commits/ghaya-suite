// GET /api/cv/submissions  — list all CV submissions (Ghaya admin only)
import { json, error, requireAuth } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return error(auth.message, 401);

  // Only Ghaya super-admins / company_admin users can view the talent pool
  // (restrict further to role==='ghaya' once that role exists)
  if (!['company_admin', 'ghaya'].includes(auth.user.role)) {
    return error('Forbidden', 403);
  }

  const url = new URL(request.url);
  const field    = url.searchParams.get('field')    || '';
  const visa     = url.searchParams.get('visa')     || '';
  const location = url.searchParams.get('location') || '';
  const status   = url.searchParams.get('status')   || '';

  let query = 'SELECT id,full_name,email,whatsapp,nationality,location,visa_status,current_title,years_experience,field,open_to,cv_link,cv_filename,expected_salary,notes,status,submitted_at,updated_at FROM cv_submissions WHERE 1=1';
  const binds = [];

  if (field)    { query += ' AND field = ?';       binds.push(field); }
  if (visa)     { query += ' AND visa_status LIKE ?'; binds.push('%'+visa+'%'); }
  if (location) { query += ' AND location LIKE ?'; binds.push('%'+location+'%'); }
  if (status)   { query += ' AND status = ?';      binds.push(status); }

  query += ' ORDER BY submitted_at DESC';

  const stmt = env.DB.prepare(query);
  const result = await (binds.length ? stmt.bind(...binds) : stmt).all();

  return json({ submissions: result.results || [] });
}
