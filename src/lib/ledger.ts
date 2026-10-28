import { db } from './db';

/** Recompute a document's paidAmount/balanceAmount/status from its allocations. */
export function recalcDocumentStatus(documentId: string, now: string) {
  const doc = db.prepare('SELECT id, total, status FROM documents WHERE id = ?').get(documentId) as any;
  if (!doc) return;
  const allocated = (db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM payment_allocations WHERE documentId = ?').get(documentId) as any)?.total || 0;
  const total = doc.total || 0;
  const balance = +(total - allocated).toFixed(2);
  let status = doc.status;
  if (status !== 'cancelled' && status !== 'draft') {
    if (allocated <= 0) status = 'unpaid';
    else if (balance > 0.004) status = 'partially_paid';
    else status = 'paid';
  }
  db.prepare('UPDATE documents SET paidAmount = ?, balanceAmount = ?, status = ?, updatedAt = ? WHERE id = ?')
    .run(+allocated.toFixed(2), balance, status, now, documentId);
}

/** Apply a cash/bank movement. direction: +1 increases the balance, -1 decreases it. */
export function applyFunds(firmId: string, paymentMethod: string, bankId: string | null | undefined, amount: number, direction: 1 | -1, now: string) {
  if (paymentMethod === 'bank' && bankId) {
    db.prepare('UPDATE bank_accounts SET currentBalance = currentBalance + ?, updatedAt = ? WHERE id = ?').run(direction * amount, now, bankId);
  } else {
    db.prepare('UPDATE firms SET cashInHand = cashInHand + ?, updatedAt = ? WHERE id = ?').run(direction * amount, now, firmId);
  }
}



