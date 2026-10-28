import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();

function ensureItemCompanyTable(){
  db.exec(`CREATE TABLE IF NOT EXISTS item_companies (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_item_companies_firm_name ON item_companies(firmId,name COLLATE NOCASE)');
}

router.get('/', (req: Request,res: Response)=>{ try { ensureItemCompanyTable(); const firmId=String(req.query.firmId||'').trim(); if(!firmId)return res.status(400).json({error:'firmId required'}); const data=db.prepare('SELECT id,firmId,name,createdAt,updatedAt FROM item_companies WHERE firmId=? ORDER BY name COLLATE NOCASE').all(firmId); res.json({success:true,data}); } catch(e:any){res.status(500).json({error:e.message});} });

router.post('/', (req: Request,res: Response)=>{
  try {
    ensureItemCompanyTable();
    const firmId=String(req.body?.firmId||'').trim();
    const name=String(req.body?.name||'').trim();
    if(!firmId||!name)return res.status(400).json({success:false,error:'firmId and company name are required',code:'COMPANY_FIELDS_REQUIRED'});
    if(!db.prepare('SELECT id FROM firms WHERE id=?').get(firmId)) return res.status(404).json({success:false,error:'Company owner firm not found',code:'FIRM_NOT_FOUND'});
    const duplicate=db.prepare('SELECT id FROM item_companies WHERE firmId=? AND lower(name)=lower(?) LIMIT 1').get(firmId,name) as any;
    if(duplicate)return res.status(409).json({success:false,error:'Company already exists for this firm',code:'ITEM_COMPANY_EXISTS',data:{id:duplicate.id}});
    const now=new Date().toISOString(),id=uuidv4();
    db.prepare('INSERT INTO item_companies(id,firmId,name,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(id,firmId,name,now,now);
    const row=db.prepare('SELECT * FROM item_companies WHERE id=?').get(id);
    res.status(201).json({success:true,data:row});
  } catch(e:any){
    console.error('[item-companies] create failed:',e?.message||e);
    res.status(500).json({success:false,error:e?.message||'Unable to create item company',code:'ITEM_COMPANY_CREATE_FAILED'});
  }
});
export default router;
