// functions/api/leads.js
// Saves demo/trial requests to D1, emails Bader, and pushes to ghaya_admin.

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

    const details =
      `Name: ${name}\n` +
      `Company: ${company}\n` +
      `Email: ${email}\n` +
      `WhatsApp: ${whatsapp}\n` +
      `Employees: ${employees || '—'}\n` +
      `Interested in: ${interested_in || '—'}`;

    // 1) Email Bader via Resend
    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Ghaya Leads <info@tryghaya.com>',
          to: ['info@tryghaya.com'],
          subject: `🎯 New Lead — ${company} (${interested_in || 'HR'})`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #eee;border-radius:12px;overflow:hidden">
              <div style="background:#0A2540;color:#fff;padding:20px 24px">
                <h2 style="margin:0">🎯 New Demo Request</h2>
              </div>
              <div style="padding:24px">
                <table style="width:100%;border-collapse:collapse;font-size:15px">
                  <tr><td style="padding:8px 0;color:#888;width:130px">Name</td><td style="padding:8px 0;font-weight:600">${name}</td></tr>
                  <tr><td style="padding:8px 0;color:#888">Company</td><td style="padding:8px 0;font-weight:600">${company}</td></tr>
                  <tr><td style="padding:8px 0;color:#888">Email</td><td style="padding:8px 0"><a href="mailto:${email}">${email}</a></td></tr>
                  <tr><td style="padding:8px 0;color:#888">WhatsApp</td><td style="padding:8px 0"><a href="https://wa.me/${whatsapp.replace(/[^0-9]/g,'')}">${whatsapp}</a></td></tr>
                  <tr><td style="padding:8px 0;color:#888">Employees</td><td style="padding:8px 0">${employees || '—'}</td></tr>
                  <tr><td style="padding:8px 0;color:#888">Interested in</td><td style="padding:8px 0;font-weight:600">${interested_in || '—'}</td></tr>
                </table>
                <a href="https://wa.me/${whatsapp.replace(/[^0-9]/g,'')}" style="display:inline-block;margin-top:18px;background:#25D366;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Reply on WhatsApp →</a>
              </div>
            </div>`
        })
      });
    }

    // 2) Push to ghaya_admin
    if (env.ONESIGNAL_REST_API_KEY && env.ONESIGNAL_APP_ID) {
      const admins = await env.DB.prepare(
        `SELECT id FROM users WHERE role = 'ghaya_admin'`
      ).all();
      if (admins.results.length > 0) {
        const adminIds = admins.results.map(a => String(a.id));
        await fetch('https://onesignal.com/api/v1/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}`
          },
          body: JSON.stringify({
            app_id: env.ONESIGNAL_APP_ID,
            target_channel: 'push',
            include_aliases: { external_id: adminIds },
            headings: { en: `🎯 New Lead — ${company}` },
            contents: { en: details },
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
