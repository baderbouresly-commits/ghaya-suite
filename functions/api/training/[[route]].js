// /api/training/* — training programs, categories, requests
import { requireAuth, json, error } from '../_lib/auth.js';

export async function onRequest({ request, env, params }) {
  if (request.method === 'OPTIONS') return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }
  });

  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status);
  const { user } = auth;

  const db = env.DB;
  const method = request.method;
  const route = params.route || [];
  const [seg0, seg1, seg2] = Array.isArray(route) ? route : [route];

  const isGhaya = user.role === 'ghaya_admin';
  const isAdmin = ['company_admin', 'admin'].includes(user.role) || isGhaya;
  const companyId = user.company_id;

  if (!isAdmin) return error('Forbidden', 403);

  // ══════════════════════════════════════════════════════════════════════════
  // CATEGORIES  /api/training/categories
  // ══════════════════════════════════════════════════════════════════════════

  if (seg0 === 'categories') {
    // GET — list all categories
    if (method === 'GET') {
      const { results } = await db.prepare(
        'SELECT * FROM training_categories ORDER BY created_by ASC, name ASC'
      ).all();
      return json({ categories: results });
    }

    // POST — add custom category (ghaya only)
    if (method === 'POST') {
      if (!isGhaya) return error('Forbidden', 403);
      const { name } = await request.json();
      if (!name) return error('name required');
      const id = crypto.randomUUID();
      try {
        await db.prepare('INSERT INTO training_categories (id, name, created_by) VALUES (?,?,?)')
          .bind(id, name.trim(), 'ghaya').run();
      } catch (e) {
        return error('Category already exists', 409);
      }
      const cat = await db.prepare('SELECT * FROM training_categories WHERE id = ?').bind(id).first();
      return json({ category: cat }, 201);
    }

    return error('Method not allowed', 405);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROGRAMS  /api/training/programs  &  /api/training/programs/:id
  // ══════════════════════════════════════════════════════════════════════════

  if (seg0 === 'programs') {
    const programId = seg1;

    // GET /programs — list catalog
    if (method === 'GET' && !programId) {
      const url = new URL(request.url);
      const category = url.searchParams.get('category');
      const type = url.searchParams.get('type');
      const level = url.searchParams.get('level');
      const search = url.searchParams.get('search');

      let q = `SELECT tp.*, tc.name as category_name
        FROM training_programs tp
        LEFT JOIN training_categories tc ON tc.id = tp.category_id
        WHERE 1=1`;
      const binds = [];

      // Company only sees active programs; ghaya sees all
      if (!isGhaya) { q += ' AND tp.is_active = 1'; }
      if (category) { q += ' AND tp.category_id = ?'; binds.push(category); }
      if (type) { q += ' AND tp.program_type = ?'; binds.push(type); }
      if (level && level !== 'any') { q += ' AND tp.level = ?'; binds.push(level); }
      if (search) { q += ' AND (tp.title LIKE ? OR tp.description LIKE ? OR tp.provider_name LIKE ?)'; binds.push(`%${search}%`, `%${search}%`, `%${search}%`); }

      q += ' ORDER BY tp.is_featured DESC, tp.updated_at DESC';

      const { results } = await db.prepare(q).bind(...binds).all();

      // Strip sensitive fields from company view
      const programs = results.map(p => {
        if (!isGhaya) {
          const { contact_name, contact_phone, contact_email, pricing_details, ...safe } = p;
          return safe;
        }
        return p;
      });

      return json({ programs });
    }

    // GET /programs/:id — single program
    if (method === 'GET' && programId) {
      const p = await db.prepare(`
        SELECT tp.*, tc.name as category_name
        FROM training_programs tp
        LEFT JOIN training_categories tc ON tc.id = tp.category_id
        WHERE tp.id = ?`).bind(programId).first();
      if (!p) return error('Not found', 404);

      if (!isGhaya) {
        const { contact_name, contact_phone, contact_email, pricing_details, ...safe } = p;
        return json({ program: safe });
      }
      return json({ program: p });
    }

    // POST /programs — ghaya creates program
    if (method === 'POST' && !programId) {
      if (!isGhaya) return error('Forbidden', 403);
      const body = await request.json();
      const { title, description, category_id, program_type, provider_name, duration,
              level, target_roles, is_featured, featured_image,
              contact_name, contact_phone, contact_email, pricing_details, is_active } = body;

      if (!title) return error('title required');

      // Only one featured at a time
      if (is_featured) {
        await db.prepare('UPDATE training_programs SET is_featured = 0').run();
      }

      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO training_programs
        (id, title, description, category_id, program_type, provider_name, duration,
         level, target_roles, is_featured, featured_image,
         contact_name, contact_phone, contact_email, pricing_details, is_active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, title, description || null, category_id || null,
          program_type || 'training', provider_name || null, duration || null,
          level || 'any', target_roles || null,
          is_featured ? 1 : 0, featured_image || null,
          contact_name || null, contact_phone || null, contact_email || null,
          pricing_details || null, is_active !== false ? 1 : 0)
        .run();

      const created = await db.prepare('SELECT * FROM training_programs WHERE id = ?').bind(id).first();
      return json({ program: created }, 201);
    }

    // PUT /programs/:id — ghaya updates program
    if (method === 'PUT' && programId) {
      if (!isGhaya) return error('Forbidden', 403);
      const p = await db.prepare('SELECT * FROM training_programs WHERE id = ?').bind(programId).first();
      if (!p) return error('Not found', 404);

      const body = await request.json();
      const { title, description, category_id, program_type, provider_name, duration,
              level, target_roles, is_featured, featured_image,
              contact_name, contact_phone, contact_email, pricing_details, is_active } = body;

      if (is_featured) {
        await db.prepare('UPDATE training_programs SET is_featured = 0').run();
      }

      await db.prepare(`UPDATE training_programs SET
        title = COALESCE(?, title),
        description = CASE WHEN ? IS NOT NULL THEN ? ELSE description END,
        category_id = CASE WHEN ? IS NOT NULL THEN ? ELSE category_id END,
        program_type = COALESCE(?, program_type),
        provider_name = CASE WHEN ? IS NOT NULL THEN ? ELSE provider_name END,
        duration = CASE WHEN ? IS NOT NULL THEN ? ELSE duration END,
        level = COALESCE(?, level),
        target_roles = CASE WHEN ? IS NOT NULL THEN ? ELSE target_roles END,
        is_featured = COALESCE(?, is_featured),
        featured_image = CASE WHEN ? IS NOT NULL THEN ? ELSE featured_image END,
        contact_name = CASE WHEN ? IS NOT NULL THEN ? ELSE contact_name END,
        contact_phone = CASE WHEN ? IS NOT NULL THEN ? ELSE contact_phone END,
        contact_email = CASE WHEN ? IS NOT NULL THEN ? ELSE contact_email END,
        pricing_details = CASE WHEN ? IS NOT NULL THEN ? ELSE pricing_details END,
        is_active = COALESCE(?, is_active),
        updated_at = datetime('now')
        WHERE id = ?`)
        .bind(
          title || null,
          description !== undefined ? description : null, description !== undefined ? description : null,
          category_id !== undefined ? category_id : null, category_id !== undefined ? category_id : null,
          program_type || null,
          provider_name !== undefined ? provider_name : null, provider_name !== undefined ? provider_name : null,
          duration !== undefined ? duration : null, duration !== undefined ? duration : null,
          level || null,
          target_roles !== undefined ? target_roles : null, target_roles !== undefined ? target_roles : null,
          is_featured !== undefined ? (is_featured ? 1 : 0) : null,
          featured_image !== undefined ? featured_image : null, featured_image !== undefined ? featured_image : null,
          contact_name !== undefined ? contact_name : null, contact_name !== undefined ? contact_name : null,
          contact_phone !== undefined ? contact_phone : null, contact_phone !== undefined ? contact_phone : null,
          contact_email !== undefined ? contact_email : null, contact_email !== undefined ? contact_email : null,
          pricing_details !== undefined ? pricing_details : null, pricing_details !== undefined ? pricing_details : null,
          is_active !== undefined ? (is_active ? 1 : 0) : null,
          programId
        ).run();

      const updated = await db.prepare('SELECT * FROM training_programs WHERE id = ?').bind(programId).first();
      return json({ program: updated });
    }

    // DELETE /programs/:id — ghaya archives (soft delete)
    if (method === 'DELETE' && programId) {
      if (!isGhaya) return error('Forbidden', 403);
      await db.prepare('UPDATE training_programs SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').bind(programId).run();
      return json({ success: true });
    }

    return error('Method not allowed', 405);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REQUESTS  /api/training/requests  &  /api/training/requests/:id
  // ══════════════════════════════════════════════════════════════════════════

  if (seg0 === 'requests') {
    const requestId = seg1;

    // GET /requests — list
    if (method === 'GET' && !requestId) {
      let q = `SELECT tr.*, c.name_en as company_name,
        (SELECT COUNT(*) FROM training_request_items tri WHERE tri.request_id = tr.id) as programs_count,
        (SELECT GROUP_CONCAT(tri2.program_id) FROM training_request_items tri2 WHERE tri2.request_id = tr.id) as program_ids_csv
        FROM training_requests tr
        LEFT JOIN companies c ON c.id = tr.company_id
        WHERE 1=1`;
      const binds = [];
      if (!isGhaya) { q += ' AND tr.company_id = ?'; binds.push(companyId); }
      q += ' ORDER BY tr.created_at DESC';

      const { results } = await db.prepare(q).bind(...binds).all();

      let pendingCount = 0;
      if (isGhaya) {
        const pc = await db.prepare("SELECT COUNT(*) as c FROM training_requests WHERE status = 'pending'").first();
        pendingCount = pc?.c || 0;
      }

      return json({ requests: results, pending_count: pendingCount });
    }

    // GET /requests/:id — single request with items + program details
    if (method === 'GET' && requestId) {
      const req = await db.prepare(`
        SELECT tr.*, c.name_en as company_name
        FROM training_requests tr
        LEFT JOIN companies c ON c.id = tr.company_id
        WHERE tr.id = ?`).bind(requestId).first();
      if (!req) return error('Not found', 404);
      if (!isGhaya && req.company_id !== companyId) return error('Forbidden', 403);

      const { results: items } = await db.prepare(`
        SELECT tri.*, tp.title, tp.description, tp.program_type, tp.provider_name,
               tp.duration, tp.level, tp.category_id, tp.featured_image,
               tp.contact_name, tp.contact_phone, tp.contact_email, tp.pricing_details,
               tc.name as category_name
        FROM training_request_items tri
        JOIN training_programs tp ON tp.id = tri.program_id
        LEFT JOIN training_categories tc ON tc.id = tp.category_id
        WHERE tri.request_id = ?
        ORDER BY tri.created_at ASC`).bind(requestId).all();

      // Hide pricing/contact from company unless approved
      const visibleItems = items.map(item => {
        if (!isGhaya && req.status !== 'approved') {
          const { contact_name, contact_phone, contact_email, pricing_details, ...safe } = item;
          return safe;
        }
        return item;
      });

      return json({ request: req, items: visibleItems });
    }

    // POST /requests — company creates request (cart of programs)
    if (method === 'POST' && !requestId) {
      if (isGhaya) return error('Ghaya cannot create training requests', 400);
      const body = await request.json();
      const { program_ids, employees_count, notes } = body;

      if (!program_ids || !program_ids.length) return error('Select at least one program');

      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO training_requests (id, company_id, employees_count, notes)
        VALUES (?,?,?,?)`)
        .bind(id, companyId, parseInt(employees_count) || 1, notes || null).run();

      // Insert items
      for (const pid of program_ids) {
        const itemId = crypto.randomUUID();
        await db.prepare('INSERT INTO training_request_items (id, request_id, program_id) VALUES (?,?,?)')
          .bind(itemId, id, pid).run();
      }

      const created = await db.prepare('SELECT * FROM training_requests WHERE id = ?').bind(id).first();
      return json({ request: created }, 201);
    }

    // PUT /requests/:id — ghaya approves/rejects; company cancels
    if (method === 'PUT' && requestId) {
      const req = await db.prepare('SELECT * FROM training_requests WHERE id = ?').bind(requestId).first();
      if (!req) return error('Not found', 404);
      if (!isGhaya && req.company_id !== companyId) return error('Forbidden', 403);

      const body = await request.json();

      if (isGhaya) {
        const { status, ghaya_notes, rejection_reason } = body;
        const valid = ['pending', 'approved', 'rejected'];
        if (status && !valid.includes(status)) return error('Invalid status');

        await db.prepare(`UPDATE training_requests SET
          status = COALESCE(?, status),
          ghaya_notes = CASE WHEN ? IS NOT NULL THEN ? ELSE ghaya_notes END,
          rejection_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE rejection_reason END,
          rejected_at = CASE WHEN ? = 'rejected' THEN datetime('now') ELSE rejected_at END,
          updated_at = datetime('now')
          WHERE id = ?`)
          .bind(
            status || null,
            ghaya_notes !== undefined ? ghaya_notes : null, ghaya_notes !== undefined ? ghaya_notes : null,
            rejection_reason || null, rejection_reason || null,
            status || null,
            requestId
          ).run();
      } else {
        if (body.status === 'cancelled' && req.status === 'pending') {
          await db.prepare("UPDATE training_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").bind(requestId).run();
        } else {
          return error('Cannot modify this request', 403);
        }
      }

      const updated = await db.prepare('SELECT * FROM training_requests WHERE id = ?').bind(requestId).first();
      return json({ request: updated });
    }

    // DELETE /requests/:id — company deletes pending; ghaya deletes any
    if (method === 'DELETE' && requestId) {
      const req = await db.prepare('SELECT * FROM training_requests WHERE id = ?').bind(requestId).first();
      if (!req) return error('Not found', 404);
      if (!isGhaya && req.company_id !== companyId) return error('Forbidden', 403);
      if (!isGhaya && req.status !== 'pending') return error('Can only delete pending requests');
      await db.prepare('DELETE FROM training_requests WHERE id = ?').bind(requestId).run();
      return json({ success: true });
    }

    return error('Method not allowed', 405);
  }

  return error('Not found', 404);
}
