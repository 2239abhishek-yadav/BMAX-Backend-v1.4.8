import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { getSubscriptionAccess } from '../lib/subscription';
import { planTier } from '../lib/plan-entitlements';
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
    // Starter keeps all secondary-store records intact but exposes only the
    // primary Main Store in the app. Upgrading restores access to other stores.
    const subscription = getSubscriptionAccess().state;
    if (planTier(subscription?.planCode, subscription?.status) === 1 && data.length > 1) {
      const primary = data.find((g:any) => String(g.name||'').trim().toLowerCase() === 'main store')
        || data.find((g:any) => Number(g.isDefault) === 1)
        || data[0];
      data = primary ? [primary] : [];
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
    const activeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1').get(firmId) as any)?.count || 0);
    const subscription = getSubscriptionAccess().state;
    const tier = planTier(subscription?.planCode, subscription?.status);
    if (tier === 1 && activeCount >= 1) return res.status(403).json({ success:false, code:'STARTER_SINGLE_STORE_LIMIT', error:'Starter plan includes one Main Store. Upgrade to Business to add more stores.' });
    const storeName = activeCount === 0 ? 'Main Store' : String(name).trim();
    const makeDefault = activeCount === 0 ? 1 : (isDefault ? 1 : 0);
    if (phone && !/^[6-9]\d{9}$/.test(String(phone))) return res.status(400).json({ error:'Phone number must be exactly 10 digits and start with 6-9' });
    const tx = db.transaction(() => {
      if (makeDefault) db.prepare('UPDATE godowns SET isDefault=0 WHERE firmId=?').run(firmId);
      db.prepare(`INSERT INTO godowns (id,firmId,name,address,contactPerson,phone,isDefault,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id,firmId,storeName,address||null,contactPerson||null,phone||null,makeDefault,1,now,now);
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
    const safeName = String(existing.name||'').trim().toLowerCase()==='main store' ? 'Main Store' : String(name).trim();
    const tx=db.transaction(()=>{
      if (isDefault) db.prepare('UPDATE godowns SET isDefault=0 WHERE firmId=?').run(firmId);
      db.prepare('UPDATE godowns SET name=?,address=?,contactPerson=?,phone=?,isDefault=?,updatedAt=? WHERE id=? AND firmId=?')
        .run(safeName,address||null,contactPerson||null,phone||null,isDefault?1:0,new Date().toISOString(),req.params.id,firmId);
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
    const activeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1').get(firmId) as any)?.count || 0);
    if (String(row.name||'').trim().toLowerCase()==='main store' || activeCount <= 1) return res.status(409).json({success:false,code:'MAIN_STORE_REQUIRED',error:'Main Store is required and cannot be deleted.'});
    const stock:any=db.prepare('SELECT COALESCE(SUM(ABS(quantity)),0) AS qty FROM inventory_stock WHERE firmId=? AND godownId=?').get(firmId,req.params.id);
    if(Number(stock?.qty||0)>0) return res.status(409).json({error:'This store has stock. Transfer/clear its stock before deleting the store.'});
    db.prepare('UPDATE godowns SET isActive=0,isDefault=0,updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),req.params.id,firmId);
    res.json({success:true});
  } catch(err:any){res.status(500).json({error:err.message});}
});

export default router;



