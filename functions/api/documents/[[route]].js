export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = url.pathname.replace('/api/documents', '').split('/').filter(Boolean);
  const method = request.method;

  // ── JWT verify ────────────────────────────────────────────
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '');
  if (!token) return json({ error: 'Unauthorized' }, 401);
  let payload;
  try {
    const [h, p, s] = token.split('.');
    const sig = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', sig, b64url(s), new TextEncoder().encode(h + '.' + p));
    if (!valid) return json({ error: 'Unauthorized' }, 401);
    payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp < Math.floor(Date.now() / 1000)) return json({ error: 'Token expired' }, 401);
  } catch { return json({ error: 'Unauthorized' }, 401); }

  const isAdmin = ['company_admin', 'manager'].includes(payload.role);
  const companyId = payload.company_id;
  const employeeId = payload.employee_id || payload.id;

  function b64url(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  }
  function uid() { return crypto.randomUUID(); }
  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }

  // ── GET /api/documents?employee_id=xxx ────────────────────
  // Returns document list (no file content)
  if (method === 'GET' && parts.length === 0) {
    const empParam = url.searchParams.get('employee_id');
    if (!isAdmin && empParam && empParam !== employeeId) return json({ error: 'Forbidden' }, 403);
    const targetEmp = isAdmin ? (empParam || null) : employeeId;
    let query, params;
    if (targetEmp) {
      query = 'SELECT * FROM documents WHERE company_id=? AND employee_id=? ORDER BY created_at DESC';
      params = [companyId, targetEmp];
    } else {
      query = 'SELECT * FROM documents WHERE company_id=? ORDER BY created_at DESC';
      params = [companyId];
    }
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return json({ documents: results });
  }

  // ── GET /api/documents/:id/download ──────────────────────
  // Returns a signed/direct download URL
  if (method === 'GET' && parts[0] && parts[1] === 'download') {
    const docId = parts[0];
    const doc = await env.DB.prepare(
      'SELECT * FROM documents WHERE id=? AND company_id=?'
    ).bind(docId, companyId).first();
    if (!doc) return json({ error: 'Not found' }, 404);
    if (!isAdmin && doc.employee_id !== employeeId) return json({ error: 'Forbidden' }, 403);

    // Get object from R2
    const obj = await env.R2.get(doc.file_key);
    if (!obj) return json({ error: 'File not found in storage' }, 404);

    const headers = new Headers();
    headers.set('Content-Type', doc.mime_type || 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${doc.file_name}"`);
    obj.writeHttpMetadata(headers);
    return new Response(obj.body, { headers });
  }

  // ── POST /api/documents — upload ──────────────────────────
  if (method === 'POST' && parts.length === 0) {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);

    const formData = await request.formData().catch(() => null);
    if (!formData) return json({ error: 'Invalid form data' }, 400);

    const file = formData.get('file');
    const empId = formData.get('employee_id');
    const docType = formData.get('doc_type') || 'Other';
    const expiryDate = formData.get('expiry_date') || null;
    const notes = formData.get('notes') || null;

    if (!file || !empId) return json({ error: 'file and employee_id required' }, 400);

    // Validate file size (10MB max)
    if (file.size > 10 * 1024 * 1024) return json({ error: 'File too large (max 10MB)' }, 400);

    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedTypes.includes(file.type)) return json({ error: 'File type not allowed. Use PDF, JPG, PNG, or Word.' }, 400);

    const docId = uid();
    const ext = file.name.split('.').pop();
    const fileKey = `${companyId}/${empId}/${docId}.${ext}`;

    // Upload to R2
    await env.R2.put(fileKey, file.stream(), {
      httpMetadata: { contentType: file.type },
    });

    // Save to DB
    await env.DB.prepare(
      'INSERT INTO documents (id,company_id,employee_id,doc_type,file_name,file_key,file_size,mime_type,expiry_date,notes,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(docId, companyId, empId, docType, file.name, fileKey, file.size, file.type, expiryDate, notes, payload.email || payload.id).run();

    const doc = await env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(docId).first();
    return json({ document: doc });
  }

  // ── DELETE /api/documents/:id ─────────────────────────────
  if (method === 'DELETE' && parts[0]) {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    const doc = await env.DB.prepare(
      'SELECT * FROM documents WHERE id=? AND company_id=?'
    ).bind(parts[0], companyId).first();
    if (!doc) return json({ error: 'Not found' }, 404);

    // Delete from R2
    await env.R2.delete(doc.file_key);

    // Delete from DB
    await env.DB.prepare('DELETE FROM documents WHERE id=?').bind(parts[0]).run();
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}
