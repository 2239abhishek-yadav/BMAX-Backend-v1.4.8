import { validateMobile } from '../lib/validators';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { getSubscriptionAccess } from '../lib/subscription';

const router=Router();

function enforceUserLimit(firmId:string){
  const access=getSubscriptionAccess();
  if(access.state?.status!=='active') return null;
  const max=Number(access.state?.maxUsers||0);
  if(max<=0) return null;
  const count=Number((db.prepare('SELECT COUNT(DISTINCT userId) AS c FROM firm_users WHERE firmId=? AND isActive=1').get(firmId) as any)?.c||0);
  if(count>=max) return `Your current B-MAX plan allows ${max} user${max===1?'':'s'} for this company. Additional users are charged at 10% of the selected plan amount.`;
  return null;
}

export const ACCESS_MODULES: Array<[string,string]> = [
  ['dashboard','Home'], ['items','Items'], ['parties','Parties'], ['ledger','Ledger'],
  ['sale_invoice','Sale Invoices'], ['sale_quotation','Sale Quotation'], ['sale_order','Sale Order'], ['delivery_challan','Delivery Challan'],
  ['sale_return','Sale Return / Cr. Note'], ['pos_billing','POS'], ['counter_sale','Counter Sale'],
  ['purchase_invoice','Purchase Bills'], ['purchase_order','Purchase Order'], ['purchase_return','Purchase Return'],
  ['payment_in','Payment In'], ['payment_out','Payment Out'], ['expenses','Expenses'], ['bank','Cash & Bank'],
  ['accounting_entries','Accounting Entries'], ['employees','Employees'], ['attendance','Attendance'], ['payroll','Payroll'],
  ['report_pl','Profit & Loss'], ['report_stock','Stock Summary'], ['report_outstanding','Outstanding'], ['report_daybook','Day Book'],
  ['report_gst','GST Reports'], ['settings','Settings'], ['data_sync','Sync & Backup'],
];
export const ACCESS_ACTIONS=['view','create','edit','delete','print','export','cancel','approve','convert','hold','resume','discount_override','rate_override','back_date','restore','transfer','manage'];

const allPermissions=()=>Object.fromEntries(ACCESS_MODULES.map(([key])=>[key,[...ACCESS_ACTIONS]]));
const viewPermissions=()=>Object.fromEntries(ACCESS_MODULES.map(([key])=>[key,['view']]));
const roleDefs=[
  {name:'Administrator',code:'administrator',description:'Full access to the selected company.',permissions:allPermissions()},
  {name:'Manager',code:'manager',description:'Operational and reporting access with controlled administration.',permissions:Object.fromEntries(ACCESS_MODULES.map(([key])=>[key,['view','create','edit','print','export','approve','convert','manage']]))},
  {name:'Operator',code:'operator',description:'Day-to-day transaction entry without destructive administration.',permissions:Object.fromEntries(ACCESS_MODULES.map(([key])=>[key,['view','create','edit','print']]))},
  {name:'Accountant',code:'accountant',description:'Accounting, payments, GST and financial reports.',permissions:Object.fromEntries(ACCESS_MODULES.filter(([k])=>['dashboard','parties','ledger','payment_in','payment_out','expenses','bank','accounting_entries','report_pl','report_outstanding','report_daybook','report_gst'].includes(k)).map(([key])=>[key,['view','create','edit','print','export','approve']]))},
  {name:'Sales Executive',code:'sales_executive',description:'Sales, customers and sales reports.',permissions:Object.fromEntries(ACCESS_MODULES.filter(([k])=>['dashboard','items','parties','sale_invoice','sale_quotation','sale_order','delivery_challan','sale_return','pos_billing','counter_sale','report_stock','report_outstanding'].includes(k)).map(([key])=>[key,['view','create','edit','print']]))},
  {name:'Purchase Executive',code:'purchase_executive',description:'Purchase and supplier operations.',permissions:Object.fromEntries(ACCESS_MODULES.filter(([k])=>['dashboard','items','parties','purchase_invoice','purchase_order','purchase_return','report_stock','report_outstanding'].includes(k)).map(([key])=>[key,['view','create','edit','print']]))},
  {name:'Inventory Manager',code:'inventory_manager',description:'Items, stock and inventory operations.',permissions:Object.fromEntries(ACCESS_MODULES.filter(([k])=>['dashboard','items','report_stock','sale_invoice','purchase_invoice','stock_transfer'].includes(k)).map(([key])=>[key,['view','create','edit','print','transfer']]))},
  {name:'Viewer',code:'viewer',description:'Read-only access.',permissions:viewPermissions()},
];

