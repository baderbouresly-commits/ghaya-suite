// functions/api/leads.js
// Public endpoint — saves demo/trial requests to D1 and notifies ghaya_admin.

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { name, company, email, whatsapp, employees, interested_in } = body;

    if (!name || !company || !email || !whatsapp) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

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
