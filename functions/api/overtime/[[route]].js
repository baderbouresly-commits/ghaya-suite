// /api/overtime/* — overtime requests, approval, payroll summary
const JWT_SECRET_KEY = 'ghaya-jwt-secret';

function parseB64u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function verifyJWT(token,secret){
  const[h,p,sig]=token.split('.');if(!h||!p||!sig)throw new Error('Invalid token');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const ok=await crypto.subtle.verify('HMAC',key,parseB64u(sig),new TextEncoder().encode(`${h}.${p}`));
  if(!ok)throw new Error('Invalid signature');
  return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});}
function err(msg,status=400){return json({error:msg},status);}

async function requireAuth(request,env){
  const auth=request.headers.get('Authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):null;
  if(!token)return{error:'Unauthorized',status:401};
  try{
    const payload=await verifyJWT(token,env.JWT_SECRET||JWT_SECRET_KEY);
    if(payload.exp&&payload.exp<Math.floor(Date.now()/1000))return{error:'Token expired',status:401};
    return{user:payload};
  }catch{return{error:'Invalid token',status:401};}
}

export async function onRequest({request,env,params}){
  if(request.method==='OPTIONS')return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE','Access-Control-Allow-Headers':'Content-Type,Authorization'}});

  const auth=await requireAuth(request,env);
  if(auth.error)return err(auth.error,auth.status);
  const{user}=auth;

  const db=env.DB;
  const method=request.method;
  const route=params.route||[];
  const seg0=Array.isArray(route)?route[0]:route;

  const isAdmin=['company_admin','manager','ghaya_admin'].includes(user.role);
  const companyId=user.company_id;

  // GET /overtime/summary?month=YYYY-MM
  if(method==='GET'&&seg0==='summary'){
    if(!isAdmin)return err('Forbidden',403);
    const url=new URL(request.url);
    const month=url.searchParams.get('month');
    if(!month)return err('month required');
    const{results}=await db.prepare(`
      SELECT o.employee_id,
        e.first_name_en||' '||e.last_name_en AS employee_name,
        e.basic_salary,
        SUM(o.hours) AS total_hours,
        SUM(o.overtime_pay) AS total_overtime_pay,
        COUNT(*) AS records_count
      FROM overtime_records o
      JOIN employees e ON e.id=o.employee_id
      WHERE o.company_id=? AND o.status='approved'
        AND substr(o.date,1,7)=?
      GROUP BY o.employee_id
      ORDER BY total_overtime_pay DESC
    `).bind(companyId,month).all();
    return json({summary:results,month});
  }

  // GET /overtime
  if(method==='GET'&&!seg0){
    const url=new URL(request.url);
    const status=url.searchParams.get('status');
    const month=url.searchParams.get('month');
    let q=`SELECT o.*,e.first_name_en||' '||e.last_name_en AS employee_name
      FROM overtime_records o JOIN employees e ON e.id=o.employee_id
      WHERE o.company_id=?`;
    const binds=[companyId];
    if(!isAdmin){const empId=user.employee_id||user.id;q+=' AND o.employee_id=?';binds.push(empId);}
    if(status){q+=' AND o.status=?';binds.push(status);}
    if(month){q+=` AND substr(o.date,1,7)=?`;binds.push(month);}
    q+=' ORDER BY o.date DESC';
    const{results}=await db.prepare(q).bind(...binds).all();
    let pendingCount=0;
    if(isAdmin&&!status){
      const pc=await db.prepare('SELECT COUNT(*) as c FROM overtime_records WHERE company_id=? AND status=?').bind(companyId,'pending').first();
      pendingCount=pc?.c||0;
    }
    return json({requests:results,pending_count:pendingCount});
  }

  // GET /overtime/:id
  if(method==='GET'&&seg0){
    const rec=await db.prepare(`SELECT o.*,e.first_name_en||' '||e.last_name_en AS employee_name
      FROM overtime_records o JOIN employees e ON e.id=o.employee_id
      WHERE o.id=? AND o.company_id=?`).bind(seg0,companyId).first();
    if(!rec)return err('Not found',404);
    if(!isAdmin&&rec.employee_id!==user.employee_id&&rec.employee_id!==user.id)return err('Forbidden',403);
    return json({record:rec});
  }

  // POST /overtime
  if(method==='POST'){
    const body=await request.json();
    const{date,hours,day_type='normal',reason}=body;
    if(!date)return err('date required');
    if(!hours||parseFloat(hours)<=0)return err('hours must be greater than 0');
    if(parseFloat(hours)>16)return err('maximum 16 overtime hours per entry');
    const empId=isAdmin?(body.employee_id||(user.employee_id||user.id)):(user.employee_id||user.id);
    const emp=await db.prepare('SELECT * FROM employees WHERE id=? AND company_id=?').bind(empId,companyId).first();
    if(!emp)return err('Employee not found',404);
    const hourly_rate=parseFloat(emp.basic_salary||0)/208;
    const rate_multiplier=day_type==='holiday'?1.5:1.25;
    const overtime_pay=parseFloat((parseFloat(hours)*hourly_rate*rate_multiplier).toFixed(3));
    const id=crypto.randomUUID();
    const status=isAdmin?'approved':'pending';
    const approved_by=isAdmin?user.id:null;
    const approved_at=isAdmin?new Date().toISOString().replace('T',' ').slice(0,19):null;
    await db.prepare(`INSERT INTO overtime_records(id,company_id,employee_id,date,hours,day_type,rate_multiplier,hourly_rate,overtime_pay,reason,status,approved_by,approved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id,companyId,empId,date,parseFloat(hours),day_type,rate_multiplier,
        parseFloat(hourly_rate.toFixed(6)),overtime_pay,reason||null,status,approved_by,approved_at).run();
    const record=await db.prepare('SELECT * FROM overtime_records WHERE id=?').bind(id).first();
    return json({record},201);
  }

  // PUT /overtime/:id
  if(method==='PUT'&&seg0){
    if(!isAdmin)return err('Forbidden',403);
    const body=await request.json();
    const{status,notes}=body;
    if(!['approved','rejected'].includes(status))return err('status must be approved or rejected');
    const rec=await db.prepare('SELECT * FROM overtime_records WHERE id=? AND company_id=?').bind(seg0,companyId).first();
    if(!rec)return err('Not found',404);
    await db.prepare(`UPDATE overtime_records SET status=?,approved_by=?,approved_at=datetime('now'),notes=?,updated_at=datetime('now') WHERE id=?`)
      .bind(status,user.id,notes||null,seg0).run();
    const updated=await db.prepare('SELECT * FROM overtime_records WHERE id=?').bind(seg0).first();
    return json({record:updated});
  }

  // DELETE /overtime/:id
  if(method==='DELETE'&&seg0){
    const rec=await db.prepare('SELECT * FROM overtime_records WHERE id=? AND company_id=?').bind(seg0,companyId).first();
    if(!rec)return err('Not found',404);
    if(!isAdmin){
      if(rec.employee_id!==user.employee_id&&rec.employee_id!==user.id)return err('Forbidden',403);
      if(rec.status!=='pending')return err('Can only cancel pending requests');
    }
    await db.prepare('DELETE FROM overtime_records WHERE id=?').bind(seg0).run();
    return json({success:true});
  }

  return err('Method not allowed',405);
}
