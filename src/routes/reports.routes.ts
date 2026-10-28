import { Router, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import { db } from '../lib/db';
import { computeGstr1, computeGstr3b, computeGstr2, computeGstReconciliation, computeGstr9, computeGstr4, computeCompositionReturns } from '../lib/gst';

const router = Router();

// Canonical item-movement classifier. This is lifecycle/velocity based, not a
// percentage split. Dashboard counts, drill-down and exports all call this
// same function so they cannot disagree.
//
// Rules:
//   < 7 days old                    -> Normal (new-item grace period)
//   7+ days + 3+ units sold / 7d   -> Fast Moving
//   7+ days + 1-2 units sold / 7d  -> Normal
//   7+ days + 0 units sold / 7d    -> Slow Moving
//   30+ days with 0 sales / 30d    -> Slow Moving / stale stock
export function classifyItemMovementRows(rows:any[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return rows.map((row:any) => {
    const created = row.createdAt ? new Date(String(row.createdAt)) : now;
    const createdStart = new Date(created.getFullYear(), created.getMonth(), created.getDate());
    const ageDays = Math.max(0, Math.floor((startOfToday.getTime()-createdStart.getTime())/86400000));
    const soldLast7Days = Math.max(0, Number(row.soldLast7Days||0));
    const soldLast30Days = Math.max(0, Number(row.soldLast30Days||0));
    let movementType:'item_fast'|'item_normal'|'item_slow';
    let movementReason:string;
    if (ageDays < 7) {
      movementType='item_normal';
      movementReason='New item: 7-day grace period';
    } else if (soldLast7Days >= 3) {
      movementType='item_fast';
      movementReason=`${soldLast7Days} units sold in the last 7 days`;
    } else if (soldLast7Days >= 1) {
      movementType='item_normal';
      movementReason=`${soldLast7Days} unit${soldLast7Days===1?'':'s'} sold in the last 7 days`;
    } else {
      movementType='item_slow';
      movementReason=ageDays >= 30 ? `No sales for ${ageDays} days; stale stock` : 'No sales in the last 7 days';
    }
    return {...row,soldLast7Days,soldLast30Days,ageDays,movementType,
      movementLabel:movementType==='item_fast'?'Fast Moving':movementType==='item_normal'?'Normal':'Slow Moving',
      movementReason,stale:ageDays>=30 && soldLast30Days<=0};
  });
}

function itemMovementClassification(firmId: string) {
  const rows = db.prepare(`
    SELECT i.id, i.name itemName, COALESCE(c.name,'') category, i.hsnCode,
           COALESCE(u.shortName,u.name,'') unit, i.currentStock, i.minStockLevel,
           i.createdAt,
           COALESCE(SUM(CASE
             WHEN d.documentType IN ('sale_invoice','sale_return')
               AND d.documentDate >= date('now','localtime','-29 day')
             THEN (CASE WHEN d.documentType='sale_return' THEN -1 ELSE 1 END) *
                  (COALESCE(di.baseQuantity,di.quantity,0)+COALESCE(di.freeQuantity,0))
             ELSE 0 END),0) soldLast30Days,
           COALESCE(SUM(CASE
             WHEN d.documentType IN ('sale_invoice','sale_return')
               AND d.documentDate >= date('now','localtime','-6 day')
             THEN (CASE WHEN d.documentType='sale_return' THEN -1 ELSE 1 END) *
                  (COALESCE(di.baseQuantity,di.quantity,0)+COALESCE(di.freeQuantity,0))
             ELSE 0 END),0) soldLast7Days
    FROM items i
    LEFT JOIN categories c ON c.id=i.categoryId
    LEFT JOIN units u ON u.id=i.unitId
    LEFT JOIN document_items di ON di.itemId=i.id
    LEFT JOIN documents d ON d.id=di.documentId
      AND d.firmId=i.firmId
      AND d.isDeleted=0
      AND d.status NOT IN ('hold','draft','cancelled')
      AND d.documentType IN ('sale_invoice','sale_return')
      AND d.documentDate >= date('now','localtime','-29 day')
    WHERE i.firmId=? AND i.type='PRODUCT' AND i.isActive=1
    GROUP BY i.id
  `).all(firmId) as any[];
  return classifyItemMovementRows(rows);
}

// Inventory-cost based profit: profit is earned against the cost of the actual
// quantity sold, not against the firm's entire purchase total.  We use a
// weighted-average purchase cost available as of each sale date, including
// opening stock as the initial cost basis. GST is excluded from revenue/cost.
function weightedCostAtSale(firmId: string, itemId: string, saleDate: string): number {
  const opening = db.prepare(`SELECT openingStock, purchasePrice FROM items WHERE id=? AND firmId=?`).get(itemId, firmId) as any;
  let qty = Number(opening?.openingStock || 0);
  let value = qty * Number(opening?.purchasePrice || 0);
  const rows = db.prepare(`
    SELECT d.documentType, di.quantity, di.baseQuantity, di.freeQuantity, di.price,
           di.discountPercentage, di.discountAmount, di.taxAmount, di.amount
    FROM document_items di
    JOIN documents d ON d.id=di.documentId
    WHERE d.firmId=? AND di.itemId=?
      AND d.documentDate <= ?
      AND d.isDeleted=0
      AND d.status NOT IN ('hold','draft','cancelled')
      AND d.documentType IN ('purchase_invoice','purchase_return')
    ORDER BY d.documentDate ASC, d.createdAt ASC
  `).all(firmId, itemId, saleDate) as any[];
  for (const r of rows) {
    const paidQty = Math.max(0, Number(r.baseQuantity || r.quantity || 0));
    if (paidQty <= 0) continue;
    const freeQty = Math.max(0, Number(r.freeQuantity || 0));
    const stockQty = r.documentType === 'purchase_invoice' ? paidQty + freeQty : paidQty;
    const lineGross = Number(r.price || 0) * paidQty;
    const disc = Math.min(lineGross, lineGross * (Number(r.discountPercentage || 0) / 100) + Number(r.discountAmount || 0));
    const lineNet = Math.max(0, lineGross - disc); // purchase cost before GST; free units add stock at zero incremental cost
    if (r.documentType === 'purchase_invoice') {
      qty += stockQty;
      value += lineNet;
    } else {
      qty = Math.max(0, qty - stockQty);
      value = Math.max(0, value - lineNet);
    }
  }
  return qty > 0 ? value / qty : Number(opening?.purchasePrice || 0);
}

function batchCostAtSale(firmId: string, itemId: string, batchId: string | null, batchNumber: string | null, saleDate: string): number | null {
  if (!batchId && !batchNumber) return null;
  const rows = db.prepare(`
    SELECT d.documentType, di.baseQuantity, di.quantity, di.freeQuantity, di.price,
           di.discountPercentage, di.discountAmount
    FROM document_items di
    JOIN documents d ON d.id=di.documentId
    WHERE d.firmId=? AND di.itemId=? AND d.documentDate <= ?
      AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled')
      AND d.documentType IN ('purchase_invoice','purchase_return')
      AND ((? IS NOT NULL AND di.batchId=?) OR (? IS NULL AND ? IS NOT NULL AND di.batchNumber=?))
    ORDER BY d.documentDate ASC, d.createdAt ASC
  `).all(firmId, itemId, saleDate, batchId, batchId, batchId, batchNumber, batchNumber) as any[];
  if (!rows.length) return null;
  let qty = 0, value = 0;
  for (const r of rows) {
    const paidQty = Math.max(0, Number(r.baseQuantity || r.quantity || 0));
    if (paidQty <= 0) continue;
    const freeQty = Math.max(0, Number(r.freeQuantity || 0));
    const stockQty = r.documentType === 'purchase_invoice' ? paidQty + freeQty : paidQty;
    const lineGross = Number(r.price || 0) * paidQty;
    const disc = Math.min(lineGross, lineGross * (Number(r.discountPercentage || 0) / 100) + Number(r.discountAmount || 0));
    const lineNet = Math.max(0, lineGross - disc);
    if (r.documentType === 'purchase_invoice') {
      qty += stockQty;
      value += lineNet;
    } else {
      qty = Math.max(0, qty - stockQty);
      value = Math.max(0, value - lineNet);
    }
  }
  return qty > 0 ? value / qty : null;
}

function costAtSale(firmId: string, itemId: string, batchId: string | null, batchNumber: string | null, saleDate: string): number {
  const batchCost = batchCostAtSale(firmId, itemId, batchId, batchNumber, saleDate);
  if (batchCost !== null) return batchCost;
  if (batchId) {
    const batch = db.prepare(`SELECT purchaseRate FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?`).get(batchId, firmId, itemId) as any;
    if (batch && Number.isFinite(Number(batch.purchaseRate))) return Number(batch.purchaseRate);
  }
  return weightedCostAtSale(firmId, itemId, saleDate);
}

function getGrossProfitRows(firmId: string, startDate?: string, endDate?: string) {
  const params:any[]=[firmId];
  let where=`d.firmId=? AND d.documentType IN ('sale_invoice','sale_return') AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled')`;
  if(startDate){where+=' AND d.documentDate>=?';params.push(startDate);}
  if(endDate){where+=' AND d.documentDate<=?';params.push(endDate);}
  return db.prepare(`SELECT d.id,d.documentType,d.documentDate,d.createdAt,d.documentNumber,d.partyName,d.total,d.discountAmount,
      di.itemId,di.batchId,di.batchNumber,di.name itemName,di.quantity,di.baseQuantity,di.freeQuantity,di.price,di.amount,di.taxAmount
    FROM document_items di JOIN documents d ON d.id=di.documentId
    WHERE ${where}
    ORDER BY d.documentDate ASC,d.createdAt ASC,di.id ASC`).all(...params) as any[];
}

function dashboardPreviousPeriod(startDate?: string, endDate?: string) {
  const fallback = new Date();
  const start = startDate || `${fallback.getFullYear()}-${String(fallback.getMonth()+1).padStart(2,'0')}-01`;
  const end = endDate || `${fallback.getFullYear()}-${String(fallback.getMonth()+1).padStart(2,'0')}-${String(new Date(fallback.getFullYear(), fallback.getMonth()+1, 0).getDate()).padStart(2,'0')}`;
  const startD = new Date(`${start}T00:00:00`);
  const endD = new Date(`${end}T00:00:00`);
  const span = Math.max(1, Math.floor((endD.getTime()-startD.getTime())/86400000)+1);
  const previousEnd = new Date(startD); previousEnd.setDate(previousEnd.getDate()-1);
  const previousStart = new Date(previousEnd); previousStart.setDate(previousStart.getDate()-(span-1));
  const fmtDate = (d:Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return { start:fmtDate(previousStart), end:fmtDate(previousEnd) };
}

function dashboardPercentChange(current:number, previous:number): number | null {
  const c=Number(current||0), p=Number(previous||0);
  if(Math.abs(p) < 0.000001) return Math.abs(c) < 0.000001 ? 0 : null;
  return Number((((c-p)/Math.abs(p))*100).toFixed(1));
}

function dashboardDate(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : fallback;
}

function dashboardDateRange(startDate?: unknown, endDate?: unknown) {
  const now = new Date();
  const fallbackStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const fallbackEnd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()).padStart(2,'0')}`;
  let start = dashboardDate(startDate, fallbackStart);
  let end = dashboardDate(endDate, fallbackEnd);
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

function calculatePeriodGrossProfit(firmId: string, startDate?: string, endDate?: string) {
  const rows=getGrossProfitRows(firmId,startDate,endDate);
  const bills: Record<string,any>={};
  for(const r of rows){
    const paidQty=Math.max(0,Number(r.baseQuantity||r.quantity||0));
    const freeQty=Math.max(0,Number(r.freeQuantity||0));
    const qty=paidQty+freeQty;
    const revenue=Math.max(0,Number(r.amount||0)-Number(r.taxAmount||0));
    // Free/scheme quantity adds stock but carries no incremental purchase value.
    const costRate=costAtSale(firmId,String(r.itemId||''),r.batchId?String(r.batchId):null,r.batchNumber?String(r.batchNumber):null,String(r.documentDate||''));
    const cost=paidQty*costRate;
    const lineProfit=revenue-cost;
    const sign=r.documentType==='sale_invoice'?1:-1;
    const bill=bills[r.id] ||= {revenue:0,costOfGoodsSold:0,profitBeforeDiscount:0,discount:0,documentType:r.documentType};
    bill.revenue += sign*revenue;
    bill.costOfGoodsSold += sign*cost;
    bill.profitBeforeDiscount += sign*lineProfit;
    bill.discount=Number(r.discountAmount||bill.discount||0);
  }
  return Object.values(bills).reduce((sum:any,b:any)=>sum + Number(b.profitBeforeDiscount||0) - (b.documentType==='sale_invoice'?Number(b.discount||0):-Number(b.discount||0)),0);
}

// Dashboard summary
router.get('/dashboard', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const range = dashboardDateRange(startDate, endDate);
    const start = range.start;
    const end = range.end;
    const documentStatusFilter = `isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`;

    const salesTotal = db.prepare(`SELECT COALESCE(SUM(total),0) as total, COUNT(*) as count
      FROM documents WHERE firmId=? AND documentType='sale_invoice' AND ${documentStatusFilter}
      AND documentDate BETWEEN ? AND ?`).get(firmId, start, end) as any;
    const purchasesTotal = db.prepare(`SELECT COALESCE(SUM(total),0) as total, COUNT(*) as count
      FROM documents WHERE firmId=? AND documentType='purchase_invoice' AND ${documentStatusFilter}
      AND documentDate BETWEEN ? AND ?`).get(firmId, start, end) as any;
    const expensesTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) as total
      FROM expenses WHERE firmId=? AND date BETWEEN ? AND ?`).get(firmId, start, end) as any;
    // Operational receivables/payables are point-in-time balances, not period totals.
    // A bill remains outstanding until its live balance reaches zero, regardless of
    // the dashboard's sales/purchase date filter. This keeps Dashboard and
    // Outstanding Report aligned with the actual money still due.
    const outstandingReceivable = (db.prepare(`SELECT COALESCE(SUM(balanceAmount),0) as total FROM documents WHERE firmId=? AND partyType='customer' AND documentType='sale_invoice' AND balanceAmount>0 AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`).get(firmId) as any);
    const outstandingPayable = (db.prepare(`SELECT COALESCE(SUM(balanceAmount),0) as total FROM documents WHERE firmId=? AND partyType='supplier' AND documentType='purchase_invoice' AND balanceAmount>0 AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`).get(firmId) as any);
    // Invoice Summary buckets are deliberately separated so the dashboard never
    // shows a paid sales bill inside pending, or a customer receivable inside payables.
    const paidSalesSummary = db.prepare(`SELECT COALESCE(SUM(total),0) as total, COUNT(*) as count
      FROM documents WHERE firmId=? AND documentType='sale_invoice' AND paidAmount>0 AND balanceAmount<=0.01
      AND ${documentStatusFilter} AND documentDate BETWEEN ? AND ?`).get(firmId, start, end) as any;
    // Pending/overdue cards use the same live balance source as Outstanding.
    // The selected dashboard period affects sales/purchase activity, but must not
    // hide an older invoice that is still genuinely receivable/payable today.
    const pendingSalesSummary = (db.prepare(`SELECT COALESCE(SUM(balanceAmount),0) as balance, COUNT(*) as count FROM documents WHERE firmId=? AND documentType='sale_invoice' AND balanceAmount>0 AND (dueDate IS NULL OR dueDate='' OR dueDate >= date('now','localtime')) AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`).get(firmId) as any);
    const overduePendingSalesSummary = (db.prepare(`SELECT COALESCE(SUM(balanceAmount),0) as balance, COUNT(*) as count FROM documents WHERE firmId=? AND documentType='sale_invoice' AND balanceAmount>0 AND dueDate IS NOT NULL AND dueDate<>'' AND dueDate < date('now','localtime') AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`).get(firmId) as any);
    const payableSummary = (db.prepare(`SELECT COALESCE(SUM(balanceAmount),0) as balance, COUNT(*) as count FROM documents WHERE firmId=? AND documentType='purchase_invoice' AND balanceAmount>0 AND (dueDate IS NULL OR dueDate='' OR dueDate >= date('now','localtime')) AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`).get(firmId) as any);
    const overduePayableSummary = (db.prepare(`SELECT COALESCE(SUM(balanceAmount),0) as balance, COUNT(*) as count FROM documents WHERE firmId=? AND documentType='purchase_invoice' AND balanceAmount>0 AND dueDate IS NOT NULL AND dueDate<>'' AND dueDate < date('now','localtime') AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`).get(firmId) as any);
    const lowStockItems = (db.prepare(`SELECT COUNT(*) as count FROM items WHERE firmId=? AND type='PRODUCT' AND isActive=1 AND currentStock<=minStockLevel AND minStockLevel>0`).get(firmId) as any);
    const totalItems = (db.prepare(`SELECT COUNT(*) as count FROM items WHERE firmId=? AND isActive=1`).get(firmId) as any);
    const totalParties = (db.prepare(`SELECT COUNT(*) as count FROM parties WHERE firmId=? AND isActive=1`).get(firmId) as any);
    const firm = (db.prepare(`SELECT cashInHand FROM firms WHERE id=?`).get(firmId) as any);
    const bankTotal = (db.prepare(`SELECT COALESCE(SUM(currentBalance),0) as total FROM bank_accounts WHERE firmId=? AND isActive=1`).get(firmId) as any);
    const inventoryValue = (db.prepare(`SELECT COALESCE(SUM(currentStock * purchasePrice),0) as total FROM items WHERE firmId=? AND type='PRODUCT' AND isActive=1`).get(firmId) as any);
    const nowDate = new Date();
    const currentExpiryValue = nowDate.getFullYear()*12 + (nowDate.getMonth()+1);
    const nearExpiryValue = currentExpiryValue + 3;
    const expiryCounts = (db.prepare(`SELECT
      SUM(CASE WHEN expiryYear IS NOT NULL AND expiryMonth IS NOT NULL AND (expiryYear*12+expiryMonth) < ? AND quantity>0 THEN 1 ELSE 0 END) expired,
      SUM(CASE WHEN expiryYear IS NOT NULL AND expiryMonth IS NOT NULL AND (expiryYear*12+expiryMonth) >= ? AND (expiryYear*12+expiryMonth) <= ? AND quantity>0 THEN 1 ELSE 0 END) nearExpiry
      FROM inventory_batches WHERE firmId=?`).get(currentExpiryValue,currentExpiryValue,nearExpiryValue,firmId) as any) || {expired:0,nearExpiry:0};
    // KPI comparison: compare the selected period against the immediately preceding
    // period of the same length. This keeps the dashboard percentage tied to the
    // Period selector instead of using a static/mock value.
    const comparison = dashboardPreviousPeriod(String(startDate||''), String(endDate||''));
    const prevSales = (db.prepare(`SELECT COALESCE(SUM(total),0) as total FROM documents WHERE firmId=? AND documentType='sale_invoice' AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate BETWEEN ? AND ?`).get(firmId,comparison.start,comparison.end) as any);
    const prevPurchases = (db.prepare(`SELECT COALESCE(SUM(total),0) as total FROM documents WHERE firmId=? AND documentType='purchase_invoice' AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate BETWEEN ? AND ?`).get(firmId,comparison.start,comparison.end) as any);
    const prevExpenses = (db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE firmId=? AND date BETWEEN ? AND ?`).get(firmId,comparison.start,comparison.end) as any);
    const prevGrossProfit = calculatePeriodGrossProfit(String(firmId), comparison.start, comparison.end);

    // Item Summary is a live lifecycle/velocity classification. New imports stay
    // Normal for 7 days; mature items are classified from actual recent sales.
    const itemMovementRows = itemMovementClassification(String(firmId));
    const itemTotalCount=itemMovementRows.length;
    const fastCount=itemMovementRows.filter((x:any)=>x.movementType==='item_fast').length;
    const normalCount=itemMovementRows.filter((x:any)=>x.movementType==='item_normal').length;
    const slowCount=itemMovementRows.filter((x:any)=>x.movementType==='item_slow').length;
    const pct=(n:number)=>itemTotalCount?Number((n/itemTotalCount*100).toFixed(1)):0;
    const stockInCount=itemMovementRows.filter((x:any)=>Number(x.currentStock||0)>0 && !(Number(x.minStockLevel||0)>0 && Number(x.currentStock||0)<=Number(x.minStockLevel||0))).length;
    const stockLowCount=itemMovementRows.filter((x:any)=>Number(x.minStockLevel||0)>0 && Number(x.currentStock||0)>0 && Number(x.currentStock||0)<=Number(x.minStockLevel||0)).length;
    const stockOutCount=itemMovementRows.filter((x:any)=>Number(x.currentStock||0)<=0).length;

    const todaySales = (db.prepare(`SELECT COALESCE(SUM(total),0) as total FROM documents WHERE firmId=? AND documentType='sale_invoice' AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate = date('now','localtime')`).get(firmId) as any);
    const todayPurchases = (db.prepare(`SELECT COALESCE(SUM(total),0) as total FROM documents WHERE firmId=? AND documentType='purchase_invoice' AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate = date('now','localtime')`).get(firmId) as any);
    
    // Recent transactions
    const recentDocs = db.prepare(`SELECT id, documentNumber, documentType, partyName, total, documentDate FROM documents WHERE firmId=? AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') ORDER BY createdAt DESC LIMIT 5`).all(firmId);

    // Revenue Overview trend follows the dashboard Period selector exactly.
    // Short periods use daily buckets; longer periods use monthly buckets.
    // This keeps the graph useful for "This Month" while preserving the
    // monthly trend style for quarter / FY / 6-12 month periods.
    const pad2 = (n:number) => String(n).padStart(2, '0');
    const qStart = start;
    const qEnd = end;
    const startMs = Date.parse(`${qStart}T00:00:00`);
    const endMs = Date.parse(`${qEnd}T00:00:00`);
    const daySpan = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, Math.floor((endMs-startMs)/86400000)+1) : 31;
    const bucket = daySpan <= 31 ? 'day' : 'month';
    const bucketExpr = bucket === 'day' ? `strftime('%Y-%m-%d', documentDate)` : `strftime('%Y-%m', documentDate)`;
    const expenseDateExpr = bucket === 'day' ? `strftime('%Y-%m-%d', date)` : `strftime('%Y-%m', date)`;

    const trendSales = db.prepare(`
      SELECT ${bucketExpr} as bucket, SUM(total) as total
      FROM documents WHERE firmId=? AND documentType='sale_invoice' AND ${documentStatusFilter}
      AND documentDate BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket ASC
    `).all(firmId, qStart, qEnd);
    const trendPurchases = db.prepare(`
      SELECT ${bucketExpr} as bucket, SUM(total) as total
      FROM documents WHERE firmId=? AND documentType='purchase_invoice' AND ${documentStatusFilter}
      AND documentDate BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket ASC
    `).all(firmId, qStart, qEnd);
    const trendExpenses = db.prepare(`
      SELECT ${expenseDateExpr} as bucket, SUM(amount) as total
      FROM expenses WHERE firmId=? AND date BETWEEN ? AND ? GROUP BY bucket ORDER BY bucket ASC
    `).all(firmId, qStart, qEnd);

    const salesByBucket: Record<string, number> = {};
    const purchByBucket: Record<string, number> = {};
    const expByBucket: Record<string, number> = {};
    (trendSales as any[]).forEach(r => salesByBucket[r.bucket] = Number(r.total || 0));
    (trendPurchases as any[]).forEach(r => purchByBucket[r.bucket] = Number(r.total || 0));
    (trendExpenses as any[]).forEach(r => expByBucket[r.bucket] = Number(r.total || 0));

    const trendBuckets: string[] = [];
    if (bucket === 'day') {
      const d = new Date(`${qStart}T00:00:00`);
      const last = new Date(`${qEnd}T00:00:00`);
      while (d <= last) {
        trendBuckets.push(`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`);
        d.setDate(d.getDate()+1);
      }
    } else {
      const d = new Date(`${qStart.slice(0,7)}-01T00:00:00`);
      const last = new Date(`${qEnd.slice(0,7)}-01T00:00:00`);
      while (d <= last) {
        trendBuckets.push(`${d.getFullYear()}-${pad2(d.getMonth()+1)}`);
        d.setMonth(d.getMonth()+1);
      }
    }

    const monthlyTrends = trendBuckets.map(key => {
      const d = new Date(`${key}${bucket === 'day' ? 'T00:00:00' : '-01T00:00:00'}`);
      const sales = salesByBucket[key] || 0;
      const purchases = purchByBucket[key] || 0;
      const expenses = expByBucket[key] || 0;
      const bucketStart = bucket === 'day' ? key : `${key}-01`;
      const bucketEnd = bucket === 'day' ? key : (()=>{ const bd=new Date(`${key}-01T00:00:00`); bd.setMonth(bd.getMonth()+1); bd.setDate(0); return `${bd.getFullYear()}-${pad2(bd.getMonth()+1)}-${pad2(bd.getDate())}`; })();
      const grossProfit = calculatePeriodGrossProfit(String(firmId), bucketStart, bucketEnd);
      return {
        month: key,
        monthLabel: bucket === 'day'
          ? d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' })
          : d.toLocaleDateString('en-IN', { month:'short', year:'2-digit' }),
        sales,
        purchases,
        expenses,
        profit: grossProfit - expenses,
      };
    });
    const periodGrossProfit = calculatePeriodGrossProfit(String(firmId), qStart, qEnd);
    const periodProfit = periodGrossProfit - Number(expensesTotal?.total || 0);

    res.json({
      success: true,
      data: {
        sales: { total: salesTotal?.total || 0, count: salesTotal?.count || 0 },
        purchases: { total: purchasesTotal?.total || 0, count: purchasesTotal?.count || 0 },
        expenses: { total: expensesTotal?.total || 0 },
        outstanding: {
          receivable: outstandingReceivable?.total || 0,
          payable: outstandingPayable?.total || 0
        },
        invoiceSummary: {
          paidTotal: paidSalesSummary?.total || 0,
          paidCount: paidSalesSummary?.count || 0,
          pendingTotal: pendingSalesSummary?.balance || 0,
          pendingCount: pendingSalesSummary?.count || 0,
          overduePendingTotal: overduePendingSalesSummary?.balance || 0,
          overduePendingCount: overduePendingSalesSummary?.count || 0,
          payableTotal: payableSummary?.balance || 0,
          payableCount: payableSummary?.count || 0,
          overduePayableTotal: overduePayableSummary?.balance || 0,
          overduePayableCount: overduePayableSummary?.count || 0
        },
        stock: {
          inStock: stockInCount,
          lowStock: stockLowCount,
          outOfStock: stockOutCount,
          inventoryValue: inventoryValue?.total || 0,
          expiredBatches: Number(expiryCounts.expired||0),
          nearExpiryBatches: Number(expiryCounts.nearExpiry||0)
        },
        itemSummary: {
          totalItems: itemTotalCount,
          fastMoving: fastCount,
          normal: normalCount,
          slowMoving: slowCount,
          fastMovingPct: pct(fastCount),
          normalPct: pct(normalCount),
          slowMovingPct: pct(slowCount)
        },
        kpiComparison: {
          previousPeriod: comparison,
          salesPct: dashboardPercentChange(Number(salesTotal?.total||0),Number(prevSales?.total||0)),
          purchasesPct: dashboardPercentChange(Number(purchasesTotal?.total||0),Number(prevPurchases?.total||0)),
          grossProfitPct: dashboardPercentChange(Number(calculatePeriodGrossProfit(String(firmId),start,end)||0),Number(prevGrossProfit||0)),
          expensesPct: dashboardPercentChange(Number(expensesTotal?.total||0),Number(prevExpenses?.total||0))
        },
        totals: { items: totalItems?.count || 0, parties: totalParties?.count || 0 },
        cashInHand: firm?.cashInHand || 0,
        bankBalance: bankTotal?.total || 0,
        today: { sales: todaySales?.total || 0, purchases: todayPurchases?.total || 0 },
        recentDocs,
        monthlyTrends,
        grossProfit: periodGrossProfit,
        profit: periodProfit
      }
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Dashboard drill-down details. All values are scoped to the same firm and period
// selected on the dashboard so cards/charts and drill-downs stay in sync.
router.get('/dashboard-details', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, type, limit = '10' } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    if (!type) return res.status(400).json({ error: 'type required' });
    const start = String(startDate || '1900-01-01');
    const end = String(endDate || '2999-12-31');
    const lim = Math.min(1000, Math.max(1, Number(limit) || 1000));
    const active = `firmId=? AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate BETWEEN ? AND ?`;

    if (type === 'sales' || type === 'purchases') {
      const documentType = type === 'sales' ? 'sale_invoice' : 'purchase_invoice';
      const rows = db.prepare(`SELECT d.id, d.documentNumber, d.documentDate, d.partyId, d.partyName,
          COALESCE(p.phone,'') AS partyPhone, d.partyType, d.total, d.paidAmount, d.balanceAmount, d.dueDate, d.documentType
        FROM documents d
        LEFT JOIN parties p ON p.id=d.partyId AND p.firmId=d.firmId
        WHERE ${active.replace('firmId=?', 'd.firmId=?').replace('isDeleted=0', 'd.isDeleted=0').replace("status NOT IN", "d.status NOT IN").replace('documentDate BETWEEN', 'd.documentDate BETWEEN ')} AND d.documentType=?
        ORDER BY d.total DESC, d.documentDate DESC, d.createdAt DESC LIMIT ?`)
        .all(firmId, start, end, documentType, lim) as any[];
      const summary = db.prepare(`SELECT COALESCE(SUM(total),0) total, COUNT(*) count FROM documents
        WHERE ${active} AND documentType=?`).get(firmId, start, end, documentType) as any;
      return res.json({ success:true, data:{ type, total:Number(summary?.total||0), count:Number(summary?.count||0), rows } });
    }

    // Invoice Summary drill-downs are status-specific. Never mix paid, pending,
    // or purchase payables: each click must return only the matching bills.
    if (type === 'paid' || type === 'pending' || type === 'overdue_pending' || type === 'payable' || type === 'overdue_payable') {
      let where = '';
      // Paid drill-down is a period activity view. Live receivable/payable
      // drill-downs are point-in-time and therefore must include older bills
      // that are still unpaid today.
      const liveBalanceType = ['pending','overdue_pending','payable','overdue_payable'].includes(String(type));
      const activeForStatus = liveBalanceType
        ? `firmId=? AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled')`
        : active;
      const params: any[] = liveBalanceType ? [firmId] : [firmId, start, end];
      if (type === 'paid') {
        // Fully paid customer sales only. Part-paid invoices stay in Pending.
        where = `AND documentType='sale_invoice' AND total > 0.01 AND balanceAmount <= 0.01`;
      } else if (type === 'pending') {
        // Customer sales with an outstanding balance that are not yet overdue.
        where = `AND documentType='sale_invoice' AND total > 0 AND balanceAmount > 0 AND (dueDate IS NULL OR dueDate='' OR dueDate >= date('now','localtime'))`;
      } else if (type === 'overdue_pending') {
        // Customer receivables whose due date has already passed.
        where = `AND documentType='sale_invoice' AND total > 0 AND balanceAmount > 0 AND dueDate IS NOT NULL AND dueDate<>'' AND dueDate < date('now','localtime')`;
      } else if (type === 'payable') {
        // Supplier purchase invoices that are still payable and not yet overdue.
        where = `AND documentType='purchase_invoice' AND total > 0 AND balanceAmount > 0 AND (dueDate IS NULL OR dueDate='' OR dueDate >= date('now','localtime'))`;
      } else {
        // Supplier payables whose due date has already passed.
        where = `AND documentType='purchase_invoice' AND total > 0 AND balanceAmount > 0 AND dueDate IS NOT NULL AND dueDate<>'' AND dueDate < date('now','localtime')`;
      }
      const activeSql = activeForStatus.replace('firmId=?', 'd.firmId=?').replace('isDeleted=0', 'd.isDeleted=0').replace("status NOT IN", "d.status NOT IN").replace('documentDate BETWEEN', 'd.documentDate BETWEEN ');
      const rows = db.prepare(`SELECT d.id, d.documentNumber, d.documentDate, d.partyId, d.partyName,
          COALESCE(p.phone,'') AS partyPhone, d.partyType, d.total, d.paidAmount, d.balanceAmount, d.dueDate, d.transactionType, d.documentType
        FROM documents d
        LEFT JOIN parties p ON p.id=d.partyId AND p.firmId=d.firmId
        WHERE ${activeSql} ${where.replace("documentType=", "d.documentType=").replace('paidAmount', 'd.paidAmount').replace('balanceAmount', 'd.balanceAmount').replace('dueDate', 'd.dueDate')}
        ORDER BY d.documentDate DESC, d.createdAt DESC, d.total DESC LIMIT ?`)
        .all(...params, lim) as any[];
      const summary = db.prepare(`SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(paidAmount),0) paidAmount, COALESCE(SUM(balanceAmount),0) balanceAmount, COUNT(*) count
        FROM documents WHERE ${activeForStatus} ${where}`).get(...params) as any;
      return res.json({ success:true, data:{ type, total:Number(summary?.total||0), paidAmount:Number(summary?.paidAmount||0), balanceAmount:Number(summary?.balanceAmount||0), count:Number(summary?.count||0), rows } });
    }

    if (type === 'expenses') {
      const rows = db.prepare(`SELECT e.id, e.date, e.amount, e.description, e.partyName, e.categoryId, COALESCE(c.name,'Uncategorized') categoryName
        FROM expenses e LEFT JOIN categories c ON e.categoryId=c.id
        WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ?
        ORDER BY e.amount DESC, e.date DESC LIMIT ?`).all(firmId, start, end, lim) as any[];
      const summary = db.prepare(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) count FROM expenses
        WHERE firmId=? AND COALESCE(isDeleted,0)=0 AND date BETWEEN ? AND ?`).get(firmId, start, end) as any;
      const topCategories = db.prepare(`SELECT COALESCE(c.name,'Uncategorized') categoryName, COALESCE(SUM(e.amount),0) total, COUNT(*) count
        FROM expenses e LEFT JOIN categories c ON e.categoryId=c.id
        WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ?
        GROUP BY e.categoryId,c.name ORDER BY total DESC LIMIT ?`).all(firmId, start, end, lim) as any[];
      return res.json({ success:true, data:{ type, total:Number(summary?.total||0), count:Number(summary?.count||0), rows, topCategories } });
    }

    // Item movement drill-down uses the exact same live classifier as the dashboard.
    if (['item_fast','item_normal','item_slow'].includes(String(type))) {
      const movementRows=itemMovementClassification(String(firmId));
      const target=movementRows.filter((r:any)=>r.movementType===String(type));
      const rows=target.slice(0,lim);
      const label=type==='item_fast'?'Fast Moving':type==='item_normal'?'Normal':'Slow Moving';
      return res.json({success:true,data:{type,label,totalCount:movementRows.length,targetCount:target.length,count:rows.length,rows,hasMore:target.length>rows.length,rule:'new < 7d = Normal; 1-2 sales/7d = Normal; 3+ sales/7d = Fast; 0 sales/7d = Slow',windowDays:7}});
    }

    if (type === 'clients') {
      const rows = db.prepare(`SELECT d.partyId, d.partyName, COALESCE(SUM(d.total),0) total, COUNT(*) invoiceCount
        FROM documents d WHERE d.firmId=? AND d.documentType='sale_invoice' AND d.isDeleted=0
        AND d.status NOT IN ('hold','draft','cancelled') AND d.documentDate BETWEEN ? AND ?
        GROUP BY d.partyId,d.partyName ORDER BY total DESC LIMIT ?`).all(firmId,start,end,lim) as any[];
      const total = rows.reduce((n:any,r:any)=>n+Number(r.total||0),0);
      return res.json({success:true,data:{type,total,rows}});
    }

    if (type === 'profit') {
      const docs = getGrossProfitRows(String(firmId),start,end);
      const byBill: Record<string,any> = {};
      const byItem: Record<string,any> = {};
      for (const r of docs) {
        const paidQty=Math.max(0,Number(r.baseQuantity||r.quantity||0));
        const freeQty=Math.max(0,Number(r.freeQuantity||0));
        const qty=paidQty+freeQty;
        const revenue=Math.max(0,Number(r.amount||0)-Number(r.taxAmount||0));
        const costRate=costAtSale(String(firmId),String(r.itemId||''),r.batchId?String(r.batchId):null,r.batchNumber?String(r.batchNumber):null,String(r.documentDate||''));
        const cost=paidQty*costRate;
        const sign=r.documentType==='sale_invoice'?1:-1;
        const bill=byBill[r.id] ||= { id:r.id, documentNumber:r.documentNumber, documentDate:r.documentDate, partyName:r.partyName||'Walk-in', documentType:r.documentType, quantity:0, revenue:0, costOfGoodsSold:0, grossProfit:0, discount:Number(r.discountAmount||0), total:Number(r.total||0) };
        bill.quantity += sign*qty;
        bill.revenue += sign*revenue;
        bill.costOfGoodsSold += sign*cost;
        bill.grossProfit += sign*(revenue-cost);
        const key=String(r.itemId||r.itemName||'unknown');
        const item=byItem[key] ||= { itemId:r.itemId, itemName:r.itemName||'Item', quantity:0, revenue:0, costOfGoodsSold:0, profit:0 };
        item.quantity += sign*qty; item.revenue += sign*revenue; item.costOfGoodsSold += sign*cost; item.profit += sign*(revenue-cost);
      }
      // Bill-level discount belongs to the bill, not each line. Apply it once.
      for (const bill of Object.values(byBill) as any[]) {
        bill.grossProfit += bill.documentType==='sale_invoice' ? -Number(bill.discount||0) : Number(bill.discount||0);
        bill.marginPct = bill.revenue ? Number((bill.grossProfit / bill.revenue * 100).toFixed(2)) : 0;
      }
      const billRows=Object.values(byBill).sort((a:any,b:any)=>String(b.documentDate).localeCompare(String(a.documentDate))).slice(0,lim);
      const itemRows=Object.values(byItem).sort((a:any,b:any)=>Math.abs(Number(b.profit||0))-Math.abs(Number(a.profit||0))).slice(0,lim);
      const totalRevenue=billRows.reduce((n:any,b:any)=>n+Number(b.revenue||0),0);
      const totalCost=billRows.reduce((n:any,b:any)=>n+Number(b.costOfGoodsSold||0),0);
      const grossProfit=billRows.reduce((n:any,b:any)=>n+Number(b.grossProfit||0),0);
      return res.json({ success:true, data:{ type, grossProfit, revenue:totalRevenue, costOfGoodsSold:totalCost, marginPct:totalRevenue?Number((grossProfit/totalRevenue*100).toFixed(2)):0, bills:billRows, items:itemRows } });
    }

    return res.status(400).json({ error:'Unknown dashboard detail type' });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

// Top 5 Selling Items (by quantity sold, within the selected date range)
router.get('/top-items', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, limit = '5' } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });

    const dateFilter = startDate && endDate ? `AND d.documentDate BETWEEN '${startDate}' AND '${endDate}'` : '';

    const rows = db.prepare(`
      SELECT
        di.itemId,
        di.name as itemName,
        SUM(di.quantity) as quantitySold,
        SUM(di.amount) as salesValue
      FROM document_items di
      JOIN documents d ON d.id = di.documentId
      WHERE d.firmId = ? AND d.documentType = 'sale_invoice' AND d.isDeleted = 0 AND d.status NOT IN ('hold','draft','cancelled') ${dateFilter}
      GROUP BY COALESCE(di.itemId, di.name)
      ORDER BY salesValue DESC
      LIMIT ?
    `).all(firmId, Number(limit));

    const ranked = (rows as any[]).map((r, i) => ({ rank: i + 1, ...r }));
    res.json({ success: true, data: ranked });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Top 5 Transactions (by total value, within the selected date range, across sale + purchase docs)
router.get('/top-transactions', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, limit = '5' } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });

    const dateFilter = startDate && endDate ? `AND documentDate BETWEEN '${startDate}' AND '${endDate}'` : '';

    const rows = db.prepare(`
      SELECT id, documentNumber, documentDate, partyName, documentType, total
      FROM documents
      WHERE firmId = ? AND isDeleted = 0 AND status NOT IN ('hold','draft','cancelled') ${dateFilter}
      ORDER BY total DESC
      LIMIT ?
    `).all(firmId, Number(limit));

    const ranked = (rows as any[]).map((r, i) => ({ rank: i + 1, ...r }));
    res.json({ success: true, data: ranked });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Top clients by sales value in the selected period
router.get('/top-clients', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, limit = '6' } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const dateFilter = startDate && endDate ? 'AND d.documentDate BETWEEN ? AND ?' : '';
    const params:any[]=[firmId]; if(startDate&&endDate) params.push(startDate,endDate); params.push(Number(limit));
    const rows=db.prepare(`SELECT d.partyId, d.partyName, SUM(d.total) AS total, COUNT(*) AS invoiceCount FROM documents d WHERE d.firmId=? AND d.documentType='sale_invoice' AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') ${dateFilter} GROUP BY d.partyId,d.partyName ORDER BY total DESC LIMIT ?`).all(...params);
    res.json({success:true,data:rows});
  } catch(err:any){res.status(500).json({error:err.message});}
});

// Profit & Loss
router.get('/profit-loss', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate } = req.query as any;
    if (!firmId) return res.status(400).json({error:'firmId required'});
    const f=String(firmId), start=String(startDate||'0000-01-01'), end=String(endDate||'9999-12-31');
    const q=(types:string[])=>{const ph=types.map(()=>'?').join(',');return db.prepare(`SELECT COALESCE(SUM(total),0) total,COALESCE(SUM(subtotal),0) subtotal,COALESCE(SUM(taxAmount),0) tax,COALESCE(SUM(roundOff),0) roundOff FROM documents WHERE firmId=? AND documentType IN (${ph}) AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate BETWEEN ? AND ?`).get(f,...types,start,end) as any};
    const sales=q(['sale_invoice']); const saleReturns=q(['sale_return']); const purchases=q(['purchase_invoice']); const purchaseReturns=q(['purchase_return']); const otherIncome=q(['other_income']);
    const expenses=(db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE firmId=? AND COALESCE(isDeleted,0)=0 AND date BETWEEN ? AND ?`).get(f,start,end) as any)?.total||0;
    const directExpenseLedgers=(db.prepare(`SELECT COALESCE(SUM(e.amount),0) total FROM expenses e JOIN categories c ON c.id=e.categoryId WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ? AND c.type='expense' AND COALESCE(c.accountGroup,'Direct Expenses')='Direct Expenses'`).get(f,start,end) as any)?.total||0;
    const indirectExpenseLedgers=(db.prepare(`SELECT COALESCE(SUM(e.amount),0) total FROM expenses e JOIN categories c ON c.id=e.categoryId WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ? AND c.type='expense' AND COALESCE(c.accountGroup,'Direct Expenses')='Indirect Expenses'`).get(f,start,end) as any)?.total||0;
    const openingStock=(db.prepare(`SELECT COALESCE(SUM(COALESCE(openingStock,0)*COALESCE(purchasePrice,0)),0) total FROM items WHERE firmId=? AND isActive=1`).get(f) as any)?.total||0;
    const closingStock=(db.prepare(`SELECT COALESCE(SUM(COALESCE(s.quantity,0)*COALESCE(i.purchasePrice,0)),0) total FROM inventory_stock s JOIN items i ON i.id=s.itemId WHERE s.firmId=? AND i.isActive=1`).get(f) as any)?.total||0;
    const grossProfitBase=calculatePeriodGrossProfit(f,start,end);
    const netSales=Number(sales.total||0)-Number(saleReturns.total||0);
    const purchaseAccounts=Number(purchases.total||0)-Number(purchaseReturns.total||0);
    const grossProfit=Number(grossProfitBase||0);
    const grossLoss=Math.max(0,-grossProfit), grossProfitPositive=Math.max(0,grossProfit);
    const directIncome=Number(otherIncome.total||0);
    const roundOff=Number(sales.roundOff||0)-Number(saleReturns.roundOff||0)+Number(purchases.roundOff||0)-Number(purchaseReturns.roundOff||0)+Number(otherIncome.roundOff||0);
    const netProfit=grossProfit+directIncome-Number(directExpenseLedgers||0)-Number(indirectExpenseLedgers||0)+roundOff;
    res.json({success:true,data:{
      openingStock, sales:Number(sales.total||0), saleReturns:Number(saleReturns.total||0), netSales,
      purchaseAccounts, purchases:Number(purchases.total||0), purchaseReturns:Number(purchaseReturns.total||0), purchaseTaxPaid:Number(purchases.tax||0)-Number(purchaseReturns.tax||0),
      directExpenses:Number(directExpenseLedgers||0), roundOff, grossProfit:grossProfitPositive, grossLoss, salesAccounts:netSales, directIncomes:directIncome,
      closingStock, indirectExpenses:Number(indirectExpenseLedgers||0), indirectIncomes:0, netProfit:Math.max(0,netProfit), netLoss:Math.max(0,-netProfit),
      profitBeforeTax:netProfit, expenses:Number(expenses||0), otherIncome:directIncome
    }});
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Profit & Loss drill-down: every visible P&L component resolves to its source rows.
router.get('/profit-loss/detail', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, component } = req.query as any;
    if (!firmId || !component) return res.status(400).json({ error: 'firmId and component required' });
    const start = String(startDate || '0000-01-01');
    const end = String(endDate || '9999-12-31');
    const f = String(firmId), c = String(component);
    let rows:any[]=[];
    const doc = (types:string[]) => {
      const ph=types.map(()=>'?').join(',');
      return db.prepare(`SELECT d.id,d.documentDate,d.documentNumber,d.documentType,d.partyName,d.partyId,d.subtotal,d.taxAmount,d.total,d.roundOff,d.paidAmount,d.balanceAmount,d.description FROM documents d WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN (${ph}) AND d.documentDate BETWEEN ? AND ? ORDER BY d.documentDate,d.documentNumber`).all(f,...types,start,end) as any[];
    };
    if(c==='opening_stock') rows=db.prepare(`SELECT i.id,i.name itemName,i.sku,COALESCE(i.openingStock,0) quantity,COALESCE(i.purchasePrice,0) rate,COALESCE(i.openingStock,0)*COALESCE(i.purchasePrice,0) amount FROM items i WHERE i.firmId=? AND i.isActive=1 AND COALESCE(i.openingStock,0)<>0 ORDER BY i.name`).all(f) as any[];
    else if(c==='purchase_accounts') rows=doc(['purchase_invoice','purchase_return']);
    else if(c==='purchase_tax') rows=db.prepare(`SELECT d.id,d.documentDate,d.documentNumber,d.documentType,d.partyName,d.taxAmount taxAmount,d.total FROM documents d WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN ('purchase_invoice','purchase_return') AND d.documentDate BETWEEN ? AND ? ORDER BY d.documentDate,d.documentNumber`).all(f,start,end) as any[];
    else if(c==='direct_expenses' || c==='indirect_expenses') { const grp=c==='indirect_expenses'?'Indirect Expenses':'Direct Expenses'; rows=db.prepare(`SELECT e.id,e.date documentDate,e.description,e.categoryId,e.partyId,e.partyName,e.paymentMethod,e.amount,e.bankId,c.name expenseType,COALESCE(c.accountGroup,'Direct Expenses') accountGroup FROM expenses e LEFT JOIN categories c ON e.categoryId=c.id WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ? AND c.type='expense' AND COALESCE(c.accountGroup,'Direct Expenses')=? ORDER BY e.date,e.createdAt`).all(f,start,end,grp) as any[]; }
    else if(c==='round_off') rows=db.prepare(`SELECT d.id,d.documentDate,d.documentNumber,d.documentType,d.partyName,d.roundOff,d.total FROM documents d WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND ABS(COALESCE(d.roundOff,0))>0 AND d.documentDate BETWEEN ? AND ? ORDER BY d.documentDate,d.documentNumber`).all(f,start,end) as any[];
    else if(c==='sales_accounts') rows=doc(['sale_invoice','sale_return']);
    else if(c==='direct_incomes') rows=doc(['other_income']);
    else if(c==='closing_stock') rows=db.prepare(`SELECT i.id,i.name itemName,i.sku,COALESCE(SUM(s.quantity),0) quantity,COALESCE(i.purchasePrice,0) rate,COALESCE(SUM(s.quantity),0)*COALESCE(i.purchasePrice,0) amount FROM items i LEFT JOIN inventory_stock s ON s.itemId=i.id AND s.firmId=i.firmId WHERE i.firmId=? AND i.isActive=1 GROUP BY i.id,i.name,i.sku,i.purchasePrice HAVING quantity<>0 ORDER BY i.name`).all(f) as any[];
    else if(c==='gross_profit' || c==='gross_loss') rows=doc(['sale_invoice','sale_return','purchase_invoice','purchase_return']);
    else if(c==='indirect_expenses') rows=[];
    else if(c==='indirect_incomes') rows=[];
    else if(c==='net_profit' || c==='net_loss') rows=db.prepare(`SELECT e.id,e.date documentDate,e.description,e.partyName,e.amount FROM expenses e WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ? ORDER BY e.date,e.createdAt`).all(f,start,end) as any[];
    else return res.status(400).json({error:'Unknown P&L component'});
    res.json({success:true,component:c,data:rows});
  } catch(err:any){ res.status(500).json({error:err.message}); }
});

// Stock Summary
router.get('/stock-summary', (req: Request, res: Response) => {
  try {
    const { firmId, search, minOnly } = req.query;
    let q = 'SELECT i.*, c.name as categoryName FROM items i LEFT JOIN categories c ON i.categoryId = c.id WHERE i.firmId = ? AND i.type = \'PRODUCT\' AND i.isActive = 1';
    const p: any[] = [firmId];
    if (search) { q += ' AND i.name LIKE ?'; p.push(`%${search}%`); }
    if (minOnly === '1' || minOnly === 'true') q += ' AND i.minStockLevel > 0 AND i.currentStock <= i.minStockLevel';
    const stockStatus = String(req.query.stockStatus || '').trim().toLowerCase();
    if (stockStatus === 'in_stock') {
      q += ' AND i.currentStock > 0 AND NOT (i.minStockLevel > 0 AND i.currentStock <= i.minStockLevel)';
    } else if (stockStatus === 'low_stock') {
      q += ' AND i.minStockLevel > 0 AND i.currentStock > 0 AND i.currentStock <= i.minStockLevel';
    } else if (stockStatus === 'out_of_stock') {
      q += ' AND i.currentStock <= 0';
    } else if (stockStatus) {
      return res.status(400).json({ error: 'Unknown stockStatus' });
    }
    q += ' ORDER BY i.name';
    res.json({ success: true, data: db.prepare(q).all(p) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Sales Report
router.get('/sales', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, partyId } = req.query;
    let q = 'SELECT d.*, di.name as itemName, di.quantity, di.price, di.amount FROM documents d LEFT JOIN document_items di ON d.id = di.documentId WHERE d.firmId=? AND d.documentType=\'sale_invoice\' AND d.isDeleted=0';
    const p: any[] = [firmId];
    if (startDate) { q += ' AND d.documentDate >= ?'; p.push(startDate); }
    if (endDate) { q += ' AND d.documentDate <= ?'; p.push(endDate); }
    if (partyId) { q += ' AND d.partyId = ?'; p.push(partyId); }
    q += ' ORDER BY d.documentDate DESC';
    res.json({ success: true, data: db.prepare(q).all(p) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Purchase Report
router.get('/purchases', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, partyId } = req.query;
    let q = 'SELECT * FROM documents WHERE firmId=? AND documentType=\'purchase_invoice\' AND isDeleted=0';
    const p: any[] = [firmId];
    if (startDate) { q += ' AND documentDate >= ?'; p.push(startDate); }
    if (endDate) { q += ' AND documentDate <= ?'; p.push(endDate); }
    if (partyId) { q += ' AND partyId = ?'; p.push(partyId); }
    q += ' ORDER BY documentDate DESC';
    res.json({ success: true, data: db.prepare(q).all(p) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GST Report (Tax Summary)
router.get('/gst', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate } = req.query;
    let q = 'SELECT documentType, SUM(taxAmount) as totalTax, SUM(total) as total, COUNT(*) as count FROM documents WHERE firmId=? AND isDeleted=0';
    const p: any[] = [firmId];
    if (startDate) { q += ' AND documentDate >= ?'; p.push(startDate); }
    if (endDate) { q += ' AND documentDate <= ?'; p.push(endDate); }
    q += ' GROUP BY documentType';
    res.json({ success: true, data: db.prepare(q).all(p) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/gst-tax-register',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;const rows=db.prepare(`SELECT d.documentDate,d.documentNumber,d.documentType,d.partyName,p.gstin partyGstin,d.taxAmount,d.total FROM documents d LEFT JOIN parties p ON p.id=d.partyId WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ? ORDER BY d.documentDate,d.documentNumber`).all(firmId,startDate,endDate);res.json({success:true,data:rows})}catch(err:any){res.status(500).json({error:err.message})}});

// GSTR-1 — outward supplies return (B2B, B2C Large, B2C Small, Credit Notes, HSN summary)
router.get('/gstr1', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate } = req.query;
    if (!firmId || !startDate || !endDate) return res.status(400).json({ error: 'firmId, startDate and endDate required' });
    res.json({ success: true, data: computeGstr1(String(firmId), String(startDate), String(endDate)) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GSTR-2 — inward supplies
router.get('/gstr2',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;if(!firmId||!startDate||!endDate)return res.status(400).json({error:'firmId, startDate and endDate required'});res.json({success:true,data:computeGstr2(String(firmId),String(startDate),String(endDate))})}catch(err:any){res.status(500).json({error:err.message})}});
router.get('/gstr2b-reconciliation',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;if(!firmId||!startDate||!endDate)return res.status(400).json({error:'firmId, startDate and endDate required'});res.json({success:true,data:computeGstReconciliation(String(firmId),String(startDate),String(endDate),'2B')})}catch(err:any){res.status(500).json({error:err.message})}});
router.get('/gstr2a-reconciliation',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;if(!firmId||!startDate||!endDate)return res.status(400).json({error:'firmId, startDate and endDate required'});res.json({success:true,data:computeGstReconciliation(String(firmId),String(startDate),String(endDate),'2A')})}catch(err:any){res.status(500).json({error:err.message})}});
router.get('/gstr9',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;if(!firmId||!startDate||!endDate)return res.status(400).json({error:'firmId, startDate and endDate required'});res.json({success:true,data:computeGstr9(String(firmId),String(startDate),String(endDate))})}catch(err:any){res.status(500).json({error:err.message})}});
router.get('/gstr4',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;if(!firmId||!startDate||!endDate)return res.status(400).json({error:'firmId, startDate and endDate required'});res.json({success:true,data:computeGstr4(String(firmId),String(startDate),String(endDate))})}catch(err:any){res.status(500).json({error:err.message})}});
router.get('/cmp08',(req:Request,res:Response)=>{try{const {firmId,startDate,endDate}=req.query;if(!firmId||!startDate||!endDate)return res.status(400).json({error:'firmId, startDate and endDate required'});res.json({success:true,data:computeCompositionReturns(String(firmId),String(startDate),String(endDate))})}catch(err:any){res.status(500).json({error:err.message})}});

// GSTR-3B — summary return (net outward tax vs input tax credit)
router.get('/gstr3b', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate } = req.query;
    if (!firmId || !startDate || !endDate) return res.status(400).json({ error: 'firmId, startDate and endDate required' });
    res.json({ success: true, data: computeGstr3b(String(firmId), String(startDate), String(endDate)) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});


/* ═══════════════════════════════════════════════════════════════════════════
   COMPLETE REPORT ENGINE
   Every Report Center tile resolves through this endpoint. Filters are applied
   against the same transaction tables used by billing/accounting, so reports
   are transaction-linked rather than placeholder screens.
═══════════════════════════════════════════════════════════════════════════ */
const REPORT_LABELS: Record<string,string> = {
  ledger:'Ledger', day_book:'Day Book', trial_balance:'Trial Balance', cash_bank:'Cash / Bank Books',
  group_summary:'Group Summary', outstanding:'Outstanding Report', receipt:'Receipt', payment:'Payment',
  debit_note:'Debit Note', credit_note:'Credit Note', profit_loss:'Profit & Loss', balance_sheet:'Balance Sheet',
  reorder:'Re-Order', stock_status:'Current Stock Status', shortage:'Shortage Reports', item_ledger:'Item Ledger',
  stock_sales:'Stock & Sales Analysis', sales_register:'Sales - Register (All)', sales_party:'Sales - Party Wise',
  sales_analysis:'Sales Analysis', pending_order:'Pending Order', purchase_register:'Purchase - Register (All)',
  purchase_party:'Purchase - Party Wise', purchase_analysis:'Purchase Analysis', purchase_pending:'Pending Purchase Order',
  minimum_stock:'Minimum Stock', maximum_stock:'Maximum Stock', batch_stock:'Batch-Wise Stock', batch_expiry:'Batch & Expiry', item_aging:'Item Aging', party_aging:'Party Aging',
  gross_profit:'Gross Profit', revenue:'Revenue Overview', top_items:'Top Items', top_clients:'Top Clients',
  gstr1:'GSTR-1', gstr3b:'GSTR-3B', gstr9:'GSTR-9 (Annual)', gstr4:'GSTR-4 (Annual)', cmp08:'CMP-08 (Quarterly)', gstr2b_recon:'GSTR-2B / ITC Reconciliation', gst_register:'GST Tax Register'
};

function reportDateWhere(alias='d', startDate?:any, endDate?:any) {
  const w:string[]=[]; const p:any[]=[];
  if(startDate){w.push(`${alias}.documentDate >= ?`);p.push(String(startDate));}
  if(endDate){w.push(`${alias}.documentDate <= ?`);p.push(String(endDate));}
  return {sql:w.length?' AND '+w.join(' AND '):'', params:p};
}
function reportDocFilters(q:any, alias='d', includeItem=true) {
  const w:string[]=[]; const p:any[]=[];
  if(q.partyId){w.push(`${alias}.partyId=?`);p.push(String(q.partyId));}
  if(q.status){w.push(`${alias}.status=?`);p.push(String(q.status));}
  if(q.paymentMethod){w.push(`${alias}.paymentType=?`);p.push(String(q.paymentMethod));}
  if(q.documentType){w.push(`${alias}.documentType=?`);p.push(String(q.documentType));}
  if(q.search){w.push(`(${alias}.documentNumber LIKE ? OR ${alias}.partyName LIKE ?)`);p.push(`%${q.search}%`,`%${q.search}%`);}
  if(q.minAmount!==' ' && q.minAmount!==undefined && q.minAmount!==''){w.push(`${alias}.total>=?`);p.push(Number(q.minAmount)||0);}
  if(q.maxAmount!==undefined && q.maxAmount!==''){w.push(`${alias}.total<=?`);p.push(Number(q.maxAmount)||0);}
  if(includeItem && q.itemId){w.push(`EXISTS (SELECT 1 FROM document_items fx WHERE fx.documentId=${alias}.id AND fx.itemId=?)`);p.push(String(q.itemId));}
  if(includeItem && q.categoryId){w.push(`EXISTS (SELECT 1 FROM document_items fc JOIN items fi ON fi.id=fc.itemId WHERE fc.documentId=${alias}.id AND fi.categoryId=?)`);p.push(String(q.categoryId));}
  return {sql:w.length?' AND '+w.join(' AND '):'',params:p};
}
function docRows(firmId:string,q:any,types:string[]) {
  const dates=reportDateWhere('d',q.startDate,q.endDate); const f=reportDocFilters(q,'d',true);
  const placeholders=types.map(()=>'?').join(',');
  const sql=`SELECT d.id,d.documentDate,d.dueDate,d.documentNumber,d.documentType,d.partyId,d.partyName,d.partyType,d.status,d.transactionType,d.paymentType,d.stateOfSupply,d.subtotal,d.discountAmount,d.taxAmount,d.shippingCharges,d.packagingCharges,d.roundOff,d.total,d.paidAmount,d.balanceAmount,d.poNumber,d.description
    FROM documents d WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN (${placeholders})${dates.sql}${f.sql} ORDER BY d.documentDate DESC,d.createdAt DESC`;
  return db.prepare(sql).all(firmId,...types,...dates.params,...f.params) as any[];
}
function lineRows(firmId:string,q:any,types:string[]) {
  const dates=reportDateWhere('d',q.startDate,q.endDate); const f=reportDocFilters(q,'d',true);
  const ph=types.map(()=>'?').join(',');
  const sql=`SELECT d.id documentId,d.documentDate,d.documentNumber,d.documentType,d.partyId,d.partyName,d.status,
    di.itemId,di.name itemName,di.hsnCode,di.quantity,di.freeQuantity,di.unit,di.packing,di.batchNumber,di.expiryMonth,di.expiryYear,di.expiryDate,di.mfgDate,
    di.price,di.discountPercentage,di.discountAmount,di.taxRate,di.taxAmount,di.amount,
    (di.quantity+COALESCE(di.freeQuantity,0)) stockQuantity
    FROM document_items di JOIN documents d ON d.id=di.documentId
    WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN (${ph})${dates.sql}${f.sql} ORDER BY d.documentDate DESC,d.createdAt DESC`;
  return db.prepare(sql).all(firmId,...types,...dates.params,...f.params) as any[];
}
function getUiModuleLabel(firmId:string, key:string, fallback:string): string {
  try {
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId=? AND settingType='ui_labels' AND settingKey=?").get(firmId,key) as any;
    const value = String(row?.settingValue || '').trim();
    return value || fallback;
  } catch { return fallback; }
}

function ageingBucket(days:number, futureLabel='Not Due'): string {
  if (!Number.isFinite(days)) return futureLabel;
  if (days <= 0) return futureLabel;
  if (days <= 30) return '0-30 Days';
  if (days <= 60) return '31-60 Days';
  if (days <= 90) return '61-90 Days';
  if (days <= 180) return '91-180 Days';
  if (days <= 365) return '181-365 Days';
  return '365+ Days';
}
function dateOnly(v:any): string { return String(v||'').slice(0,10); }
function daysBetween(from:string, to:string): number {
  const a=Date.parse(from), b=Date.parse(to);
  return Number.isFinite(a)&&Number.isFinite(b) ? Math.max(0,Math.floor((b-a)/86400000)) : NaN;
}
function itemAgingReport(firmId:string,q:any) {
  const asOf=dateOnly(q.endDate||new Date().toISOString());
  const rows:any[]=db.prepare(`
    SELECT b.id batchId,b.itemId,b.batchNumber,b.expiryMonth,b.expiryYear,b.expiryDate,b.mfgDate,
           COALESCE(b.quantity,0) quantity,COALESCE(b.purchaseRate,0) purchaseRate,COALESCE(b.mrp,0) mrp,
           b.createdAt batchCreatedAt,i.name itemName,COALESCE(i.itemCode,i.sku) itemCode,i.sku,i.barcode,i.currentStock,i.categoryId,c.name categoryName
    FROM inventory_batches b
    JOIN items i ON i.id=b.itemId
    LEFT JOIN categories c ON c.id=i.categoryId
    WHERE b.firmId=? AND COALESCE(b.quantity,0)>0 AND COALESCE(i.isActive,1)=1
      ${q.itemId?'AND b.itemId=?':''} ${q.categoryId?'AND i.categoryId=?':''}
      ${q.search?'AND (i.name LIKE ? OR i.sku LIKE ? OR b.batchNumber LIKE ?)':''}
    ORDER BY i.name,b.batchNumber,b.createdAt
  `).all(firmId,...(q.itemId?[String(q.itemId)]:[]),...(q.categoryId?[String(q.categoryId)]:[]),...(q.search?[`%${q.search}%`,`%${q.search}%`,`%${q.search}%`]:[])) as any[];
  const purchaseDateStmt=db.prepare(`SELECT MIN(d.documentDate) purchaseDate
    FROM document_items di JOIN documents d ON d.id=di.documentId
    WHERE d.firmId=? AND di.itemId=? AND d.documentType='purchase_invoice' AND d.isDeleted=0
      AND d.status NOT IN ('hold','draft','cancelled') AND di.batchId=? AND d.documentDate<=?`);
  return rows.map(r=>{
    const pd=(purchaseDateStmt.get(firmId,r.itemId,r.batchId,asOf) as any)?.purchaseDate;
    const received=dateOnly(pd||r.batchCreatedAt);
    const ageDays=daysBetween(received,asOf);
    const qty=Number(r.quantity||0), rate=Number(r.purchaseRate||0);
    const expiry=(r.expiryYear&&r.expiryMonth)?`${String(r.expiryMonth).padStart(2,'0')}/${r.expiryYear}`:'';
    let expiryStatus='';
    if(r.expiryYear&&r.expiryMonth){
      const lastDay=new Date(Number(r.expiryYear),Number(r.expiryMonth),0);
      expiryStatus=lastDay.getTime()<Date.parse(asOf)?'Expired':(Math.ceil((lastDay.getTime()-Date.parse(asOf))/86400000)<=90?'Near Expiry':'OK');
    }
    return {...r, receivedDate:received, ageDays:Number.isFinite(ageDays)?ageDays:null, ageingBucket:ageingBucket(ageDays,'Unknown'), expiryDisplay:expiry, expiryStatus, stockValue:qty*rate, asOfDate:asOf};
  });
}
function partyAgingReport(firmId:string,q:any) {
  const asOf=dateOnly(q.endDate||new Date().toISOString());
  const type=q.partyType?String(q.partyType):'';
  const docs:any[]=db.prepare(`SELECT d.id,d.partyId,d.partyName,d.partyType,d.documentNumber,d.documentDate,d.dueDate,d.total,d.paidAmount,d.balanceAmount,d.documentType
    FROM documents d WHERE d.firmId=? AND d.documentType IN ('sale_invoice','purchase_invoice')
      AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentDate<=?
      AND COALESCE(d.balanceAmount,0)>0 ${type?'AND d.partyType=?':''} ${q.partyId?'AND d.partyId=?':''} ${q.search?'AND (d.partyName LIKE ? OR d.documentNumber LIKE ?)':''}
    ORDER BY d.partyName,d.documentDate,d.documentNumber`).all(firmId,asOf,...(type?[type]:[]),...(q.partyId?[String(q.partyId)]:[]),...(q.search?[`%${q.search}%`,`%${q.search}%`]:[])) as any[];
  const partyTotals:any=new Map();
  for(const d of docs){
    const key=String(d.partyId||d.partyName||'');
    const due=dateOnly(d.dueDate)||dateOnly(d.documentDate); const days=Math.max(0,daysBetween(due,asOf)||0); const bal=Number(d.balanceAmount||0);
    if(!partyTotals.has(key)) partyTotals.set(key,{total:0,notDue:0,b0:0,b1:0,b2:0,b3:0,b4:0,b5:0});
    const x=partyTotals.get(key); x.total+=bal;
    if(days<=0)x.notDue+=bal; else if(days<=30)x.b0+=bal; else if(days<=60)x.b1+=bal; else if(days<=90)x.b2+=bal; else if(days<=180)x.b3+=bal; else if(days<=365)x.b4+=bal; else x.b5+=bal;
  }
  return docs.map(d=>{
    const key=String(d.partyId||d.partyName||''); const due=dateOnly(d.dueDate)||dateOnly(d.documentDate); const raw=daysBetween(due,asOf); const overdueDays=Number.isFinite(raw)?Math.max(0,raw):0; const t=partyTotals.get(key)||{};
    return {...d,dueDateUsed:due,outstanding:Number(d.balanceAmount||0),overdueDays,ageingBucket:ageingBucket(overdueDays,'Not Due'),partyOutstanding:Number(t.total||0),partyNotDue:Number(t.notDue||0),party_0_30:Number(t.b0||0),party_31_60:Number(t.b1||0),party_61_90:Number(t.b2||0),party_91_180:Number(t.b3||0),party_181_365:Number(t.b4||0),party_365_plus:Number(t.b5||0),asOfDate:asOf};
  });
}

function genericReport(firmId:string, reportId:string, q:any) {
  const sales=['sale_invoice','sale_return']; const purchases=['purchase_invoice','purchase_return'];
  switch(reportId){
    case 'item_aging': return itemAgingReport(firmId,q);
    case 'party_aging': return partyAgingReport(firmId,q);
    case 'ledger': return docRows(firmId,q,[...sales,...purchases,'expense','other_income']).map((r:any)=>({...r, debit:['purchase_invoice','expense','sale_return'].includes(r.documentType)?r.total:0, credit:['sale_invoice','purchase_return','other_income'].includes(r.documentType)?r.total:0}));
    case 'day_book': {
      const start=String(q.startDate||q.endDate||new Date().toISOString().slice(0,10));
      const end=String(q.endDate||q.startDate||start);
      const docs=docRows(firmId,{...q,startDate:start,endDate:end},[
        'sale_invoice','sale_return','sale_order','sale_quotation','delivery_challan',
        'purchase_invoice','purchase_return','purchase_order','other_income'
      ]);
      const payments=db.prepare(`SELECT id,paymentDate date,receiptNumber documentNumber,type,partyId,partyName,amount,paymentMethod,bankId,reference,description,createdAt FROM payments WHERE firmId=? AND COALESCE(isDeleted,0)=0 AND paymentDate BETWEEN ? AND ? ORDER BY paymentDate DESC,createdAt DESC`).all(firmId,start,end) as any[];
      const expenses=db.prepare(`SELECT id,date,description,amount,paymentMethod,bankId,partyId,partyName,createdAt,categoryId FROM expenses WHERE firmId=? AND COALESCE(isDeleted,0)=0 AND date BETWEEN ? AND ? ORDER BY date DESC,createdAt DESC`).all(firmId,start,end) as any[];
      const bank=db.prepare(`SELECT bt.id,bt.date,bt.type,bt.amount,bt.reference,bt.description,bt.accountId,ba.accountName,bt.createdAt FROM bank_transactions bt LEFT JOIN bank_accounts ba ON ba.id=bt.accountId WHERE bt.firmId=? AND bt.date BETWEEN ? AND ? ORDER BY bt.date DESC,bt.createdAt DESC`).all(firmId,start,end) as any[];
      const defaults:any={sale_invoice:'Sales Invoice',sale_return:'Credit Note / Sales Return',sale_order:'Sales Order',sale_quotation:'Quotation',delivery_challan:'Delivery Challan',purchase_invoice:'Purchase Invoice',purchase_return:'Debit Note / Purchase Return',purchase_order:'Purchase Order',other_income:'Other Income'}; const label=(type:string)=>getUiModuleLabel(firmId,type,defaults[type]||type);
      const entries:any[]=[];
      for(const d of docs){
        const isIn=['sale_invoice','other_income'].includes(String(d.documentType));
        const isOut=['purchase_invoice'].includes(String(d.documentType));
        const isReturnOut=String(d.documentType)==='sale_return';
        const isReturnIn=String(d.documentType)==='purchase_return';
        const moneyType=(isIn?'Money In':isOut||isReturnOut?'Money Out':isReturnIn?'Money In':'Transaction');
        entries.push({
          date:d.documentDate,time:d.documentTime||String(d.createdAt||'').slice(11,19),type:label(String(d.documentType)),referenceNo:d.documentNumber,
          party:d.partyName||'',account:d.partyType||'',paymentMethod:d.paymentType||'',description:d.description||'',
          subtotal:Number(d.subtotal||0),tax:Number(d.taxAmount||0),amount:Number(d.total||0),
          debit:(isOut||isReturnOut)?Number(d.total||0):0,credit:(isIn||isReturnIn)?Number(d.total||0):0,
          flow:moneyType,status:d.status||''
        });
      }
      for(const x of payments){
        const incoming=String(x.type)==='payment_in';
        entries.push({date:x.date,time:String(x.createdAt||'').slice(11,19),type:incoming?'Receipt':'Payment',referenceNo:x.documentNumber||x.reference||'',party:x.partyName||'',account:incoming?'Customer Receipt':'Supplier Payment',paymentMethod:x.paymentMethod||'',description:x.description||'',subtotal:0,tax:0,amount:Number(x.amount||0),debit:incoming?Number(x.amount||0):0,credit:incoming?0:Number(x.amount||0),flow:incoming?'Money In':'Money Out',status:'posted'});
      }
      for(const x of expenses){
        entries.push({date:x.date,time:String(x.createdAt||'').slice(11,19),type:'Expense',referenceNo:x.id?String(x.id).slice(0,8):'',party:x.partyName||'',account:'Expense',paymentMethod:x.paymentMethod||'',description:x.description||'',subtotal:Number(x.amount||0),tax:0,amount:Number(x.amount||0),debit:Number(x.amount||0),credit:0,flow:'Money Out',status:'posted'});
      }
      for(const x of bank){
        const incoming=['credit','deposit','in','payment_in'].includes(String(x.type||'').toLowerCase());
        entries.push({date:x.date,time:String(x.createdAt||'').slice(11,19),type:'Bank Transaction',referenceNo:x.reference||'',party:'',account:x.accountName||'Bank',paymentMethod:'Bank',description:x.description||'',subtotal:0,tax:0,amount:Number(x.amount||0),debit:incoming?Number(x.amount||0):0,credit:incoming?0:Number(x.amount||0),flow:incoming?'Money In':'Money Out',status:'posted'});
      }
      entries.sort((a,b)=>`${b.date} ${b.time||''}`.localeCompare(`${a.date} ${a.time||''}`));
      return entries;
    }
    case 'trial_balance': {
      const rows=docRows(firmId,q,[...sales,...purchases,'expense','other_income']);
      const m:any={Sales:{debit:0,credit:0},Purchases:{debit:0,credit:0},Expenses:{debit:0,credit:0},OtherIncome:{debit:0,credit:0},Receivables:{debit:0,credit:0},Payables:{debit:0,credit:0}};
      rows.forEach((r:any)=>{if(r.documentType==='sale_invoice'){m.Sales.credit+=r.total;} else if(r.documentType==='sale_return'){m.Sales.debit+=r.total;} else if(r.documentType==='purchase_invoice'){m.Purchases.debit+=r.total;} else if(r.documentType==='purchase_return'){m.Purchases.credit+=r.total;} else if(r.documentType==='expense'){m.Expenses.debit+=r.total;} else if(r.documentType==='other_income'){m.OtherIncome.credit+=r.total;}});
      const parties=db.prepare(`SELECT p.name,p.type,p.openingBalance,p.openingBalanceType,COALESCE(SUM(CASE WHEN d.documentType IN ('sale_invoice','sale_return') THEN d.balanceAmount ELSE 0 END),0) salesBalance,COALESCE(SUM(CASE WHEN d.documentType IN ('purchase_invoice','purchase_return') THEN d.balanceAmount ELSE 0 END),0) purchaseBalance FROM parties p LEFT JOIN documents d ON d.partyId=p.id AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentDate BETWEEN ? AND ? WHERE p.firmId=? GROUP BY p.id,p.name,p.type,p.openingBalance,p.openingBalanceType`).all(q.startDate||'0000-01-01',q.endDate||'9999-12-31',firmId) as any[];
      parties.forEach((p:any)=>{const opening=Number(p.openingBalance||0)*(String(p.openingBalanceType||'debit')==='credit'?-1:1); const bal=opening+Number(p.salesBalance||0)-Number(p.purchaseBalance||0); if(bal>=0)m.Receivables.debit+=bal; else m.Payables.credit+=-bal;});
      return Object.entries(m).map(([account,v]:any)=>({account,debit:Number(v.debit||0),credit:Number(v.credit||0),difference:Number(v.debit||0)-Number(v.credit||0)}));
    }
    case 'cash_bank': {
      const payments=db.prepare(`SELECT paymentDate date,receiptNumber reference,type,partyName,amount,paymentMethod,bankId,description FROM payments WHERE firmId=? AND paymentDate BETWEEN ? AND ? ORDER BY paymentDate DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31') as any[];
      const bank=db.prepare(`SELECT bt.date,ba.accountName,bt.type,bt.amount,bt.reference,bt.description FROM bank_transactions bt JOIN bank_accounts ba ON ba.id=bt.accountId WHERE bt.firmId=? AND bt.date BETWEEN ? AND ? ORDER BY bt.date DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31') as any[];
      return [...payments.map(x=>({...x,source:'Payment'})),...bank.map(x=>({...x,source:'Bank'}))].sort((a:any,b:any)=>String(b.date).localeCompare(String(a.date)));
    }
    case 'group_summary': return db.prepare(`SELECT COALESCE(g.name,'Ungrouped') groupName,COUNT(p.id) partyCount,COALESCE(SUM(p.openingBalance),0) openingBalance FROM parties p LEFT JOIN groups g ON g.id=p.groupId WHERE p.firmId=? GROUP BY g.id,g.name ORDER BY groupName`).all(firmId);
    case 'outstanding': {
      const parties = db.prepare(`SELECT p.id partyId,p.name partyName,p.type,p.phone,p.gstin,COALESCE(p.openingBalance,0) openingBalance,p.openingBalanceType,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN d.balanceAmount WHEN d.documentType='sale_return' THEN -d.balanceAmount ELSE 0 END),0) receivable,COALESCE(SUM(CASE WHEN d.documentType='purchase_invoice' THEN d.balanceAmount WHEN d.documentType='purchase_return' THEN -d.balanceAmount ELSE 0 END),0) payable FROM parties p LEFT JOIN documents d ON d.partyId=p.id AND d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') WHERE p.firmId=? GROUP BY p.id ORDER BY ABS(receivable-payable) DESC`).all(firmId,firmId) as any[];
      const invoices = db.prepare(`SELECT partyId,documentType,documentDate,dueDate,balanceAmount FROM documents WHERE firmId=? AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentType IN ('sale_invoice','purchase_invoice') AND balanceAmount>0`).all(firmId) as any[];
      const byParty:any = {};
      for (const inv of invoices) {
        const k=String(inv.partyId||''); if(!k) continue;
        const bal=Number(inv.balanceAmount||0); const due=String(inv.dueDate||''); const overdue=!!due && due < new Date().toISOString().slice(0,10);
        if(!byParty[k]) byParty[k]={currentDue:0,overdue:0,oldestDueDate:'',maxOverdueDays:0,overdueInvoiceCount:0};
        if(overdue){ byParty[k].overdue += bal; byParty[k].overdueInvoiceCount += 1; const days=Math.max(0,Math.floor((Date.parse(new Date().toISOString().slice(0,10))-Date.parse(due))/86400000)); byParty[k].maxOverdueDays=Math.max(byParty[k].maxOverdueDays,days); if(!byParty[k].oldestDueDate || due<byParty[k].oldestDueDate) byParty[k].oldestDueDate=due; }
        else byParty[k].currentDue += bal;
      }
      return parties.map((p:any)=>({...p,...(byParty[String(p.partyId)]||{currentDue:0,overdue:0,oldestDueDate:'',maxOverdueDays:0,overdueInvoiceCount:0}),invoiceCount: invoices.filter((x:any)=>String(x.partyId||'')===String(p.partyId)).length}));
    }
    case 'receipt': return db.prepare(`SELECT * FROM payments WHERE firmId=? AND type='payment_in' AND paymentDate BETWEEN ? AND ? ORDER BY paymentDate DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31');
    case 'payment': return db.prepare(`SELECT * FROM payments WHERE firmId=? AND type='payment_out' AND paymentDate BETWEEN ? AND ? ORDER BY paymentDate DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31');
    case 'debit_note': return docRows(firmId,q,['purchase_return']);
    case 'credit_note': return docRows(firmId,q,['sale_return']);
    case 'profit_loss': {
      const s=docRows(firmId,q,['sale_invoice']); const sr=docRows(firmId,q,['sale_return']); const pu=docRows(firmId,q,['purchase_invoice']);
      const ex=db.prepare(`SELECT COALESCE(SUM(CASE WHEN COALESCE(c.accountGroup,'Direct Expenses')='Direct Expenses' THEN e.amount ELSE 0 END),0) directExpenses,COALESCE(SUM(CASE WHEN COALESCE(c.accountGroup,'Direct Expenses')='Indirect Expenses' THEN e.amount ELSE 0 END),0) indirectExpenses FROM expenses e LEFT JOIN categories c ON c.id=e.categoryId WHERE e.firmId=? AND COALESCE(e.isDeleted,0)=0 AND e.date BETWEEN ? AND ?`).get(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31') as any;
      const sales=s.reduce((a,r)=>a+Number(r.total||0),0), returns=sr.reduce((a,r)=>a+Number(r.total||0),0), purchases=pu.reduce((a,r)=>a+Number(r.total||0),0), directExpenses=Number(ex?.directExpenses||0), indirectExpenses=Number(ex?.indirectExpenses||0), expenses=directExpenses+indirectExpenses;
      const gross=calculatePeriodGrossProfit(firmId,q.startDate,q.endDate); return [{sales, saleReturns:returns, netSales:sales-returns, purchases, grossProfit:gross, directExpenses, indirectExpenses, expenses, netProfit:gross-expenses}];
    }
    case 'balance_sheet': {
      const out=genericReport(firmId,'outstanding',q) as any[]; const rec=out.reduce((a,r)=>a+Math.max(0,Number(r.receivable||0)-Number(r.openingBalanceType==='credit'?r.openingBalance:0)),0); const pay=out.reduce((a,r)=>a+Math.max(0,Number(r.payable||0)+Number(r.openingBalanceType==='credit'?r.openingBalance:0)),0);
      const cash=(db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='payment_in' THEN amount ELSE -amount END),0) v FROM payments WHERE firmId=? AND paymentDate<=?`).get(firmId,q.endDate||'9999-12-31') as any)?.v||0;
      const bank=(db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END),0)+COALESCE((SELECT SUM(openingBalance) FROM bank_accounts WHERE firmId=?),0) v FROM bank_transactions WHERE firmId=? AND date<=?`).get(firmId,firmId,q.endDate||'9999-12-31') as any)?.v||0;
      const inv=(db.prepare(`SELECT COALESCE(SUM(currentStock*purchasePrice),0) v FROM items WHERE firmId=? AND isActive=1`).get(firmId) as any)?.v||0;
      return [{asset:'Receivables',amount:rec},{asset:'Inventory',amount:inv},{asset:'Cash',amount:Number(cash)},{asset:'Bank',amount:Number(bank)},{liability:'Payables',amount:pay},{liability:'Balancing Capital / Equity',amount:rec+inv+Number(cash)+Number(bank)-pay}];
    }
    case 'reorder': case 'shortage': case 'minimum_stock': case 'maximum_stock': case 'stock_status': {
      let extra=''; if(reportId==='reorder'||reportId==='shortage'||reportId==='minimum_stock')extra=' AND i.currentStock<=i.minStockLevel'; if(reportId==='maximum_stock')extra=' AND i.currentStock>0 AND i.currentStock>=i.minStockLevel*2';
      if(q.search)extra+=' AND i.name LIKE '+JSON.stringify('%'+q.search+'%');
      return db.prepare(`SELECT i.id,i.name,i.sku,i.hsnCode,i.packing,i.currentStock,i.openingStock,i.minStockLevel,i.purchasePrice,i.salePrice,(i.currentStock*i.purchasePrice) stockValue,c.name categoryName FROM items i LEFT JOIN categories c ON c.id=i.categoryId WHERE i.firmId=? AND i.isActive=1${extra} ORDER BY i.name`).all(firmId);
    }
    case 'item_ledger': return lineRows(firmId,q,[...sales,...purchases]);
    case 'stock_sales': {
      return db.prepare(`SELECT di.itemId,di.name itemName,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN di.quantity ELSE 0 END),0) qtySold,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN di.amount ELSE 0 END),0) salesValue,COALESCE(SUM(CASE WHEN d.documentType='sale_return' THEN di.quantity ELSE 0 END),0) qtyReturned,COALESCE(SUM(CASE WHEN d.documentType='sale_return' THEN di.amount ELSE 0 END),0) returnValue FROM document_items di JOIN documents d ON d.id=di.documentId WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN ('sale_invoice','sale_return') AND d.documentDate BETWEEN ? AND ? GROUP BY di.itemId,di.name ORDER BY salesValue DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31');
    }
    case 'sales_register': return lineRows(firmId,q,['sale_invoice','sale_return']);
    case 'sales_party': return db.prepare(`SELECT d.partyId,d.partyName,COUNT(*) invoiceCount,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN d.total ELSE 0 END),0) sales,COALESCE(SUM(CASE WHEN d.documentType='sale_return' THEN d.total ELSE 0 END),0) returns,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN d.total ELSE -d.total END),0) netSales FROM documents d WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN ('sale_invoice','sale_return') AND d.documentDate BETWEEN ? AND ? ${q.partyId?'AND d.partyId=?':''} GROUP BY d.partyId,d.partyName ORDER BY netSales DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31',...(q.partyId?[q.partyId]:[]));
    case 'sales_analysis': return db.prepare(`SELECT COALESCE(di.itemId,di.name) itemKey,di.name itemName,COUNT(DISTINCT d.id) invoices,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN di.quantity ELSE 0 END),0) quantitySold,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN di.amount ELSE 0 END),0) salesValue,COALESCE(SUM(CASE WHEN d.documentType='sale_return' THEN di.quantity ELSE 0 END),0) quantityReturned,COALESCE(SUM(CASE WHEN d.documentType='sale_return' THEN di.amount ELSE 0 END),0) returnValue,COALESCE(SUM(CASE WHEN d.documentType='sale_invoice' THEN di.amount-di.taxAmount ELSE -di.amount+di.taxAmount END),0) netValue FROM document_items di JOIN documents d ON d.id=di.documentId WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN ('sale_invoice','sale_return') AND d.documentDate BETWEEN ? AND ? ${q.partyId?'AND d.partyId=?':''} ${q.itemId?'AND di.itemId=?':''} GROUP BY COALESCE(di.itemId,di.name),di.name ORDER BY netValue DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31',...(q.partyId?[q.partyId]:[]),...(q.itemId?[q.itemId]:[]));
    case 'pending_order': return docRows(firmId,q,['sale_order']).filter((r:any)=>!['cancelled','completed','closed'].includes(String(r.status||'').toLowerCase()));
    case 'purchase_register': return lineRows(firmId,q,['purchase_invoice','purchase_return']);
    case 'purchase_party': return db.prepare(`SELECT d.partyId,d.partyName,COUNT(*) invoiceCount,COALESCE(SUM(CASE WHEN d.documentType='purchase_invoice' THEN d.total ELSE 0 END),0) purchases,COALESCE(SUM(CASE WHEN d.documentType='purchase_return' THEN d.total ELSE 0 END),0) returns,COALESCE(SUM(CASE WHEN d.documentType='purchase_invoice' THEN d.total ELSE -d.total END),0) netPurchases FROM documents d WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN ('purchase_invoice','purchase_return') AND d.documentDate BETWEEN ? AND ? ${q.partyId?'AND d.partyId=?':''} GROUP BY d.partyId,d.partyName ORDER BY netPurchases DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31',...(q.partyId?[q.partyId]:[]));
    case 'purchase_analysis': return db.prepare(`SELECT COALESCE(di.itemId,di.name) itemKey,di.name itemName,COUNT(DISTINCT d.id) invoices,COALESCE(SUM(CASE WHEN d.documentType='purchase_invoice' THEN di.quantity ELSE 0 END),0) quantityPurchased,COALESCE(SUM(CASE WHEN d.documentType='purchase_invoice' THEN di.amount ELSE 0 END),0) purchaseValue,COALESCE(SUM(CASE WHEN d.documentType='purchase_return' THEN di.quantity ELSE 0 END),0) quantityReturned,COALESCE(SUM(CASE WHEN d.documentType='purchase_return' THEN di.amount ELSE 0 END),0) returnValue,COALESCE(SUM(CASE WHEN d.documentType='purchase_invoice' THEN di.amount ELSE -di.amount END),0) netValue FROM document_items di JOIN documents d ON d.id=di.documentId WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentType IN ('purchase_invoice','purchase_return') AND d.documentDate BETWEEN ? AND ? ${q.partyId?'AND d.partyId=?':''} ${q.itemId?'AND di.itemId=?':''} GROUP BY COALESCE(di.itemId,di.name),di.name ORDER BY netValue DESC`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31',...(q.partyId?[q.partyId]:[]),...(q.itemId?[q.itemId]:[]));
    case 'purchase_pending': return docRows(firmId,q,['purchase_order']).filter((r:any)=>String(r.documentSubtype||'')!=='purchase_challan' && !['cancelled','completed','closed'].includes(String(r.status||'').toLowerCase()));
    case 'batch_stock': return db.prepare(`SELECT b.*,i.name itemName,i.sku,i.hsnCode,c.name categoryName FROM inventory_batches b JOIN items i ON i.id=b.itemId LEFT JOIN categories c ON c.id=i.categoryId WHERE b.firmId=? ${q.itemId?'AND b.itemId=?':''} ${q.categoryId?'AND i.categoryId=?':''} ${q.search?'AND (i.name LIKE ? OR b.batchNumber LIKE ?)':''} ORDER BY i.name,b.batchNumber`).all(firmId,...(q.itemId?[q.itemId]:[]),...(q.categoryId?[q.categoryId]:[]),...(q.search?[`%${q.search}%`,`%${q.search}%`]:[]));
    case 'batch_expiry': return db.prepare(`SELECT b.id,b.batchNumber,b.expiryMonth,b.expiryYear,b.expiryDate,b.mfgDate,b.quantity,b.purchaseRate,b.mrp,b.sellingRate,i.name itemName,i.sku FROM inventory_batches b JOIN items i ON i.id=b.itemId WHERE b.firmId=? ${q.itemId?'AND b.itemId=?':''} ORDER BY CASE WHEN b.expiryYear IS NULL OR b.expiryMonth IS NULL THEN 1 ELSE 0 END,b.expiryYear,b.expiryMonth`).all(firmId,...(q.itemId?[q.itemId]:[]));
    case 'gross_profit': {
      const start=String(q.startDate||'0000-01-01'), end=String(q.endDate||'9999-12-31');
      const rows=db.prepare(`SELECT d.id,d.documentNumber,d.documentDate,d.partyName,d.documentType,d.discountAmount,
          di.itemId,di.batchId,di.batchNumber,di.name itemName,di.quantity,di.baseQuantity,di.freeQuantity,di.price,di.amount,di.taxAmount
        FROM document_items di JOIN documents d ON d.id=di.documentId
        WHERE d.firmId=? AND d.documentType IN ('sale_invoice','sale_return') AND d.isDeleted=0
          AND d.status NOT IN ('hold','draft','cancelled') AND d.documentDate BETWEEN ? AND ?
        ORDER BY d.documentDate ASC,d.createdAt ASC`).all(firmId,start,end) as any[];
      const bills:Record<string,any>={};
      for(const r of rows){
        const qty=Number(r.baseQuantity||r.quantity||0)+Math.max(0,Number(r.freeQuantity||0));
        const revenue=Math.max(0,Number(r.amount||0)-Number(r.taxAmount||0));
        const cost=costAtSale(String(firmId),String(r.itemId||''),r.batchId?String(r.batchId):null,r.batchNumber?String(r.batchNumber):null,String(r.documentDate||''))*qty;
        const b=bills[r.id] ||= {id:r.id,documentNumber:r.documentNumber,documentDate:r.documentDate,partyName:r.partyName||'Walk-in',documentType:r.documentType, revenue:0,costOfGoodsSold:0,grossProfit:0,discount:0};
        b.revenue += revenue;
        b.costOfGoodsSold += cost;
      }
      for(const r of rows){
        const b=bills[r.id];
        if(b && b.discount===0) b.discount=Number(r.discountAmount||0);
      }
      const billRows=Object.values(bills).map((b:any)=>{
        const sign=b.documentType==='sale_return'?-1:1;
        const revenue=sign*b.revenue, cost=sign*b.costOfGoodsSold, discount=sign*b.discount;
        const grossProfit=revenue-cost-discount;
        return {...b,revenue,costOfGoodsSold:cost,discount,grossProfit,marginPct:revenue?Number((grossProfit/revenue*100).toFixed(2)):0};
      });
      const grossProfit=billRows.reduce((n:any,b:any)=>n+Number(b.grossProfit||0),0);
      return [{reportTotal:true,documentNumber:'TOTAL',revenue:billRows.reduce((n:any,b:any)=>n+Number(b.revenue||0),0),costOfGoodsSold:billRows.reduce((n:any,b:any)=>n+Number(b.costOfGoodsSold||0),0),grossProfit,marginPct:billRows.reduce((n:any,b:any)=>n+Number(b.revenue||0),0)?Number((grossProfit/billRows.reduce((n:any,b:any)=>n+Number(b.revenue||0),0)*100).toFixed(2)):0}, ...billRows];
    }
    case 'revenue': { const d=docRows(firmId,q,['sale_invoice']); return [{period:q.startDate+' to '+q.endDate,sales:d.reduce((a,r)=>a+Number(r.total||0),0),invoiceCount:d.length}]; }
    case 'top_items': return db.prepare(`SELECT di.itemId,di.name itemName,SUM(di.quantity) quantitySold,SUM(di.amount) salesValue FROM document_items di JOIN documents d ON d.id=di.documentId WHERE d.firmId=? AND d.documentType='sale_invoice' AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentDate BETWEEN ? AND ? GROUP BY di.itemId,di.name ORDER BY salesValue DESC LIMIT 100`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31');
    case 'top_clients': return db.prepare(`SELECT d.partyId,d.partyName,SUM(d.total) total,COUNT(*) invoiceCount FROM documents d WHERE d.firmId=? AND d.documentType='sale_invoice' AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled') AND d.documentDate BETWEEN ? AND ? GROUP BY d.partyId,d.partyName ORDER BY total DESC LIMIT 100`).all(firmId,q.startDate||'0000-01-01',q.endDate||'9999-12-31');
    default: return [];
  }
}

router.get('/catalog', (req:Request,res:Response)=>{try{const {firmId}=req.query;if(!firmId)return res.status(400).json({error:'firmId required'});res.json({success:true,data:{parties:db.prepare(`SELECT id,name,type FROM parties WHERE firmId=? AND isActive=1 ORDER BY name`).all(firmId),items:db.prepare(`SELECT id,name,categoryId FROM items WHERE firmId=? AND isActive=1 ORDER BY name`).all(firmId),categories:db.prepare(`SELECT id,name FROM categories WHERE firmId=? ORDER BY name`).all(firmId)}})}catch(err:any){res.status(500).json({error:err.message})}});

router.get('/all/:reportId', (req:Request,res:Response)=>{try{const {firmId,...q}=req.query as any;if(!firmId)return res.status(400).json({error:'firmId required'});const reportId=String(req.params.reportId);if(!REPORT_LABELS[reportId] && !['gstr1','gstr2','gstr2a_recon','gstr2b_recon','gstr3b','gstr9','gstr4','cmp08','gst_register','gst_internal'].includes(reportId))return res.status(404).json({error:'Unknown report'});let data:any;if(reportId==='gstr1')data=computeGstr1(String(firmId),String(q.startDate),String(q.endDate));else if(reportId==='gstr2')data=computeGstr2(String(firmId),String(q.startDate),String(q.endDate));else if(reportId==='gstr2a_recon')data=computeGstReconciliation(String(firmId),String(q.startDate),String(q.endDate),'2A');else if(reportId==='gstr2b_recon')data=computeGstReconciliation(String(firmId),String(q.startDate),String(q.endDate),'2B');else if(reportId==='gstr3b')data=computeGstr3b(String(firmId),String(q.startDate),String(q.endDate));else if(reportId==='gstr9')data=computeGstr9(String(firmId),String(q.startDate),String(q.endDate));else if(reportId==='gstr4')data=computeGstr4(String(firmId),String(q.startDate),String(q.endDate));else if(reportId==='cmp08')data=computeCompositionReturns(String(firmId),String(q.startDate),String(q.endDate));else if(reportId==='gst_register')data=db.prepare(`SELECT d.documentDate,d.documentNumber,d.documentType,d.partyName,p.gstin partyGstin,d.subtotal,d.taxAmount,d.total,d.status FROM documents d LEFT JOIN parties p ON p.id=d.partyId WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ? ${q.partyId?'AND d.partyId=?':''} ORDER BY d.documentDate,d.documentNumber`).all(firmId,q.startDate,q.endDate,...(q.partyId?[q.partyId]:[]));else if(reportId==='gst_internal')data=db.prepare(`SELECT documentType,COUNT(*) count,COALESCE(SUM(subtotal),0) taxableValue,COALESCE(SUM(taxAmount),0) totalTax,COALESCE(SUM(total),0) totalValue FROM documents WHERE firmId=? AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate BETWEEN ? AND ? GROUP BY documentType`).all(firmId,q.startDate,q.endDate);else data=genericReport(String(firmId),reportId,q);res.json({success:true,reportId,title:REPORT_LABELS[reportId]||reportId,data:Array.isArray(data)?data:[data]});}catch(err:any){res.status(500).json({error:err.message})}});

router.get('/dashboard-item-movement/export', (req: Request, res: Response) => {
  try {
    const { firmId, type, format='xlsx' } = req.query;
    if (!firmId || !type) return res.status(400).json({error:'firmId and type required'});
    if (!['item_fast','item_normal','item_slow'].includes(String(type))) return res.status(400).json({error:'invalid item movement type'});
    const all=itemMovementClassification(String(firmId)).filter((r:any)=>r.movementType===String(type));
    const label=type==='item_fast'?'Fast Moving':type==='item_normal'?'Normal':'Slow Moving';
    const rows=all.map((r:any)=>({
      'Item Name':r.itemName||'', Category:r.category||'', HSN:r.hsnCode||'', Unit:r.unit||'',
      'Current Stock':Number(r.currentStock||0), 'Minimum Stock':Number(r.minStockLevel||0),
      'Sold Last 7 Days':Number(r.soldLast7Days||0), 'Sold Last 30 Days':Number(r.soldLast30Days||0),
      'Item Age (Days)':Number(r.ageDays||0), Movement:label, Reason:r.movementReason||''
    }));
    const base=`BMAX_${label.replace(/\s+/g,'_')}_Items`;
    if(String(format).toLowerCase()==='pdf'){
      const doc:any=new jsPDF({orientation:'landscape'}); doc.setFontSize(15); doc.text(`B-MAX — ${label} Items`,14,14);
      doc.setFontSize(8); doc.text(`${rows.length} items · Live 7-day movement rule`,14,20);
      const cols=Object.keys(rows[0]||{'Item Name':''});
      const body=rows.map((r:any)=>cols.map(c=>String(r[c]??'')));
      (doc as any).autoTable({head:[cols],body,startY:25,styles:{fontSize:7,cellPadding:2},headStyles:{fontSize:7}});
      const buf=Buffer.from(doc.output('arraybuffer')); res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',`attachment; filename="${base}.pdf"`); return res.send(buf);
    }
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows.length?rows:[{'Item Name':'No matching items'}]),label.slice(0,31));
    const out=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${base}.xlsx"`); return res.send(out);
  } catch(err:any){ return res.status(500).json({error:err.message}); }
});

