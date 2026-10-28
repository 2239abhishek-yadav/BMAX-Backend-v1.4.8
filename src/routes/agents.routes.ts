import { validateMobile } from '../lib/validators';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();
router.get('/', (req: Request, res: Response) => { try { res.json({ success: true, data: db.prepare('SELECT * FROM agents WHERE firmId = ? AND isActive = 1 ORDER BY name').all([req.query.firmId]) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.post('/', (req: Request, res: Response) => { try { const now = new Date().toISOString(); const id = uuidv4(); const { firmId, name, phone, email, commissionRate = 0, commissionType = 'percentage' } = req.body; const phoneCheck=validateMobile(phone); if(!phoneCheck.valid)return res.status(400).json({error:phoneCheck.error}); db.prepare('INSERT INTO agents (id, firmId, name, phone, email, commissionRate, commissionType, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, firmId, name, phoneCheck.value, email, commissionRate, commissionType, now, now); res.status(201).json({ success: true, data: db.prepare('SELECT * FROM agents WHERE id = ?').get(id) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.put('/:id', (req: Request, res: Response) => { try { const { name, phone, email, commissionRate, commissionType, isActive } = req.body; const phoneCheck=validateMobile(phone); if(!phoneCheck.valid)return res.status(400).json({error:phoneCheck.error}); db.prepare('UPDATE agents SET name=?, phone=?, email=?, commissionRate=?, commissionType=?, isActive=?, updatedAt=? WHERE id=?').run(name, phoneCheck.value, email, commissionRate, commissionType, isActive ? 1 : 0, new Date().toISOString(), req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.delete('/:id', (req: Request, res: Response) => { try { db.prepare('UPDATE agents SET isActive = 0, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
export default router;



