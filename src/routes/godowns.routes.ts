import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();

// Store/Godown master: location-wise stock is kept separately from the item master.
router.get('/', (req: Request, res: Response) => {
  try {
    const firmId=String(req.query.firmId||'');
    let data:any[] = db.prepare(`SELECT * FROM godowns WHERE firmId = ? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC, name`).all([firmId]) as any[];
    // A new firm should always have a usable billing location. Create Main Store
    // only when no active store exists; existing user-created stores are untouched.
    if (firmId && data.length===0) {
      const now=new Date().toISOString(), id=uuidv4();
      db.prepare(`INSERT INTO godowns (id,firmId,name,address,contactPerson,phone,isDefault,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id,firmId,'Main Store',null,null,null,1,1,now,now);
      data = db.prepare(`SELECT * FROM godowns WHERE firmId = ? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC, name`).all([firmId]) as any[];
    }
    res.json({ success: true, data });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/stock', (req: Request, res: Response) => {
  try {
    const data = db.prepare(`
      SELECT s.itemId, i.name AS itemName, COALESCE(u.shortName,u.name,'') AS unit, s.quantity, s.updatedAt
      FROM inventory_stock s
      JOIN items i ON i.id=s.itemId
      LEFT JOIN units u ON u.id=i.unitId
      WHERE s.firmId=? AND s.godownId=? AND i.isActive=1
      ORDER BY i.name
    `).all([req.query.firmId, req.params.id]);
    res.json({ success: true, data });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const id = uuidv4();
    const { firmId, name, address='', contactPerson='', phone='', isDefault=0 } = req.body;
    if (!firmId || !String(name || '').trim()) return res.status(400).json({ error:'Store name required' });
    if (phone && !/^[6-9]\d{9}$/.test(String(phone))) return res.status(400).json({ error:'Phone number must be exactly 10 digits and start with 6-9' });
    const tx = db.transaction(() => {
      if (isDefault) db.prepare('UPDATE godowns SET isDefault=0 WHERE firmId=?').run(firmId);
      db.prepare(`INSERT INTO godowns (id,firmId,name,address,contactPerson,phone,isDefault,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id,firmId,String(name).trim(),address||null,contactPerson||null,phone||null,isDefault?1:0,1,now,now);
    });
    tx();
    res.status(201).json({ success:true, data: db.prepare('SELECT * FROM godowns WHERE id=?').get(id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const { firmId, name, address='', contactPerson='', phone='', isDefault=0 } = req.body;
    if (!String(name || '').trim()) return res.status(400).json({ error:'Store name required' });
    if (phone && !/^[6-9]\d{9}$/.test(String(phone))) return res.status(400).json({ error:'Phone number must be exactly 10 digits and start with 6-9' });
    const existing:any = db.prepare('SELECT * FROM godowns WHERE id=? AND firmId=?').get(req.params.id,firmId);
    if (!existing) return res.status(404).json({ error:'Store not found' });
    const tx=db.transaction(()=>{
      if (isDefault) db.prepare('UPDATE godowns SET isDefault=0 WHERE firmId=?').run(firmId);
      db.prepare('UPDATE godowns SET name=?,address=?,contactPerson=?,phone=?,isDefault=?,updatedAt=? WHERE id=? AND firmId=?')
        .run(String(name).trim(),address||null,contactPerson||null,phone||null,isDefault?1:0,new Date().toISOString(),req.params.id,firmId);
    }); tx();
    res.json({ success:true, data:db.prepare('SELECT * FROM godowns WHERE id=?').get(req.params.id) });
  } catch (err:any) { res.status(500).json({error:err.message}); }
});

router.post('/:id/default', (req: Request, res: Response) => {
  try {
    const { firmId }=req.body;
    const exists=db.prepare('SELECT id FROM godowns WHERE id=? AND firmId=? AND COALESCE(isActive,1)=1').get(req.params.id,firmId);
    if(!exists) return res.status(404).json({error:'Store not found'});
    const tx=db.transaction(()=>{ db.prepare('UPDATE godowns SET isDefault=0 WHERE firmId=?').run(firmId); db.prepare('UPDATE godowns SET isDefault=1,updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),req.params.id,firmId); }); tx();
    res.json({success:true});
  } catch(err:any){res.status(500).json({error:err.message});}
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const firmId=String(req.query.firmId||'');
    const row:any=db.prepare('SELECT * FROM godowns WHERE id=? AND firmId=?').get(req.params.id,firmId);
    if(!row) return res.status(404).json({error:'Store not found'});
    const stock:any=db.prepare('SELECT COALESCE(SUM(ABS(quantity)),0) AS qty FROM inventory_stock WHERE firmId=? AND godownId=?').get(firmId,req.params.id);
    if(Number(stock?.qty||0)>0) return res.status(409).json({error:'This store has stock. Transfer/clear its stock before deleting the store.'});
    db.prepare('UPDATE godowns SET isActive=0,isDefault=0,updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),req.params.id,firmId);
    res.json({success:true});
  } catch(err:any){res.status(500).json({error:err.message});}
});

export default router;



