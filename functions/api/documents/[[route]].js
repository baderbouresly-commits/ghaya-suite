// /api/documents/* — HR document storage (Cloudflare R2 + D1 metadata)
// Routes:
//   GET    /api/documents?employee_id=X   — list docs for an employee
//   POST   /api/documents                 — upload (multipart/form-data)
//   GET    /api/documents/:id/download    — signed download URL
//   DELETE /api/documents/:id             — delete from R2 + D1

import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  const result = await requireAuth(request, env);
  if (result.error) return error(result.error, result.status);

  const { user } = result;
  const db  = env.DB;
  const r2  = env.R2;
  const method = request.method;
  const route  = params.route || [];
  const docId  = Array.isArray(route) ? route[0] : route;
  const action = Array.isArray(route) ? route[1] : null; // e.g. "download"

  // ── GET /api/documents?employee_id=X ──────────────────────────
  if (method === 'GET' && !action) {
    const url = new URL(request.url);
    const employeeId = url.searchParams.get('employee_id');

    // Employee can only fetch their own docs
    if (user.role === 'employee') {
      const emp = await db.prepare('SELECT id FROM employees WHERE user_id = ? AND company_id = ?')
        .bind(user.sub, user.company_id).first();
      if (!emp) return error('Employee not found', 404);

      const { results } = await db.prepare(`
        SELECT d.id, d.file_name, d.file_size, d.mime_type, d.notes,
               d.created_at, dt.name_en as type_name
        FROM employee_documents d
        LEFT JOIN document_types dt ON dt.id = d.document_type_id
        WHERE d.employee_id = ? AND d.company_id = ?
        ORDER BY d.created_at DESC
      `).bind(emp.id, user.company_id).all();
      return json({ documents: results });
    }

    // Admin / manager
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);
    if (!employeeId) return error('employee_id required');

    // Confirm employee belongs to this company
    const emp = await db.prepare('SELECT id FROM employees WHERE id = ? AND company_id = ?')
      .bind(employeeId, user.company_id).first();
    if (!emp) return error('Employee not found', 404);

    const { results } = await db.prepare(`
      SELECT d.id, d.file_name, d.file_size, d.mime_type, d.notes,
             d.created_at, dt.name_en as type_name
      FROM employee_documents d
      LEFT JOIN document_types dt ON dt.id = d.document_type_id
      WHERE d.employee_id = ? AND d.company_id = ?
      ORDER BY d.created_at DESC
    `).bind(employeeId, user.company_id).all();
    return json({ documents: results });
  }

  // ── GET /api/documents/:id/download ───────────────────────────
  if (method === 'GET' && docId && action === 'download') {
    // Fetch metadata
    const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ?').bind(docId).first();
    if (!doc) return error('Not found', 404);

    // Access check
    if (user.role === 'employee') {
      const emp = await db.prepare('SELECT id FROM employees WHERE user_id = ? AND company_id = ?')
        .bind(user.sub, user.company_id).first();
      if (!emp || emp.id !== doc.employee_id) return error('Forbidden', 403);
    } else if (['company_admin', 'manager'].includes(user.role)) {
      if (doc.company_id !== user.company_id) return error('Forbidden', 403);
    } else {
      return error('Forbidden', 403);
    }

    // Stream file from R2
    const obj = await r2.get(doc.r2_key);
    if (!obj) return error('File not found in storage', 404);

    const headers = new Headers();
    headers.set('Content-Type', doc.mime_type || 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.file_name)}"`);
    if (doc.file_size) headers.set('Content-Length', String(doc.file_size));

    return new Response(obj.body, { headers });
  }

  // ── POST /api/documents — upload ──────────────────────────────
  if (method === 'POST') {
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('multipart/form-data')) return error('multipart/form-data required');

    let formData;
    try { formData = await request.formData(); } catch { return error('Invalid form data'); }

    const file       = formData.get('file');
    const employeeId = formData.get('employee_id');
    const typeId     = formData.get('document_type_id') || 'dt-other';
    const notes      = formData.get('notes') || null;

    if (!file || typeof file === 'string') return error('file is required');
    if (!employeeId) return error('employee_id is required');

    // Confirm employee belongs to this company
    const emp = await db.prepare('SELECT id FROM employees WHERE id = ? AND company_id = ?')
      .bind(employeeId, user.company_id).first();
    if (!emp) return error('Employee not found', 404);

    // Size limit: 10 MB
    const MAX_BYTES = 10 * 1024 * 1024;
    const fileBuffer = await file.arrayBuffer();
    if (fileBuffer.byteLength > MAX_BYTES) return error('File too large (max 10 MB)');

    // Allowed MIME types
    const ALLOWED_TYPES = [
      'application/pdf',
      'image/jpeg','image/png','image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    const mime = file.type || 'application/octet-stream';
    if (!ALLOWED_TYPES.includes(mime)) return error('File type not allowed. Use PDF, JPG, PNG, or Word.');

    const docId   = crypto.randomUUID();
    const r2Key   = `${user.company_id}/${employeeId}/${docId}/${file.name}`;

    // Upload to R2
    await r2.put(r2Key, fileBuffer, {
      httpMetadata: { contentType: mime },
      customMetadata: { uploadedBy: user.sub, companyId: user.company_id },
    });

    // Ensure document_type exists (fallback to 'other')
    const dtExists = await db.prepare('SELECT id FROM document_types WHERE id = ?').bind(typeId).first();
    const finalTypeId = dtExists ? typeId : 'dt-noc'; // use a known seed ID as fallback

    // Save metadata in D1
    await db.prepare(`
      INSERT INTO employee_documents
        (id, company_id, employee_id, document_type_id, file_name, file_size, mime_type, r2_key, notes, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      docId,
      user.company_id,
      employeeId,
      finalTypeId,
      file.name,
      fileBuffer.byteLength,
      mime,
      r2Key,
      notes,
      user.sub
    ).run();

    return json({ message: 'Document uploaded', id: docId, file_name: file.name }, 201);
  }

  // ── DELETE /api/documents/:id ──────────────────────────────────
  if (method === 'DELETE' && docId) {
    if (!['company_admin', 'manager'].includes(user.role)) return error('Forbidden', 403);

    const doc = await db.prepare('SELECT * FROM employee_documents WHERE id = ?').bind(docId).first();
    if (!doc) return error('Not found', 404);
    if (doc.company_id !== user.company_id) return error('Forbidden', 403);

    // Delete from R2
    try { await r2.delete(doc.r2_key); } catch { /* ignore if already gone */ }

    // Delete metadata
    await db.prepare('DELETE FROM employee_documents WHERE id = ?').bind(docId).run();

    return json({ success: true });
  }

  return error('Not found', 404);
}
