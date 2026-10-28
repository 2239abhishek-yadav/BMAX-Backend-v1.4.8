/**
 * B-MAX CRM domain service.
 * Single source of truth for loyalty schema, earning, availability and redemption.
 */
import { db } from './db';

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureCrmSchema(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_loyalty_rules (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'Default Loyalty Program',
      mode TEXT NOT NULL DEFAULT 'bill_percentage', basis TEXT NOT NULL DEFAULT 'per_rupee',
      percentage REAL DEFAULT 1, pointsPerRupee REAL DEFAULT 1, spendThreshold REAL DEFAULT 0,
      thresholdPoints REAL DEFAULT 0, minBillAmount REAL DEFAULT 0, maxRedeemPoints INTEGER DEFAULT 0,
      maxRedeemPercentage REAL DEFAULT 100, redeemMinPoints INTEGER DEFAULT 0, redeemStepPoints INTEGER DEFAULT 1, pointValue REAL DEFAULT 1,
      expiryDays INTEGER DEFAULT 0, frictionless INTEGER DEFAULT 1, isActive INTEGER DEFAULT 1,
      itemRulesJson TEXT DEFAULT '[]', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_crm_loyalty_rules_firm ON crm_loyalty_rules(firmId);
    CREATE TABLE IF NOT EXISTS crm_loyalty_ledger (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, partyId TEXT NOT NULL, type TEXT NOT NULL,
      points INTEGER NOT NULL, source TEXT, referenceId TEXT, referenceNumber TEXT,
      expiresAt TEXT, note TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_crm_loyalty_ledger_party ON crm_loyalty_ledger(firmId, partyId, createdAt);
    CREATE TABLE IF NOT EXISTS crm_leads (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT,
      company TEXT, source TEXT, inquiry TEXT, productInterest TEXT, quotedAmount REAL DEFAULT 0,
      pitch TEXT, stage TEXT DEFAULT 'New', priority TEXT DEFAULT 'Medium', nextFollowUp TEXT,
      ownerUserId TEXT, notes TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_crm_leads_firm_stage ON crm_leads(firmId, stage);
    CREATE TABLE IF NOT EXISTS crm_approval_rules (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, moduleKey TEXT NOT NULL,
      minAmount REAL DEFAULT 0, maxAmount REAL, role TEXT NOT NULL, sequenceNo INTEGER DEFAULT 1,
      mode TEXT DEFAULT 'sequential', slaHours INTEGER DEFAULT 24, isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_crm_approval_rules_firm ON crm_approval_rules(firmId, moduleKey, sequenceNo);
  `);
  try { db.prepare('ALTER TABLE crm_loyalty_rules ADD COLUMN pointValue REAL DEFAULT 1').run(); } catch {}
  // Forward-compatible migrations for CRM tables created by earlier builds.
  // CREATE TABLE IF NOT EXISTS does not add columns to an existing installation.
  const ensureColumn = (table:string, column:string, ddl:string) => {
    try {
      const cols:any[] = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
    } catch {}
  };
  ensureColumn('crm_leads','email','email TEXT');
  ensureColumn('crm_leads','company','company TEXT');
  ensureColumn('crm_leads','source','source TEXT');
  ensureColumn('crm_leads','inquiry','inquiry TEXT');
  ensureColumn('crm_leads','productInterest','productInterest TEXT');
  ensureColumn('crm_leads','quotedAmount','quotedAmount REAL DEFAULT 0');
  ensureColumn('crm_leads','pitch','pitch TEXT');
  ensureColumn('crm_leads','stage',"stage TEXT DEFAULT 'New'");
  ensureColumn('crm_leads','priority',"priority TEXT DEFAULT 'Medium'");
  ensureColumn('crm_leads','nextFollowUp','nextFollowUp TEXT');
  ensureColumn('crm_leads','ownerUserId','ownerUserId TEXT');
  ensureColumn('crm_leads','notes','notes TEXT');
  ensureColumn('crm_leads','createdAt','createdAt TEXT');
  ensureColumn('crm_leads','updatedAt','updatedAt TEXT');
  ensureColumn('crm_approval_rules','sequenceNo','sequenceNo INTEGER DEFAULT 1');
  ensureColumn('crm_approval_rules','mode',"mode TEXT DEFAULT 'sequential'");
  ensureColumn('crm_approval_rules','slaHours','slaHours INTEGER DEFAULT 24');
  ensureColumn('crm_approval_rules','isActive','isActive INTEGER DEFAULT 1');
  ensureColumn('crm_approval_rules','createdAt','createdAt TEXT');
  ensureColumn('crm_approval_rules','updatedAt','updatedAt TEXT');
}

export function crmGetRule(firmId:string):any {
  let rule:any=db.prepare('SELECT * FROM crm_loyalty_rules WHERE firmId=? AND isActive=1 ORDER BY updatedAt DESC LIMIT 1').get(firmId);
  if(!rule){ const id=uid('lr'), now=nowIso(); db.prepare(`INSERT INTO crm_loyalty_rules (id,firmId,name,createdAt,updatedAt) VALUES (?,?,?,?,?)`).run(id,firmId,'Default Loyalty Program',now,now); rule=db.prepare('SELECT * FROM crm_loyalty_rules WHERE id=?').get(id); }
  try{ rule.itemRules=JSON.parse(rule.itemRulesJson||'[]'); }catch{ rule.itemRules=[]; }
  return rule;
}
export function crmAvailablePoints(firmId:string, partyId:string):number {
  const now=nowIso();
  const row:any=db.prepare(`SELECT COALESCE(SUM(CASE WHEN points>0 AND (expiresAt IS NULL OR expiresAt>?) THEN points ELSE 0 END),0) earned,
    COALESCE(SUM(CASE WHEN points<0 THEN points ELSE 0 END),0) spent FROM crm_loyalty_ledger WHERE firmId=? AND partyId=?`).get(now,firmId,partyId);
  return Math.max(0,Math.trunc(Number(row?.earned||0)+Number(row?.spent||0)));
}
export function crmEarnPoints(firmId:string, partyId:string, total:number, items:any[], referenceId:string, referenceNumber:string, now=nowIso()):number {
  if(!partyId) return 0;
  const rule=crmGetRule(firmId); const billTotal=Math.max(0,Number(total)||0);
  if(billTotal < Number(rule.minBillAmount||0)) return 0;
  let points=0;
  if(String(rule.mode)==='item_wise'){
    const map=new Map<string,any>((rule.itemRules||[]).map((x:any)=>[String(x.itemId),x]));
    for(const it of (Array.isArray(items)?items:[])){
      const r=map.get(String(it.itemId||'')); if(!r) continue;
      const qty=Math.max(0,Number(it.quantity)||0), minQty=Math.max(1,Number(r.minQty)||1), perUnit=Math.max(0,Number(r.points)||0);
      points += Math.floor(qty/minQty)*Math.trunc(perUnit);
    }
  } else if(String(rule.mode)==='spend_threshold'){
    if(billTotal >= Number(rule.spendThreshold||0)) points=Math.trunc(Number(rule.thresholdPoints)||0);
  } else {
    const basis=String(rule.basis||'per_rupee');
    if(basis==='per_1000') points=Math.floor((billTotal/1000)*Number(rule.pointsPerRupee||0));
    else if(basis==='per_100') points=Math.floor((billTotal/100)*Number(rule.pointsPerRupee||0));
    else if(basis==='per_rupee') points=Math.floor(billTotal*Number(rule.pointsPerRupee||0));
    else points=Math.floor((billTotal*Number(rule.percentage||0))/100);
  }
  points=Math.max(0,Math.trunc(points)); if(!points) return 0;
  const expiry=Number(rule.expiryDays||0)>0?new Date(Date.now()+Number(rule.expiryDays)*86400000).toISOString():null;
  const id=uid('ll');
  db.prepare(`INSERT INTO crm_loyalty_ledger (id,firmId,partyId,type,points,source,referenceId,referenceNumber,expiresAt,note,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,firmId,partyId,'earned',points,'sale',referenceId,referenceNumber,expiry,`Auto earned from ${referenceNumber||'sale'}`,now);
  db.prepare('UPDATE parties SET loyaltyPoints=? WHERE id=? AND firmId=?').run(crmAvailablePoints(firmId,partyId),partyId,firmId);
  return points;
}
export function crmRedeemPoints(firmId:string, partyId:string, requested:number, referenceId:string|null, referenceNumber:string|null, note=''):any {
  const rule=crmGetRule(firmId); const available=crmAvailablePoints(firmId,partyId); let points=Math.trunc(Number(requested)||0);
  if(points<=0) throw new Error('Enter valid loyalty points');
  if(points>available) throw new Error(`Only ${available} loyalty points are available`);
  if(points < Number(rule.redeemMinPoints||0)) throw new Error(`Minimum redemption is ${Number(rule.redeemMinPoints||0)} points`);
  const step=Math.max(1,Number(rule.redeemStepPoints||1)); if(points%step!==0) throw new Error(`Redemption must be in multiples of ${step} points`);
  if(Number(rule.maxRedeemPoints||0)>0) points=Math.min(points,Number(rule.maxRedeemPoints));
  const amount=+(points*Number(rule.pointValue||1)).toFixed(2); const id=uid('ll'); const now=nowIso();
  db.prepare(`INSERT INTO crm_loyalty_ledger (id,firmId,partyId,type,points,source,referenceId,referenceNumber,expiresAt,note,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,firmId,partyId,'redeemed',-points,'redemption',referenceId,referenceNumber,null,note||`Redeemed on ${referenceNumber||'sale'}`,now);
  db.prepare('UPDATE parties SET loyaltyPoints=? WHERE id=? AND firmId=?').run(crmAvailablePoints(firmId,partyId),partyId,firmId);
  return {id,points,amount,available:crmAvailablePoints(firmId,partyId)};
}




