import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { recalcDocumentStatus, applyFunds } from '../lib/ledger';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, type, partyId } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    let q = 'SELECT * FROM payments WHERE firmId = ? AND COALESCE(isDeleted,0) = 0';
    const p: any[] = [firmId];
    if (type) { q += ' AND type = ?'; p.push(type); }
    if (partyId) { q += ' AND partyId = ?'; p.push(partyId); }
    q += ' ORDER BY paymentDate DESC';
    const payments = db.prepare(q).all(p) as any[];
    const allocStmt = db.prepare('SELECT documentId, amount FROM payment_allocations WHERE paymentId = ?');
    for (const pay of payments) {
      pay.allocations = allocStmt.all(pay.id);
      const allocationRows = pay.allocations as any[];
      pay.linkedDocumentNumbers = allocationRows
        .map((a:any) => (db.prepare('SELECT documentNumber FROM documents WHERE id = ? AND firmId = ?').get(a.documentId, firmId) as any)?.documentNumber)
        .filter(Boolean);
      if (pay.linkedDocumentId) {
        pay.linkedDocumentNumber = (db.prepare('SELECT documentNumber FROM documents WHERE id = ? AND firmId = ?').get(pay.linkedDocumentId, firmId) as any)?.documentNumber || null;
      }
    }
    res.json({ success: true, data: payments });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Unpaid/partially-paid bills for a party, to drive bill-wise Payment Out / Receipt selection.
