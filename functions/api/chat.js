// POST /api/chat — HR Chatbot powered by Gemini
import { requireAuth, json, error } from './_lib/auth.js';

const EMPLOYEE_SYSTEM_PROMPT = `You are an HR assistant for Ghaya, an HR platform serving companies in Kuwait.
You are talking to an EMPLOYEE. Answer their questions about:
- Kuwait Labour Law (Law No. 6 of 2010 and its amendments)
- Their leave entitlements (annual leave, sick leave, emergency leave, unpaid leave)
- PIFSS (Public Institution for Social Security) — applies to Kuwaiti nationals only (5% employee, 11% employer contribution)
- End of service indemnity (مكافأة نهاية الخدمة) calculations
- Notice periods and resignation rights
- Working hours, overtime, and public holidays in Kuwait
- Maternity and paternity leave
- General HR policies

Rules:
- Be friendly, helpful, and BRIEF — max 3-4 short sentences unless the user asks for more detail
- Answer in the same language the user writes in (Arabic or English)
- NEVER use asterisks (*), bold, bullet points, or headers in your response. Write ONLY in plain conversational sentences, like a text message. This is critical.
- Do NOT answer questions unrelated to HR, labour law, or the workplace
- If you don't know something specific to their company, tell them to check with their HR manager
- Only mention consulting a lawyer if the question is about a legal dispute — don't add it to every answer
- Get straight to the point — no long intros`;

const ADMIN_SYSTEM_PROMPT = `You are an HR advisor for Ghaya, an HR platform serving companies in Kuwait.
You are talking to an HR MANAGER or COMPANY ADMIN. Help them with:
- Kuwait Labour Law (Law No. 6 of 2010 and its amendments) — employer obligations
- Hiring and onboarding procedures
- Termination procedures (by employer and by resignation) — legal requirements
- Disciplinary procedures and warning letters
- End of service indemnity (مكافأة نهاية الخدمة) calculations for terminated/resigned employees
- PIFSS registration and contributions for Kuwaiti employees
- Leave management — approvals, accruals, carry-overs
- Working hours, overtime rules, and public holiday pay
- Visa and residency (iqama) obligations for expat employees
- Maternity leave employer obligations
- Employment contracts — required clauses under Kuwait law
- Salary certificates and HR documentation

Rules:
- Be professional, precise, and BRIEF — max 4-5 short sentences unless the user asks for more detail
- Answer in the same language the user writes in (Arabic or English)
- NEVER use asterisks (*), bold, bullet points, or headers in your response. Write ONLY in plain conversational sentences, like a text message. This is critical.
- Cite the relevant law article when directly relevant (e.g. "Article 51 of Kuwait Labour Law")
- Do NOT answer questions unrelated to HR or employment law
- Only mention consulting a lawyer for genuinely complex legal disputes — don't add it to every answer
- Get straight to the point — no long intros`;

async function getEmployeeContext(env, user) {
  if (!user.employee_id) return '';
  try {
    const db = env.DB;
    const emp = await db.prepare(
      'SELECT first_name_en, last_name_en, nationality, basic_salary, department, job_title_en, contract_type, employment_start_date FROM employees WHERE id = ?'
    ).bind(user.employee_id).first();

    const leaves = await db.prepare(
      "SELECT leave_type, start_date, end_date, days_requested, status FROM leaves WHERE employee_id = ? ORDER BY start_date DESC LIMIT 20"
    ).bind(user.employee_id).all();

    const leaveRows = leaves?.results || [];
    const year = new Date().getFullYear().toString();
    const yearLeaves = leaveRows.filter(l => (l.start_date || '').startsWith(year));
    const approvedDays = yearLeaves.filter(l => l.status === 'approved').reduce((s, l) => s + (parseInt(l.days_requested) || 0), 0);
    const pendingCount = leaveRows.filter(l => l.status === 'pending').length;
    const remaining = 30 - approvedDays;

    if (!emp) return '';

    return `

CURRENT EMPLOYEE DATA (use this to answer personal questions about their own leave/salary/profile — do not say you don't have access, this IS their real data):
- Name: ${emp.first_name_en || ''} ${emp.last_name_en || ''}
- Nationality: ${emp.nationality || 'unknown'}
- Job Title: ${emp.job_title_en || 'unknown'}
- Department: ${emp.department || 'unknown'}
- Contract Type: ${emp.contract_type || 'unknown'}
- Start Date: ${emp.employment_start_date || 'unknown'}
- Basic Salary: ${emp.basic_salary || 'unknown'} KWD
- Annual Leave Remaining This Year: ${remaining} days (out of 30)
- Annual Leave Taken This Year: ${approvedDays} days
- Pending Leave Requests: ${pendingCount}
- Recent Leave History: ${leaveRows.slice(0, 5).map(l => `${l.leave_type} ${l.start_date} to ${l.end_date} (${l.status})`).join('; ') || 'none'}
`;
  } catch (e) {
    console.error('Employee context error:', e);
    return '';
  }
}

export async function onRequestPost({ request, env }) {
  // Auth check
  const auth = await requireAuth(request, env);
  if (auth.error) return error(auth.error, auth.status || 401);

  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON', 400); }

  const { message, history = [], portal = 'employee' } = body;
  if (!message || !message.trim()) return error('Message is required', 400);

  let systemPrompt = portal === 'admin' ? ADMIN_SYSTEM_PROMPT : EMPLOYEE_SYSTEM_PROMPT;

  // Inject the employee's real data (leave balance, salary, etc.) for employee portal
  if (portal !== 'admin') {
    const context = await getEmployeeContext(env, auth.user);
    systemPrompt += context;
  }

  // Build conversation history for Gemini
  const contents = [];

  // Add previous messages
  for (const msg of history.slice(-10)) { // last 10 messages for context
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  // Add current message
  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 300,
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini error:', err);
      return error('AI service error', 500);
    }

    const data = await response.json();
    let reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) return error('No response from AI', 500);

    // Safety net: strip markdown artifacts in case the model still adds them
    reply = reply.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^#+\s*/gm, '');

    return json({ reply });
  } catch (e) {
    console.error('Chat error:', e);
    return error('Failed to get AI response', 500);
  }
}