router.get('/all/:reportId/export', (req:Request,res:Response)=>{try{const {firmId,...q}=req.query as any;if(!firmId)return res.status(400).json({error:'firmId required'});const reportId=String(req.params.reportId);let data:any;if(['gstr1','gstr2','gstr2a_recon','gstr2b_recon','gstr3b','gstr9','gstr4','cmp08'].includes(reportId)){const map:any={gstr1:()=>computeGstr1(String(firmId),String(q.startDate),String(q.endDate)),gstr2:()=>computeGstr2(String(firmId),String(q.startDate),String(q.endDate)),gstr2a_recon:()=>computeGstReconciliation(String(firmId),String(q.startDate),String(q.endDate),'2A'),gstr2b_recon:()=>computeGstReconciliation(String(firmId),String(q.startDate),String(q.endDate),'2B'),gstr3b:()=>computeGstr3b(String(firmId),String(q.startDate),String(q.endDate)),gstr9:()=>computeGstr9(String(firmId),String(q.startDate),String(q.endDate)),gstr4:()=>computeGstr4(String(firmId),String(q.startDate),String(q.endDate)),cmp08:()=>computeCompositionReturns(String(firmId),String(q.startDate),String(q.endDate))}; data=map[reportId]();} else if(reportId==='gst_register') data=db.prepare(`SELECT d.documentDate,d.documentNumber,d.documentType,d.partyName,p.gstin partyGstin,d.subtotal,d.taxAmount,d.total,d.status FROM documents d LEFT JOIN parties p ON p.id=d.partyId WHERE d.firmId=? AND d.isDeleted=0 AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ? ${q.partyId?'AND d.partyId=?':''} ORDER BY d.documentDate,d.documentNumber`).all(firmId,q.startDate,q.endDate,...(q.partyId?[q.partyId]:[])); else if(reportId==='gst_internal') data=db.prepare(`SELECT documentType,COUNT(*) count,COALESCE(SUM(subtotal),0) taxableValue,COALESCE(SUM(taxAmount),0) totalTax,COALESCE(SUM(total),0) totalValue FROM documents WHERE firmId=? AND isDeleted=0 AND status NOT IN ('hold','draft','cancelled') AND documentDate BETWEEN ? AND ? GROUP BY documentType`).all(firmId,q.startDate,q.endDate); else data=genericReport(String(firmId),reportId,q); if(!Array.isArray(data))data=[data]; const title=REPORT_LABELS[reportId]||reportId; const format=String(q.format||'xlsx'); const base=`${reportId}_${q.startDate||'start'}_to_${q.endDate||'end'}`; if(format==='pdf'){const doc:any=new jsPDF({orientation:'landscape'});doc.setFontSize(16);doc.text(title,14,14);doc.setFontSize(9);doc.text(`${q.startDate||''} to ${q.endDate||''}`,14,20);const rows=data.slice(0,500);const cols=Object.keys(rows[0]||{Note:'No records'}).slice(0,12);const body=rows.map((r:any)=>cols.map(c=>String(r[c]??'')));(doc as any).autoTable({head:[cols.map(c=>c.replace(/([A-Z])/g,' $1'))],body,startY:25,styles:{fontSize:7,cellPadding:2},headStyles:{fontSize:7}});const buf=Buffer.from(doc.output('arraybuffer'));res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${base}.pdf"`);return res.send(buf);} const wb=XLSX.utils.book_new();const rows=data.length?data:[{Note:'No records found for selected filters.'}];XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Report');const out=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${base}.xlsx"`);return res.send(out);}catch(err:any){res.status(500).json({error:err.message})}});

// Sheet helper: XLSX chokes on a truly empty json_to_sheet() in some versions,
// so an empty section still gets a one-row placeholder instead of no sheet at all.
function sheetOrPlaceholder(rows: any[], emptyNote: string) {
  return XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: emptyNote }]);
}

// GSTR-1 export — Excel (multi-sheet, matches the GSTR-1 tables) or JSON (raw computed data)
router.get('/gstr1/export', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, format = 'xlsx' } = req.query;
    if (!firmId || !startDate || !endDate) return res.status(400).json({ error: 'firmId, startDate and endDate required' });
    const data = computeGstr1(String(firmId), String(startDate), String(endDate));
    const filenameBase = `GSTR1_${startDate}_to_${endDate}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
      return res.send(JSON.stringify(data, null, 2));
    }

    const wb = XLSX.utils.book_new();
    const summaryRows = [
      { Field: 'Firm', Value: data.firm.name || '' },
      { Field: 'GSTIN', Value: data.firm.gstin || '' },
      { Field: 'Period', Value: `${data.period.startDate} to ${data.period.endDate}` },
      { Field: 'Total Invoices', Value: data.summary.totalInvoices },
      { Field: 'Taxable Value', Value: data.summary.taxableValue },
      { Field: 'IGST', Value: data.summary.igst },
      { Field: 'CGST', Value: data.summary.cgst },
      { Field: 'SGST', Value: data.summary.sgst },
      { Field: 'Total Tax', Value: data.summary.totalTax },
      { Field: 'Credit Note Value', Value: data.summary.creditNoteValue },
      { Field: 'Credit Note Tax', Value: data.summary.creditNoteTax },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');
    XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(data.b2b, 'No B2B invoices in this period.'), 'B2B (4A)');
    XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(data.b2cLarge, 'No B2C Large invoices in this period.'), 'B2C Large (5)');
    XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(data.b2cSmall, 'No B2C Small supplies in this period.'), 'B2C Small (7)');
    XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(data.creditNotes, 'No credit notes in this period.'), 'Credit Notes (9B)');
    XLSX.utils.book_append_sheet(wb, sheetOrPlaceholder(data.hsnSummary, 'No items in this period.'), 'HSN Summary (12)');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
    res.send(buf);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GSTR-3B export — Excel (one sheet, table 3.1 / 4 / 6.1) or JSON (raw computed data)
