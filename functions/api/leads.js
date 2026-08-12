// functions/api/leads.js
// Public endpoint — no auth required. Saves demo/trial requests to D1 and notifies ghaya_admin.

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { name, company, email, whatsapp, employees, interested_in } = body;

    if (!name || !company || !email || !whatsapp) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Create table on first run (safe — IF NOT EXISTS)
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        company      TEXT NOT NULL,
        email        TEXT NOT NULL,
        whatsapp     TEXT NOT NULL,
        employees    TEXT,
        interested_in TEXT,
        status       TEXT DEFAULT 'new',
        notes        TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Save the lead
    await env.DB.prepare(`
      INSERT INTO leads (name, company, email, whatsapp, employees, interested_in)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(name, company, email, whatsapp, employees || '', interested_in || '').run();

    // Push notification to ghaya_admin
    if (env.ONESIGNAL_API_KEY && env.ONESIGNAL_APP_ID) {
      const admins = await env.DB.prepare(
        `SELECT id FROM users WHERE role = 'ghaya_admin'`
      ).all();

      if (admins.results.length > 0) {
        const adminIds = admins.results.map(a => String(a.id));
        await fetch('https://onesignal.com/api/v1/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Key ${env.ONESIGNAL_API_KEY}`
          },
          body: JSON.stringify({
            app_id: env.ONESIGNAL_APP_ID,
            target_channel: 'push',
            include_aliases: { external_id: adminIds },
            headings: { en: '🎯 New Demo Request!' },
            contents: { en: `${name} · ${company} · ${interested_in}\nWhatsApp: ${whatsapp}` },
            url: 'https://ghaya-suite.pages.dev/ghaya/'
          })
        });
      }
    }

    return Response.json({ success: true });

  } catch (e) {
    console.error('leads error:', e);
    return Response.json({ error: 'Something went wrong, please try again.' }, { status: 500 });
  }
}

// GET — returns all leads (ghaya_admin only, for the dashboard)
export async function onRequestGet(context) {
  const { request, env } = context;

  const { requireAuth } = await import('../_lib/auth.js');
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  if (user.role !== 'ghaya_admin') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const leads = await env.DB.prepare(
    `SELECT * FROM leads ORDER BY created_at DESC`
  ).all();

  return Response.json({ leads: leads.results });
}
