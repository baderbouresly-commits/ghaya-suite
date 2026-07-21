// POST /api/cv/submit
import { json, error } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON'); }

  const { full_name, email, whatsapp, nationality, location, visa_status,
          current_title, years_experience, field, open_to,
          cv_link, expected_salary, notes } = body;

  // Required field validation
  const required = { full_name, email, whatsapp, nationality, location, visa_status, current_title, years_experience, field, cv_link };
  for (const [key, val] of Object.entries(required)) {
    if (!val || !String(val).trim()) {
      return error(`Missing required field: ${key}`, 400);
    }
  }

  // Basic email check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return error('Invalid email address', 400);
  }

  const db = env.DB;

  // Check for duplicate email
  const existing = await db.prepare(
    'SELECT id FROM cv_submissions WHERE email = ?'
  ).bind(email.toLowerCase().trim()).first();

  if (existing) {
    // Update their existing submission instead of creating duplicate
    await db.prepare(`
      UPDATE cv_submissions SET
        full_name = ?, whatsapp = ?, nationality = ?, location = ?,
        visa_status = ?, current_title = ?, years_experience = ?, field = ?,
        open_to = ?, cv_link = ?, expected_salary = ?, notes = ?,
        updated_at = datetime('now')
      WHERE email = ?
    `).bind(
      full_name.trim(), whatsapp.trim(), nationality.trim(), location.trim(),
      visa_status.trim(), current_title.trim(), years_experience.trim(), field.trim(),
      open_to || '', cv_link.trim(), expected_salary || '', notes || '',
      email.toLowerCase().trim()
    ).run();

    return json({ success: true, updated: true });
  }

  // New submission
  await db.prepare(`
    INSERT INTO cv_submissions
      (full_name, email, whatsapp, nationality, location, visa_status,
       current_title, years_experience, field, open_to,
       cv_link, expected_salary, notes, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
  `).bind(
    full_name.trim(),
    email.toLowerCase().trim(),
    whatsapp.trim(),
    nationality.trim(),
    location.trim(),
    visa_status.trim(),
    current_title.trim(),
    years_experience.trim(),
    field.trim(),
    open_to || '',
    cv_link.trim(),
    expected_salary || '',
    notes || ''
  ).run();

  return json({ success: true, updated: false });
}
