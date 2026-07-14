// /api/companies/* — company info + settings (full CRUD for company_admin)
const JWT_SECRET_KEY = 'ghaya-jwt-secret';

function b64u(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
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

const COMPANY_SELECT = `SELECT id, name_en, name_ar, subscription_tier, subscription_active, managed_by_ghaya, created_at,
  work_start_time, work_end_time, late_threshold_minutes, work_days,
  geofence_enabled, workplace_lat, workplace_lng, geofence_radius_meters,
  permission_hours_monthly FROM companies`;

export async function onRequest({request,env,params}){
  if(request.method==='OPTIONS')return new Response(null,{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,PUT','Access-Control-Allow-Headers':'Content-Type,Authorization'}});

  const auth=await requireAuth(request,env);
  if(auth.error)return err(auth.error,auth.status);
  const{user}=auth;

  const db=env.DB;
  const method=request.method;
  const route=params.route||[];
  const companyId=Array.isArray(route)?route[0]:route;

  // GET /api/companies/:id
  if(method==='GET'&&companyId){
    if(user.role!=='ghaya_admin'&&user.company_id!==companyId)return err('Forbidden',403);
    const company=await db.prepare(COMPANY_SELECT+' WHERE id=?').bind(companyId).first();
    if(!company)return err('Not found',404);
    return json({company});
  }

  // GET /api/companies (ghaya_admin only)
  if(method==='GET'&&!companyId){
    if(user.role!=='ghaya_admin')return err('Forbidden',403);
    const{results}=await db.prepare(COMPANY_SELECT+' ORDER BY created_at DESC').all();
    return json({companies:results});
  }

  // PUT /api/companies/:id — partial update using COALESCE (no field is required)
  if(method==='PUT'&&companyId){
    if(user.role!=='ghaya_admin'&&user.company_id!==companyId)return err('Forbidden',403);
    const body=await request.json();

    const n=v=>v!==undefined?v:null;
    const ni=v=>v!==undefined&&v!==null?parseInt(v):null;
    const nf=v=>v!==undefined&&v!==null?parseFloat(v):null;
    const nb=v=>v!==undefined?(v?1:0):null;

    const ge=nb(body.geofence_enabled);

    await db.prepare(`UPDATE companies SET
      name_en               = COALESCE(?, name_en),
      name_ar               = COALESCE(?, name_ar),
      work_start_time       = COALESCE(?, work_start_time),
      work_end_time         = COALESCE(?, work_end_time),
      late_threshold_minutes= COALESCE(?, late_threshold_minutes),
      work_days             = COALESCE(?, work_days),
      geofence_enabled      = CASE WHEN ? IS NOT NULL THEN ? ELSE geofence_enabled END,
      workplace_lat         = COALESCE(?, workplace_lat),
      workplace_lng         = COALESCE(?, workplace_lng),
      geofence_radius_meters= COALESCE(?, geofence_radius_meters),
      permission_hours_monthly = COALESCE(?, permission_hours_monthly),
      updated_at            = datetime('now')
      WHERE id=?`)
      .bind(
        n(body.name_en), n(body.name_ar),
        n(body.work_start_time), n(body.work_end_time),
        ni(body.late_threshold_minutes), n(body.work_days),
        ge, ge,
        nf(body.workplace_lat), nf(body.workplace_lng),
        ni(body.geofence_radius_meters),
        nf(body.permission_hours_monthly),
        companyId
      ).run();

    const company=await db.prepare(COMPANY_SELECT+' WHERE id=?').bind(companyId).first();
    return json({company});
  }

  return err('Method not allowed',405);
}
