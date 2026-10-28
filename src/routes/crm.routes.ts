/**
 * B-MAX CRM HTTP API.
 * Route handlers only; business calculations live in ../lib/crm.
 */
import { Router } from 'express';
import { db } from '../lib/db';
import { validateMobile } from '../lib/validators';
import { crmGetRule, crmAvailablePoints, crmRedeemPoints } from '../lib/crm';

const router = Router();

function uid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

router.get('/loyalty/:firmId/party/:partyId/summary',(req,res)=>{try{const rule=crmGetRule(req.params.firmId);const available=crmAvailablePoints(req.params.firmId,req.params.partyId);res.json({rule:{...rule,itemRules:rule.itemRules},availablePoints:available,pointValue:Number(rule.pointValue||1)});}catch(e:any){res.status(500).json({error:e.message});}});
router.get('/loyalty/:firmId/quote',(req,res)=>{try{const b=req.query||{},rule=crmGetRule(req.params.firmId),available=crmAvailablePoints(req.params.firmId,String(b.partyId||''));const billTotal=Math.max(0,Number(b.billTotal)||0),value=Math.max(.0001,Number(rule.pointValue||1));let maxByBill=Math.floor((billTotal*(Number(rule.maxRedeemPercentage||100)/100))/value);if(Number(rule.maxRedeemPoints||0)>0)maxByBill=Math.min(maxByBill,Number(rule.maxRedeemPoints));const eligible=Math.max(0,Math.min(available,maxByBill));res.json({availablePoints:available,eligiblePoints:eligible,pointValue:value,maxRedeemPercentage:Number(rule.maxRedeemPercentage||100),frictionless:!!rule.frictionless,minPoints:Number(rule.redeemMinPoints||0),stepPoints:Number(rule.redeemStepPoints||1),maxRedeemPoints:Number(rule.maxRedeemPoints||0),amountPerPoint:value});}catch(e:any){res.status(500).json({error:e.message});}});
router.post('/loyalty/:firmId/claim',(req,res)=>{try{const b=req.body||{};const points=Math.trunc(Number(b.points)||0);if(!b.partyId||points<=0)return res.status(400).json({error:'partyId and positive points are required'});const id=uid('ll'),now=nowIso(),rule=crmGetRule(req.params.firmId),expiry=Number(rule.expiryDays||0)>0?new Date(Date.now()+Number(rule.expiryDays)*86400000).toISOString():null;db.prepare(`INSERT INTO crm_loyalty_ledger (id,firmId,partyId,type,points,source,referenceId,referenceNumber,expiresAt,note,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,req.params.firmId,b.partyId,'claimed',points,'claim',b.referenceId||null,b.referenceNumber||null,expiry,b.note||'Customer claimed loyalty points',now);db.prepare('UPDATE parties SET loyaltyPoints=? WHERE id=? AND firmId=?').run(crmAvailablePoints(req.params.firmId,b.partyId),b.partyId,req.params.firmId);res.json({ok:true,id,availablePoints:crmAvailablePoints(req.params.firmId,b.partyId)});}catch(e:any){res.status(500).json({error:e.message});}});
router.post('/loyalty/:firmId/redeem',(req,res)=>{try{const b=req.body||{};if(!b.partyId)return res.status(400).json({error:'partyId required'});res.json({ok:true,data:crmRedeemPoints(req.params.firmId,b.partyId,b.points,b.referenceId||null,b.referenceNumber||null,b.note||'')});}catch(e:any){res.status(400).json({error:e.message});}});

router.get('/loyalty/:firmId', (req,res)=>{
  try {
    const firmId=req.params.firmId;
    let rule:any=db.prepare('SELECT * FROM crm_loyalty_rules WHERE firmId=? AND isActive=1 ORDER BY updatedAt DESC LIMIT 1').get(firmId);
    if(!rule){
      const id=uid('lr'), now=nowIso();
      db.prepare(`INSERT INTO crm_loyalty_rules (id,firmId,name,createdAt,updatedAt) VALUES (?,?,?,?,?)`).run(id,firmId,'Default Loyalty Program',now,now);
      rule=db.prepare('SELECT * FROM crm_loyalty_rules WHERE id=?').get(id);
    }
    let rules:any[]=[]; try{ rules=JSON.parse(rule.itemRulesJson||'[]'); if(!Array.isArray(rules)) rules=[]; }catch{ rules=[]; }
    rule.itemRules=rules; delete rule.itemRulesJson;
    const parties=db.prepare(`SELECT id,name,phone,loyaltyPoints FROM parties WHERE firmId=? AND isActive=1 ORDER BY name LIMIT 500`).all(firmId);
    const items=db.prepare(`SELECT id,name,itemCode,sku,barcode,isActive FROM items WHERE firmId=? AND isActive=1 ORDER BY name LIMIT 5000`).all(firmId);
    res.json({rule, parties, items});
  }catch(e:any){res.status(500).json({error:e.message});}
});
router.post('/loyalty/:firmId/rule',(req,res)=>{
  try{
    const firmId=req.params.firmId, b=req.body||{}, now=nowIso();
    let itemRules:any[]=[];
    if(Array.isArray(b.itemRules)){
      const seen=new Set<string>();
      for(const raw of b.itemRules){
        const itemId=String(raw?.itemId||'').trim();
        const points=Math.trunc(Number(raw?.points)||0);
        const minQty=Math.max(1,Math.trunc(Number(raw?.minQty)||1));
        if(!itemId){ if(b.mode==='item_wise') return res.status(400).json({error:'Every item-wise rule must have an item selected'}); continue; }
        if(seen.has(itemId)) return res.status(400).json({error:'Duplicate item in item-wise rules'});
        const item:any=db.prepare('SELECT id,name FROM items WHERE id=? AND firmId=? AND isActive=1').get(itemId,firmId);
        if(!item) return res.status(400).json({error:'Selected item is invalid or does not belong to this firm'});
        if(points<=0) return res.status(400).json({error:`Points for ${item.name} must be greater than 0`});
        seen.add(itemId); itemRules.push({itemId,item:item.name,points,minQty});
      }
    }
    let rule:any=db.prepare('SELECT id FROM crm_loyalty_rules WHERE firmId=? ORDER BY updatedAt DESC LIMIT 1').get(firmId);
    const id=rule?.id||uid('lr');
    db.prepare(`INSERT INTO crm_loyalty_rules (id,firmId,name,mode,basis,percentage,pointsPerRupee,spendThreshold,thresholdPoints,minBillAmount,maxRedeemPoints,maxRedeemPercentage,redeemMinPoints,redeemStepPoints,pointValue,expiryDays,frictionless,itemRulesJson,isActive,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mode=excluded.mode,basis=excluded.basis,percentage=excluded.percentage,pointsPerRupee=excluded.pointsPerRupee,spendThreshold=excluded.spendThreshold,thresholdPoints=excluded.thresholdPoints,minBillAmount=excluded.minBillAmount,maxRedeemPoints=excluded.maxRedeemPoints,maxRedeemPercentage=excluded.maxRedeemPercentage,redeemMinPoints=excluded.redeemMinPoints,redeemStepPoints=excluded.redeemStepPoints,pointValue=excluded.pointValue,expiryDays=excluded.expiryDays,frictionless=excluded.frictionless,itemRulesJson=excluded.itemRulesJson,isActive=excluded.isActive,updatedAt=excluded.updatedAt`)
      .run(id,firmId,b.name||'Default Loyalty Program',b.mode||'bill_percentage',b.basis||'per_rupee',Number(b.percentage)||0,Number(b.pointsPerRupee)||0,Number(b.spendThreshold)||0,Number(b.thresholdPoints)||0,Number(b.minBillAmount)||0,Number(b.maxRedeemPoints)||0,Number(b.maxRedeemPercentage)||100,Number(b.redeemMinPoints)||0,Number(b.redeemStepPoints)||1,Number(b.pointValue)||1,Number(b.expiryDays)||0,b.frictionless?1:0,JSON.stringify(itemRules),b.isActive===false?0:1,rule?.id ? (db.prepare('SELECT createdAt FROM crm_loyalty_rules WHERE id=?').get(id) as any)?.createdAt : now,now);
    res.json({ok:true,id});
  }catch(e:any){res.status(500).json({error:e.message});}
});
router.get('/loyalty/:firmId/party/:partyId/history',(req,res)=>{
  try{ const rows=db.prepare(`SELECT l.*,p.name as partyName,p.phone FROM crm_loyalty_ledger l LEFT JOIN parties p ON p.id=l.partyId WHERE l.firmId=? AND l.partyId=? ORDER BY l.createdAt DESC`).all(req.params.firmId,req.params.partyId); res.json({rows}); }
  catch(e:any){res.status(500).json({error:e.message});}
});
router.post('/loyalty/:firmId/adjust',(req,res)=>{
  try{ const b=req.body||{}, firmId=req.params.firmId, now=nowIso(), points=Math.trunc(Number(b.points)||0); if(!b.partyId||!points) return res.status(400).json({error:'partyId and non-zero points are required'}); const id=uid('ll'); const expiry=Number(b.expiryDays)>0?new Date(Date.now()+Number(b.expiryDays)*86400000).toISOString():null; db.transaction(()=>{db.prepare(`INSERT INTO crm_loyalty_ledger (id,firmId,partyId,type,points,source,referenceId,referenceNumber,expiresAt,note,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,firmId,b.type||'adjustment',points,b.source||'manual',b.referenceId||null,b.referenceNumber||null,expiry,b.note||'',now); db.prepare('UPDATE parties SET loyaltyPoints=MAX(0,COALESCE(loyaltyPoints,0)+?) WHERE id=? AND firmId=?').run(points,b.partyId,firmId);})(); res.json({ok:true,id}); }
  catch(e:any){res.status(500).json({error:e.message});}
});

