import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();

function ensureItemCompanyTable(){
  db.exec(`CREATE TABLE IF NOT EXISTS item_companies (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, isActive INTEGER NOT NULL DEFAULT 1, FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE)`);
  const cols=(db.prepare('PRAGMA table_info(item_companies)').all() as any[]).map(c=>c.name);
  if(!cols.includes('isActive')) db.exec('ALTER TABLE item_companies ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1');
  const index:any=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_item_companies_firm_name'").get();
  if(!String(index?.sql||'').includes('WHERE COALESCE(isActive,1)=1')){
    db.exec('DROP INDEX IF EXISTS idx_item_companies_firm_name');
    db.exec('CREATE UNIQUE INDEX idx_item_companies_firm_name ON item_companies(firmId,name COLLATE NOCASE) WHERE COALESCE(isActive,1)=1');
  }
}

router.get('/', (req: Request,res: Response)=>{ try { ensureItemCompanyTable(); const firmId=String(req.query.firmId||'').trim(); if(!firmId)return res.status(400).json({error:'firmId required'}); const data=db.prepare('SELECT id,firmId,name,createdAt,updatedAt,isActive FROM item_companies WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY name COLLATE NOCASE').all(firmId); res.json({success:true,data}); } catch(e:any){res.status(500).json({ error: 'An unexpected error occurred. Please try again or contact B-MAX support.', code: 'INTERNAL_ERROR' });} });

router.post('/', (req: Request,res: Response)=>{
  try {
    ensureItemCompanyTable();
    const firmId=String(req.body?.firmId||'').trim();
    const name=String(req.body?.name||'').trim();
    if(!firmId||!name)return res.status(400).json({success:false,error:'firmId and company name are required',code:'COMPANY_FIELDS_REQUIRED'});
    if(!db.prepare('SELECT id FROM firms WHERE id=?').get(firmId)) return res.status(404).json({success:false,error:'Company owner firm not found',code:'FIRM_NOT_FOUND'});
    const duplicate=db.prepare('SELECT id,isActive FROM item_companies WHERE firmId=? AND lower(name)=lower(?) LIMIT 1').get(firmId,name) as any;
    const now=new Date().toISOString();
    if(duplicate && Number(duplicate.isActive||0)===1)return res.status(409).json({success:false,error:'Company already exists for this firm',code:'ITEM_COMPANY_EXISTS',data:{id:duplicate.id}});
    if(duplicate) {
      db.prepare('UPDATE item_companies SET isActive=1,updatedAt=? WHERE id=? AND firmId=?').run(now,duplicate.id,firmId);
      const restored=db.prepare('SELECT * FROM item_companies WHERE id=?').get(duplicate.id);
      return res.status(200).json({success:true,data:restored,restored:true});
    }
    const id=uuidv4();
    db.prepare('INSERT INTO item_companies(id,firmId,name,createdAt,updatedAt,isActive) VALUES(?,?,?,?,?,1)').run(id,firmId,name,now,now);
    const row=db.prepare('SELECT * FROM item_companies WHERE id=?').get(id);
    res.status(201).json({success:true,data:row});
  } catch(e:any){
    console.error('[item-companies] create failed:',e?.message||e);
    res.status(500).json({success:false,error:'An unexpected error occurred. Please try again or contact B-MAX support.',code:'ITEM_COMPANY_CREATE_FAILED'});
  }
});
export default router;