function ensureRoleTable(){
  db.exec(`CREATE TABLE IF NOT EXISTS user_roles (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL, description TEXT, permissionsJson TEXT DEFAULT '{}', isSystem INTEGER DEFAULT 0, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_firm_code ON user_roles(firmId, code)');
}
function ensureRoles(firmId:string){
  ensureRoleTable();
  const now=new Date().toISOString();
  const insert=db.prepare('INSERT OR IGNORE INTO user_roles (id,firmId,name,code,description,permissionsJson,isSystem,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for(const r of roleDefs) insert.run(uuidv4(),firmId,r.name,r.code,r.description,JSON.stringify(r.permissions),1,1,now,now);
  // Existing memberships get linked to the matching seeded role without changing their stored custom permissions.
  db.prepare(`UPDATE firm_users SET roleId=(SELECT id FROM user_roles ur WHERE ur.firmId=firm_users.firmId AND ur.code=CASE firm_users.role WHEN 'owner' THEN 'administrator' WHEN 'admin' THEN 'administrator' WHEN 'sales' THEN 'sales_executive' WHEN 'purchase' THEN 'purchase_executive' WHEN 'accounts' THEN 'accountant' WHEN 'billing' THEN 'operator' WHEN 'manager' THEN 'manager' ELSE 'viewer' END) WHERE firmId=? AND (roleId IS NULL OR roleId='')`).run(firmId);
}
function parseJson(raw:any,fallback:any={}){try{return raw?JSON.parse(raw):fallback}catch{return fallback}}
function getRole(roleId:string|null|undefined){return roleId?db.prepare('SELECT * FROM user_roles WHERE id=?').get(roleId) as any:null}
function effectivePermissions(m:any){
  const role=getRole(m.roleId);
  const rolePerms=parseJson(role?.permissionsJson,{});
  const overrides=parseJson(m.permissionsJson,{});
  if(Object.keys(overrides).length===0) return rolePerms;
  const merged:any={...rolePerms};
  for(const [key,actions] of Object.entries(overrides)) merged[key]=Array.isArray(actions)?actions:[];
  return merged;
}
function effectiveMembership(m:any){return {...m,permissions:effectivePermissions(m),accessScope:parseJson(m.accessScopeJson,{})}}
function normalizeScope(scope:any){
  const s=scope&&typeof scope==='object'?scope:{};
  return {firmId:s.firmId||undefined,storeIds:Array.isArray(s.storeIds)?s.storeIds.filter(Boolean):[],categoryIds:Array.isArray(s.categoryIds)?s.categoryIds.filter(Boolean):[],brandIds:Array.isArray(s.brandIds)?s.brandIds.filter(Boolean):[]};
}

router.get('/roles',(req:Request,res:Response)=>{try{const firmId=String(req.query.firmId||'');if(!firmId)return res.status(400).json({error:'firmId is required'});ensureRoles(firmId);const rows=db.prepare('SELECT id,name,code,description,permissionsJson,isSystem,isActive,createdAt,updatedAt FROM user_roles WHERE firmId=? AND isActive=1 ORDER BY isSystem DESC,name').all(firmId) as any[];res.json({success:true,data:rows.map(r=>({...r,permissions:parseJson(r.permissionsJson)})),actions:ACCESS_ACTIONS,modules:ACCESS_MODULES});}catch(e:any){res.status(500).json({error:e.message})}});
router.post('/roles',(req:Request,res:Response)=>{try{const {firmId,name,description='',permissions={}}=req.body||{};if(!firmId||!String(name||'').trim())return res.status(400).json({error:'firmId and role name are required'});ensureRoles(firmId);const clean=String(name).trim();const code=clean.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||`role_${Date.now()}`;if(db.prepare('SELECT id FROM user_roles WHERE firmId=? AND code=?').get(firmId,code))return res.status(409).json({error:'A role with this name already exists'});const now=new Date().toISOString(),id=uuidv4();db.prepare('INSERT INTO user_roles (id,firmId,name,code,description,permissionsJson,isSystem,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,firmId,clean,code,String(description||''),JSON.stringify(permissions||{}),0,1,now,now);res.status(201).json({success:true,data:{id,firmId,name:clean,code,description,permissions,isSystem:0,isActive:1}})}catch(e:any){res.status(500).json({error:e.message})}});
router.put('/roles/:roleId',(req:Request,res:Response)=>{try{const row=db.prepare('SELECT * FROM user_roles WHERE id=?').get(req.params.roleId) as any;if(!row)return res.status(404).json({error:'Role not found'});const {name,description,permissions,isActive}=req.body||{};const now=new Date().toISOString();if(name && !row.isSystem){const code=String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');const dup=db.prepare('SELECT id FROM user_roles WHERE firmId=? AND code=? AND id<>?').get(row.firmId,code,row.id);if(dup)return res.status(409).json({error:'Another role already uses this name'});db.prepare('UPDATE user_roles SET name=?,code=?,description=COALESCE(?,description),permissionsJson=COALESCE(?,permissionsJson),isActive=COALESCE(?,isActive),updatedAt=? WHERE id=?').run(String(name).trim(),code,description??null,permissions===undefined?null:JSON.stringify(permissions),isActive===undefined?null:(isActive?1:0),now,row.id)}else{db.prepare('UPDATE user_roles SET description=COALESCE(?,description),permissionsJson=COALESCE(?,permissionsJson),isActive=COALESCE(?,isActive),updatedAt=? WHERE id=?').run(description??null,permissions===undefined?null:JSON.stringify(permissions),isActive===undefined?null:(isActive?1:0),now,row.id)}res.json({success:true,data:{...db.prepare('SELECT * FROM user_roles WHERE id=?').get(row.id) as any,permissions:parseJson((db.prepare('SELECT permissionsJson FROM user_roles WHERE id=?').get(row.id) as any)?.permissionsJson)}})}catch(e:any){res.status(500).json({error:e.message})}});
router.delete('/roles/:roleId',(req:Request,res:Response)=>{try{const row=db.prepare('SELECT * FROM user_roles WHERE id=?').get(req.params.roleId) as any;if(!row)return res.status(404).json({error:'Role not found'});if(row.isSystem)return res.status(400).json({error:'System roles cannot be deleted'});const count=(db.prepare('SELECT COUNT(*) c FROM firm_users WHERE roleId=?').get(row.id) as any).c;if(count>0)return res.status(400).json({error:'Role is assigned to users. Reassign those users before deleting it.'});db.prepare('DELETE FROM user_roles WHERE id=?').run(row.id);res.json({success:true})}catch(e:any){res.status(500).json({error:e.message})}});

router.get('/',(req:Request,res:Response)=>{try{const firmId=String(req.query.firmId||'');if(!firmId)return res.status(400).json({error:'firmId is required'});ensureRoles(firmId);const rows=db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.isActive,fu.id membershipId,fu.role,fu.roleId,fu.permissionsJson,fu.accessScopeJson,fu.isOwner,fu.isActive membershipActive,fu.inviteStatus,fu.invitedAt,fu.acceptedAt,ur.name roleName FROM users u JOIN firm_users fu ON fu.userId=u.id LEFT JOIN user_roles ur ON ur.id=fu.roleId WHERE fu.firmId=? ORDER BY u.name`).all(firmId) as any[];res.json({success:true,data:rows.map(effectiveMembership)})}catch(e:any){res.status(500).json({error:e.message})}});