router.get('/leads/:firmId',(req,res)=>{
  try {
    const rows=db.prepare('SELECT * FROM crm_leads WHERE firmId=? ORDER BY datetime(updatedAt) DESC, rowid DESC').all(req.params.firmId);
    res.json({rows});
  } catch(e:any) { res.status(500).json({error:e?.message||'Unable to load leads'}); }
});
router.post('/leads/:firmId',(req,res)=>{
  try {
    const b=req.body||{}, now=nowIso(), id=String(b.id||uid('lead'));
    const name=String(b.name||'').trim();
    if(!name) return res.status(400).json({error:'Lead name is required'});
    const phoneCheck=validateMobile(b.phone);
    if(!phoneCheck.valid) return res.status(400).json({error:phoneCheck.error});
    const stageSet=new Set(['New','Contacted','Qualified','Proposal','Negotiation','Won','Lost','Nurture']);
    const prioritySet=new Set(['Low','Medium','High','Urgent']);
    const stage=stageSet.has(String(b.stage))?String(b.stage):'New';
    const priority=prioritySet.has(String(b.priority))?String(b.priority):'Medium';
    const phone=phoneCheck.value||'';
    const quotedAmount=Number.isFinite(Number(b.quotedAmount))?Number(b.quotedAmount):0;
    db.prepare(`INSERT INTO crm_leads (id,firmId,name,phone,email,company,source,inquiry,productInterest,quotedAmount,pitch,stage,priority,nextFollowUp,ownerUserId,notes,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,phone=excluded.phone,email=excluded.email,company=excluded.company,source=excluded.source,inquiry=excluded.inquiry,productInterest=excluded.productInterest,quotedAmount=excluded.quotedAmount,pitch=excluded.pitch,stage=excluded.stage,priority=excluded.priority,nextFollowUp=excluded.nextFollowUp,ownerUserId=excluded.ownerUserId,notes=excluded.notes,updatedAt=excluded.updatedAt`).run(
      id,req.params.firmId,name,phone,String(b.email||'').trim(),String(b.company||'').trim(),String(b.source||'Walk-in'),String(b.inquiry||''),String(b.productInterest||''),quotedAmount,String(b.pitch||''),stage,priority,b.nextFollowUp||null,b.ownerUserId||null,String(b.notes||''),b.createdAt||now,now
    );
    const saved=db.prepare('SELECT * FROM crm_leads WHERE id=? AND firmId=?').get(id,req.params.firmId);
    res.json({ok:true,id,lead:saved});
  } catch(e:any) { res.status(500).json({error:e?.message||'Unable to save lead'}); }
});
router.delete('/leads/:firmId/:id',(req,res)=>{try{db.prepare('DELETE FROM crm_leads WHERE id=? AND firmId=?').run(req.params.id,req.params.firmId);res.json({ok:true});}catch(e:any){res.status(500).json({error:e.message});}});