router.get('/unpaid-bills', (req: Request, res: Response) => {
  try {
    const { firmId, partyId, partyType } = req.query;
    if (!firmId || !partyId) return res.status(400).json({ error: 'firmId and partyId required' });
    const documentType = partyType === 'supplier' ? 'purchase_invoice' : 'sale_invoice';
    const bills = db.prepare(
      `SELECT id, documentNumber, documentDate, total, paidAmount, balanceAmount, status
       FROM documents
       WHERE firmId = ? AND partyId = ? AND documentType = ? AND isDeleted = 0
         AND status NOT IN ('paid', 'cancelled', 'draft')
       ORDER BY documentDate ASC`
    ).all(firmId, partyId, documentType);
    res.json({ success: true, data: bills });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Recycle Bin: soft-deleted payment transactions
router.get('/recycle-bin', (req: Request, res: Response) => {
  try {
    const { firmId, search } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    let q = `SELECT * FROM payments WHERE firmId=? AND COALESCE(isDeleted,0)=1`;
    const params: any[] = [firmId];
    if (search) { q += ` AND (partyName LIKE ? OR receiptNumber LIKE ? OR type LIKE ?)`; const x=`%${search}%`; params.push(x,x,x); }
    q += ' ORDER BY updatedAt DESC, paymentDate DESC';
    res.json({success:true,data:db.prepare(q).all(params)});
  } catch (err:any) { res.status(500).json({error:err.message}); }
});

router.patch('/:id/trash', (req: Request, res: Response) => {
  try {
    const r=db.prepare('UPDATE payments SET isDeleted=1, updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),req.params.id,req.body?.firmId || '');
    if (!r.changes) return res.status(404).json({error:'Payment not found'});
    res.json({success:true,message:'Payment moved to trash'});
  } catch(err:any){res.status(500).json({error:err.message});}
});

router.patch('/:id/restore', (req: Request, res: Response) => {
  try {
    const now=new Date().toISOString();
    const payment=db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id) as any;
    if(!payment) return res.status(404).json({error:'Payment not found'});
    if(Number(payment.isDeleted||0)!==1) return res.json({success:true,data:payment});
    const run=db.transaction(()=>{
      db.prepare('UPDATE payments SET isDeleted=0, updatedAt=? WHERE id=?').run(now,req.params.id);
      const allocs=db.prepare('SELECT documentId FROM payment_allocations WHERE paymentId=?').all(req.params.id) as any[];
      for(const a of allocs) recalcDocumentStatus(a.documentId,now);
      applyFunds(payment.firmId,payment.paymentMethod,payment.bankId,payment.amount,payment.type==='payment_in'?1:-1,now);
    });
    run();
    res.json({success:true,data:db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id)});
  } catch(err:any){res.status(500).json({error:err.message});}
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id) as any;
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    p.allocations = db.prepare('SELECT documentId, amount FROM payment_allocations WHERE paymentId = ?').all(p.id);
    p.linkedDocumentNumbers = (p.allocations as any[])
      .map((a:any) => (db.prepare('SELECT documentNumber FROM documents WHERE id = ? AND firmId = ?').get(a.documentId, p.firmId) as any)?.documentNumber)
      .filter(Boolean);
    if (p.linkedDocumentId) {
      p.linkedDocumentNumber = (db.prepare('SELECT documentNumber FROM documents WHERE id = ? AND firmId = ?').get(p.linkedDocumentId, p.firmId) as any)?.documentNumber || null;
    }
    res.json({ success: true, data: p });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Create a Payment In (Receipt) or Payment Out, optionally allocated bill-wise against
// one or more documents. Unallocated balance is treated as advance/unadjusted.

// POS payment replacement: keeps the previous confirmed payment in the recycle bin,
// reverses its cash/bank effect, and atomically posts the newly edited payment rows.
// POS payments are intentionally unallocated at this stage; the final invoice flow
// handles the bill reconciliation. This prevents duplicate ledger entries while still
// preserving the previous payment version for recovery.
router.post('/replace-pos', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const { firmId, oldPaymentIds = [], entries = [] } = req.body || {};
    if (!firmId || !Array.isArray(oldPaymentIds) || !oldPaymentIds.length || !Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ error: 'firmId, oldPaymentIds and entries are required' });
    }
    const oldPayments = oldPaymentIds.map((id:string) => db.prepare('SELECT * FROM payments WHERE id=? AND firmId=?').get(id, firmId) as any);
    if (oldPayments.some((p:any) => !p)) return res.status(404).json({ error: 'Previous POS payment not found' });
    if (oldPayments.some((p:any) => Number(p.isDeleted || 0) === 1)) return res.status(409).json({ error: 'A previous POS payment is already in the recycle bin' });
    for (const p of oldPayments) {
      const allocationCount = Number((db.prepare('SELECT COUNT(*) AS c FROM payment_allocations WHERE paymentId=?').get(p.id) as any)?.c || 0);
      if (allocationCount > 0 || p.linkedDocumentId) {
        return res.status(409).json({ error: 'This payment is already linked to a transaction and cannot be replaced from POS.' });
      }
    }
    const cleanEntries = entries.map((e:any) => ({
      type: 'payment_in', partyId: e.partyId || null, partyName: e.partyName,
      amount: Number(e.amount), paymentMethod: e.paymentMethod || 'cash', bankId: e.bankId || null,
      receiptNumber: e.receiptNumber || null, paymentDate: e.paymentDate || now.slice(0,10),
      reference: e.reference || 'POS Payment', description: e.description || 'POS payment collected before bill creation'
    }));
    if (cleanEntries.some((e:any) => !e.partyName || !Number.isFinite(e.amount) || e.amount <= 0 || !e.paymentDate)) {
      return res.status(400).json({ error: 'Invalid replacement payment' });
    }
    const created:any[] = [];
    const run = db.transaction(() => {
      for (const p of oldPayments) {
        applyFunds(firmId, p.paymentMethod, p.bankId, Number(p.amount) || 0, -1, now);
        db.prepare('UPDATE payments SET isDeleted=1, updatedAt=? WHERE id=? AND firmId=?').run(now, p.id, firmId);
      }
      const insert = db.prepare(`INSERT INTO payments (id, firmId, type, partyId, partyName, amount, paymentMethod, bankId,
          receiptNumber, paymentDate, reference, description, linkedDocumentId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of cleanEntries) {
        const id = uuidv4();
        insert.run(id, firmId, e.type, e.partyId, e.partyName, e.amount, e.paymentMethod, e.bankId,
          e.receiptNumber, e.paymentDate, e.reference, e.description, null, now, now);
        applyFunds(firmId, e.paymentMethod, e.bankId, e.amount, 1, now);
        created.push(db.prepare('SELECT * FROM payments WHERE id=?').get(id));
      }
    });
    run();
    res.json({ success: true, data: created });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const id = uuidv4();
    const {
      firmId, type, partyId, partyName, amount, paymentMethod = 'cash', bankId,
      receiptNumber, paymentDate, reference, description, allocations = []
    } = req.body;
    if (!firmId || !type || !partyName || !amount || !paymentDate) {
      return res.status(400).json({ error: 'Required fields missing' });
    }
    if (type !== 'payment_in' && type !== 'payment_out') {
      return res.status(400).json({ error: 'Payment type must be payment_in or payment_out' });
    }
    const paymentAmount = parseFloat(amount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ error: 'Payment amount must be greater than zero' });
    }

    // POS confirmation is idempotent by session reference. A rapid double-click or
    // repeated request must never create a second cash/bank movement.
    const posReference = String(reference || '');
    if (posReference.startsWith('POS Payment:') && partyId) {
      const existing:any = db.prepare(`SELECT * FROM payments WHERE firmId=? AND partyId=? AND reference=? AND type=? AND isDeleted=0 ORDER BY createdAt DESC LIMIT 1`).get(firmId, partyId, posReference, type);
      if (existing) {
        existing.allocations = db.prepare('SELECT documentId, amount FROM payment_allocations WHERE paymentId=?').all(existing.id);
        return res.status(200).json({ success:true, data:existing, idempotent:true });
      }
    }

    // Bill-wise reconciliation is automatic by default. Payment In is matched
    // FIFO against the party's oldest open sales invoices; Payment Out is matched
    // FIFO against the oldest open purchase invoices. Any remainder stays as an
    // unallocated advance, exactly as it would when the user intentionally pays
    // more than the current outstanding bills. Explicit allocations are still
    // respected for future advanced workflows, but normal UI entry needs none.
    let effectiveAllocations = Array.isArray(allocations) ? allocations : [];
    if (effectiveAllocations.length === 0 && partyId) {
      const documentType = type === 'payment_out' ? 'purchase_invoice' : 'sale_invoice';
      const openBills = db.prepare(
        `SELECT id, balanceAmount FROM documents
         WHERE firmId = ? AND partyId = ? AND documentType = ? AND isDeleted = 0
           AND status NOT IN ('paid','cancelled','draft') AND balanceAmount > 0
         ORDER BY documentDate ASC, createdAt ASC`
      ).all(firmId, partyId, documentType) as any[];
      let remaining = paymentAmount;
      effectiveAllocations = [];
      for (const bill of openBills) {
        if (remaining <= 0.004) break;
        const take = Math.min(Number(bill.balanceAmount) || 0, remaining);
        if (take > 0) {
          effectiveAllocations.push({ documentId: bill.id, amount: +take.toFixed(2) });
          remaining = +(remaining - take).toFixed(2);
        }
      }
    }

    const allocTotal = effectiveAllocations.reduce((s: number, a: any) => s + (parseFloat(a.amount) || 0), 0);
    if (allocTotal - paymentAmount > 0.004) {
      return res.status(400).json({ error: 'Allocated amount cannot exceed payment amount' });
    }

    const run = db.transaction(() => {
      db.prepare(`INSERT INTO payments (id, firmId, type, partyId, partyName, amount, paymentMethod, bankId,
          receiptNumber, paymentDate, reference, description, linkedDocumentId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, firmId, type, partyId, partyName, paymentAmount, paymentMethod, bankId, receiptNumber, paymentDate,
          reference, description, effectiveAllocations[0]?.documentId || null, now, now);

      const insertAlloc = db.prepare('INSERT INTO payment_allocations (id, firmId, paymentId, documentId, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
      for (const a of effectiveAllocations) {
        const allocAmt = parseFloat(a.amount) || 0;
        if (allocAmt <= 0) continue;
        insertAlloc.run(uuidv4(), firmId, id, a.documentId, allocAmt, now);
        recalcDocumentStatus(a.documentId, now);
      }

      // payment_in (Receipt) increases cash/bank; payment_out decreases it.
      applyFunds(firmId, paymentMethod, bankId, paymentAmount, type === 'payment_in' ? 1 : -1, now);
    });
    run();

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as any;
    payment.allocations = db.prepare('SELECT documentId, amount FROM payment_allocations WHERE paymentId = ?').all(id);
    res.status(201).json({ success: true, data: payment });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Non-financial edit only (financial fields are immutable — delete and re-create to change amount/allocations,
// so cash/bank and bill balances never drift out of sync).
router.put('/:id', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const { partyId, partyName, receiptNumber, paymentDate, reference, description } = req.body;
    db.prepare('UPDATE payments SET partyId=?, partyName=?, receiptNumber=?, paymentDate=?, reference=?, description=?, updatedAt=? WHERE id=?')
      .run(partyId, partyName, receiptNumber, paymentDate, reference, description, now, req.params.id);
    res.json({ success: true, data: db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id) as any;
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (Number(payment.isDeleted || 0) === 1) return res.json({ success: true, message: 'Payment already in recycle bin' });

    const run = db.transaction(() => {
      const allocs = db.prepare('SELECT documentId FROM payment_allocations WHERE paymentId = ?').all(req.params.id) as any[];
      // Reverse cash/bank movement and soft-delete first. Recalculate linked bills
      // only after deletion so the removed allocation is no longer counted.
      applyFunds(payment.firmId, payment.paymentMethod, payment.bankId, payment.amount, payment.type === 'payment_in' ? -1 : 1, now);
      db.prepare('UPDATE payments SET isDeleted=1, updatedAt=? WHERE id=?').run(now, req.params.id);
      for (const a of allocs) recalcDocumentStatus(a.documentId, now);
    });
    run();

    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;



