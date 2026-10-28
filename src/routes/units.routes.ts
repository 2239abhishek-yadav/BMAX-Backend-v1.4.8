import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();
router.get('/', (req: Request, res: Response) => { try { res.json({ success: true, data: db.prepare('SELECT * FROM units WHERE firmId = ? ORDER BY name').all([req.query.firmId]) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.post('/', (req: Request, res: Response) => { try { const now = new Date().toISOString(); const id = uuidv4(); const { firmId, name, shortName } = req.body; db.prepare('INSERT INTO units (id, firmId, name, shortName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, firmId, name, shortName, now, now); res.status(201).json({ success: true, data: db.prepare('SELECT * FROM units WHERE id = ?').get(id) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.put('/:id', (req: Request, res: Response) => { try { const { name, shortName } = req.body; db.prepare('UPDATE units SET name=?, shortName=?, updatedAt=? WHERE id=?').run(name, shortName, new Date().toISOString(), req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.delete('/:id', (req: Request, res: Response) => { try { db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
export default router;



