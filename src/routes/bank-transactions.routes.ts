import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, accountId } = req.query;
    if (!firmId || !accountId) return res.status(400).json({ error: 'firmId and accountId are required' });
    const account = db.prepare('SELECT id FROM bank_accounts WHERE id = ? AND firmId = ? AND isActive = 1').get(String(accountId), String(firmId));
    if (!account) return res.status(404).json({ error: 'Bank account not found' });
    const rows = db.prepare(`SELECT id, firmId, accountId, date, type, amount, description, reference, createdAt, updatedAt
      FROM bank_transactions WHERE firmId = ? AND accountId = ? ORDER BY date DESC, createdAt DESC`).all(String(firmId), String(accountId));
    res.json({ success: true, data: rows });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const { firmId, accountId, date, type = 'credit', amount, description = '', reference = '' } = req.body;
    const numericAmount = Number(amount);
    if (!firmId || !accountId || !date || !['credit','debit'].includes(type) || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'firmId, accountId, date, valid type and positive amount are required' });
    }
    const account = db.prepare('SELECT id FROM bank_accounts WHERE id = ? AND firmId = ? AND isActive = 1').get(accountId, firmId);
    if (!account) return res.status(404).json({ error: 'Bank account not found' });
    const now = new Date().toISOString();
    const id = uuidv4();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO bank_transactions (id, firmId, accountId, date, type, amount, description, reference, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, firmId, accountId, date, type, numericAmount, description, reference, now, now);
      const delta = type === 'credit' ? numericAmount : -numericAmount;
      db.prepare('UPDATE bank_accounts SET currentBalance = COALESCE(currentBalance, openingBalance, 0) + ?, updatedAt = ? WHERE id = ? AND firmId = ?').run(delta, now, accountId, firmId);
    });
    tx();
    res.status(201).json({ success: true, data: db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;



