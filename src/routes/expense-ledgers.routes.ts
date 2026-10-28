import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';

const router = Router();
const DIRECT_GROUP = 'Direct Expenses';
const EXPENSE_GROUPS = new Set(['Direct Expenses','Indirect Expenses']);
const normalizeGroup = (v:any) => EXPENSE_GROUPS.has(String(v||'')) ? String(v) : DIRECT_GROUP;

router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const rows = db.prepare(`SELECT id,firmId,name,type,accountGroup,accountNature,isSystemLedger,createdAt,updatedAt
      FROM categories WHERE firmId=? AND type='expense' ORDER BY name COLLATE NOCASE`).all(String(firmId));
    res.json({ success: true, data: rows.map((r:any)=>({ ...r, accountGroup: r.accountGroup || DIRECT_GROUP, accountNature: r.accountNature || 'expense' })) });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const firmId=String(req.body?.firmId||'').trim();
    const name=String(req.body?.name||'').trim();
    const accountGroup=normalizeGroup(req.body?.accountGroup);
    if (!firmId || !name) return res.status(400).json({ error:'firmId and expense type name are required' });
    const duplicate=db.prepare('SELECT id FROM categories WHERE firmId=? AND type=\'expense\' AND LOWER(name)=LOWER(?) LIMIT 1').get(firmId,name);
    if (duplicate) return res.status(409).json({ error:'Expense type already exists', data: duplicate });
    const now=new Date().toISOString(), id=uuidv4();
    db.prepare(`INSERT INTO categories (id,firmId,name,type,accountGroup,accountNature,isSystemLedger,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id,firmId,name,'expense',accountGroup,'expense',0,now,now);
    const row=db.prepare('SELECT id,firmId,name,type,accountGroup,accountNature,isSystemLedger,createdAt,updatedAt FROM categories WHERE id=?').get(id) as any;
    res.status(201).json({ success:true, data:row });
  } catch(err:any){ res.status(500).json({error:err.message}); }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const firmId=String(req.body?.firmId||'').trim();
    const name=String(req.body?.name||'').trim();
    const accountGroup=normalizeGroup(req.body?.accountGroup);
    if(!firmId || !name) return res.status(400).json({error:'firmId and expense type name are required'});
    const dup=db.prepare(`SELECT id FROM categories WHERE firmId=? AND type='expense' AND LOWER(name)=LOWER(?) AND id<>? LIMIT 1`).get(firmId,name,req.params.id);
    if(dup) return res.status(409).json({error:'Expense type already exists',data:dup});
    const r=db.prepare(`UPDATE categories SET name=?,accountGroup=?,accountNature='expense',updatedAt=? WHERE id=? AND firmId=? AND type='expense'`).run(name,accountGroup,new Date().toISOString(),req.params.id,firmId);
    if(!r.changes) return res.status(404).json({error:'Expense ledger not found'});
    const row=db.prepare('SELECT id,firmId,name,type,accountGroup,accountNature,isSystemLedger,createdAt,updatedAt FROM categories WHERE id=?').get(req.params.id);
    res.json({success:true,data:row});
  } catch(err:any){res.status(500).json({error:err.message});}
});

export default router;



