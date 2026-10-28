import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();

function ensureCategoryTable(){
  db.exec(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL,
    type TEXT CHECK(type IN ('item','party','expense')) DEFAULT 'item',
    accountGroup TEXT, accountNature TEXT, isSystemLedger INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_categories_firm_type ON categories(firmId,type)');
}

router.get('/', (req: Request, res: Response) => { try { ensureCategoryTable(); const firmId=String(req.query.firmId||'').trim(); if(!firmId)return res.status(400).json({error:'firmId is required'}); const { type } = req.query; let q = 'SELECT * FROM categories WHERE firmId = ?'; const p: any[] = [firmId]; if (type) { q += ' AND type = ?'; p.push(String(type)); } q += ' ORDER BY name COLLATE NOCASE'; res.json({ success: true, data: db.prepare(q).all(p) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });

router.post('/', (req: Request, res: Response) => {
  try {
    ensureCategoryTable();
    const firmId=String(req.body?.firmId||'').trim();
    const name=String(req.body?.name||'').trim();
    const type=String(req.body?.type||'item').trim().toLowerCase();
    if(!firmId) return res.status(400).json({success:false,error:'firmId is required',code:'FIRM_ID_REQUIRED'});
    if(!name) return res.status(400).json({success:false,error:'Category name is required',code:'CATEGORY_NAME_REQUIRED'});
    if(!['item','party','expense'].includes(type)) return res.status(400).json({success:false,error:'Invalid category type',code:'INVALID_CATEGORY_TYPE'});
    if(!db.prepare('SELECT id FROM firms WHERE id=?').get(firmId)) return res.status(404).json({success:false,error:'Company not found',code:'FIRM_NOT_FOUND'});
    const duplicate=db.prepare('SELECT id FROM categories WHERE firmId=? AND type=? AND lower(name)=lower(?) LIMIT 1').get(firmId,type,name) as any;
    if(duplicate) return res.status(409).json({success:false,error:'Category already exists for this company',code:'CATEGORY_EXISTS',data:{id:duplicate.id}});
    const now=new Date().toISOString(),id=uuidv4();
    db.prepare('INSERT INTO categories (id,firmId,name,type,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(id,firmId,name,type,now,now);
    const row=db.prepare('SELECT * FROM categories WHERE id=?').get(id);
    res.status(201).json({success:true,data:row});
  } catch(err:any) {
    console.error('[categories] create failed:',err?.message||err);
    res.status(500).json({success:false,error:err?.message||'Unable to create category',code:'CATEGORY_CREATE_FAILED'});
  }
});

router.put('/:id', (req: Request, res: Response) => { try { ensureCategoryTable(); const { name } = req.body; db.prepare('UPDATE categories SET name=?, updatedAt=? WHERE id=?').run(String(name||'').trim(), new Date().toISOString(), req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.delete('/:id', (req: Request, res: Response) => { try { ensureCategoryTable(); db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
export default router;