router.post('/invite',(req:Request,res:Response)=>{try{const {name,email,phone,roleId,firmIds=[],accessScopes={},permissions={}}=req.body||{};const cleanEmail=String(email||'').trim().toLowerCase();if(!name||!cleanEmail)return res.status(400).json({error:'Name and email are required'});if(!Array.isArray(firmIds)||!firmIds.length)return res.status(400).json({error:'Select at least one company'});for(const id of firmIds)ensureRoles(String(id));const role=getRole(roleId);if(!role || !firmIds.includes(role.firmId))return res.status(400).json({error:'Select a valid role for the first company, or create the role first'});const phoneCheck=validateMobile(phone);if(!phoneCheck.valid)return res.status(400).json({error:phoneCheck.error});for(const firmId of firmIds){const existingUser=db.prepare('SELECT u.id FROM users u JOIN firm_users fu ON fu.userId=u.id WHERE lower(u.email)=? AND fu.firmId=? AND fu.isActive=1').get(cleanEmail,String(firmId)) as any;if(!existingUser){const limitError=enforceUserLimit(String(firmId));if(limitError)return res.status(403).json({error:limitError,code:'USER_LIMIT_REACHED'});}}const now=new Date().toISOString();let u=db.prepare('SELECT * FROM users WHERE lower(email)=?').get(cleanEmail) as any;if(!u){const id=uuidv4();db.prepare('INSERT INTO users (id,name,email,phone,isActive,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?)').run(id,String(name).trim(),cleanEmail,phoneCheck.value||null,now,now);u=db.prepare('SELECT * FROM users WHERE id=?').get(id)}else{db.prepare('UPDATE users SET name=?,phone=?,updatedAt=? WHERE id=?').run(String(name).trim(),phoneCheck.value||null,now,u.id);u=db.prepare('SELECT * FROM users WHERE id=?').get(u.id)}
  const memberships:any[]=[];for(const firmId of firmIds){ensureRoles(String(firmId));const existing=db.prepare('SELECT * FROM firm_users WHERE firmId=? AND userId=?').get(firmId,u.id) as any;const sameRole=db.prepare('SELECT * FROM user_roles WHERE firmId=? AND code=?').get(firmId,role.code) as any;const firmRoleId=accessScopes?.[firmId]?.roleId||((firmId===role.firmId)?role.id:(sameRole?.id||null));const fallbackRole=firmRoleId?getRole(firmRoleId):sameRole;const chosenRole=fallbackRole||db.prepare('SELECT * FROM user_roles WHERE firmId=? AND code=?').get(firmId,'viewer') as any;const scope=normalizeScope({...accessScopes?.[firmId],firmId});if(existing){db.prepare('UPDATE firm_users SET role=?,roleId=?,permissionsJson=?,accessScopeJson=?,isActive=1,inviteStatus=\'pending\',invitedAt=COALESCE(invitedAt,?),updatedAt=? WHERE id=?').run(chosenRole.name?.toLowerCase().replace(/\s+/g,'_')||'viewer',chosenRole.id,JSON.stringify(permissions||{}),JSON.stringify(scope),now,now,existing.id);memberships.push({id:existing.id,firmId,roleId:chosenRole.id})}else{const mid=uuidv4();db.prepare('INSERT INTO firm_users (id,firmId,userId,role,roleId,permissionsJson,accessScopeJson,isOwner,isActive,inviteStatus,invitedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,0,1,\'pending\',?,?,?)').run(mid,firmId,u.id,chosenRole.name?.toLowerCase().replace(/\s+/g,'_')||'viewer',chosenRole.id,JSON.stringify(permissions||{}),JSON.stringify(scope),now,now,now);memberships.push({id:mid,firmId,roleId:chosenRole.id})}}
  res.status(201).json({success:true,data:{user:u,memberships},message:'User access created. Invitation is pending until the user signs in.'});
}catch(e:any){res.status(500).json({error:e.message})}});

