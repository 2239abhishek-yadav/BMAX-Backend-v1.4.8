import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, ensureCashCustomer } from '../lib/db';
import { generateSeriesNumber } from './series.routes';
import { getModuleSettings, getNegativeStockAllowed, syncNegativeStockFromRequest } from '../lib/moduleSettings';
import { crmEarnPoints } from '../lib/crm';
import { recalcDocumentStatus, applyFunds } from '../lib/ledger';
import { validateMobile } from '../lib/validators';
import { expiryFromLegacyDate, parseExpiryInput, normalizeExpiryMonth, normalizeExpiryYear } from '../lib/batchExpiry';
import { assertDocumentItemQuantities } from '../lib/quantityPolicy';

const router = Router();

const DUE_DATE_DOCUMENT_TYPES = ['sale_invoice','purchase_invoice','sale_order','purchase_order','delivery_challan','purchase_return','sale_return'];
const VALID_GST_SLABS = [0, 5, 18];

// Batch/expiry details are operational inventory attributes, not order/quotation
// attributes. They become relevant when an actual invoice/challan/return moves
// stock. Planning documents deliberately store no batch/expiry metadata.
const BATCH_DETAIL_DOCUMENT_TYPES = new Set([
  'sale_invoice','purchase_invoice','delivery_challan','purchase_challan',
  'sale_return','sale_return_challan','purchase_return','purchase_return_challan'
]);
const allowsBatchDetails = (documentType:string) => BATCH_DETAIL_DOCUMENT_TYPES.has(String(documentType || ''));

const AUDIT_FIELDS = ['documentDate','entryDate','documentTime','partyName','partyId','partyType','transactionType','status','subtotal','discountAmount','discountPercentage','taxAmount','shippingCharges','packagingCharges','adjustment','roundOff','total','paidAmount','balanceAmount','paymentType','bankId','poNumber','poDate','description','dueDate','ewaybillNo','vehicleNumber','transportName','deliveryDate'];
function auditSnapshot(doc:any,items:any[]=[]){const s:any={}; for(const k of AUDIT_FIELDS)s[k]=doc?.[k]??null; s.items=(items||[]).map((x:any)=>({id:x.id,itemId:x.itemId,name:x.name,quantity:x.quantity,price:x.price,discount:x.discount,discountPercentage:x.discountPercentage,discountAmount:x.discountAmount,taxRate:x.taxRate,amount:x.amount,batchNumber:x.batchNumber||null})); return s;}
function auditDiff(a:any,b:any){const c:any={}; for(const k of AUDIT_FIELDS)if(String(a?.[k]??'')!==String(b?.[k]??''))c[k]={old:a?.[k]??null,new:b?.[k]??null}; const rates=(s:any)=>(s?.items||[]).map((x:any)=>`${x.name||x.itemId||'Item'}: ${Number(x.price||0).toFixed(2)}`).join(' | '); if(rates(a)!==rates(b))c['Item Rates']={old:rates(a)||'—',new:rates(b)||'—'}; const qty=(s:any)=>(s?.items||[]).map((x:any)=>`${x.name||x.itemId||'Item'}: ${Number(x.quantity||0)}`).join(' | '); if(qty(a)!==qty(b))c['Item Quantities']={old:qty(a)||'—',new:qty(b)||'—'}; return c;}
function writeDocumentAudit(documentId:string,firmId:string,action:string,oldDoc:any,oldItems:any[],newDoc:any,newItems:any[],req:any,note?:string){const changes=action==='MODIFIED'?auditDiff(auditSnapshot(oldDoc,oldItems),auditSnapshot(newDoc,newItems)):action==='CREATED'?{documentNumber:{old:null,new:newDoc?.documentNumber||null},total:{old:null,new:newDoc?.total??0}}:{documentNumber:{old:oldDoc?.documentNumber||null,new:null},total:{old:oldDoc?.total??0,new:null}}; db.prepare(`INSERT INTO document_audit_logs (id,firmId,documentId,action,changesJson,note,actorId,actorName,createdAt) VALUES (?,?,?,?,?,?,?,?,?)`).run(uuidv4(),firmId,documentId,action,JSON.stringify(changes),note||null,req?.body?.userId||req?.user?.id||null,req?.body?.userName||req?.user?.name||'System',new Date().toISOString());}

function firmTaxConfig(firmId:string){ const f:any=db.prepare('SELECT gstType,vatRate FROM firms WHERE id=?').get(firmId); const mode=String(f?.gstType||'regular'); return {mode, enabled:mode!=='none', vatRate:Number(f?.vatRate||5)}; }
function validateLineTax(firmId:string, rate:number){ const c=firmTaxConfig(firmId); if(!c.enabled && rate!==0) throw new Error('Tax must be 0% when No GST is selected'); if(c.mode==='vat'){ if(!Number.isFinite(rate)||rate<0||rate>100) throw new Error('VAT rate must be between 0% and 100%'); return; } if(!VALID_GST_SLABS.includes(rate)) throw new Error('GST rate must be one of 0%, 5% or 18%'); }
function lineExpiry(item:any): { month:number|null; year:number|null } {
  const parsed=parseExpiryInput(item?.expiryDate);
  const legacy=expiryFromLegacyDate(item?.expiryDate);
  return { month: normalizeExpiryMonth(item?.expiryMonth) ?? parsed.month ?? legacy.month, year: normalizeExpiryYear(item?.expiryYear) ?? parsed.year ?? legacy.year };
}

// Firm-wide stock policy: negative stock is OFF by default. When disabled,
// every stock-decreasing transaction must have enough current stock.
function isNegativeStockAllowed(firmId: string): boolean { return getNegativeStockAllowed(firmId); }


function isStoreStockDocument(documentType: string): boolean {
  return ['sale_invoice','sale_order','delivery_challan','sale_return','sale_return_challan','purchase_invoice','purchase_order','purchase_return','purchase_return_challan'].includes(documentType);
}
function isPurchaseChallan(documentType: string, documentSubtype?: string|null): boolean {
  return documentType === 'purchase_order' && String(documentSubtype || '') === 'purchase_challan';
}

function addDaysDate(dateStr: string, days: number): string | null { const d=new Date(`${String(dateStr||'').slice(0,10)}T00:00:00`); if(!Number.isFinite(d.getTime())) return null; d.setDate(d.getDate()+Math.max(0,Number(days)||0)); return d.toISOString().slice(0,10); }

function storeStockDelta(documentType: string, baseQuantity: number, freeQuantity = 0, documentSubtype?: string|null): number {
  const q = Math.max(0, Number(baseQuantity) || 0);
  const free = Math.max(0, Number(freeQuantity) || 0);
  if (['sale_invoice','sale_order','delivery_challan'].includes(documentType) && !isPurchaseChallan(documentType, documentSubtype)) return -(q + free);
  if (['purchase_return','purchase_return_challan'].includes(documentType)) return -q;
  if (['purchase_invoice','purchase_order'].includes(documentType)) return q + free;
  if (['sale_return','sale_return_challan'].includes(documentType)) return q;
  return 0;
}

