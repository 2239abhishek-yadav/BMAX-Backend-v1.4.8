import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { validateGSTIN } from '../lib/validators';

const router = Router();
router.get('/', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    if (!firmId) return res.status(400).json({ error: 'firmId is required' });
    const rows = db.prepare('SELECT * FROM gst_registrations WHERE firmId=? ORDER BY isPrimary DESC, createdAt ASC').all(firmId);
    res.json({ success:true, data:rows });
  } catch (e:any) { res.status(500).json({error:e.message}); }
});
router.post('/', (req: Request, res: Response) => {
  try {
    const { firmId, gstin, legalName, tradeName, state, stateCode, address, pincode, isPrimary } = req.body || {};
    if (!firmId || !gstin) return res.status(400).json({error:'firmId and gstin are required'});
    const check = validateGSTIN(gstin);
    if (!check.valid) return res.status(400).json({error:check.error});
    const id=uuidv4(), now=new Date().toISOString();
    const tx=db.transaction(()=>{
      if (isPrimary) db.prepare('UPDATE gst_registrations SET isPrimary=0 WHERE firmId=?').run(firmId);
      db.prepare(`INSERT INTO gst_registrations (id,firmId,gstin,legalName,tradeName,state,stateCode,address,pincode,isPrimary,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`)
        .run(id,firmId,check.value,legalName||null,tradeName||null,state||null,stateCode||null,address||null,pincode||null,isPrimary?1:0,now,now);
    });
    tx();
    res.status(201).json({success:true,data:db.prepare('SELECT * FROM gst_registrations WHERE id=?').get(id)});
  } catch(e:any){ res.status(500).json({error:e.message}); }
});
router.put('/:id', (req:Request,res:Response)=>{
  try { const {gstin,legalName,tradeName,state,stateCode,address,pincode,isPrimary,isActive,firmId}=req.body||{}; const row=db.prepare('SELECT * FROM gst_registrations WHERE id=?').get(req.params.id) as any; if(!row)return res.status(404).json({error:'GST registration not found'}); const check=validateGSTIN(gstin||row.gstin); if(!check.valid)return res.status(400).json({error:check.error}); const now=new Date().toISOString(); const tx=db.transaction(()=>{if(isPrimary)db.prepare('UPDATE gst_registrations SET isPrimary=0 WHERE firmId=?').run(firmId||row.firmId); db.prepare('UPDATE gst_registrations SET gstin=?,legalName=?,tradeName=?,state=?,stateCode=?,address=?,pincode=?,isPrimary=?,isActive=?,updatedAt=? WHERE id=?').run(check.value,legalName??row.legalName,tradeName??row.tradeName,state??row.state,stateCode??row.stateCode,address??row.address,pincode??row.pincode,isPrimary?1:0,isActive===undefined?row.isActive:(isActive?1:0),now,req.params.id);}); tx(); res.json({success:true,data:db.prepare('SELECT * FROM gst_registrations WHERE id=?').get(req.params.id)}); } catch(e:any){res.status(500).json({error:e.message});}
});
router.delete('/:id',(req:Request,res:Response)=>{try{db.prepare('DELETE FROM gst_registrations WHERE id=?').run(req.params.id);res.json({success:true});}catch(e:any){res.status(500).json({error:e.message});}});
export default router;



