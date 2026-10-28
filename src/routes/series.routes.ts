import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';

const router = Router();

const VALID_TYPES = [
  'sale_invoice', 'sale_order', 'sale_return', 'sale_quotation', 'delivery_challan',
  'purchase_invoice', 'purchase_order', 'purchase_return', 'expense'
];

// GET all series for a firm (optionally filtered by transactionType)
router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, transactionType } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    let q = 'SELECT * FROM series WHERE firmId = ?';
    const params: any[] = [firmId];
    if (transactionType) { q += ' AND transactionType = ?'; params.push(transactionType); }
    q += ' ORDER BY transactionType, isDefault DESC, name';
    res.json({ success: true, data: db.prepare(q).all(params) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET single series
router.get('/:id', (req: Request, res: Response) => {
  try {
    const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Series not found' });
    res.json({ success: true, data: s });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST create series
router.post('/', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const {
      firmId, name, prefix, transactionType,
      startingNumber = 1, numberLength = 4, financialYear,
      includeFinancialYearInNumber = false, resetYearly = false,
      isActive = true, isDefault = false
    } = req.body;

    if (!firmId || !name || !prefix || !transactionType) {
      return res.status(400).json({ error: 'firmId, name, prefix and transactionType are required' });
    }
    if (!VALID_TYPES.includes(transactionType)) {
      return res.status(400).json({ error: `transactionType must be one of: ${VALID_TYPES.join(', ')}` });
    }

    const id = uuidv4();

    const run = db.transaction(() => {
      // Only one default series per firm+transactionType — unset any existing default.
      if (isDefault) {
        db.prepare('UPDATE series SET isDefault = 0 WHERE firmId = ? AND transactionType = ?')
          .run(firmId, transactionType);
      }
      db.prepare(`
        INSERT INTO series (
          id, firmId, name, prefix, transactionType, startingNumber, currentNumber,
          numberLength, financialYear, includeFinancialYearInNumber, resetYearly,
          isActive, isDefault, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, firmId, name, prefix, transactionType,
        startingNumber, startingNumber, numberLength, financialYear || null,
        includeFinancialYearInNumber ? 1 : 0, resetYearly ? 1 : 0,
        isActive ? 1 : 0, isDefault ? 1 : 0, now, now
      );
    });
    run();

    res.status(201).json({ success: true, data: db.prepare('SELECT * FROM series WHERE id = ?').get(id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT update series (does NOT reset currentNumber unless explicitly provided —
// numbering continuity is preserved on edits like renaming or toggling active state)
router.put('/:id', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Series not found' });

    const {
      name = existing.name, prefix = existing.prefix,
      numberLength = existing.numberLength, financialYear = existing.financialYear,
      includeFinancialYearInNumber = !!existing.includeFinancialYearInNumber,
      resetYearly = !!existing.resetYearly,
      isActive = !!existing.isActive, isDefault = !!existing.isDefault,
      currentNumber
    } = req.body;

    const run = db.transaction(() => {
      if (isDefault && !existing.isDefault) {
        db.prepare('UPDATE series SET isDefault = 0 WHERE firmId = ? AND transactionType = ?')
          .run(existing.firmId, existing.transactionType);
      }
      db.prepare(`
        UPDATE series SET name=?, prefix=?, numberLength=?, financialYear=?,
          includeFinancialYearInNumber=?, resetYearly=?, isActive=?, isDefault=?,
          currentNumber=?, updatedAt=? WHERE id=?
      `).run(
        name, prefix, numberLength, financialYear || null,
        includeFinancialYearInNumber ? 1 : 0, resetYearly ? 1 : 0,
        isActive ? 1 : 0, isDefault ? 1 : 0,
        currentNumber !== undefined ? currentNumber : existing.currentNumber,
        now, req.params.id
      );
    });
    run();

    res.json({ success: true, data: db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE series (blocked if it has ever been used, to protect historical documents/reports —
// deactivate instead via PUT isActive:false)
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Series not found' });
    if (s.currentNumber > s.startingNumber) {
      return res.status(400).json({ error: 'Series has generated numbers already and cannot be deleted. Deactivate it instead.' });
    }
    db.prepare('DELETE FROM series WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Series deleted' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET preview of the next number WITHOUT consuming it (for showing in the form before save)
router.get('/:id/preview', (req: Request, res: Response) => {
  try {
    const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id) as any;
    if (!s) return res.status(404).json({ error: 'Series not found' });
    res.json({ success: true, data: formatSeriesNumber(s, s.currentNumber) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

function formatSeriesNumber(series: any, num: number): string {
  const padded = String(num).padStart(series.numberLength, '0');
  if (series.includeFinancialYearInNumber && series.financialYear) {
    return `${series.prefix}/${series.financialYear}/${padded}`;
  }
  return `${series.prefix}-${padded}`;
}

/**
 * Atomically generates + consumes the next number for a series.
 * Uses better-sqlite3's synchronous transaction, which holds SQLite's write
 * lock for the duration — this is what prevents two concurrent requests
 * (e.g. two users saving an invoice at the same instant) from ever getting
 * the same number, since better-sqlite3 executes fully synchronously and
 * serializes all writes to the single DB connection.
 *
 * Exported so documents.routes.ts can call it directly when a seriesId is
 * supplied on document creation.
 */
export function generateSeriesNumber(seriesId: string): { documentNumber: string; seriesId: string } {
  const txn = db.transaction(() => {
    const series = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId) as any;
    if (!series) throw new Error('Series not found');
    if (!series.isActive) throw new Error('Series is inactive');

    const numberToUse = series.currentNumber;
    db.prepare('UPDATE series SET currentNumber = currentNumber + 1, updatedAt = ? WHERE id = ?')
      .run(new Date().toISOString(), seriesId);

    return { documentNumber: formatSeriesNumber(series, numberToUse), seriesId };
  });
  return txn();
}

export default router;



