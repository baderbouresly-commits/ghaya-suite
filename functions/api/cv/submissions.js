// GET  /api/cv/submissions  – list all CV submissions (Ghaya admin only)
// POST /api/cv/submissions  – submit a new CV (public, no auth)
import { json, error, requireAuth } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status || 401);

  if (!['company_admin', 'ghaya', 'ghaya_admin'].includes(auth.user.role)) {
    return error('Forbidden', 403);
  }

  const url = new URL(request.url);
  const field    = url.searchParams.get('field')    || '';
  const visa     = url.searchParams.get('visa')     || '';
  const location = url.searchParams.get('location') || '';
  const status   = url.searchParams.get('status')   || '';

  let query = 'SELECT id,full_name,email,whatsapp,nationality,location,visa_status,current_title,years_experience,field,open_to,cv_link,cv_file,cv_filename,expected_salary,notes,status,submitted_at,updated_at FROM cv_submissions WHERE 1=1';
  const binds = [];

  if (field)    { query += ' AND field = ?';          binds.push(field); }
  if (visa)     { query += ' AND visa_status LIKE ?'; binds.push('%'+visa+'%'); }
  if (location) { query += ' AND location LIKE ?';    binds.push('%'+location+'%'); }
  if (status)   { query += ' AND status = ?';         binds.push(status); }

  query += ' ORDER BY submitted_at DESC';

  const stmt = env.DB.prepare(query);
  const result = await (binds.length ? stmt.bind(...binds) : stmt).all();

  return json({ submissions: result.results || [] });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON', 400); }

  const {
    full_name, email, whatsapp, nationality, location,
    visa_status, current_title, years_experience, field,
    open_to, cv_link, cv_file, cv_filename,
    expected_salary, notes
  } = body;

  if (!full_name) return error('Full name is required', 400);

  // Upload PDF to R2 instead of storing base64 in D1
  let cvFileKey = null;
  if (cv_file && cv_file.startsWith('data:')) {
    try {
      const base64 = cv_file.split(',')[1];
      const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      cvFileKey = `cvs/${Date.now()}-${Math.random().toString(36).substr(2, 9)}.pdf`;
      await env.R2.put(cvFileKey, binary, { httpMetadata: { contentType: 'application/pdf' } });
    } catch (e) {
      console.error('R2 upload error:', e);
    }
  }

  try {
    await env.DB.prepare(`
INSERT OR REPLACE INTO cv_submissions
        (full_name, email, whatsapp, nationality, location, visa_status,
        current_title, years_experience, field, open_to, cv_link,
        cv_file, cv_filename, expected_salary, notes, status, submitted_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
`).bind(
      full_name || null, email || null, whatsapp || null, nationality || null,
      location || null, visa_status || null, current_title || null,
      years_experience ? parseInt(years_experience) : null,
      field || null, open_to || null, cv_link || null,
      cvFileKey || null, cv_filename || null, expected_salary || null, notes || null
    ).run();

    return json({ success: true });
  } catch (err) {
    console.error('CV submit error:', err);
    return error('Failed to save: ' + err.message, 500);
  }
}
