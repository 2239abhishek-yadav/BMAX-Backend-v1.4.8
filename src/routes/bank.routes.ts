import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
const router = Router();
router.get('/', (req: Request, res: Response) => { try { const { firmId } = req.query; res.json({ success: true, data: db.prepare('SELECT id, firmId, accountName AS name, accountName, bankName, accountNumber, ifscCode, branchName, openingBalance, currentBalance, upiId, isActive, createdAt, updatedAt FROM bank_accounts WHERE firmId = ? AND isActive = 1 ORDER BY accountName').all([firmId]) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.post('/', (req: Request, res: Response) => { try { const now = new Date().toISOString(); const id = uuidv4(); const { firmId, accountName = req.body.name, bankName, accountNumber, ifscCode, branchName, openingBalance = 0, upiId } = req.body; db.prepare('INSERT INTO bank_accounts (id, firmId, accountName, bankName, accountNumber, ifscCode, branchName, openingBalance, currentBalance, upiId, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, firmId, accountName, bankName, accountNumber, ifscCode, branchName, openingBalance, openingBalance, upiId, now, now); res.status(201).json({ success: true, data: db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.put('/:id', (req: Request, res: Response) => { try { const now = new Date().toISOString(); const { accountName, bankName, accountNumber, ifscCode, branchName, upiId, isActive } = req.body; db.prepare('UPDATE bank_accounts SET accountName=?, bankName=?, accountNumber=?, ifscCode=?, branchName=?, upiId=?, isActive=?, updatedAt=? WHERE id=?').run(accountName, bankName, accountNumber, ifscCode, branchName, upiId, isActive ? 1 : 0, now, req.params.id); res.json({ success: true, data: db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(req.params.id) }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
router.delete('/:id', (req: Request, res: Response) => { try { db.prepare('UPDATE bank_accounts SET isActive = 0, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), req.params.id); res.json({ success: true }); } catch (err: any) { res.status(500).json({ error: err.message }); } });
export default router;



