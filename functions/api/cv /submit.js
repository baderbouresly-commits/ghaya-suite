// POST /api/cv/submit — public endpoint, no auth required
import { json, error } from '../_lib/auth.js';

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

  try {
    await env.DB.prepare(`
      INSERT INTO cv_submissions
        (full_name, email, whatsapp, nationality, location, visa_status,
         current_title, years_experience, field, open_to, cv_link,
         cv_file, cv_filename, expected_salary, notes, status, submitted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    `).bind(
      full_name || null,
      email || null,
      whatsapp || null,
      nationality || null,
      location || null,
      visa_status || null,
      current_title || null,
      years_experience ? parseInt(years_experience) : null,
      field || null,
      open_to || null,
      cv_link || null,
      cv_file || null,
      cv_filename || null,
      expected_salary || null,
      notes || null
    ).run();

    return json({ success: true });
  } catch (err) {
    console.error('CV submit error:', err);
    return error('Failed to save submission: ' + err.message, 500);
  }
}