router.post('/',(req:Request,res:Response)=>{try{const {firmId,name,email,phone,role='viewer',roleId,permissions={},accessScope={}}=req.body||{};if(!firmId||!name||!email)return res.status(400).json({error:'firmId, name and email are required'});ensureRoles(firmId);const phoneCheck=validateMobile(phone);if(!phoneCheck.valid)return res.status(400).json({error:phoneCheck.error});const chosenRole=roleId?getRole(roleId):db.prepare('SELECT * FROM user_roles WHERE firmId=? AND code=?').get(firmId,String(role).toLowerCase()) as any;if(roleId && (!chosenRole || chosenRole.firmId!==firmId))return res.status(400).json({error:'Invalid role'});const limitError=enforceUserLimit(String(firmId));if(limitError)return res.status(403).json({error:limitError,code:'USER_LIMIT_REACHED'});const now=new Date().toISOString();let u=db.prepare('SELECT * FROM users WHERE email=?').get(String(email).trim().toLowerCase()) as any;if(!u){const id=uuidv4();db.prepare('INSERT INTO users (id,name,email,phone,isActive,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?)').run(id,name,String(email).trim().toLowerCase(),phoneCheck.value||null,now,now);u=db.prepare('SELECT * FROM users WHERE id=?').get(id)}const existing=db.prepare('SELECT id FROM firm_users WHERE firmId=? AND userId=?').get(firmId,u.id) as any;if(existing)return res.status(409).json({error:'User is already mapped to this company'});const membershipId=uuidv4();const rname=chosenRole?.code||role;db.prepare('INSERT INTO firm_users (id,firmId,userId,role,roleId,permissionsJson,accessScopeJson,isOwner,isActive,inviteStatus,invitedAt,acceptedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,0,1,\'active\',?,?,?,?)').run(membershipId,firmId,u.id,rname,chosenRole?.id||null,JSON.stringify(permissions||{}),JSON.stringify(normalizeScope(accessScope)),null,now,now,now);res.status(201).json({success:true,data:{...u,membershipId,role:rname,roleId:chosenRole?.id||null,permissions,accessScope}})}catch(e:any){res.status(500).json({error:e.message})}});