function validateStockForDocumentLines(firmId: string, documentType: string, items: any[], rawGodownId: string | null = null) {
  const stockDecrease = ['sale_invoice','sale_order','delivery_challan','purchase_return','purchase_return_challan'].includes(documentType);
  const strictReturn = ['purchase_return','purchase_return_challan'].includes(documentType);
  // Purchase returns are always stock-controlled: the global negative-stock
  // setting must never allow returning more stock than is available.
  if (!stockDecrease || (isNegativeStockAllowed(firmId) && !strictReturn)) return;
  for (const line of Array.isArray(items) ? items : []) {
    if (!line?.itemId) continue;
    const dbItem:any = db.prepare('SELECT name,currentStock,decimalEnabled FROM items WHERE id=? AND firmId=? AND isActive=1').get(line.itemId, firmId);
    if (!dbItem) throw new Error(`Item not found or inactive: ${line.name || line.itemId}`);
    assertDocumentItemQuantities(dbItem, line);
    const resolved = resolveLineUnit(firmId, documentType, dbItem, line);
    const qty = Number(resolved.baseQuantity || 0);
    const schemeFree = ['sale_invoice','sale_order','delivery_challan'].includes(documentType) ? Math.max(0, Number(line.freeQuantity) || 0) : 0;
    const requiredQty = qty + schemeFree;
    if (qty <= 0) continue;
    const available = Number(dbItem.currentStock || 0);
    if (available - requiredQty < -0.0001) throw new Error(`Insufficient stock for ${dbItem.name || line.name}. Available: ${available}, Required: ${requiredQty}`);
    if (line.batchId || line.batchNumber) {
      const b:any = line.batchId
        ? db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(line.batchId,firmId,line.itemId)
        : db.prepare('SELECT quantity FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=?').get(firmId,line.itemId,String(line.batchNumber).trim());
      if (!b) throw new Error(`Selected batch not found for ${dbItem.name || line.name}`);
      if (Number(b.quantity || 0) - requiredQty < -0.0001) throw new Error(`Insufficient batch stock for ${dbItem.name || line.name} / ${line.batchNumber || line.batchId}`);
    }
    const gid = line.godownId || rawGodownId || null;
    if (gid) {
      const sr:any = db.prepare('SELECT quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,line.itemId,gid);
      if (Number(sr?.quantity || 0) - requiredQty < -0.0001) throw new Error(`Insufficient stock for ${dbItem.name || line.name} in selected store. Available: ${Number(sr?.quantity||0)}, Required: ${requiredQty}`);
    }
  }
}

function purchaseAutoNumber(firmId: string, documentType: string, now: string): string {
  const cfg:any = {
    purchase_invoice: { prefix: 'PB' },
    purchase_order: { prefix: 'PO' },
    purchase_challan: { prefix: 'PC' },
    purchase_return: { prefix: 'PR' },
    purchase_return_challan: { prefix: 'PRC' },
  }[documentType] || { prefix: 'PUR' };
  const row:any = db.prepare('SELECT * FROM document_number_counters WHERE firmId=? AND documentType=?').get(firmId, documentType);
  if (!row) {
    db.prepare('INSERT INTO document_number_counters(id,firmId,documentType,prefix,nextNumber,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      .run(uuidv4(), firmId, documentType, cfg.prefix, 2, now, now);
    return `${cfg.prefix}-${String(1).padStart(4,'0')}`;
  }
  const n = Math.max(1, Number(row.nextNumber) || 1);
  db.prepare('UPDATE document_number_counters SET nextNumber=?,updatedAt=? WHERE id=?').run(n + 1, now, row.id);
  return `${row.prefix || cfg.prefix}-${String(n).padStart(4,'0')}`;
}

function validateReturnReference(firmId:string, documentType:string, referenceDocumentId:string|null|undefined, items:any[], excludeDocumentId:string|null = null) {
  if (!['purchase_return','sale_return','purchase_return_challan','sale_return_challan'].includes(documentType) || !referenceDocumentId) return;
  const original:any = db.prepare('SELECT id,documentType,partyId,isDeleted,status FROM documents WHERE id=? AND firmId=?').get(referenceDocumentId, firmId);
  const expectedTypes = documentType === 'purchase_return' || documentType === 'purchase_return_challan' ? ['purchase_invoice','purchase_order'] : ['sale_invoice','delivery_challan'];
  const validPurchaseChallan = expectedTypes.includes(String(original?.documentType||'')) && String(original?.documentType||'')==='purchase_order' && String(original?.documentSubtype||'')==='purchase_challan';
  const validExpected = expectedTypes.includes(String(original?.documentType||'')) && (String(original?.documentType||'')!=='purchase_order' || validPurchaseChallan);
  if (!original || Number(original.isDeleted||0)===1 || !validExpected || ['cancelled','draft','hold'].includes(String(original.status||''))) {
    throw new Error(`Invalid original ${documentType.startsWith('purchase_') ? 'purchase bill/challan' : 'sales invoice/challan'} reference`);
  }
  const sourceItems:any[] = db.prepare('SELECT itemId,baseQuantity,quantity,batchId,batchNumber FROM document_items WHERE documentId=?').all(referenceDocumentId);
  const returnedSql = `SELECT di.itemId, COALESCE(di.batchId,'') batchId, COALESCE(di.batchNumber,'') batchNumber, COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty
    FROM documents d JOIN document_items di ON di.documentId=d.id
    WHERE d.firmId=? AND d.referenceDocumentId=? AND d.documentType=? AND d.isDeleted=0
      AND d.status NOT IN ('cancelled','draft','hold') ${excludeDocumentId ? 'AND d.id<>?' : ''}
    GROUP BY di.itemId,COALESCE(di.batchId,''),COALESCE(di.batchNumber,'')`;
  const params:any[]=[firmId, referenceDocumentId, documentType]; if (excludeDocumentId) params.push(excludeDocumentId);
  const returned:any[]=db.prepare(returnedSql).all(...params);
  const already = new Map(returned.map(r=>[`${r.itemId}|${r.batchId}|${r.batchNumber}`, Number(r.qty||0)]));
  const originalQty = new Map(sourceItems.map(r=>[`${r.itemId}|${r.batchId||''}|${r.batchNumber||''}`, Number(r.baseQuantity ?? r.quantity ?? 0)]));
  for (const line of Array.isArray(items)?items:[]) {
    if (!line?.itemId) continue;
    const requested = Math.max(0, Number(line.baseQuantity ?? line.quantity) || 0);
    if (requested <= 0) continue;
    const key=`${line.itemId}|${line.batchId||''}|${line.batchNumber||''}`;
    const allowed = Math.max(0, Number(originalQty.get(key)||0) - Number(already.get(key)||0));
    if (requested > allowed + 0.0001) {
      throw new Error(`Return quantity for ${line.name || line.itemId} exceeds pending return quantity. Allowed: ${allowed}, Requested: ${requested}`);
    }
  }
}

function applyStoreStock(firmId: string, itemId: string, godownId: string | null, delta: number, itemName: string, allowNegative: boolean, now: string) {
  if (!godownId || !delta) return;
  const godown = db.prepare('SELECT id FROM godowns WHERE id=? AND firmId=? AND COALESCE(isActive,1)=1').get(godownId, firmId);
  if (!godown) throw new Error(`Store/Godown not found for ${itemName}`);
  const row:any = db.prepare('SELECT id,quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,itemId,godownId);
  const next = Number(row?.quantity || 0) + Number(delta);
  if (delta < 0 && !allowNegative && next < -0.0001) throw new Error(`Insufficient stock for ${itemName} in selected store. Available: ${Number(row?.quantity || 0)}, Required: ${Math.abs(delta)}`);
  if (row) db.prepare('UPDATE inventory_stock SET quantity=?,updatedAt=? WHERE id=?').run(next,now,row.id);
  else db.prepare('INSERT INTO inventory_stock(id,firmId,itemId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?)').run(uuidv4(),firmId,itemId,godownId,next,now);
}

/**
 * Two Units + Conversion
 * -----------------------
 * A document line may be sold/purchased in an item's base unit (Unit 1) or its
 * secondary/larger unit (Unit 2) — e.g. sell in Strips while stock is tracked in
 * Tablets. This resolves whichever unit was picked on the line into a base-unit
 * quantity, which is what all stock math (items.currentStock) is keyed on — so
 * stock stays accurate regardless of which unit a given sale/purchase used.
 *
 * Respects the module's `unitsEnabled` setting: when a module has Units &
 * Conversion disabled, every line is treated as base-unit quantity (legacy
 * behavior), even if a secondary unit was somehow supplied.
 */
function resolveLineUnit(firmId: string, documentType: string, item: any, line: any) {
  const qty1 = parseFloat(line.quantity) || 0;
  const qty2 = parseFloat(line.secondaryQuantity) || 0;
  const unitsEnabled = getModuleSettings(firmId, documentType).unitsEnabled;
  if (!unitsEnabled || !item) return { baseQuantity: qty1, isSecondaryUnit: 0, unitId: item?.unitId || line.unitId || null, secondaryQuantity: 0, secondaryUnitId: null };
  const factor = parseFloat(item.conversionFactor) || 1;
  const hasSecondary = item.secondaryUnitId && qty2 > 0;
  const baseQuantity = +(qty1 + (hasSecondary ? qty2 * factor : 0)).toFixed(4);
  return { baseQuantity, isSecondaryUnit: hasSecondary && qty1 === 0 ? 1 : 0, unitId: item.unitId || line.unitId || null, secondaryQuantity: qty2, secondaryUnitId: hasSecondary ? item.secondaryUnitId : null };
}

// Pending source-document helpers. Remaining quantity is calculated from exact
// sourceDocumentId/sourceDocumentItemId links written on converted invoice lines.
function pendingSourceTypes(kind:string): {documentType:string, documentSubtype?:string}|null {
  if (kind==='sale_order') return {documentType:'sale_order'};
  if (kind==='delivery_challan') return {documentType:'delivery_challan'};
  if (kind==='purchase_order') return {documentType:'purchase_order'};
  if (kind==='purchase_challan') return {documentType:'purchase_order', documentSubtype:'purchase_challan'};
  return null;
}
function getPendingSourceDocuments(firmId:string, kind:string, partyId:string) {
  const spec=pendingSourceTypes(kind); if(!spec) throw new Error('Invalid pending document type');
  let sql=`SELECT * FROM documents WHERE firmId=? AND isDeleted=0 AND partyId=? AND documentType=?`;
  const params:any[]=[firmId,partyId,spec.documentType];
  if (spec.documentSubtype) { sql += ` AND documentSubtype=?`; params.push(spec.documentSubtype); }
  else if (spec.documentType==='purchase_order') sql += ` AND COALESCE(documentSubtype,'') <> 'purchase_challan'`;
  sql += ` ORDER BY documentDate DESC, createdAt DESC`;
  const docs:any[]=db.prepare(sql).all(...params) as any[];
  return docs.filter(d=>!['cancelled','completed','closed'].includes(String(d.status||'').toLowerCase())).map(d=>{
    const items:any[]=db.prepare('SELECT * FROM document_items WHERE documentId=? ORDER BY createdAt').all(d.id) as any[];
    const remainingItems=items.map(it=>{
      const original=Math.max(0,Number(it.baseQuantity ?? it.quantity ?? 0));
      const allocated=Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty FROM document_items di JOIN documents td ON td.id=di.documentId WHERE td.firmId=? AND td.isDeleted=0 AND td.status NOT IN ('cancelled','draft','hold') AND di.sourceDocumentId=? AND di.sourceDocumentItemId=?`).get(firmId,d.id,it.id) as any)?.qty||0);
      return {...it, pendingQuantity:Math.max(0,original-allocated), originalQuantity:original, convertedQuantity:Math.max(0,allocated)};
    }).filter(it=>it.pendingQuantity>0.0001);
    return {...d, items:remainingItems, pendingItemCount:remainingItems.length, pendingQuantity:remainingItems.reduce((a:number,x:any)=>a+Number(x.pendingQuantity||0),0)};
  }).filter(d=>d.items.length);
}

router.get('/pending-references', (req: Request, res: Response) => {
  try {
    const {firmId, partyId, kind} = req.query;
    if(!firmId || !partyId || !kind) return res.status(400).json({error:'firmId, partyId and kind are required'});
    const docs=getPendingSourceDocuments(String(firmId),String(kind),String(partyId));
    res.json({success:true,data:docs,count:docs.length});
  } catch(err:any){ res.status(500).json({error:err.message}); }
});

// GET paginated documents
router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, documentType, partyId, search, startDate, endDate, status, page = '1', limit = '50' } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });

    let query = 'SELECT d.*, p.partyKind AS partyKind FROM documents d LEFT JOIN parties p ON p.id=d.partyId WHERE d.firmId = ? AND d.isDeleted = 0';
    const params: any[] = [firmId];

    const isProformaQuery = String(documentType || '') === 'sale_proforma';
    if (isProformaQuery) { query += " AND documentType = 'sale_quotation' AND documentSubtype = 'proforma'"; }
    else if (documentType === 'sale_quotation') { query += " AND documentType = 'sale_quotation' AND COALESCE(documentSubtype, '') <> 'proforma'"; }
    else if (documentType === 'purchase_challan') { query += " AND documentType = 'purchase_order' AND documentSubtype = 'purchase_challan'"; }
    else if (documentType === 'purchase_order') { query += " AND documentType = 'purchase_order' AND COALESCE(documentSubtype, '') <> 'purchase_challan'"; }
    else if (documentType) { query += ' AND documentType = ?'; params.push(documentType); }
    if (partyId) { query += ' AND partyId = ?'; params.push(partyId); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (startDate) { query += ' AND documentDate >= ?'; params.push(startDate); }
    if (endDate) { query += ' AND documentDate <= ?'; params.push(endDate); }
    if (search) { query += ' AND (documentNumber LIKE ? OR partyName LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    // Count
    let countSql = `SELECT COUNT(*) as total FROM documents WHERE firmId = ? AND isDeleted = 0`;
    const countParams:any[] = [firmId];
    if (isProformaQuery) countSql += " AND documentType='sale_quotation' AND documentSubtype='proforma'";
    else if (documentType === 'sale_quotation') countSql += " AND documentType='sale_quotation' AND COALESCE(documentSubtype,'')<>'proforma'";
    else if (documentType === 'purchase_challan') countSql += " AND documentType='purchase_order' AND documentSubtype='purchase_challan'";
    else if (documentType === 'purchase_order') countSql += " AND documentType='purchase_order' AND COALESCE(documentSubtype,'')<>'purchase_challan'";
    else if (documentType) { countSql += ' AND documentType=?'; countParams.push(documentType); }
    const countResult = db.prepare(countSql).get(...countParams) as any;

    query += ' ORDER BY documentDate DESC, createdAt DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), (Number(page) - 1) * Number(limit));

    const documents = db.prepare(query).all(...params);
    res.json({ success: true, data: documents, total: countResult?.total || 0 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Return-source documents: only documents with a non-zero returnable quantity are shown.
// Matching is item + batch aware, so a fully returned batch/line disappears while another
// batch of the same item can still be returned.
router.get('/return-references', (req: Request, res: Response) => {
  try {
    const { firmId, partyId, side = 'sale', source = 'invoice' } = req.query;
    if (!firmId || !partyId) return res.status(400).json({ error: 'firmId and partyId required' });
    const isPurchase = String(side) === 'purchase';
    const sourceType = isPurchase
      ? (String(source)==='challan' ? 'purchase_challan' : 'purchase_invoice')
      : (String(source)==='challan' ? 'delivery_challan' : 'sale_invoice');
    let sources:any[]=[];
    if (sourceType==='purchase_challan') {
      sources = db.prepare(`SELECT * FROM documents WHERE firmId=? AND partyId=? AND isDeleted=0 AND documentType='purchase_order' AND documentSubtype='purchase_challan' AND status NOT IN ('cancelled','draft','hold') ORDER BY documentDate DESC,createdAt DESC`).all(firmId,partyId);
    } else {
      sources = db.prepare(`SELECT * FROM documents WHERE firmId=? AND partyId=? AND isDeleted=0 AND documentType=? AND status NOT IN ('cancelled','draft','hold') ORDER BY documentDate DESC,createdAt DESC`).all(firmId,partyId,sourceType);
    }
    const out:any[]=[];
    for (const d of sources) {
      const src:any[] = db.prepare('SELECT * FROM document_items WHERE documentId=? AND itemId IS NOT NULL').all(d.id);
      const ret:any[] = db.prepare(`SELECT di.itemId, COALESCE(di.batchId,'') batchId, COALESCE(di.batchNumber,'') batchNumber, COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty
        FROM documents rd JOIN document_items di ON di.documentId=rd.id
        WHERE rd.firmId=? AND rd.referenceDocumentId=? AND rd.isDeleted=0 AND rd.status NOT IN ('cancelled','draft','hold')
          AND rd.documentType IN ('sale_return','purchase_return','sale_return_challan','purchase_return_challan')
        GROUP BY di.itemId,COALESCE(di.batchId,''),COALESCE(di.batchNumber,'')`).all(firmId,d.id);
      const used=new Map(ret.map((r:any)=>[`${r.itemId}|${r.batchId}|${r.batchNumber}`,Number(r.qty||0)]));
      const remaining=src.map((x:any)=>{const key=`${x.itemId}|${x.batchId||''}|${x.batchNumber||''}`;const original=Number(x.baseQuantity??x.quantity??0);const returned=Number(used.get(key)||0);return {...x,returnableQuantity:Math.max(0,+(original-returned).toFixed(4))};}).filter((x:any)=>x.returnableQuantity>0.0001);
      if(remaining.length) out.push({...d,documentType:sourceType,items:remaining,returnableTotal:remaining.reduce((s:number,x:any)=>s+x.returnableQuantity,0)});
    }
    res.json({success:true,data:out});
  } catch(err:any){res.status(500).json({error:err.message});}
});

// GET deleted documents for the Recycle Bin
router.get('/recycle-bin', (req: Request, res: Response) => {
  try {
    const { firmId, search } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    let q = 'SELECT * FROM documents WHERE firmId=? AND isDeleted=1'; const p:any[]=[firmId];
    if(search){ q += ' AND (documentNumber LIKE ? OR partyName LIKE ? OR documentType LIKE ?)'; const x=`%${search}%`; p.push(x,x,x); }
    q += ' ORDER BY updatedAt DESC, documentDate DESC';
    res.json({success:true,data:db.prepare(q).all(...p)});
  } catch(err:any){res.status(500).json({error:err.message});}
});

// Create a held sales invoice. HOLD is an operational draft: it stores the bill and
// items for later resume, but deliberately creates NO stock movement, payment,
// receivable/payable, ledger, loyalty or dashboard sales entry.
router.post('/hold', (req: Request, res: Response) => {
  try {
    const b:any=req.body||{}; const firmId=String(b.firmId||'');
    if(!firmId) return res.status(400).json({error:'firmId required'});
    const documentType=String(b.documentType||'sale_invoice');
    if(documentType!=='sale_invoice') return res.status(400).json({error:'Only Sales Invoice bills can be held'});
    const items=Array.isArray(b.items)?b.items:[];
    if(!items.some((x:any)=>String(x?.name||'').trim() && Number(x?.quantity||0)>0)) return res.status(400).json({error:'Add at least one item before holding the bill'});
    const now=new Date().toISOString(); const id=uuidv4();
    let partyId=String(b.partyId||'').trim()||null; let partyName=String(b.partyName||'').trim();
    if(!partyId || !partyName || partyName.toLowerCase()==='guest customer') { const cash=ensureCashCustomer(firmId); partyId=String(cash.id); partyName=String(cash.name); }
    const party=partyId?db.prepare('SELECT id FROM parties WHERE id=? AND firmId=?').get(partyId,firmId):null;
    if(!party) return res.status(400).json({error:'Selected party is not valid for this company'});
    const multi=getModuleSettings(firmId,documentType).multiSeriesEnabled;
    let seriesId=b.seriesId||null, documentNumber=String(b.documentNumber||'').trim();
    if(!documentNumber || documentNumber==='Auto') {
      if(multi && seriesId) { const generated=generateSeriesNumber(seriesId); documentNumber=generated.documentNumber; seriesId=generated.seriesId; }
      else { const firm:any=db.prepare('SELECT invoicePrefix,invoiceNumber FROM firms WHERE id=?').get(firmId); documentNumber=`${firm?.invoicePrefix||'INV'}-${String(firm?.invoiceNumber||1).padStart(4,'0')}`; db.prepare('UPDATE firms SET invoiceNumber=invoiceNumber+1 WHERE id=?').run(firmId); }
    }
    const documentDate=String(b.documentDate||new Date().toISOString().slice(0,10));
    const entryDate=String(b.entryDate||documentDate);
    let dueDate=String(b.dueDate||'').trim()||null;
    if(!dueDate){ const cp:any=db.prepare('SELECT creditDays FROM parties WHERE id=? AND firmId=?').get(partyId,firmId); dueDate=addDaysDate(documentDate,Number(cp?.creditDays||15)>0?Math.min(3650,Math.floor(Number(cp?.creditDays||15))):15); }
    if(dueDate && dueDate<documentDate) return res.status(400).json({error:'Due date cannot be before transaction date'});
    const total=Math.max(0,Number(b.total)||0);
    const batchDetailsAllowed = allowsBatchDetails('sale_invoice');
    const docVals:any={id,firmId,documentType:'sale_invoice',documentSubtype:null,documentNumber,seriesId,godownId:b.godownId||null,gstRegistrationId:b.gstRegistrationId||null,documentDate,documentTime:b.documentTime||null,entryDate,partyId,partyName,partyType:b.partyType||'customer',phone:b.phone||'',billingAddress:b.billingAddress||'',shippingAddress:b.shippingAddress||null,transactionType:'credit',status:'hold',stateOfSupply:b.stateOfSupply||null,subtotal:Number(b.subtotal)||0,discountAmount:Number(b.discountAmount)||0,discountPercentage:Number(b.discountPercentage)||0,taxAmount:Number(b.taxAmount)||0,shippingCharges:Number(b.shippingCharges)||0,packagingCharges:Number(b.packagingCharges)||0,adjustment:Number(b.adjustment)||0,roundOff:Number(b.roundOff)||0,total,paidAmount:0,balanceAmount:0,paymentType:b.paymentType||'cash',bankId:b.bankId||null,poNumber:b.poNumber||null,poDate:b.poDate||null,description:b.description||b.notes||null,validUntil:b.validUntil||null,paymentTerms:b.paymentTerms||null,dueDate,extraChargesJson:b.extraChargesJson||'[]',gstPriceMode:['inclusive','exclusive'].includes(String(b.gstPriceMode))?String(b.gstPriceMode):'exclusive',createdAt:now,updatedAt:now};
    const dcols=new Set((db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c=>c.name));
    const cols=Object.keys(docVals).filter(k=>dcols.has(k));
    db.prepare(`INSERT INTO documents (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>docVals[k]));
    const icols=new Set((db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c=>c.name));
    for(const item of items){
      const dbItem=item.itemId?db.prepare('SELECT unitId,secondaryUnitId,conversionFactor FROM items WHERE id=?').get(item.itemId) as any:null;
      const resolved=resolveLineUnit(firmId,'sale_invoice',dbItem,item);
      const vals:any={id:uuidv4(),documentId:id,firmId,itemId:item.itemId||null,godownId:item.godownId||b.godownId||null,name:item.name,description:item.description,hsnCode:item.hsnCode,quantity:item.quantity||0,unit:item.unit,unitId:resolved.unitId,isSecondaryUnit:resolved.isSecondaryUnit,baseQuantity:resolved.baseQuantity,secondaryQuantity:item.secondaryQuantity||0,secondaryUnitId:item.secondaryUnitId||null,price:item.price||0,discount:item.discount||0,discountType:item.discountType||'amount',discountPercentage:item.discountPercentage||0,discountAmount:item.discountAmount||0,taxRate:item.taxRate||0,taxAmount:item.taxAmount||0,amount:item.amount||0,batchId:batchDetailsAllowed ? (item.batchId||null) : null,batchNumber:batchDetailsAllowed ? (item.batchNumber||null) : null,expiryDate:null,expiryMonth:batchDetailsAllowed ? lineExpiry(item).month : null,expiryYear:batchDetailsAllowed ? lineExpiry(item).year : null,mfgDate:batchDetailsAllowed ? (item.mfgDate||null) : null,packing:item.packing||null,freeQuantity:item.freeQuantity||0,mrp:item.mrp||0,sellingRate:item.sellingRate||0,markup:item.markup||0,createdAt:now,updatedAt:now};
      const cs=Object.keys(vals).filter(k=>icols.has(k)); db.prepare(`INSERT INTO document_items (${cs.join(',')}) VALUES (${cs.map(()=>'?').join(',')})`).run(...cs.map(k=>vals[k]));
    }
    const doc=db.prepare('SELECT * FROM documents WHERE id=?').get(id) as any; const docItems=db.prepare('SELECT * FROM document_items WHERE documentId=?').all(id);
    res.status(201).json({success:true,data:{...doc,items:docItems}});
  } catch(err:any){ console.error('[Documents] Hold error:',err); res.status(500).json({error:err.message}); }
});

// GET document by id with items
router.get('/:id/logs', (req: Request, res: Response) => {
  try {
    const firmId=String(req.query.firmId||''); const doc:any=db.prepare('SELECT id,firmId FROM documents WHERE id=?').get(req.params.id);
    if(!doc) return res.status(404).json({error:'Document not found'});
    if(firmId && String(doc.firmId)!==firmId) return res.status(403).json({error:'Document does not belong to firm'});
    const rows:any[]=db.prepare('SELECT id,action,changesJson,note,actorId,actorName,createdAt FROM document_audit_logs WHERE documentId=? ORDER BY createdAt DESC').all(req.params.id);
    res.json({success:true,data:rows.map(r=>({...r,changes:(()=>{try{return JSON.parse(r.changesJson||'{}')}catch{return {}}})()}))});
  } catch(err:any){res.status(500).json({error:err.message});}
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    // Hydrate saved batch metadata from the authoritative inventory batch record.
    // Older document_items rows may have NULL expiry fields even though the batch
    // itself has the correct expiry. Returning the canonical batch values here
    // makes Modify/Print/View show the same batch + expiry information consistently.
    const items = db.prepare(`SELECT di.*,
      COALESCE(di.batchNumber, b.batchNumber) AS batchNumber,
      COALESCE(di.expiryDate, b.expiryDate) AS expiryDate,
      COALESCE(di.expiryMonth, b.expiryMonth) AS expiryMonth,
      COALESCE(di.expiryYear, b.expiryYear) AS expiryYear,
      COALESCE(di.mfgDate, b.mfgDate) AS mfgDate,
      COALESCE(di.packing, b.packing) AS packing,
      COALESCE(di.mrp, b.mrp) AS mrp,
      COALESCE(di.sellingRate, b.sellingRate) AS sellingRate
      FROM document_items di
      LEFT JOIN inventory_batches b ON b.id=di.batchId AND b.firmId=di.firmId
      WHERE di.documentId = ?
      ORDER BY di.createdAt ASC`).all(req.params.id);
    const viewDoc:any = { ...doc as any, items: allowsBatchDetails(String((doc as any).documentType))
      ? items
      : items.map((x:any)=>({...x,batchId:null,batchNumber:null,expiryDate:null,expiryMonth:null,expiryYear:null,mfgDate:null})) };
    if (String(viewDoc.documentType)==='purchase_order' && String(viewDoc.documentSubtype||'')==='purchase_challan') viewDoc.documentType='purchase_challan';
    res.json({ success: true, data: viewDoc });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create document (invoice, order, etc)
router.post('/', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const id = uuidv4();
    const {
      firmId, documentType, documentNumber, seriesId, documentDate, documentTime,
      partyId, partyName, partyType, phone, billingAddress, shippingAddress, gstRegistrationId,
      transactionType = 'cash', status = 'active', stateOfSupply,
      subtotal = 0, discountAmount = 0, discountPercentage = 0,
      taxAmount = 0, shippingCharges = 0, packagingCharges = 0,
      adjustment = 0, roundOff = 0, total = 0, paidAmount: rawPaidAmount = 0, balanceAmount: rawBalanceAmount = 0,
      paymentType = 'cash', bankId, poNumber, poDate, description, documentSubtype, validUntil, paymentTerms, dueDate, referenceDocumentId, referenceDocumentNumber, referenceDocumentDate, sourceDocumentIdsJson, aiSourceFileName, aiSourceFilePath, aiImportedAt,
      ewaybillNo, vehicleNumber, transportName, deliveryDate, extraChargesJson = '[]',
      godownId: rawGodownId = null,
      gstPriceMode = 'exclusive',
      paymentBreakdown = [],
      autoPaidAmount,
      posPaymentIds = [],
      posPaymentSessionId = null,
      items = [],
      counterSaleIds = []
    } = req.body;
    // firmId must be initialized from the request body before the canonical
    // negative-stock policy is synchronized.
    syncNegativeStockFromRequest(String(firmId || ''), req.body?.allowNegativeStock);
    const linkedCounterSaleIds: string[] = Array.isArray(counterSaleIds) ? counterSaleIds.map((x:any)=>String(x)).filter(Boolean) : [];
    const fromCounterSale = String(documentType) === 'sale_invoice' && linkedCounterSaleIds.length > 0;

    if (!firmId || !documentType) {
      return res.status(400).json({ error: 'firmId and documentType are required' });
    }
    const phoneCheck = validateMobile(phone);
    if (!phoneCheck.valid) return res.status(400).json({ error: phoneCheck.error });
    const normalizedPhone = phoneCheck.value || '';
    // Empty-string optional foreign keys are invalid in SQLite when foreign-key
    // enforcement is enabled. The Billing UI uses '' for Guest Customer, so
    // normalize an unselected party to NULL before inserting the document.
    let normalizedPartyId = String(partyId || '').trim() || null;
    let normalizedPartyName = String(partyName || '').trim();
    const salesLike = ['sale_invoice','sale_order','sale_return','sale_return_challan','sale_quotation','delivery_challan','sale_proforma'].includes(String(documentType));
    // All sales-side documents may be created without registering a party. In that case
    // they are posted against the firm's single system Cash Customer.
    if (salesLike && (!normalizedPartyId || !normalizedPartyName || normalizedPartyName.toLowerCase() === 'guest customer')) {
      const cash = ensureCashCustomer(String(firmId));
      normalizedPartyId = String(cash.id);
      normalizedPartyName = String(cash.name);
    }
    if (!normalizedPartyName && !salesLike) {
      return res.status(400).json({ error: 'Party is required for purchase documents' });
    }
    if (normalizedPartyId) {
      const partyExists = db.prepare('SELECT id FROM parties WHERE id=? AND firmId=?').get(normalizedPartyId, firmId);
      if (!partyExists) return res.status(400).json({ error: 'Selected party is not valid for this company' });
    }
    for (const line of (Array.isArray(items) ? items : [])) {
      if (!line?.itemId) continue;
      const itemForPrecision:any = db.prepare('SELECT name,decimalEnabled FROM items WHERE id=? AND firmId=? AND isActive=1').get(line.itemId, firmId);
      if (!itemForPrecision) return res.status(400).json({ error: `Item not found or inactive: ${line.name || line.itemId}` });
      assertDocumentItemQuantities(itemForPrecision, line);
    }
    // Purchase Return and Purchase Challan are document quantities, never
    // negative quantities. Negative-stock policy only controls whether stock
    // can fall below zero during eligible stock-decreasing operations.
    if (['purchase_return','purchase_return_challan','purchase_challan'].includes(String(documentType))) {
      for (const line of (Array.isArray(items) ? items : [])) {
        const q = Number(line?.quantity ?? 0);
        const free = Number(line?.freeQuantity ?? 0);
        if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: `Quantity cannot be negative for ${documentType}` });
        if (!Number.isFinite(free) || free < 0) return res.status(400).json({ error: `Free quantity cannot be negative for ${documentType}` });
      }
    }
    const isProforma = String(documentType) === 'sale_proforma';
    const isPurchaseChallanDoc = String(documentType) === 'purchase_challan';
    const storedDocumentType = isProforma ? 'sale_quotation' : (isPurchaseChallanDoc ? 'purchase_order' : documentType);
    const storedDocumentSubtype = isProforma ? 'proforma' : (isPurchaseChallanDoc ? 'purchase_challan' : (documentSubtype || null));
    const batchDetailsAllowed = allowsBatchDetails(String(documentType));
    const isInvoiceCandidate = ['sale_invoice','purchase_invoice'].includes(storedDocumentType);
    const invoiceTotalForType = Math.max(0, parseFloat(String(total)) || 0);
    const normalizedPosPaymentIds: string[] = Array.isArray(posPaymentIds) ? posPaymentIds.map((x:any)=>String(x)).filter(Boolean) : [];
    let posPaymentTotal = 0;
    if (normalizedPosPaymentIds.length) {
      const placeholders = normalizedPosPaymentIds.map(()=>'?').join(',');
      const posRows = db.prepare(`SELECT id, amount, partyId, type, isDeleted, linkedDocumentId FROM payments WHERE firmId=? AND id IN (${placeholders})`).all(firmId, ...normalizedPosPaymentIds) as any[];
      if (posRows.length !== normalizedPosPaymentIds.length) return res.status(409).json({ error: 'One or more POS payments could not be found' });
      if (posRows.some((x:any)=>Number(x.isDeleted||0)===1 || String(x.type)!=='payment_in' || x.linkedDocumentId)) return res.status(409).json({ error: 'A POS payment is already used or deleted' });
      if (posRows.some((x:any)=>String(x.partyId||'') !== String(normalizedPartyId||''))) return res.status(409).json({ error: 'POS payment customer does not match this bill' });
      posPaymentTotal = posRows.reduce((sum:number,x:any)=>sum + Math.max(0, Number(x.amount)||0),0);
      if (posPaymentTotal > invoiceTotalForType + 0.01) return res.status(400).json({ error: 'POS payment cannot exceed bill total' });
    }

    const classificationPaidRaw = autoPaidAmount === undefined || autoPaidAmount === null ? rawPaidAmount : autoPaidAmount;
    const requestedPaidForType = Math.max(0, Math.min(invoiceTotalForType, parseFloat(String(classificationPaidRaw)) || 0));
    // Cash/Credit is never chosen by the user. A fully paid invoice is Cash; any
    // unpaid or part-paid invoice is Credit. Non-invoice documents retain their
    // legacy transactionType semantics. Counter Sale handoffs are always Cash.
    const normalizedTransactionType = isInvoiceCandidate
      ? (fromCounterSale || requestedPaidForType + 0.004 >= invoiceTotalForType ? 'cash' : 'credit')
      : (String(transactionType || 'cash') === 'credit' ? 'credit' : 'cash');
    if (isProforma && String(validUntil || '').trim() && String(validUntil) < String(documentDate || '')) {
      return res.status(400).json({ error: 'Proforma validity date cannot be before the document date' });
    }
    let resolvedDueDate = DUE_DATE_DOCUMENT_TYPES.includes(String(storedDocumentType)) ? (String(dueDate || '').trim() || null) : null;
    if (!resolvedDueDate && DUE_DATE_DOCUMENT_TYPES.includes(String(storedDocumentType))) {
      const cp:any = normalizedPartyId ? db.prepare('SELECT creditDays FROM parties WHERE id=? AND firmId=?').get(normalizedPartyId, firmId) : null;
      const configuredDays = Number(cp?.creditDays || 0);
      const days = configuredDays > 0 ? Math.min(3650, Math.floor(configuredDays)) : 15;
      const d = new Date(`${String(documentDate || '').slice(0,10)}T00:00:00`);
      if (Number.isFinite(d.getTime())) { d.setDate(d.getDate()+days); resolvedDueDate = d.toISOString().slice(0,10); }
    }
    if (resolvedDueDate && documentDate && resolvedDueDate < String(documentDate)) return res.status(400).json({ error: 'Due date cannot be before transaction date' });
    const resolvedGstRegistrationId = gstRegistrationId || (db.prepare('SELECT id FROM gst_registrations WHERE firmId=? AND isPrimary=1 AND isActive=1 LIMIT 1').get(firmId) as any)?.id || null;
    if (Array.isArray(items)) { for (const line of items) { const rate = Number(line?.taxRate ?? 0); try { validateLineTax(String(firmId), rate); } catch(e:any) { return res.status(400).json({ error: e.message }); } } }

    // Accounting boundary: only posted bills/returns participate in receivable/payable.
    // Quotations, orders and delivery documents are operational and must never create
    // an outstanding balance, even if an older/stale client sends paid/balance fields.
    const isInvoiceDocument = ['sale_invoice','purchase_invoice'].includes(storedDocumentType);
    const isReturnDocument = ['sale_return','purchase_return'].includes(storedDocumentType);
    const returnSource:any = isReturnDocument && referenceDocumentId ? db.prepare('SELECT documentType,documentSubtype FROM documents WHERE id=? AND firmId=?').get(referenceDocumentId, firmId) : null;
    const isAccountingReturn = isReturnDocument && String(returnSource?.documentType||'') === (storedDocumentType==='sale_return' ? 'sale_invoice' : 'purchase_invoice');
    const isAccountingDocument = isInvoiceDocument || isAccountingReturn;
    const paidAmount = fromCounterSale ? (parseFloat(String(total)) || 0) : ((isInvoiceDocument || isAccountingReturn) ? requestedPaidForType : (isAccountingDocument ? (parseFloat(String(rawPaidAmount)) || 0) : 0));
    const balanceAmount = fromCounterSale ? 0 : ((isInvoiceDocument || isAccountingReturn) ? Math.max(0, (parseFloat(String(total)) || 0) - paidAmount) : (isAccountingDocument ? (parseFloat(String(rawBalanceAmount)) || 0) : 0));

    // Customer credit-limit guard: only credit Sales Invoices consume the configured limit.
    if (storedDocumentType === 'sale_invoice' && normalizedTransactionType === 'credit' && normalizedPartyId && !fromCounterSale) {
      const cash = ensureCashCustomer(String(firmId));
      const isCashCustomer = String(normalizedPartyId) === String(cash.id);
      if (!isCashCustomer) {
        const party:any = db.prepare('SELECT creditLimit FROM parties WHERE id=? AND firmId=?').get(normalizedPartyId, firmId);
        const limit = Math.max(0, Number(party?.creditLimit || 0));
        if (limit > 0) {
          const current:any = db.prepare(`SELECT COALESCE(SUM(CASE WHEN documentType='sale_invoice' THEN balanceAmount WHEN documentType='sale_return' THEN -balanceAmount ELSE 0 END),0) AS balance FROM documents WHERE firmId=? AND partyId=? AND isDeleted=0`).get(firmId, normalizedPartyId);
          const existing = Math.max(0, Number(current?.balance || 0));
          const newBalance = Math.max(0, Number(balanceAmount || 0));
          if (existing + newBalance > limit + 0.004) return res.status(400).json({ error: `Credit limit exceeded for ${normalizedPartyName}. Limit: ₹${limit.toFixed(2)}, Available: ₹${Math.max(0, limit-existing).toFixed(2)}` });
        }
      }
    }

    // Permanent Cash Customer rule: a normal Cash Customer sales invoice can NEVER
    // be posted on credit. Full payment must be collected at billing time. The only
    // exception is a Counter Sale handoff, because that transaction was already paid
    // at the counter and is intentionally carried forward as a fully-paid invoice.
    if (storedDocumentType === 'sale_invoice' && !fromCounterSale && normalizedPartyId) {
      const cash = ensureCashCustomer(String(firmId));
      const isCashCustomer = String(normalizedPartyId) === String(cash.id);
      const invoiceTotal = Math.max(0, Number(total) || 0);
      if (isCashCustomer && invoiceTotal > 0.004 && Math.max(paidAmount, posPaymentTotal) + 0.004 < invoiceTotal) {
        return res.status(400).json({
          error: `Cash Customer billing requires full payment before the bill can be saved. Paid: ₹${paidAmount.toFixed(2)}, Bill Total: ₹${invoiceTotal.toFixed(2)}`
        });
      }
    }

    // Preflight all stock checks before any document/number/payment rows are written.
    // This prevents a failed billing attempt (e.g. insufficient stock) from leaving a
    // phantom ACTIVE invoice behind in the ledger, dashboard or sales totals.
    if (status !== 'hold' && status !== 'draft') {
      validateStockForDocumentLines(String(firmId), String(documentType), items, rawGodownId);
    }

    // Purchase documents support both modes: leave the field blank for B-MAX's
    // automatic series, or type the supplier/PO/challan/debit-note number manually.
    // The generated number is committed only when the document is saved.
    const isPurchaseDocument = String(storedDocumentType || '').startsWith('purchase_');
    const isReturnChallanDocument = ['sale_return_challan','purchase_return_challan'].includes(String(storedDocumentType));

    // Validate return references before any stock/payment rows are written.
    validateReturnReference(String(firmId), String(storedDocumentType), referenceDocumentId, items, null);

    // Sales-side documents keep the existing series/legacy numbering behavior.
    // Proformas are intentionally excluded from quotation series: they have their
    // own PI counter even when multi-series is enabled for sale_quotation.
    const multiSeriesEnabled = getModuleSettings(firmId, storedDocumentType).multiSeriesEnabled;

    let docNumber = String(documentNumber || '').trim();
    let usedSeriesId: string | null = null;
    if (!docNumber && (isPurchaseDocument || isReturnChallanDocument)) {
      if (isPurchaseDocument) docNumber = purchaseAutoNumber(String(firmId), String(storedDocumentType), now);
      else {
        const prefix = storedDocumentType === 'purchase_return_challan' ? 'PRC' : 'SRC';
        const row:any = db.prepare('SELECT * FROM document_number_counters WHERE firmId=? AND documentType=?').get(firmId, storedDocumentType);
        if (!row) { db.prepare('INSERT INTO document_number_counters(id,firmId,documentType,prefix,nextNumber,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run(uuidv4(),firmId,storedDocumentType,prefix,2,now,now); docNumber=`${prefix}-0001`; }
        else { const n=Math.max(1,Number(row.nextNumber)||1); db.prepare('UPDATE document_number_counters SET nextNumber=?,updatedAt=? WHERE id=?').run(n+1,now,row.id); docNumber=`${row.prefix||prefix}-${String(n).padStart(4,'0')}`; }
      }
    } else if (!docNumber && !isPurchaseDocument) {
      if (isProforma) {
        const firm = db.prepare('SELECT * FROM firms WHERE id = ?').get(firmId) as any;
        const num = Number(firm?.proformaNumber || 1);
        docNumber = `PI-${String(num).padStart(4, '0')}`;
        db.prepare('UPDATE firms SET proformaNumber = proformaNumber + 1 WHERE id = ?').run(firmId);
      } else {
        let resolvedSeriesId = multiSeriesEnabled ? seriesId : null;
        if (!resolvedSeriesId && multiSeriesEnabled) {
          const defaultSeries = db.prepare(
            'SELECT id FROM series WHERE firmId = ? AND transactionType = ? AND isActive = 1 AND isDefault = 1'
          ).get(firmId, storedDocumentType) as any;
          if (defaultSeries) resolvedSeriesId = defaultSeries.id;
        }

        if (resolvedSeriesId) {
          const generated = generateSeriesNumber(resolvedSeriesId);
          docNumber = generated.documentNumber;
          usedSeriesId = generated.seriesId;
        } else {
          // Legacy fallback — unchanged from the original single-counter behavior.
          const firm = db.prepare('SELECT * FROM firms WHERE id = ?').get(firmId) as any;
          const prefix = firm?.invoicePrefix || 'INV';
          const num = firm?.invoiceNumber || 1;
          docNumber = `${prefix}-${String(num).padStart(4, '0')}`;
          db.prepare('UPDATE firms SET invoiceNumber = invoiceNumber + 1 WHERE id = ?').run(firmId);
        }
      }
    } else if (seriesId && multiSeriesEnabled && !isPurchaseDocument) {
      // A manual sales-side number may still be linked to its selected series. Purchase documents never use a series.
      usedSeriesId = seriesId;
    }

    const duplicate:any = db.prepare('SELECT id FROM documents WHERE firmId=? AND documentType=? AND documentNumber=? AND isDeleted=0 LIMIT 1').get(firmId, storedDocumentType, docNumber);
    if (duplicate) return res.status(409).json({ error: `Document number ${docNumber} already exists for this document type` });

    // Counter Sale handoff: ensure every linked Counter Sale has actually reserved
    // its stock before we restore that reservation for the final invoice posting.
    // This is intentionally idempotent: an already-reserved row is untouched, while
    // a legacy/unreserved open row is reserved here instead of failing the bill.
    if (fromCounterSale) {
      const placeholders = linkedCounterSaleIds.map(()=>'?').join(',');
      const counterRows:any[] = db.prepare(`SELECT * FROM counter_sales WHERE firmId=? AND status='open' AND id IN (${placeholders})`).all(firmId,...linkedCounterSaleIds);
      if (counterRows.length !== linkedCounterSaleIds.length) throw new Error('One or more Counter Sale entries are no longer open');
      const nowRestore = now;
      const allowNegative = isNegativeStockAllowed(firmId);
      const defaultGodown = (db.prepare("SELECT * FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC, CASE WHEN lower(name)='main store' THEN 0 ELSE 1 END, name LIMIT 1").get(firmId) as any);
      for (const cr of counterRows) {
        const cis:any[] = db.prepare('SELECT * FROM counter_sale_items WHERE counterSaleId=? AND firmId=?').all(cr.id,firmId);
        if (!cis.length) throw new Error(`Counter Sale #${cr.counterNo||cr.id} has no items`);

        // Reserve legacy/unreserved rows atomically before the restore step below.
        if (Number(cr.stockReserved||0)!==1) {
          for (const it of cis) {
            const item:any = db.prepare('SELECT * FROM items WHERE id=? AND firmId=? AND isActive=1').get(it.itemId,firmId);
            if (!item) throw new Error(`Item not found or inactive: ${it.name}`);
            const qty = Number(it.baseQuantity||it.quantity||0);
            if (qty<=0) throw new Error(`Quantity must be greater than zero for ${it.name}`);
            if (!allowNegative && Number(item.currentStock||0)-qty < -0.0001) throw new Error(`Insufficient stock for ${item.name}. Available: ${Number(item.currentStock||0)}, Required: ${qty}`);
            if (it.batchId) {
              const b:any=db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=?').get(it.batchId,firmId);
              if (!b) throw new Error(`Selected batch not found for ${it.name}`);
              if (!allowNegative && Number(b.quantity||0)-qty < -0.0001) throw new Error(`Insufficient batch stock for ${it.name}`);
            }
            const gid=it.godownId || defaultGodown?.id || null;
            if (gid) {
              const sr:any=db.prepare('SELECT quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,it.itemId,gid);
              if (!allowNegative && Number(sr?.quantity||0)-qty < -0.0001) throw new Error(`Insufficient stock for ${item.name} in selected store. Available: ${Number(sr?.quantity||0)}, Required: ${qty}`);
            }
          }
          for (const it of cis) {
            const qty=Number(it.baseQuantity||it.quantity||0);
            const item:any=db.prepare('SELECT name FROM items WHERE id=? AND firmId=?').get(it.itemId,firmId);
            db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,nowRestore,it.itemId,firmId);
            if(it.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,nowRestore,it.batchId,firmId);
            const gid=it.godownId || defaultGodown?.id || null;
            if(gid) applyStoreStock(firmId,it.itemId,gid,-qty,item?.name||it.name,allowNegative,nowRestore);
            if(!it.godownId && gid) db.prepare('UPDATE counter_sale_items SET godownId=?,updatedAt=? WHERE id=? AND firmId=?').run(gid,nowRestore,it.id,firmId);
          }
          db.prepare("UPDATE counter_sales SET stockReserved=1,stockReservedAt=?,updatedAt=? WHERE id=? AND firmId=? AND status='open'").run(nowRestore,nowRestore,cr.id,firmId);
        }

        for (const it of cis) {
          const qty=Number(it.baseQuantity||it.quantity||0); if(qty<=0) continue;
          db.prepare('UPDATE items SET currentStock=currentStock+?,updatedAt=? WHERE id=? AND firmId=?').run(qty,nowRestore,it.itemId,firmId);
          if(it.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity+?,updatedAt=? WHERE id=? AND firmId=?').run(qty,nowRestore,it.batchId,firmId);
          const gid=it.godownId || (db.prepare("SELECT id FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY CASE WHEN lower(name)='main store' THEN 0 ELSE 1 END, createdAt LIMIT 1").get(firmId) as any)?.id;
          if(gid){
            const sr:any=db.prepare('SELECT id,quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,it.itemId,gid);
            if(sr) db.prepare('UPDATE inventory_stock SET quantity=?,updatedAt=? WHERE id=?').run(Number(sr.quantity||0)+qty,nowRestore,sr.id);
            else db.prepare('INSERT INTO inventory_stock(id,firmId,itemId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?)').run(uuidv4(),firmId,it.itemId,gid,qty,nowRestore);
          }
        }
      }
      db.prepare(`UPDATE counter_sales SET stockReserved=0,updatedAt=? WHERE firmId=? AND status='open' AND id IN (${placeholders})`).run(nowRestore,firmId,...linkedCounterSaleIds);
    }

    // Insert document using the actual database columns.
    // Some users may be upgrading from older databases that contain additional
    // columns. Building the INSERT from PRAGMA table_info prevents SQLite
    // "N values for M columns" failures when schemas differ across upgrades.
    const documentValues: Record<string, any> = {
      id, firmId, documentType: storedDocumentType, documentSubtype: storedDocumentSubtype, documentNumber: docNumber, seriesId: usedSeriesId, godownId: rawGodownId || null, gstRegistrationId: resolvedGstRegistrationId,
      documentDate, documentTime, partyId: normalizedPartyId, partyName: normalizedPartyName, partyType, phone: normalizedPhone, billingAddress,
      shippingAddress, transactionType: normalizedTransactionType, status, stateOfSupply, subtotal, discountAmount,
      discountPercentage, taxAmount, shippingCharges, packagingCharges, adjustment, roundOff,
      total, paidAmount, balanceAmount, paymentType, bankId, poNumber, poDate, description, validUntil, paymentTerms, dueDate, referenceDocumentId: referenceDocumentId || null, referenceDocumentNumber: referenceDocumentNumber || null, referenceDocumentDate: referenceDocumentDate || null, sourceDocumentIdsJson: sourceDocumentIdsJson || null,
      aiSourceFileName, aiSourceFilePath, aiImportedAt, ewaybillNo, vehicleNumber,
      transportName, deliveryDate, extraChargesJson, gstPriceMode: ['inclusive','exclusive'].includes(String(gstPriceMode)) ? String(gstPriceMode) : 'exclusive', createdAt: now, updatedAt: now
    };
    const actualDocumentColumns = new Set(
      (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c => c.name)
    );
    const documentColumns = Object.keys(documentValues).filter(k => actualDocumentColumns.has(k));
    const documentPlaceholders = documentColumns.map(() => '?').join(', ');
    db.prepare(`INSERT INTO documents (${documentColumns.join(', ')}) VALUES (${documentPlaceholders})`)
      .run(...documentColumns.map(k => documentValues[k]));

    // Insert items
    if (items.length > 0) {
      const actualItemColumns = new Set(
        (db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c => c.name)
      );

      for (const item of items) {
        const dbItem = item.itemId ? db.prepare('SELECT unitId, secondaryUnitId, conversionFactor FROM items WHERE id = ?').get(item.itemId) as any : null;
        const { baseQuantity, isSecondaryUnit, unitId: resolvedUnitId } = resolveLineUnit(firmId, documentType, dbItem, item);

        const itemValues: Record<string, any> = {
          id: uuidv4(), documentId: id, firmId, itemId: item.itemId, sourceDocumentId: item.sourceDocumentId || null, sourceDocumentItemId: item.sourceDocumentItemId || null, godownId: item.godownId || rawGodownId || null, name: item.name,
          description: item.description, hsnCode: item.hsnCode, quantity: item.quantity || 0,
          unit: item.unit, unitId: resolvedUnitId, isSecondaryUnit, baseQuantity,
          secondaryQuantity: item.secondaryQuantity || 0, secondaryUnitId: item.secondaryUnitId || null,
          price: item.price || 0, discount: item.discount || 0, discountType: item.discountType || 'amount',
          discountPercentage: item.discountPercentage || 0, discountAmount: item.discountAmount || 0,
          taxRate: item.taxRate || 0, taxAmount: item.taxAmount || 0, amount: item.amount || 0,
          batchId: item.batchId || null, batchNumber: item.batchNumber || null,
          expiryDate: item.expiryDate || null,
          expiryMonth: lineExpiry(item).month, expiryYear: lineExpiry(item).year,
          mfgDate: item.mfgDate || null, packing: item.packing || null, freeQuantity: item.freeQuantity || 0,
          mrp: item.mrp || 0, sellingRate: item.sellingRate || 0, markup: item.markup || 0,
          createdAt: now, updatedAt: now
        };
        const itemColumns = Object.keys(itemValues).filter(k => actualItemColumns.has(k));
        const itemPlaceholders = itemColumns.map(() => '?').join(', ');
        db.prepare(`INSERT INTO document_items (${itemColumns.join(', ')}) VALUES (${itemPlaceholders})`)
          .run(...itemColumns.map(k => itemValues[k]));

        // Enforce firm-wide negative-stock policy before applying any stock decrease.
        if (item.itemId) {
          const isStockDecrease = ['sale_invoice','sale_order','delivery_challan','purchase_return'].includes(documentType) && !isPurchaseChallanDoc;
          if (isStockDecrease && (!isNegativeStockAllowed(firmId) || ['purchase_return','purchase_return_challan'].includes(documentType))) {
            const stockRow = db.prepare('SELECT currentStock FROM items WHERE id=? AND firmId=?').get(item.itemId, firmId) as any;
            const available = Number(stockRow?.currentStock || 0);
            if (available - baseQuantity < -0.0001) {
              throw new Error(`Insufficient stock for ${item.name}. Available: ${available}, Required: ${baseQuantity}`);
            }
          }
        }

        // Batch-aware stock: purchase adds to the selected batch; sale deducts from it.
        // Zero-stock batches are retained for history and disappear only from active selectors.
        if (item.itemId) {
          const isSaleBatch = ['sale_invoice','sale_order','delivery_challan'].includes(documentType) && !isPurchaseChallanDoc;
          const isPurchaseBatch = ['purchase_invoice','purchase_order','purchase_challan'].includes(documentType);
          const isSaleReturnBatch = ['sale_return','sale_return_challan'].includes(documentType);
          const isPurchaseReturnBatch = ['purchase_return','purchase_return_challan'].includes(documentType);
          const batchNo = item.batchNumber ? String(item.batchNumber).trim() : null;
          const ex=lineExpiry(item);
          const batchTracking = getModuleSettings(firmId,storedDocumentType).batchEnabled === true;
          const batchExpiryEnabled = getModuleSettings(firmId,storedDocumentType).expiryEnabled === true;
          const nonCreatingBatchDoc = isSaleBatch || isSaleReturnBatch || isPurchaseReturnBatch;
          if (nonCreatingBatchDoc && batchTracking && (batchNo || item.batchId)) {
            // Sales/returns may select a batch, but they can never create or edit its master data.
            // The batch record is the single source of truth for expiry, MRP, rates and manufacturing date.
          }
          if ((batchNo || item.batchId) && isPurchaseBatch && batchExpiryEnabled && (!ex.month || !ex.year)) {
            throw new Error(`Expiry Month and Expiry Year are required for batch ${batchNo || item.batchId}`);
          }
          if ((batchNo || item.batchId)) {
            let batch = item.batchId ? db.prepare('SELECT * FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(item.batchId,firmId,item.itemId) as any : null;
            if (!batch && batchNo) batch = db.prepare('SELECT * FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=?').get(firmId,item.itemId,batchNo) as any;
            if (nonCreatingBatchDoc && batchTracking && !batch) throw new Error(`Select an existing batch for ${item.name}. New batches can only be created in Purchase or Manufacturing.`);
            const freeQty = Math.max(0, Number(item.freeQuantity) || 0);
            const stockQuantity = baseQuantity + ((isPurchaseBatch && freeQty) ? freeQty : 0);
            const saleStockQuantity = baseQuantity + ((isSaleBatch && freeQty) ? freeQty : 0);
            const delta = isSaleBatch ? -saleStockQuantity : (isPurchaseReturnBatch ? -baseQuantity : (isPurchaseBatch || isSaleReturnBatch) ? stockQuantity : 0);
            if (batch) {
              if (delta < 0 && (!isNegativeStockAllowed(firmId) || isPurchaseReturnBatch) && Number(batch.quantity||0) + delta < -0.0001) throw new Error(`Insufficient batch stock for ${item.name} / ${batchNo}`);
              if (isPurchaseBatch) {
                db.prepare(`UPDATE inventory_batches SET quantity=quantity+?,expiryDate=NULL,expiryMonth=?,expiryYear=?,mfgDate=COALESCE(?,mfgDate),packing=COALESCE(?,packing),purchaseRate=?,mrp=?,sellingRate=?,markup=?,updatedAt=? WHERE id=?`)
                  .run(delta,ex.month,ex.year,item.mfgDate||null,item.packing||null,Number(item.price)||Number(batch.purchaseRate)||0,Number(item.mrp)||Number(batch.mrp)||0,Number(item.sellingRate)||Number(batch.sellingRate)||0,Number(item.markup)||Number(batch.markup)||0,now,batch.id);
              } else {
                // Sales and returns only move quantity. Batch metadata remains immutable from selling screens.
                db.prepare(`UPDATE inventory_batches SET quantity=quantity+?,updatedAt=? WHERE id=?`).run(delta,now,batch.id);
              }
            } else if (isPurchaseBatch && delta > 0) {
              const ex=lineExpiry(item);
              db.prepare(`INSERT INTO inventory_batches(id,firmId,itemId,batchNumber,expiryDate,expiryMonth,expiryYear,mfgDate,packing,purchaseRate,mrp,sellingRate,markup,quantity,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(uuidv4(),firmId,item.itemId,batchNo,null,ex.month,ex.year,item.mfgDate||null,item.packing||null,Number(item.price)||0,Number(item.mrp)||0,Number(item.sellingRate)||0,Number(item.markup)||0,delta,now,now);
            }
          }
        }

        // Update stock for products — always in base-unit (Unit 1) terms, regardless
        // of which unit the line was sold/purchased in.
        if (item.itemId) {
          const isSale = ['sale_invoice', 'sale_order', 'delivery_challan'].includes(documentType) && !isPurchaseChallanDoc;
          const isPurchase = ['purchase_invoice', 'purchase_order', 'purchase_challan'].includes(documentType);
          const isSaleReturn = ['sale_return','sale_return_challan'].includes(documentType);
          const isPurchaseReturn = ['purchase_return','purchase_return_challan'].includes(documentType);

          if (isSale || isPurchaseReturn) {
            const freeQty = isSale ? Math.max(0, Number(item.freeQuantity)||0) : 0;
            db.prepare('UPDATE items SET currentStock = currentStock - ?, updatedAt = ? WHERE id = ?')
              .run(baseQuantity + freeQty, now, item.itemId);
          } else if (isPurchase || isSaleReturn) {
            const freeQty = Math.max(0, Number(item.freeQuantity) || 0);
            db.prepare('UPDATE items SET currentStock = currentStock + ?, updatedAt = ? WHERE id = ?')
              .run(baseQuantity + ((isPurchase && freeQty) ? freeQty : 0), now, item.itemId);
          }
          if (isStoreStockDocument(storedDocumentType)) {
            const lineGodownId = item.godownId || rawGodownId || null;
            if (!lineGodownId) throw new Error(`Select a Store/Godown for ${item.name}`);
            applyStoreStock(firmId, item.itemId, lineGodownId, storeStockDelta(storedDocumentType, baseQuantity, item.freeQuantity, storedDocumentSubtype), item.name, isNegativeStockAllowed(firmId) && !['purchase_return','purchase_return_challan'].includes(documentType), now);
          }
        }
      }
    }

    // Only sale/purchase invoices carry a receivable/payable balance — link any amount
    // collected/paid at billing time into the same payment_allocations ledger that
    // Payment Out/Receipt use, so cash/bank, ledger and status stay one source of truth.
    if ((isInvoiceDocument || isAccountingReturn) && status !== 'draft' && status !== 'cancelled') {
      if (paidAmount > 0 && normalizedPartyId && normalizedPosPaymentIds.length === 0) {
        const payType = documentType === 'sale_invoice' || storedDocumentType === 'purchase_return' ? 'payment_in' : 'payment_out';
        const breakdown = Array.isArray(paymentBreakdown)
          ? paymentBreakdown.map((x:any)=>({ method: String(x?.method || 'cash'), amount: Math.max(0, parseFloat(String(x?.amount)) || 0) })).filter((x:any)=>x.amount > 0)
          : [];
        const rows = breakdown.length ? breakdown : [{ method: paymentType || 'cash', amount: paidAmount }];
        let allocated = 0;
        for (const row of rows) {
          const remaining = Math.max(0, paidAmount - allocated);
          const amount = Math.min(row.amount, remaining);
          if (amount <= 0) continue;
          const payId = uuidv4();
          db.prepare(`INSERT INTO payments (id, firmId, type, partyId, partyName, amount, paymentMethod, bankId,
              receiptNumber, paymentDate, reference, description, linkedDocumentId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(payId, firmId, payType, normalizedPartyId, normalizedPartyName, amount, row.method, row.method === 'bank' ? bankId : null,
              null, documentDate, `Auto: ${docNumber}`, 'Collected at billing', id, now, now);
          db.prepare('INSERT INTO payment_allocations (id, firmId, paymentId, documentId, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), firmId, payId, id, amount, now);
          applyFunds(firmId, row.method, row.method === 'bank' ? bankId : null, amount, payType === 'payment_in' ? 1 : -1, now);
          allocated += amount;
          if (allocated >= paidAmount - 0.0001) break;
        }
      }
      // If POS payment(s) were confirmed before the bill, link those exact payment rows to this invoice.
      // This is the single source of truth: no second payment is created during invoice save.
      if (normalizedPosPaymentIds.length) {
        const addAllocation = db.prepare('INSERT INTO payment_allocations (id, firmId, paymentId, documentId, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
        let remaining = Math.max(0, Number(total)||0);
        for (const paymentId of normalizedPosPaymentIds) {
          if (remaining <= 0.004) break;
          const pay:any = db.prepare('SELECT id, amount FROM payments WHERE id=? AND firmId=? AND isDeleted=0').get(paymentId, firmId);
          if (!pay) throw new Error('POS payment is no longer available');
          const alreadyAllocated:any = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payment_allocations WHERE paymentId=?').get(paymentId);
          const available = Math.max(0, Number(pay.amount||0) - Number(alreadyAllocated?.total||0));
          const take = Math.min(available, remaining);
          if (take <= 0.004) continue;
          addAllocation.run(uuidv4(), firmId, paymentId, id, +take.toFixed(2), now);
          db.prepare('UPDATE payments SET linkedDocumentId=?, updatedAt=? WHERE id=? AND firmId=?').run(id, now, paymentId, firmId);
          remaining = +(remaining - take).toFixed(2);
        }
      }

      // Automatically consume previous unallocated advances only for normal invoices.
      // Return settlements are new cash/bank movements and must never consume an advance.
      if (isInvoiceDocument) {
      // The advance was already received/paid when it was entered, so we only create
      // a new allocation here — never another cash/bank movement. This makes a prior
      // customer advance automatically reduce the next sales invoice balance (and a
      // supplier advance reduce the next purchase invoice balance).
      if (normalizedPartyId) {
        const advancePaymentType = documentType === 'sale_invoice' ? 'payment_in' : 'payment_out';
        const currentAllocated = (db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM payment_allocations WHERE documentId = ?').get(id) as any)?.total || 0;
        let remainingToPay = Math.max(0, +(Number(total || 0) - Number(currentAllocated || 0)).toFixed(2));
        if (remainingToPay > 0.004) {
          const priorAdvances = db.prepare(`
            SELECT p.id, p.amount, COALESCE(a.allocated,0) AS allocated,
                   (p.amount - COALESCE(a.allocated,0)) AS available
            FROM payments p
            LEFT JOIN (SELECT paymentId, SUM(amount) AS allocated FROM payment_allocations GROUP BY paymentId) a
              ON a.paymentId=p.id
            WHERE p.firmId=? AND p.partyId=? AND p.type=?
              AND p.linkedDocumentId IS NULL
              AND (p.amount - COALESCE(a.allocated,0)) > 0.004
            ORDER BY p.paymentDate ASC, p.createdAt ASC
          `).all(firmId, normalizedPartyId, advancePaymentType) as any[];
          const addAdvance = db.prepare('INSERT INTO payment_allocations (id, firmId, paymentId, documentId, amount, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
          for (const adv of priorAdvances) {
            if (remainingToPay <= 0.004) break;
            const available = Math.max(0, Number(adv.available) || 0);
            const take = Math.min(available, remainingToPay);
            if (take <= 0.004) continue;
            addAdvance.run(uuidv4(), firmId, adv.id, id, +take.toFixed(2), now);
            remainingToPay = +(remainingToPay - take).toFixed(2);
          }
        }
      }
      }

      recalcDocumentStatus(id, now);
    }

    // Purchase bill conversion from pending Purchase Order / Purchase Challan.
    // Only the exact selected source quantities are consumed. A source document
    // remains pending until every source line is fully converted.
    if (storedDocumentType === 'purchase_invoice' && status !== 'draft' && status !== 'cancelled' && sourceDocumentIdsJson) {
      let sourceIds:string[]=[];
      try { const parsed=JSON.parse(String(sourceDocumentIdsJson)); sourceIds=Array.isArray(parsed)?parsed.map((x:any)=>String(x)).filter(Boolean):[]; } catch { sourceIds=[]; }
      if (sourceIds.length) {
        const seen=new Set<string>();
        for (const sid of sourceIds) {
          if (seen.has(sid)) continue; seen.add(sid);
          const src:any=db.prepare('SELECT * FROM documents WHERE id=? AND firmId=? AND isDeleted=0').get(sid,firmId);
          if (!src) throw new Error('A linked purchase order/challan could not be found');
          if (!['purchase_order'].includes(String(src.documentType)) || !['', 'purchase_challan'].includes(String(src.documentSubtype||''))) throw new Error(`Invalid purchase source ${src.documentNumber||sid}`);
          if (String(src.status||'').toLowerCase()==='cancelled') throw new Error(`Purchase source ${src.documentNumber||sid} is cancelled`);
          if (String(src.partyId||'') !== String(normalizedPartyId||'')) throw new Error(`Purchase source ${src.documentNumber||sid} belongs to a different supplier`);
          const srcItems:any[]=db.prepare('SELECT * FROM document_items WHERE documentId=?').all(sid);
          let sourceRemaining=0;
          for (const it of srcItems) {
            const original=Math.max(0,Number(it.baseQuantity||it.quantity||0));
            if (!it.itemId || original<=0) continue;
            const allocatedBefore=Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty FROM document_items di JOIN documents td ON td.id=di.documentId WHERE td.firmId=? AND td.isDeleted=0 AND td.status NOT IN ('cancelled','draft','hold') AND di.sourceDocumentId=? AND di.sourceDocumentItemId=? AND di.documentId<>?`).get(firmId,sid,it.id,id) as any)?.qty||0);
            const thisAllocation=Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty FROM document_items di WHERE di.documentId=? AND di.sourceDocumentId=? AND di.sourceDocumentItemId=?`).get(id,sid,it.id) as any)?.qty||0);
            if (thisAllocation < -0.0001 || thisAllocation > Math.max(0,original-allocatedBefore)+0.0001) throw new Error(`Selected quantity for ${it.name||it.itemId} exceeds pending quantity. Allowed: ${Math.max(0,original-allocatedBefore)}, Selected: ${thisAllocation}`);
            if (thisAllocation>0.0001) {
              // Source order/challan has already affected stock; undo only the quantity
              // transferred into this purchase bill. The purchase bill's own stock receipt
              // was applied earlier, so net stock stays unchanged for the transferred part.
              db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=? AND firmId=?').run(thisAllocation,now,it.itemId,firmId);
              if (it.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity-?,updatedAt=? WHERE id=? AND firmId=?').run(thisAllocation,now,it.batchId,firmId);
              const gid=it.godownId || src.godownId || null;
              if (gid) applyStoreStock(firmId,it.itemId,gid,-thisAllocation,it.name||'Item',isNegativeStockAllowed(firmId),now);
            }
            sourceRemaining += Math.max(0,original-allocatedBefore-thisAllocation);
          }
          db.prepare("UPDATE documents SET status=?,updatedAt=? WHERE id=? AND firmId=?").run(sourceRemaining<=0.0001?'completed':'active',now,sid,firmId);
        }
      }
    }

    if (String(documentType)==='sale_invoice' && status!=='draft' && status!=='cancelled' && normalizedPartyId && String(normalizedPartyName||'').trim().toLowerCase()!=='cash customer') { try { crmEarnPoints(firmId,String(normalizedPartyId),Number(total)||0,items,id,String(docNumber||'')); } catch(e:any) { console.error('[CRM] auto earn failed',e?.message||e); } }

    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    const docItems = db.prepare('SELECT * FROM document_items WHERE documentId = ?').all(id);
    writeDocumentAudit(id, String(firmId), 'CREATED', null, [], doc, docItems, req, 'Transaction created');
    if (fromCounterSale) {
      const placeholders = linkedCounterSaleIds.map(()=>'?').join(',');
      db.prepare(`UPDATE counter_sales SET status='converted',convertedDocumentId=?,updatedAt=? WHERE firmId=? AND status='open' AND id IN (${placeholders})`).run(id,now,firmId,...linkedCounterSaleIds);
    }
    res.status(201).json({ success: true, data: { ...doc as any, items: docItems } });
  } catch (err: any) {
    console.error('[Documents] Create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Convert selected pending sales orders / delivery challans into one sales invoice.
// Source documents are marked completed and their already-applied stock movement is reversed
// before the invoice is created, so the final stock position is unchanged (no double deduction).
router.post('/convert-pending-to-invoice', (req: Request, res: Response) => {
  try {
    const { firmId, sourceIds = [], documentDate, partyId, partyName, partyType = 'customer', phone, billingAddress, items = [], subtotal = 0, discountAmount = 0, taxAmount = 0, total = 0 } = req.body;
    const phoneCheck = validateMobile(phone);
    if (!phoneCheck.valid) return res.status(400).json({ error: phoneCheck.error });
    if (!firmId || !partyName || !Array.isArray(sourceIds) || !sourceIds.length) return res.status(400).json({ error: 'firmId, partyName and sourceIds are required' });
    syncNegativeStockFromRequest(firmId, req.body?.allowNegativeStock);
    const now = new Date().toISOString();
    const result = db.transaction(() => {
      const sources = sourceIds.map((id:string) => db.prepare('SELECT * FROM documents WHERE id=? AND firmId=? AND isDeleted=0').get(id,firmId) as any).filter(Boolean);
      if (!sources.length) throw new Error('No pending order / challan found');
      for (const src of sources) {
        if (!['sale_order','delivery_challan'].includes(String(src.documentType))) throw new Error('Only Sale Orders and Delivery Challans can be converted');
        if (['cancelled','completed','closed'].includes(String(src.status||'').toLowerCase())) throw new Error(`Document ${src.documentNumber||src.id} is already completed`);
        if (String(src.partyId||'') !== String(partyId||'')) throw new Error(`Document ${src.documentNumber||src.id} belongs to a different customer`);
      }
      const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(firmId) as any;
      const prefix = firm?.invoicePrefix || 'INV'; const num = firm?.invoiceNumber || 1;
      const docNumber = `${prefix}-${String(num).padStart(4,'0')}`;
      db.prepare('UPDATE firms SET invoiceNumber=invoiceNumber+1 WHERE id=?').run(firmId);
      const id=uuidv4();
      const conversionDate = documentDate || sources[0].documentDate;
      const partyForDue:any = partyId ? db.prepare('SELECT creditDays FROM parties WHERE id=? AND firmId=?').get(partyId,firmId) : null;
      const computedDue = sources[0].dueDate || addDaysDate(conversionDate, Number(partyForDue?.creditDays || 15) > 0 ? Math.min(3650, Math.floor(Number(partyForDue?.creditDays || 15))) : 15);
      const docVals:any={id,firmId,documentType:'sale_invoice',documentNumber:docNumber,seriesId:null,documentDate:documentDate||sources[0].documentDate,documentTime:null,partyId,partyName,partyType,phone,billingAddress,shippingAddress:null,transactionType:'credit',status:'active',stateOfSupply:null,subtotal:Number(subtotal)||0,discountAmount:Number(discountAmount)||0,discountPercentage:0,taxAmount:Number(taxAmount)||0,shippingCharges:0,packagingCharges:0,adjustment:0,roundOff:0,total:Number(total)||0,paidAmount:0,balanceAmount:Number(total)||0,paymentType:'cash',bankId:null,poNumber:null,poDate:null,description:`Converted from ${sources.map((x:any)=>x.documentNumber||x.id).join(', ')}`,dueDate:computedDue,createdAt:now,updatedAt:now};
      const dcols=new Set((db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c=>c.name));
      const cols=Object.keys(docVals).filter(k=>dcols.has(k));
      db.prepare(`INSERT INTO documents (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>docVals[k]));
      const icolsSet=new Set((db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c=>c.name));
      const selectedBySource=new Map<string,number>();
      for(const item of items){
        const sourceId=String(item.sourceDocumentId||''); const sourceItemId=String(item.sourceDocumentItemId||'');
        if(!sourceId||!sourceItemId) throw new Error(`Every converted sales line must reference its source item`);
        const src=sources.find((x:any)=>String(x.id)===sourceId); if(!src) throw new Error('Invalid source document on selected item');
        const srcItem:any=db.prepare('SELECT * FROM document_items WHERE id=? AND documentId=?').get(sourceItemId,sourceId);
        if(!srcItem) throw new Error(`Source item not found for ${src.documentNumber||sourceId}`);
        const original=Math.max(0,Number(srcItem.baseQuantity||srcItem.quantity||0));
        const allocatedBefore=Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty FROM document_items di JOIN documents td ON td.id=di.documentId WHERE td.firmId=? AND td.isDeleted=0 AND td.status NOT IN ('cancelled','draft','hold') AND di.sourceDocumentId=? AND di.sourceDocumentItemId=?`).get(firmId,sourceId,sourceItemId) as any)?.qty||0);
        const dbItem=item.itemId?db.prepare('SELECT unitId,secondaryUnitId,conversionFactor FROM items WHERE id=?').get(item.itemId) as any:null;
        const {baseQuantity,isSecondaryUnit,unitId:resolvedUnitId}=resolveLineUnit(firmId,'sale_invoice',dbItem,item);
        const requested=Math.max(0,Number(baseQuantity)||0);
        const allowed=Math.max(0,original-allocatedBefore);
        if(requested<=0) continue;
        if(requested>allowed+0.0001) throw new Error(`Selected quantity for ${srcItem.name||srcItem.itemId} exceeds pending quantity. Allowed: ${allowed}, Selected: ${requested}`);
        const vals:any={id:uuidv4(),documentId:id,firmId,itemId:item.itemId,name:item.name,description:item.description,hsnCode:item.hsnCode,quantity:item.quantity||0,unit:item.unit,unitId:resolvedUnitId,isSecondaryUnit,baseQuantity,secondaryQuantity:item.secondaryQuantity||0,secondaryUnitId:item.secondaryUnitId||null,sourceDocumentId:sourceId,sourceDocumentItemId:sourceItemId,price:item.price||0,discount:item.discount||0,discountType:item.discountType||'amount',discountPercentage:item.discountPercentage||0,discountAmount:item.discountAmount||0,taxRate:item.taxRate||0,taxAmount:item.taxAmount||0,amount:item.amount||0,batchId:null,batchNumber:null,expiryDate:null,expiryMonth:null,expiryYear:null,mfgDate:null,packing:item.packing||null,freeQuantity:0,mrp:item.mrp||0,sellingRate:item.sellingRate||0,markup:item.markup||0,createdAt:now,updatedAt:now};
        const cs=Object.keys(vals).filter(k=>icolsSet.has(k)); db.prepare(`INSERT INTO document_items (${cs.join(',')}) VALUES (${cs.map(()=>'?').join(',')})`).run(...cs.map(k=>vals[k]));
        selectedBySource.set(sourceId,(selectedBySource.get(sourceId)||0)+requested);
        if(item.itemId){ db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=? AND firmId=?').run(requested,now,item.itemId,firmId); }
      }
      if(!selectedBySource.size) throw new Error('Select at least one pending item and quantity');
      // Undo only the source stock reservation for selected quantities. Remaining source
      // quantities stay reserved and remain visible as pending.
      for(const src of sources){
        const srcItems=db.prepare('SELECT * FROM document_items WHERE documentId=?').all(src.id) as any[];
        let remaining=0;
        for(const it of srcItems){
          const original=Math.max(0,Number(it.baseQuantity||it.quantity||0));
          if(!it.itemId||original<=0) continue;
          const allocatedAfter=Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty FROM document_items di JOIN documents td ON td.id=di.documentId WHERE td.firmId=? AND td.isDeleted=0 AND td.status NOT IN ('cancelled','draft','hold') AND di.sourceDocumentId=? AND di.sourceDocumentItemId=?`).get(firmId,src.id,it.id) as any)?.qty||0);
          const selected=selectedBySource.get(String(src.id))?Number((db.prepare(`SELECT COALESCE(SUM(COALESCE(di.baseQuantity,di.quantity)),0) qty FROM document_items di WHERE di.documentId=? AND di.sourceDocumentId=? AND di.sourceDocumentItemId=?`).get(id,src.id,it.id) as any)?.qty||0):0;
          if(selected>0){ db.prepare('UPDATE items SET currentStock=currentStock+?,updatedAt=? WHERE id=? AND firmId=?').run(selected,now,it.itemId,firmId); if(it.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity+?,updatedAt=? WHERE id=? AND firmId=?').run(selected,now,it.batchId,firmId); }
          remaining += Math.max(0,original-allocatedAfter);
        }
        db.prepare('UPDATE documents SET status=?,updatedAt=? WHERE id=? AND firmId=?').run(remaining<=0.0001?'completed':'active',now,src.id,firmId);
      }
      recalcDocumentStatus(id,now); return {id,documentNumber:docNumber};
    })();
    const doc=db.prepare('SELECT * FROM documents WHERE id=?').get(result.id); const docItems=db.prepare('SELECT * FROM document_items WHERE documentId=?').all(result.id);
    res.status(201).json({success:true,data:{...doc as any,items:docItems}});
  } catch(err:any){ console.error('[Documents] Conversion error:',err); res.status(500).json({error:err.message}); }
});

// Convert one saved Proforma Invoice into a real Sales Invoice.
// A proforma has no accounting or stock effect; conversion is the point at which
// the normal sales-invoice stock/accounting rules begin.
router.post('/convert-proforma-to-invoice', (req: Request, res: Response) => {
  try {
    const { firmId, sourceId, documentDate } = req.body;
    if (!firmId || !sourceId) return res.status(400).json({ error: 'firmId and sourceId are required' });
    const result = db.transaction(() => {
      const source = db.prepare("SELECT * FROM documents WHERE id=? AND firmId=? AND documentType='sale_quotation' AND documentSubtype='proforma' AND isDeleted=0").get(sourceId, firmId) as any;
      if (!source) throw new Error('Proforma Invoice not found');
      if (['cancelled','completed','closed'].includes(String(source.status||'').toLowerCase())) throw new Error('This proforma is already closed');
      const sourceItems = db.prepare('SELECT * FROM document_items WHERE documentId=? ORDER BY createdAt').all(sourceId) as any[];
      const firm = db.prepare('SELECT * FROM firms WHERE id=?').get(firmId) as any;
      const num = Number(firm?.invoiceNumber || 1);
      const prefix = firm?.invoicePrefix || 'INV';
      const docNumber = `${prefix}-${String(num).padStart(4,'0')}`;
      db.prepare('UPDATE firms SET invoiceNumber=invoiceNumber+1 WHERE id=?').run(firmId);
      const id=uuidv4(), now=new Date().toISOString();
      const proformaCreditDays = Number((db.prepare('SELECT creditDays FROM parties WHERE id=? AND firmId=?').get(source.partyId,firmId) as any)?.creditDays || 15);
      const proformaDue = source.dueDate || addDaysDate(documentDate || source.documentDate, proformaCreditDays > 0 ? Math.min(3650, Math.floor(proformaCreditDays)) : 15);
      const vals:any={id,firmId,documentType:'sale_invoice',documentSubtype:null,documentNumber:docNumber,seriesId:null,gstRegistrationId:source.gstRegistrationId||null,documentDate:documentDate||new Date().toISOString().slice(0,10),documentTime:null,partyId:source.partyId,partyName:source.partyName,partyType:'customer',phone:source.phone,billingAddress:source.billingAddress,shippingAddress:source.shippingAddress,transactionType:'credit',status:'active',stateOfSupply:source.stateOfSupply,subtotal:source.subtotal||0,discountAmount:source.discountAmount||0,discountPercentage:source.discountPercentage||0,taxAmount:source.taxAmount||0,shippingCharges:source.shippingCharges||0,packagingCharges:source.packagingCharges||0,adjustment:source.adjustment||0,roundOff:source.roundOff||0,total:source.total||0,paidAmount:0,balanceAmount:source.total||0,paymentType:'cash',bankId:null,poNumber:source.poNumber||null,poDate:source.poDate||null,description:`Converted from Proforma ${source.documentNumber}`,validUntil:null,paymentTerms:source.paymentTerms||null,dueDate:proformaDue,ewaybillNo:null,vehicleNumber:null,transportName:null,deliveryDate:null,extraChargesJson:source.extraChargesJson||'[]',gstPriceMode:source.gstPriceMode||'exclusive',createdAt:now,updatedAt:now};
      const dcols=new Set((db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c=>c.name)); const cols=Object.keys(vals).filter(k=>dcols.has(k));
      db.prepare(`INSERT INTO documents (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>vals[k]));
      const icols=new Set((db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c=>c.name));
      const batchDetailsAllowedForUpdate = allowsBatchDetails('sale_invoice');
      for(const item of sourceItems){
        const dbItem=item.itemId?db.prepare('SELECT unitId,secondaryUnitId,conversionFactor FROM items WHERE id=?').get(item.itemId) as any:null;
        const resolved=resolveLineUnit(firmId,'sale_invoice',dbItem,item);
        const v:any={id:uuidv4(),documentId:id,firmId,itemId:item.itemId,name:item.name,description:item.description,hsnCode:item.hsnCode,quantity:item.quantity||0,unit:item.unit,unitId:resolved.unitId,isSecondaryUnit:resolved.isSecondaryUnit,baseQuantity:resolved.baseQuantity,secondaryQuantity:item.secondaryQuantity||0,secondaryUnitId:item.secondaryUnitId||null,price:item.price||0,discount:item.discount||0,discountType:item.discountType||'amount',discountPercentage:item.discountPercentage||0,discountAmount:item.discountAmount||0,taxRate:item.taxRate||0,taxAmount:item.taxAmount||0,amount:item.amount||0,batchId:batchDetailsAllowedForUpdate ? (item.batchId||null) : null,batchNumber:batchDetailsAllowedForUpdate ? (item.batchNumber||null) : null,expiryDate:null,expiryMonth:batchDetailsAllowedForUpdate ? lineExpiry(item).month : null,expiryYear:batchDetailsAllowedForUpdate ? lineExpiry(item).year : null,mfgDate:batchDetailsAllowedForUpdate ? (item.mfgDate||null) : null,packing:item.packing||null,freeQuantity:item.freeQuantity||0,mrp:item.mrp||0,sellingRate:item.sellingRate||0,markup:item.markup||0,createdAt:now,updatedAt:now};
        const cs=Object.keys(v).filter(k=>icols.has(k)); db.prepare(`INSERT INTO document_items (${cs.join(',')}) VALUES (${cs.map(()=>'?').join(',')})`).run(...cs.map(k=>v[k]));
        if(item.itemId && resolved.baseQuantity>0){ const qty=Number(resolved.baseQuantity); if(item.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,now,item.batchId,firmId); db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=?').run(qty,now,item.itemId); }
      }
      db.prepare("UPDATE documents SET status='completed',updatedAt=? WHERE id=? AND firmId=?").run(now,sourceId,firmId);
      recalcDocumentStatus(id,now);
      return id;
    })();
    const doc=db.prepare('SELECT * FROM documents WHERE id=?').get(result); const items=db.prepare('SELECT * FROM document_items WHERE documentId=?').all(result);
    res.status(201).json({success:true,data:{...doc as any,items}});
  } catch(err:any){ console.error('[Documents] Proforma conversion error:',err); res.status(500).json({error:err.message}); }
});

// PUT update document
router.put('/:id' , (req: Request, res: Response) => {
  try {
    const updateDocument = db.transaction(() => {
    const now = new Date().toISOString();
    const {
      documentDate, entryDate, documentTime, partyId, partyName, partyType, phone,
      billingAddress, shippingAddress, gstRegistrationId, transactionType, status, stateOfSupply,
      subtotal, discountAmount, discountPercentage, taxAmount,
      shippingCharges, packagingCharges, adjustment, roundOff,
      total, paidAmount, balanceAmount, paymentType, bankId,
      poNumber, poDate, description, documentSubtype, validUntil, paymentTerms, dueDate, aiSourceFileName, aiSourceFilePath, aiImportedAt, ewaybillNo, vehicleNumber, referenceDocumentId, referenceDocumentNumber, referenceDocumentDate, sourceDocumentIdsJson,
      transportName, deliveryDate, extraChargesJson = '[]', godownId: updateGodownId = null, gstPriceMode = 'exclusive', paymentBreakdown = [], items = [], allowItemReplacement = false
    } = req.body;

    // Get old items to reverse stock
    const oldItems = db.prepare('SELECT * FROM document_items WHERE documentId = ?').all(req.params.id) as any[];
    const oldDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    const batchDetailsAllowedForUpdate = allowsBatchDetails(String(oldDoc?.documentType || ''));

    // HARD RULE: on an existing transaction, an existing line cannot silently be
    // replaced with another item. The UI must first ask for explicit confirmation.
    // New lines are allowed, and deleting an existing line is allowed. The backend
    // enforces the same rule so a client cannot bypass the row-level confirmation.
    if (oldDoc && Array.isArray(items)) {
      const oldById = new Map(oldItems.map((x:any)=>[String(x.id), x]));
      for (const line of items as any[]) {
        const lineId = String(line?.id || '').trim();
        if (!lineId) continue; // new line
        const oldLine:any = oldById.get(lineId);
        if (!oldLine) continue;
        const oldItemId = String(oldLine.itemId || '');
        const newItemId = String(line?.itemId || '');
        if (oldItemId !== newItemId && !Boolean(allowItemReplacement)) {
          throw new Error('Item replacement requires confirmation. Click Modify, then click the item and confirm “Do you want to modify this item?”');
        }
      }
    }

    // Legacy-safe date contract: a modification must preserve an existing date,
    // and an old document with NULL entryDate inherits its documentDate.
    const resolvedUpdateDocumentDate = String(documentDate || oldDoc?.documentDate || new Date().toISOString().slice(0,10)).slice(0,10);
    const resolvedUpdateEntryDate = String(entryDate || oldDoc?.entryDate || resolvedUpdateDocumentDate).slice(0,10);

    if (Array.isArray(items)) { for (const line of items) { validateLineTax(String((req.body as any).firmId || oldDoc?.firmId || ''), Number(line?.taxRate ?? 0)); } }
    const updatePhoneCheck = validateMobile(phone);
    if (!updatePhoneCheck.valid) return res.status(400).json({ error: updatePhoneCheck.error });
    const normalizedUpdatePhone = phone === undefined ? (oldDoc?.phone || '') : (updatePhoneCheck.value || '');
    const resolvedUpdateGstRegistrationId = gstRegistrationId || (db.prepare('SELECT id FROM gst_registrations WHERE firmId=? AND isPrimary=1 AND isActive=1 LIMIT 1').get((req.body as any).firmId || oldDoc?.firmId) as any)?.id || null;
    const isSalesSideDocument = ['sale_invoice','sale_order','sale_return','sale_return_challan','sale_quotation','delivery_challan'].includes(String(oldDoc?.documentType || ''));
    let normalizedUpdatePartyId = String(partyId || '').trim() || null;
    let normalizedUpdatePartyName = String(partyName || '').trim();
    if (isSalesSideDocument && (!normalizedUpdatePartyId || !normalizedUpdatePartyName || normalizedUpdatePartyName.toLowerCase() === 'guest customer')) {
      const cash = ensureCashCustomer(String((req.body as any).firmId || oldDoc?.firmId));
      normalizedUpdatePartyId = String(cash.id);
      normalizedUpdatePartyName = String(cash.name);
    }
    if (!normalizedUpdatePartyName) throw new Error('Party is required for purchase documents');
    if (normalizedUpdatePartyId) {
      const partyExists = db.prepare('SELECT id FROM parties WHERE id=? AND firmId=?').get(normalizedUpdatePartyId, (req.body as any).firmId || oldDoc?.firmId);
      if (!partyExists) throw new Error('Selected party is not valid for this company');
    }
    validateReturnReference(String((req.body as any).firmId || oldDoc?.firmId), String(oldDoc?.documentType || ''), referenceDocumentId, items, String(req.params.id));
    const isAccountingDocument = ['sale_invoice', 'purchase_invoice', 'sale_return', 'purchase_return'].includes(oldDoc?.documentType);
    const isInvoiceDocument = ['sale_invoice', 'purchase_invoice'].includes(oldDoc?.documentType);
    const updateIsInvoice = ['sale_invoice', 'purchase_invoice'].includes(oldDoc?.documentType);
    const updateTotalForType = Math.max(0, parseFloat(String(total)) || 0);
    const updateRequestedPaidForType = Math.max(0, Math.min(updateTotalForType, parseFloat(String(paidAmount)) || 0));
    // Automatic billing classification: fully paid = Cash, unpaid/part-paid = Credit.
    const normalizedUpdateTransactionType = updateIsInvoice
      ? (updateRequestedPaidForType + 0.004 >= updateTotalForType ? 'cash' : 'credit')
      : (String(transactionType || 'cash') === 'credit' ? 'credit' : 'cash');
    // Existing documents already have an entry date. During modification, never
    // overwrite it with undefined just because an older client omitted the field.
    const isDueDateUpdateDocument = DUE_DATE_DOCUMENT_TYPES.includes(String(oldDoc?.documentType || ''));
    let resolvedUpdateDueDate = isDueDateUpdateDocument ? (String(dueDate || '').trim() || null) : null;
    if (!resolvedUpdateDueDate && isDueDateUpdateDocument) {
      const cp:any = normalizedUpdatePartyId ? db.prepare('SELECT creditDays FROM parties WHERE id=? AND firmId=?').get(normalizedUpdatePartyId, (req.body as any).firmId || oldDoc?.firmId) : null;
      const configuredDays = Number(cp?.creditDays || 0);
      const days = configuredDays > 0 ? Math.min(3650, Math.floor(configuredDays)) : 15;
      const d = new Date(`${resolvedUpdateDocumentDate}T00:00:00`);
      if (Number.isFinite(d.getTime())) { d.setDate(d.getDate()+days); resolvedUpdateDueDate = d.toISOString().slice(0,10); }
    }
    if (resolvedUpdateDueDate && resolvedUpdateDocumentDate && resolvedUpdateDueDate < resolvedUpdateDocumentDate) throw new Error('Due date cannot be before transaction date');
    const normalizedPaidAmount = isInvoiceDocument ? updateRequestedPaidForType : (isAccountingDocument ? (parseFloat(String(paidAmount)) || 0) : 0);
    const normalizedBalanceAmount = isInvoiceDocument ? Math.max(0, (parseFloat(String(total)) || 0) - normalizedPaidAmount) : (isAccountingDocument ? (parseFloat(String(balanceAmount)) || 0) : 0);

    // Customer credit-limit guard on modification. Exclude the current invoice from the existing balance.
    if (oldDoc?.documentType === 'sale_invoice' && normalizedUpdateTransactionType === 'credit' && normalizedUpdatePartyId && !(req.body as any).counterSaleIds?.length) {
      const cash = ensureCashCustomer(String((req.body as any).firmId || oldDoc?.firmId));
      if (String(normalizedUpdatePartyId) !== String(cash.id)) {
        const party:any = db.prepare('SELECT creditLimit FROM parties WHERE id=? AND firmId=?').get(normalizedUpdatePartyId, (req.body as any).firmId || oldDoc?.firmId);
        const limit = Math.max(0, Number(party?.creditLimit || 0));
        if (limit > 0) {
          const current:any = db.prepare(`SELECT COALESCE(SUM(CASE WHEN documentType='sale_invoice' THEN balanceAmount WHEN documentType='sale_return' THEN -balanceAmount ELSE 0 END),0) AS balance FROM documents WHERE firmId=? AND partyId=? AND isDeleted=0 AND id<>?`).get((req.body as any).firmId || oldDoc?.firmId, normalizedUpdatePartyId, req.params.id);
          const existing = Math.max(0, Number(current?.balance || 0));
          if (existing + Math.max(0, Number(normalizedBalanceAmount || 0)) > limit + 0.004) throw new Error(`Credit limit exceeded for ${normalizedUpdatePartyName}. Limit: ₹${limit.toFixed(2)}, Available: ₹${Math.max(0, limit-existing).toFixed(2)}`);
        }
      }
    }

    // Permanent Cash Customer rule on modification as well. A normal Cash Customer
    // sales invoice must remain fully paid; Counter Sale handoffs are exempt because
    // their payment was already collected before conversion. External payment entries
    // already allocated to this invoice also count toward the paid amount.
    if (oldDoc?.documentType === 'sale_invoice' && normalizedUpdatePartyId && !(req.body as any).counterSaleIds?.length) {
      const cash = ensureCashCustomer(String((req.body as any).firmId || oldDoc?.firmId));
      const isCashCustomer = String(normalizedUpdatePartyId) === String(cash.id);
      if (isCashCustomer && Math.max(0, Number(total) || 0) > 0.004) {
        const externalPaid = Number((db.prepare(
          'SELECT COALESCE(SUM(pa.amount),0) AS total FROM payment_allocations pa JOIN payments p ON p.id=pa.paymentId WHERE pa.documentId=? AND NOT (p.linkedDocumentId=? AND p.firmId=? AND p.type=?)'
        ).get(req.params.id, req.params.id, oldDoc.firmId, 'payment_in') as any)?.total || 0);
        const effectivePaid = Math.max(normalizedPaidAmount, externalPaid);
        if (effectivePaid + 0.004 < Math.max(0, Number(total) || 0)) {
          throw new Error(`Cash Customer billing requires full payment before the bill can be saved. Paid: ₹${effectivePaid.toFixed(2)}, Bill Total: ₹${(Number(total)||0).toFixed(2)}`);
        }
      }
    }

    // Reverse old stock changes — use the baseQuantity that was stored on the line at the
    // time (correct even if the item's unit/conversion has since changed), falling back to
    // the raw quantity for legacy rows saved before Two Units + Conversion existed.
    if (oldDoc && String(oldDoc.status||'') !== 'hold') {
      const isSale = ['sale_invoice', 'sale_order', 'delivery_challan'].includes(oldDoc.documentType);
      const isPurchase = ['purchase_invoice', 'purchase_order'].includes(oldDoc.documentType);
      const isSaleReturn = ['sale_return','sale_return_challan'].includes(oldDoc.documentType);
      const isPurchaseReturn = ['purchase_return','purchase_return_challan'].includes(oldDoc.documentType);
      for (const oldItem of oldItems as any[]) {
        if (oldItem.itemId) {
          const qty = Number(oldItem.baseQuantity || oldItem.quantity) || 0;
          const freeQty = (isPurchase && oldDoc.documentType !== 'purchase_return') ? Math.max(0, Number(oldItem.freeQuantity) || 0) : 0;
          const stockQty = qty + freeQty;
          // NOTE: at create time, a purchase/sale-return line ADDS stockQty to the batch and a
          // sale/purchase-return line SUBTRACTS qty from the batch. Reversing an edit must apply
          // the opposite sign of that original delta, not just its magnitude.
          const batchDeltaReverse = (isSale || isPurchaseReturn) ? qty : (isPurchase || isSaleReturn) ? -stockQty : 0;
          if (oldItem.batchId && batchDeltaReverse) db.prepare('UPDATE inventory_batches SET quantity=quantity+?,updatedAt=? WHERE id=? AND firmId=?').run(batchDeltaReverse, now, oldItem.batchId, oldDoc.firmId);
          if (isSale || isPurchaseReturn) db.prepare('UPDATE items SET currentStock = currentStock + ?, updatedAt = ? WHERE id = ?').run(qty, now, oldItem.itemId);
          else if (isPurchase) db.prepare('UPDATE items SET currentStock = currentStock - ?, updatedAt = ? WHERE id = ?').run(stockQty, now, oldItem.itemId);
          else if (isSaleReturn) db.prepare('UPDATE items SET currentStock = currentStock - ?, updatedAt = ? WHERE id = ?').run(qty, now, oldItem.itemId);
          if (isStoreStockDocument(oldDoc.documentType)) {
            const oldGodownId = oldItem.godownId || (oldDoc as any).godownId || null;
            if (oldGodownId) applyStoreStock(oldDoc.firmId, oldItem.itemId, oldGodownId, -storeStockDelta(oldDoc.documentType, qty, oldItem.freeQuantity), oldItem.name, true, now);
          }
        }
      }
    }

    const updateDocumentStmt = db.prepare(`
      UPDATE documents SET documentDate=@documentDate, documentTime=@documentTime, partyId=@partyId, partyName=@partyName, partyType=@partyType,
        phone=@phone, billingAddress=@billingAddress, shippingAddress=@shippingAddress, gstRegistrationId=@gstRegistrationId, godownId=@godownId, transactionType=@transactionType, status=@status, stateOfSupply=@stateOfSupply,
        subtotal=@subtotal, discountAmount=@discountAmount, discountPercentage=@discountPercentage, taxAmount=@taxAmount,
        shippingCharges=@shippingCharges, packagingCharges=@packagingCharges, adjustment=@adjustment, roundOff=@roundOff,
        total=@total, paidAmount=@paidAmount, balanceAmount=@balanceAmount, paymentType=@paymentType, bankId=@bankId,
        poNumber=@poNumber, poDate=@poDate, description=@description, documentSubtype=@documentSubtype, validUntil=@validUntil, paymentTerms=@paymentTerms, dueDate=@dueDate, entryDate=@entryDate, referenceDocumentId=@referenceDocumentId, referenceDocumentNumber=@referenceDocumentNumber, referenceDocumentDate=@referenceDocumentDate, sourceDocumentIdsJson=@sourceDocumentIdsJson, aiSourceFileName=@aiSourceFileName, aiSourceFilePath=@aiSourceFilePath, aiImportedAt=@aiImportedAt, ewaybillNo=@ewaybillNo, vehicleNumber=@vehicleNumber,
        transportName=@transportName, deliveryDate=@deliveryDate, extraChargesJson=@extraChargesJson, gstPriceMode=@gstPriceMode, updatedAt=@updatedAt WHERE id=@id
    `);
    updateDocumentStmt.run({
      documentDate:resolvedUpdateDocumentDate, documentTime, partyId:normalizedUpdatePartyId, partyName:normalizedUpdatePartyName, partyType, phone:normalizedUpdatePhone,
      billingAddress, shippingAddress, gstRegistrationId:resolvedUpdateGstRegistrationId, godownId:updateGodownId || null, transactionType:normalizedUpdateTransactionType, status, stateOfSupply,
      subtotal, discountAmount, discountPercentage, taxAmount,
      shippingCharges, packagingCharges, adjustment, roundOff,
      total, paidAmount:normalizedPaidAmount, balanceAmount:normalizedBalanceAmount, paymentType, bankId,
      poNumber, poDate, description, documentSubtype:documentSubtype || oldDoc.documentSubtype || null, validUntil:validUntil || null, paymentTerms:paymentTerms || null, dueDate:resolvedUpdateDueDate, entryDate:resolvedUpdateEntryDate, referenceDocumentId:referenceDocumentId || null, referenceDocumentNumber:referenceDocumentNumber || null, referenceDocumentDate:referenceDocumentDate || null, sourceDocumentIdsJson:sourceDocumentIdsJson || null, aiSourceFileName, aiSourceFilePath, aiImportedAt, ewaybillNo, vehicleNumber,
      transportName, deliveryDate, extraChargesJson, gstPriceMode:(['inclusive','exclusive'].includes(String(gstPriceMode)) ? String(gstPriceMode) : 'exclusive'), updatedAt:now, id:req.params.id
    });

    // Delete and re-insert items
    db.prepare('DELETE FROM document_items WHERE documentId = ?').run(req.params.id);
    
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id) as any;
    const actualUpdateItemColumns = new Set((db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c=>c.name));
    // IMPORTANT: derive SQL columns AND bound values from the exact same array.
    // The old implementation built the SQL column list from one hard-coded list,
    // but built the values from Object.keys(updateItemValues). That list also contains
    // godownId, so on databases where document_items has godownId SQLite received one
    // extra bound parameter and threw: "Too many parameter values were provided".
    const updateItemColumns = [
      'id','documentId','firmId','itemId','godownId','name','description','hsnCode','quantity','unit','unitId',
      'isSecondaryUnit','baseQuantity','secondaryQuantity','secondaryUnitId','price','discount','discountType',
      'discountPercentage','discountAmount','taxRate','taxAmount','amount','batchId','batchNumber','expiryDate',
      'expiryMonth','expiryYear','mfgDate','packing','freeQuantity','mrp','sellingRate','markup','createdAt','updatedAt'
    ].filter(c=>actualUpdateItemColumns.has(c));
    // Use named bindings for modification inserts. This makes the binding contract
    // independent of column ordering and prevents the SQLite positional-binding
    // failure that surfaced as "Too many parameter values were provided" on some
    // upgraded databases with additional document_items columns.
    const insertItem = db.prepare(`INSERT INTO document_items (${updateItemColumns.join(',')}) VALUES (${updateItemColumns.map(c=>`@${c}`).join(',')})`);

    for (const item of items) {
      const dbItem = item.itemId ? db.prepare('SELECT unitId, secondaryUnitId, conversionFactor FROM items WHERE id = ?').get(item.itemId) as any : null;
      const { baseQuantity, isSecondaryUnit, unitId: resolvedUnitId } = resolveLineUnit(doc.firmId, doc.documentType, dbItem, item);
      if (['purchase_return','purchase_return_challan','purchase_challan'].includes(String(doc.documentType))) {
        if (!Number.isFinite(Number(baseQuantity)) || Number(baseQuantity) < 0 || Number(item.freeQuantity || 0) < 0) {
          throw new Error(`Quantity cannot be negative for ${doc.documentType}`);
        }
      }

      const updateItemValues: Record<string,any> = {
        id:uuidv4(),documentId:req.params.id,firmId:doc.firmId,itemId:item.itemId,godownId:item.godownId || updateGodownId || null,name:item.name,description:item.description,hsnCode:item.hsnCode,
        quantity:item.quantity||0,unit:item.unit,unitId:resolvedUnitId,isSecondaryUnit:isSecondaryUnit,baseQuantity,secondaryQuantity:item.secondaryQuantity||0,secondaryUnitId:item.secondaryUnitId||null,
        price:item.price||0,discount:item.discount||0,discountType:item.discountType||'amount',discountPercentage:item.discountPercentage||0,discountAmount:item.discountAmount||0,taxRate:item.taxRate||0,taxAmount:item.taxAmount||0,amount:item.amount||0,
        batchId:item.batchId||null,batchNumber:item.batchNumber||null,expiryDate:null,expiryMonth:lineExpiry(item).month,expiryYear:lineExpiry(item).year,mfgDate:item.mfgDate||null,packing:item.packing||null,freeQuantity:item.freeQuantity||0,mrp:item.mrp||0,sellingRate:item.sellingRate||0,markup:item.markup||0,createdAt:now,updatedAt:now
      };
      const itemBindings:any = {}; for (const k of updateItemColumns) itemBindings[k] = updateItemValues[k];
      insertItem.run(itemBindings);

      // Apply new stock changes — base-unit terms.
      if (item.itemId && doc.documentType) {
        const isSale = ['sale_invoice', 'sale_order', 'delivery_challan'].includes(doc.documentType);
        const isPurchase = ['purchase_invoice', 'purchase_order'].includes(doc.documentType);
        const isSaleReturn = ['sale_return','sale_return_challan'].includes(doc.documentType);
        const isPurchaseReturn = ['purchase_return','purchase_return_challan'].includes(doc.documentType);
        const freeQty = isPurchase ? Math.max(0, Number(item.freeQuantity)||0) : 0;
        const stockQty = baseQuantity + freeQty;
        const batchDelta = (isSale || isPurchaseReturn) ? -baseQuantity : (isPurchase || isSaleReturn) ? stockQty : 0;
        if (batchDelta < 0 && (!isNegativeStockAllowed(doc.firmId) || isPurchaseReturn)) {
          const stockRow = db.prepare('SELECT currentStock FROM items WHERE id=? AND firmId=?').get(item.itemId, doc.firmId) as any;
          const available = Number(stockRow?.currentStock || 0);
          if (available - baseQuantity < -0.0001) {
            throw new Error(`Insufficient stock for ${item.name}. Available: ${available}, Required: ${baseQuantity}`);
          }
        }
        if (batchDelta < 0 && item.batchId) {
          const b0=db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(item.batchId,doc.firmId,item.itemId) as any;
          if (b0 && (!isNegativeStockAllowed(doc.firmId) || isPurchaseReturn) && Number(b0.quantity||0) + batchDelta < -0.0001) throw new Error(`Insufficient batch stock for ${item.name} / ${item.batchNumber||item.batchId}`);
        }
        if (item.batchId && batchDelta) { const ex=lineExpiry(item); db.prepare('UPDATE inventory_batches SET quantity=quantity+?,expiryDate=NULL,expiryMonth=?,expiryYear=?,updatedAt=? WHERE id=? AND firmId=?').run(batchDelta,ex.month,ex.year,now,item.batchId,doc.firmId); }
        if (!item.batchId && item.batchNumber && batchDelta) {
          const b=db.prepare('SELECT id,quantity FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=?').get(doc.firmId,item.itemId,item.batchNumber) as any;
          if(b) { if (batchDelta < 0 && (!isNegativeStockAllowed(doc.firmId) || isPurchaseReturn) && Number(b.quantity||0)+batchDelta < -0.0001) throw new Error(`Insufficient batch stock for ${item.name} / ${item.batchNumber}`); const ex=lineExpiry(item); db.prepare('UPDATE inventory_batches SET quantity=quantity+?,expiryDate=NULL,expiryMonth=?,expiryYear=?,updatedAt=? WHERE id=?').run(batchDelta,ex.month,ex.year,now,b.id); }
          else if (batchDelta > 0) { const ex=lineExpiry(item); db.prepare(`INSERT INTO inventory_batches(id,firmId,itemId,batchNumber,expiryDate,expiryMonth,expiryYear,mfgDate,packing,purchaseRate,mrp,sellingRate,markup,quantity,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuidv4(),doc.firmId,item.itemId,String(item.batchNumber).trim(),null,ex.month,ex.year,item.mfgDate||null,item.packing||null,Number(item.price)||0,Number(item.mrp)||0,Number(item.sellingRate)||0,Number(item.markup)||0,batchDelta,now,now); }
        }
        if (isSale || isPurchaseReturn) db.prepare('UPDATE items SET currentStock = currentStock - ?, updatedAt = ? WHERE id = ?').run(baseQuantity, now, item.itemId);
        else if (isPurchase) db.prepare('UPDATE items SET currentStock = currentStock + ?, updatedAt = ? WHERE id = ?').run(stockQty, now, item.itemId);
        else if (isSaleReturn) db.prepare('UPDATE items SET currentStock = currentStock + ?, updatedAt = ? WHERE id = ?').run(baseQuantity, now, item.itemId);
        if (isStoreStockDocument(doc.documentType)) {
          const lineGodownId = item.godownId || updateGodownId || null;
          if (!lineGodownId) throw new Error(`Select a Store/Godown for ${item.name}`);
          applyStoreStock(doc.firmId, item.itemId, lineGodownId, storeStockDelta(doc.documentType, baseQuantity, item.freeQuantity), item.name, isNegativeStockAllowed(doc.firmId) && !['purchase_return','purchase_return_challan'].includes(doc.documentType), now);
        }
      }
    }

    // Reconcile billing-time payments in-place. Payments created later from
    // Accounting / Payment In-Out are external and remain untouched. Every change
    // to the invoice amount/payment is committed atomically with the document.
    if (['sale_invoice', 'purchase_invoice', 'sale_return', 'purchase_return'].includes(doc.documentType) && status !== 'draft' && status !== 'cancelled' && status !== 'hold') {
      const requestedPaid = Math.max(0, Math.min(parseFloat(String(paidAmount)) || 0, parseFloat(String(total)) || 0));
      const paymentDirectionIn = ['sale_invoice','purchase_return'].includes(doc.documentType);
      const autoPaymentType = paymentDirectionIn ? 'payment_in' : 'payment_out';
      const externalAllocated = Number((db.prepare(
        'SELECT COALESCE(SUM(pa.amount),0) AS total FROM payment_allocations pa JOIN payments p ON p.id = pa.paymentId WHERE pa.documentId = ? AND NOT (p.linkedDocumentId = ? AND p.firmId = ? AND p.type = ?)'
      ).get(req.params.id, req.params.id, doc.firmId, autoPaymentType) as any)?.total || 0);

      if (requestedPaid + 0.004 < externalAllocated) {
        throw new Error(`Paid amount cannot be less than existing accounting payments allocated to this invoice (₹${Number(externalAllocated).toFixed(2)})`);
      }

      const desiredAutoPaid = Math.max(0, +(requestedPaid - externalAllocated).toFixed(2));
      const existingAutoPayments = db.prepare(
        'SELECT * FROM payments WHERE linkedDocumentId = ? AND firmId = ? AND type = ? AND isDeleted=0 ORDER BY createdAt ASC, id ASC'
      ).all(req.params.id, doc.firmId, autoPaymentType) as any[];

      // Reverse every existing auto payment first. This guarantees that changing
      // ₹500 → ₹300 or Cash → Bank never leaves stale money in the old account.
      for (const oldPayment of existingAutoPayments) {
        const oldAmount = Math.max(0, Number(oldPayment.amount) || 0);
        if (oldAmount > 0) applyFunds(doc.firmId, oldPayment.paymentMethod || 'cash', oldPayment.bankId || null, oldAmount, paymentDirectionIn ? -1 : 1, now);
      }

      // Normalize the requested payment breakdown. If the UI sends multiple modes,
      // preserve them; if it sends only a single payment amount, keep one existing
      // auto-payment row and edit that row instead of creating duplicate entries.
      const rawBreakdown = Array.isArray(paymentBreakdown)
        ? paymentBreakdown.map((x:any)=>({ method:String(x?.method||'cash'), amount:Math.max(0, Number(x?.amount)||0), bankId:x?.bankId||null })).filter((x:any)=>x.amount>0)
        : [];
      const desiredRows:any[] = [];
      let remainingDesired = desiredAutoPaid;
      for (const row of rawBreakdown) {
        if (remainingDesired <= 0.004) break;
        const amount = Math.min(row.amount, remainingDesired);
        if (amount > 0.004) { desiredRows.push({...row, amount:+amount.toFixed(2)}); remainingDesired=+(remainingDesired-amount).toFixed(2); }
      }
      if (remainingDesired > 0.004) {
        const fallbackMethod = rawBreakdown[0]?.method || paymentType || 'cash';
        const fallbackBank = rawBreakdown[0]?.bankId || bankId || null;
        if (desiredRows.length) desiredRows[0].amount=+(desiredRows[0].amount+remainingDesired).toFixed(2);
        else if (desiredAutoPaid > 0.004) desiredRows.push({method:fallbackMethod,bankId:fallbackBank,amount:desiredAutoPaid});
      }

      const paymentUpdate = db.prepare(`UPDATE payments SET partyId=@partyId, partyName=@partyName, amount=@amount, paymentMethod=@paymentMethod, bankId=@bankId, paymentDate=@paymentDate, reference=@reference, updatedAt=@updatedAt WHERE id=@id`);
      const deleteAllocation = db.prepare('DELETE FROM payment_allocations WHERE paymentId=? AND documentId=?');
      const insertAllocation = db.prepare('INSERT INTO payment_allocations (id, firmId, paymentId, documentId, amount, createdAt) VALUES (@id, @firmId, @paymentId, @documentId, @amount, @createdAt)');
      const deletePayment = db.prepare('DELETE FROM payments WHERE id=?');
      const insertPayment = db.prepare(`INSERT INTO payments (id, firmId, type, partyId, partyName, amount, paymentMethod, bankId,
        receiptNumber, paymentDate, reference, description, linkedDocumentId, createdAt, updatedAt)
        VALUES (@id, @firmId, @type, @partyId, @partyName, @amount, @paymentMethod, @bankId, @receiptNumber, @paymentDate, @reference, @description, @linkedDocumentId, @createdAt, @updatedAt)`);

      for (let i=0; i<desiredRows.length; i++) {
        const row=desiredRows[i];
        const existing=existingAutoPayments[i];
        if (existing) {
          deleteAllocation.run(existing.id, req.params.id);
          paymentUpdate.run({ partyId:normalizedUpdatePartyId, partyName:normalizedUpdatePartyName, amount:row.amount, paymentMethod:row.method, bankId:row.method==='bank' ? (row.bankId || bankId || null) : null, paymentDate:documentDate, reference:existing.reference || `Auto: ${doc.documentNumber}`, updatedAt:now, id:existing.id });
          insertAllocation.run({ id:uuidv4(), firmId:doc.firmId, paymentId:existing.id, documentId:req.params.id, amount:row.amount, createdAt:now });
        } else {
          const payId=uuidv4();
          insertPayment.run({ id:payId, firmId:doc.firmId, type:autoPaymentType, partyId:normalizedUpdatePartyId, partyName:normalizedUpdatePartyName, amount:row.amount, paymentMethod:row.method, bankId:row.method==='bank' ? (row.bankId || bankId || null) : null, receiptNumber:null, paymentDate:documentDate, reference:`Auto: ${doc.documentNumber}`, description:'Collected at billing', linkedDocumentId:req.params.id, createdAt:now, updatedAt:now });
          insertAllocation.run({ id:uuidv4(), firmId:doc.firmId, paymentId:payId, documentId:req.params.id, amount:row.amount, createdAt:now });
        }
        applyFunds(doc.firmId, row.method, row.method==='bank' ? (row.bankId || bankId || null) : null, row.amount, paymentDirectionIn ? 1 : -1, now);
      }

      // Remove surplus auto-payment rows from an older multi-mode payment split.
      for (let i=desiredRows.length; i<existingAutoPayments.length; i++) {
        const oldPayment=existingAutoPayments[i];
        deleteAllocation.run(oldPayment.id, req.params.id);
        deletePayment.run(oldPayment.id);
      }

      // Single source of truth: paid/balance/status comes from allocations.
      recalcDocumentStatus(req.params.id, now);
    }

    const updatedDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    const docItems = db.prepare('SELECT * FROM document_items WHERE documentId = ?').all(req.params.id);
    writeDocumentAudit(req.params.id, String(oldDoc.firmId), 'MODIFIED', oldDoc, oldItems as any[], updatedDoc, docItems as any[], req, 'Transaction modified');
    return { ...updatedDoc as any, items: docItems };
    });

    const data = updateDocument();
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH trash/delete document
router.patch('/:id/trash', (req: Request, res: Response) => {
  try {
    const oldDoc:any=db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
    if(!oldDoc) return res.status(404).json({error:'Document not found'});
    const oldItems:any[]=db.prepare('SELECT * FROM document_items WHERE documentId=?').all(req.params.id);
    const firmId=String(req.body?.firmId||oldDoc.firmId||'');
    db.prepare('UPDATE documents SET isDeleted = 1, updatedAt = ? WHERE id = ? AND firmId = ?').run(new Date().toISOString(), req.params.id, firmId);
    writeDocumentAudit(req.params.id,firmId,'DELETED',oldDoc,oldItems,null,[],req,'Transaction deleted / moved to recycle bin');
    res.json({ success: true, message: 'Document trashed' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH restore document
router.patch('/:id/restore', (req: Request, res: Response) => {
  try {
    db.prepare('UPDATE documents SET isDeleted = 0, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
    res.json({ success: true, message: 'Document restored' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET next document number (preview only — does not consume the number).
// If seriesId is given, previews that series; otherwise falls back to the
// firm's default series for this type, then to the legacy per-firm counter.
router.get('/next-number/:type', (req: Request, res: Response) => {
  try {
    const { firmId, seriesId } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });

    const requestedType = String(req.params.type || '');
    if (requestedType === 'sale_proforma') {
      const firm = db.prepare('SELECT proformaNumber FROM firms WHERE id = ?').get(firmId) as any;
      if (!firm) return res.status(404).json({ error: 'Firm not found' });
      const num = Number(firm.proformaNumber || 1);
      return res.json({ success: true, data: `PI-${String(num).padStart(4, '0')}`, seriesId: null });
    }

    const multiSeriesEnabled = getModuleSettings(String(firmId), requestedType).multiSeriesEnabled;

    let series: any = null;
    if (multiSeriesEnabled && seriesId) {
      series = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
    } else if (multiSeriesEnabled) {
      series = db.prepare(
        'SELECT * FROM series WHERE firmId = ? AND transactionType = ? AND isActive = 1 AND isDefault = 1'
      ).get(firmId, req.params.type);
    }

    if (series) {
      const padded = String(series.currentNumber).padStart(series.numberLength, '0');
      const preview = series.includeFinancialYearInNumber && series.financialYear
        ? `${series.prefix}/${series.financialYear}/${padded}`
        : `${series.prefix}-${padded}`;
      return res.json({ success: true, data: preview, seriesId: series.id });
    }

    // Legacy fallback
    const firm = db.prepare('SELECT * FROM firms WHERE id = ?').get(firmId) as any;
    if (!firm) return res.status(404).json({ error: 'Firm not found' });
    const prefix = firm.invoicePrefix || 'INV';
    const num = firm.invoiceNumber || 1;
    res.json({ success: true, data: `${prefix}-${String(num).padStart(4, '0')}`, seriesId: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE document: hard-delete is intentionally disabled. All transaction deletes
// are soft-deletes so the record remains recoverable in Utilities & Tools -> Recycle Bin.
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const r = db.prepare('UPDATE documents SET isDeleted=1, updatedAt=? WHERE id=?').run(now, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true, message: 'Document moved to recycle bin' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;