router.get('/approvals/:firmId',(req,res)=>{try{res.json({rows:db.prepare('SELECT * FROM crm_approval_rules WHERE firmId=? ORDER BY moduleKey,sequenceNo,minAmount').all(req.params.firmId)});}catch(e:any){res.status(500).json({error:e.message});}});
router.post('/approvals/:firmId',(req,res)=>{try{const b=req.body||{},now=nowIso(),id=b.id||uid('ar'); const validApprovalModules=new Set(['purchase_invoice','purchase_order','purchase_return','sale_invoice','sale_order','sale_return','expense','payment_in','payment_out','journal','quotation','proforma','pos_billing']); if(b.moduleKey&&!validApprovalModules.has(String(b.moduleKey))) return res.status(400).json({error:'Invalid approval module'}); db.prepare(`INSERT INTO crm_approval_rules (id,firmId,name,moduleKey,minAmount,maxAmount,role,sequenceNo,mode,slaHours,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,moduleKey=excluded.moduleKey,minAmount=excluded.minAmount,maxAmount=excluded.maxAmount,role=excluded.role,sequenceNo=excluded.sequenceNo,mode=excluded.mode,slaHours=excluded.slaHours,isActive=excluded.isActive,updatedAt=excluded.updatedAt`).run(id,req.params.firmId,b.name||'Approval Rule',b.moduleKey||'purchase',Number(b.minAmount)||0,b.maxAmount===''||b.maxAmount==null?null:Number(b.maxAmount),b.role||'Manager',Number(b.sequenceNo)||1,b.mode||'sequential',Number(b.slaHours)||24,b.isActive===false?0:1,b.createdAt||now,now);res.json({ok:true,id});}catch(e:any){res.status(500).json({error:e.message});}});
router.delete('/approvals/:firmId/:id',(req,res)=>{try{db.prepare('DELETE FROM crm_approval_rules WHERE id=? AND firmId=?').run(req.params.id,req.params.firmId);res.json({ok:true});}catch(e:any){res.status(500).json({error:e.message});}});



export default router;



