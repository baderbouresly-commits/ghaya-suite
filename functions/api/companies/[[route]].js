// /api/companies/* — company CRUD (ghaya_admin) + company settings (company_admin)
import { requireAuth, json, error, hashPassword } from '../_lib/auth.js';

const COMPANY_SELECT = `SELECT id, name_en, name_ar, cr_number, industry, size_tier,
  subscription_tier, subscription_active, managed_by_ghaya, created_at,
  work_start_time, work_end_time, late_threshold_minutes, work_days,
  geofence_enabled, workplace_lat, workplace_lng, geofence_radius_meters,
  permission_hours_monthly FROM companies`;

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
  const companyId = Array.isArray(route) ? route[0] : route;

  // ── GET /api/companies/:id ──
  if (method === 'GET' && companyId) {
    if (user.role !== 'ghaya_admin' && user.company_id !== companyId) return error('Forbidden', 403);
    const company = await db.prepare(COMPANY_SELECT + ' WHERE id=?').bind(companyId).first();
    if (!company) return error('Not found', 404);
    return json({ company });
  }

  // ── GET /api/companies — list all (ghaya_admin only) ──
  if (method === 'GET' && !companyId) {
    if (user.role !== 'ghaya_admin') return error('Forbidden', 403);
    const { results } = await db.prepare(COMPANY_SELECT + ' ORDER BY created_at DESC').all();
    return json({ companies: results });
  }

  // ── POST /api/companies — create new company + admin user (ghaya_admin only) ──
  if (method === 'POST') {
    if (user.role !== 'ghaya_admin') return error('Forbidden', 403);
    const body = await request.json();

    const { name_en, name_ar, cr_number, industry, size_tier, subscription_tier,
            managed_by_ghaya, admin_email, admin_password } = body;

    if (!name_en) return error('Company name (EN) is required');
    if (!admin_email) return error('Admin email is required');

    // Check email not taken
    const existing = await db.prepare('SELECT id FROM users WHERE email=?').bind(admin_email.toLowerCase()).first();
    if (existing) return error('Admin email already in use');

    const compId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(admin_password || 'TempPass2025!');

    await db.prepare(`INSERT INTO companies (id, name_en, name_ar, cr_number, industry, size_tier,
      subscription_tier, subscription_active, managed_by_ghaya, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`)
      .bind(compId, name_en, name_ar || null, cr_number || null, industry || null,
            size_tier || 'small', subscription_tier || 'starter', managed_by_ghaya ? 1 : 0)
      .run();

    await db.prepare(`INSERT INTO users (id, company_id, email, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, 'company_admin', datetime('now'))`)
      .bind(userId, compId, admin_email.toLowerCase(), passwordHash)
      .run();

    const company = await db.prepare(COMPANY_SELECT + ' WHERE id=?').bind(compId).first();
    return json({ company, admin_user_id: userId }, 201);
  }

  // ── PUT /api/companies/:id — partial update ──
  if (method === 'PUT' && companyId) {
    if (user.role !== 'ghaya_admin' && user.company_id !== companyId) return error('Forbidden', 403);
    const body = await request.json();

    const n  = v => v !== undefined ? v : null;
    const ni = v => v !== undefined && v !== null ? parseInt(v) : null;
    const nf = v => v !== undefined && v !== null ? parseFloat(v) : null;
    const nb = v => v !== undefined ? (v ? 1 : 0) : null;

    // Fields only ghaya_admin can change
    const ghayaOnly = user.role === 'ghaya_admin';
    const managedVal   = ghayaOnly ? nb(body.managed_by_ghaya)   : null;
    const activeVal    = ghayaOnly ? nb(body.subscription_active) : null;
    const tierVal      = ghayaOnly && body.subscription_tier !== undefined ? body.subscription_tier : null;
    const nameEnVal    = n(body.name_en);
    const nameArVal    = n(body.name_ar);
    const crVal        = n(body.cr_number);
    const industryVal  = n(body.industry);

    const ge = nb(body.geofence_enabled);

    await db.prepare(`UPDATE companies SET
      name_en                  = COALESCE(?, name_en),
      name_ar                  = COALESCE(?, name_ar),
      cr_number                = COALESCE(?, cr_number),
      industry                 = COALESCE(?, industry),
      subscription_tier        = COALESCE(?, subscription_tier),
      subscription_active      = CASE WHEN ? IS NOT NULL THEN ? ELSE subscription_active END,
      managed_by_ghaya         = CASE WHEN ? IS NOT NULL THEN ? ELSE managed_by_ghaya END,
      work_start_time          = COALESCE(?, work_start_time),
      work_end_time            = COALESCE(?, work_end_time),
      late_threshold_minutes   = COALESCE(?, late_threshold_minutes),
      work_days                = COALESCE(?, work_days),
      geofence_enabled         = CASE WHEN ? IS NOT NULL THEN ? ELSE geofence_enabled END,
      workplace_lat            = COALESCE(?, workplace_lat),
      workplace_lng            = COALESCE(?, workplace_lng),
      geofence_radius_meters   = COALESCE(?, geofence_radius_meters),
      permission_hours_monthly = COALESCE(?, permission_hours_monthly),
      updated_at               = datetime('now')
      WHERE id=?`)
      .bind(
        nameEnVal, nameArVal, crVal, industryVal,
        tierVal,
        activeVal, activeVal,
        managedVal, managedVal,
        n(body.work_start_time), n(body.work_end_time),
        ni(body.late_threshold_minutes), n(body.work_days),
        ge, ge,
        nf(body.workplace_lat), nf(body.workplace_lng),
        ni(body.geofence_radius_meters),
        nf(body.permission_hours_monthly),
        companyId
      ).run();

    const company = await db.prepare(COMPANY_SELECT + ' WHERE id=?').bind(companyId).first();
    return json({ company });
  }

  return error('Method not allowed', 405);
}