router.put('/:membershipId',(req:Request,res:Response)=>{try{const {name,phone,role,roleId,permissions,accessScope,isActive}=req.body||{};const m=db.prepare('SELECT * FROM firm_users WHERE id=?').get(req.params.membershipId) as any;if(!m)return res.status(404).json({error:'Membership not found'});if(roleId){const r=getRole(roleId);if(!r||r.firmId!==m.firmId)return res.status(400).json({error:'Invalid role for this company'})}const phoneCheck=phone===undefined?{valid:true,value:undefined}:validateMobile(phone);if(!phoneCheck.valid)return res.status(400).json({error:phoneCheck.error});const now=new Date().toISOString();if(name!==undefined||phone!==undefined)db.prepare('UPDATE users SET name=COALESCE(?,name),phone=COALESCE(?,phone),updatedAt=? WHERE id=?').run(name??null,phoneCheck.value===undefined?null:phoneCheck.value,now,m.userId);db.prepare('UPDATE firm_users SET role=COALESCE(?,role),roleId=COALESCE(?,roleId),permissionsJson=COALESCE(?,permissionsJson),accessScopeJson=COALESCE(?,accessScopeJson),isActive=COALESCE(?,isActive),updatedAt=? WHERE id=?').run(role??null,roleId??null,permissions===undefined?null:JSON.stringify(permissions),accessScope===undefined?null:JSON.stringify(normalizeScope(accessScope)),isActive===undefined?null:(isActive?1:0),now,req.params.membershipId);res.json({success:true})}catch(e:any){res.status(500).json({error:e.message})}});
router.delete('/:membershipId',(req:Request,res:Response)=>{try{const r=db.prepare('SELECT * FROM firm_users WHERE id=?').get(req.params.membershipId) as any;if(!r)return res.status(404).json({error:'Membership not found'});db.prepare('DELETE FROM firm_users WHERE id=?').run(req.params.membershipId);res.json({success:true})}catch(e:any){res.status(500).json({error:e.message})}});
router.get('/by-email',(req:Request,res:Response)=>{try{const email=String(req.query.email||'').trim().toLowerCase();if(!email)return res.status(400).json({error:'email is required'});const rows=db.prepare(`SELECT fu.id membershipId,fu.firmId,fu.role,fu.roleId,fu.permissionsJson,fu.accessScopeJson,fu.isOwner,fu.isActive membershipActive,fu.inviteStatus,fu.invitedAt,fu.acceptedAt,f.name firmName,ur.name roleName FROM users u JOIN firm_users fu ON fu.userId=u.id JOIN firms f ON f.id=fu.firmId LEFT JOIN user_roles ur ON ur.id=fu.roleId WHERE lower(u.email)=? ORDER BY f.name`).all(email) as any[];res.json({success:true,data:rows.map(effectiveMembership)})}catch(e:any){res.status(500).json({error:e.message})}});
router.get('/resolve',(req:Request,res:Response)=>{try{const email=String(req.query.email||'').trim().toLowerCase(),firmId=String(req.query.firmId||'');if(!email||!firmId)return res.status(400).json({error:'email and firmId are required'});ensureRoles(firmId);const m=db.prepare(`SELECT fu.*,u.name,u.email,ur.name roleName,ur.code roleCode FROM users u JOIN firm_users fu ON fu.userId=u.id LEFT JOIN user_roles ur ON ur.id=fu.roleId WHERE lower(u.email)=? AND fu.firmId=? AND fu.isActive=1`).get(email,firmId) as any;if(!m)return res.status(403).json({error:'No active company access for this user'});res.json({success:true,data:effectiveMembership(m)})}catch(e:any){res.status(500).json({error:e.message})}});

export function checkPermission(email:string,firmId:string,module:string,action:string){
  const m=db.prepare(`SELECT fu.*,ur.permissionsJson rolePermissions FROM users u JOIN firm_users fu ON fu.userId=u.id LEFT JOIN user_roles ur ON ur.id=fu.roleId WHERE lower(u.email)=? AND fu.firmId=? AND fu.isActive=1 AND u.isActive=1`).get(String(email||'').trim().toLowerCase(),firmId) as any;
  if(!m)return {allowed:false,reason:'No active company access'};
  if(m.isOwner)return {allowed:true,membership:effectiveMembership(m)};
  const perms=effectivePermissions(m);
  // UI aliases must resolve to the canonical permission keys used by the transaction routes.
  const moduleAliases:any={credit_note:'sale_return',debit_note:'purchase_return'};
  const actionAliases:any={backdate:'back_date'};
  const canonicalModule=moduleAliases[module]||module;
  const canonicalAction=actionAliases[action]||action;
  const actions=Array.isArray(perms?.[canonicalModule])?perms[canonicalModule]:[];
  return {allowed:actions.includes(canonicalAction)||actions.includes('manage'),membership:effectiveMembership(m)};
}

export default router;
