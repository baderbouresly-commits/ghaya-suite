import { requireAuth } from '../../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env);
  if (auth.error) return new Response(auth.error, { status: auth.status || 401 });
  if (!['company_admin', 'ghaya', 'ghaya_admin'].includes(auth.user.role)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Extract ID from URL: /api/cv/submissions/:id/file
  const parts = new URL(request.url).pathname.split('/');
  const id = parseInt(parts[parts.indexOf('file') - 1], 10);
  if (!id) return new Response('Invalid ID', { status: 400 });

  const row = await env.DB.prepare(
    'SELECT cv_file, cv_filename FROM cv_submissions WHERE id = ?'
  ).bind(id).first();

  if (!row || !row.cv_file) return new Response('No file found', { status: 404 });

  const base64 = row.cv_file.includes(',') ? row.cv_file.split(',')[1] : row.cv_file;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${row.cv_filename || 'cv.pdf'}"`,
    }
  });
}