router.get('/gstr3b/export', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, format = 'xlsx' } = req.query;
    if (!firmId || !startDate || !endDate) return res.status(400).json({ error: 'firmId, startDate and endDate required' });
    const data = computeGstr3b(String(firmId), String(startDate), String(endDate));
    const filenameBase = `GSTR3B_${startDate}_to_${endDate}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
      return res.send(JSON.stringify(data, null, 2));
    }

    const rows = [
      { Section: 'Firm', Field: 'Name', Value: data.firm.name || '' },
      { Section: 'Firm', Field: 'GSTIN', Value: data.firm.gstin || '' },
      { Section: 'Firm', Field: 'Period', Value: `${data.period.startDate} to ${data.period.endDate}` },
      { Section: '3.1 Outward Taxable Supplies', Field: 'Taxable Value', Value: data.outwardSupplies.taxableValue },
      { Section: '3.1 Outward Taxable Supplies', Field: 'IGST', Value: data.outwardSupplies.igst },
      { Section: '3.1 Outward Taxable Supplies', Field: 'CGST', Value: data.outwardSupplies.cgst },
      { Section: '3.1 Outward Taxable Supplies', Field: 'SGST', Value: data.outwardSupplies.sgst },
      { Section: '4. Eligible ITC', Field: 'Taxable Value', Value: data.itc.taxableValue },
      { Section: '4. Eligible ITC', Field: 'IGST', Value: data.itc.igst },
      { Section: '4. Eligible ITC', Field: 'CGST', Value: data.itc.cgst },
      { Section: '4. Eligible ITC', Field: 'SGST', Value: data.itc.sgst },
      { Section: '6.1 Net Tax Payable', Field: 'IGST', Value: data.netTaxPayable.igst },
      { Section: '6.1 Net Tax Payable', Field: 'CGST', Value: data.netTaxPayable.cgst },
      { Section: '6.1 Net Tax Payable', Field: 'SGST', Value: data.netTaxPayable.sgst },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'GSTR-3B');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
    res.send(buf);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Party Outstanding Report — one canonical ledger engine for Receivables and Payables.
// Receivables are open sale invoices; Payables are open purchase invoices. A party is
// present only when the live net balance is strictly positive. Party drill-down uses the
// same classification, so the list total and ledger can never disagree on document type.
router.get('/party-outstanding', (req: Request, res: Response) => {
  try {
    const firmId=String(req.query.firmId||'').trim();
    const partyType=String(req.query.partyType||'').trim();
    const partyId=String(req.query.partyId||'').trim();
    const partyName=String(req.query.partyName||'').trim();
    if(!firmId) return res.status(400).json({error:'firmId required'});
    if(!['customer','supplier'].includes(partyType)) return res.status(400).json({error:'partyType must be customer or supplier'});

    const today=new Date().toISOString().slice(0,10);
    const documentType=partyType==='customer'?'sale_invoice':'purchase_invoice';
    const base=`d.firmId=? AND d.documentType=? AND d.balanceAmount>0.000001 AND d.isDeleted=0 AND d.status NOT IN ('hold','draft','cancelled')`;

    if(partyId || partyName){
      const whereParty = partyId
        ? `(CAST(d.partyId AS TEXT)=? OR (d.partyId IS NULL AND LOWER(TRIM(COALESCE(d.partyName,'')))=LOWER(TRIM(?))))`
        : `LOWER(TRIM(COALESCE(d.partyName,'')))=LOWER(TRIM(?))`;
      const ps:any[]=[firmId,documentType];
      if(partyId) ps.push(partyId,partyName); else ps.push(partyName);
      const q=`SELECT d.id,d.partyId,d.partyName,d.partyType,d.documentType,d.documentNumber,d.documentDate,d.dueDate,
        COALESCE(d.total,0) invoiceValue,COALESCE(d.paidAmount,0) receivedAmount,
        COALESCE(d.adjustment,0) adjustmentAmount,COALESCE(d.balanceAmount,0) outstandingAmount
        FROM documents d WHERE ${base} AND ${whereParty}
        ORDER BY d.documentDate ASC,d.createdAt ASC,d.id ASC`;
      const rows:any[]=db.prepare(q).all(...ps).map((r:any)=>{
        const due=String(r.dueDate||'');
        const doc=String(r.documentDate||'');
        const bal=Math.max(0,Number(r.outstandingAmount||0));
        const overdue=!!due && due<today && bal>0;
        const ageDays=doc?Math.max(0,Math.floor((Date.parse(today)-Date.parse(doc))/86400000)):0;
        const overdueDays=overdue?Math.max(0,Math.floor((Date.parse(today)-Date.parse(due))/86400000)):0;
        const invoiceType=documentType==='sale_invoice'?'Sales Invoice':'Purchase Invoice';
        return {...r,invoiceType,netDue:bal,overdueAmount:overdue?bal:0,ageDays,overdueDays,statusLabel:overdue?'Overdue':'Current'};
      });
      const summary=rows.reduce((a:any,r:any)=>{
        a.invoiceCount+=1;
        a.invoiceValue+=Number(r.invoiceValue||0);
        a.receivedAmount+=Number(r.receivedAmount||0);
        a.adjustmentAmount+=Number(r.adjustmentAmount||0);
        a.outstandingAmount+=Number(r.netDue||0);
        a.overdueAmount+=Number(r.overdueAmount||0);
        return a;
      },{invoiceCount:0,invoiceValue:0,receivedAmount:0,adjustmentAmount:0,outstandingAmount:0,overdueAmount:0});
      const canonicalPartyName=rows[0]?.partyName||partyName;
      return res.json({success:true,data:{partyId,partyType,partyName:canonicalPartyName,summary,rows}});
    }

    const q=`SELECT d.partyId,d.partyName,d.dueDate,COALESCE(d.balanceAmount,0) balanceAmount
      FROM documents d WHERE ${base}`;
    const docs:any[]=db.prepare(q).all(firmId,documentType);
    const grouped:Record<string,any>={};
    for(const d of docs){
      const partyKey=d.partyId?`id:${String(d.partyId)}`:`name:${String(d.partyName||'').trim().toLowerCase()}`;
      if(!grouped[partyKey]) grouped[partyKey]={partyId:d.partyId||null,partyName:d.partyName||'—',outstanding:0,overdueOutstanding:0};
      const bal=Math.max(0,Number(d.balanceAmount||0));
      grouped[partyKey].outstanding+=bal;
      if(String(d.dueDate||'') && String(d.dueDate)<today) grouped[partyKey].overdueOutstanding+=bal;
    }
    const rows=Object.values(grouped)
      .filter((r:any)=>Number(r.outstanding)>0.000001)
      .map((r:any)=>({...r,outstanding:Number(r.outstanding.toFixed(2)),overdueOutstanding:Number(r.overdueOutstanding.toFixed(2))}))
      .sort((x:any,y:any)=>y.outstanding-x.outstanding);
    const totals=rows.reduce((a:any,r:any)=>({outstanding:a.outstanding+Number(r.outstanding||0),overdueOutstanding:a.overdueOutstanding+Number(r.overdueOutstanding||0)}),{outstanding:0,overdueOutstanding:0});
    return res.json({success:true,data:{rows,totals}});
  } catch(err:any){
    console.error('[OutstandingReport] failed:',err);
    return res.status(500).json({error:err?.message||'Unable to load outstanding report'});
  }
});

// Day Book
router.get('/day-book', (req: Request, res: Response) => {
  try {
    const { firmId, date, startDate, endDate } = req.query as any;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const start=String(startDate||date||new Date().toISOString().slice(0,10));
    const end=String(endDate||date||start);
    const data=genericReport(String(firmId),'day_book',{startDate:start,endDate:end});
    res.json({ success: true, data });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;



