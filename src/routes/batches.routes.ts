import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { expiryFromLegacyDate, parseExpiryInput, expiryDisplay, normalizeExpiryMonth, normalizeExpiryYear } from '../lib/batchExpiry';

const router = Router();

// Available batches for purchase/sale selection. Zero-stock batches are excluded here;
// reports/history can still retrieve them.
router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, itemId, search, includeZero } = req.query;
    if (!firmId || !itemId) return res.status(400).json({ error: 'firmId and itemId required' });
    let q = `SELECT b.*, i.name AS itemName FROM inventory_batches b JOIN items i ON i.id=b.itemId WHERE b.firmId=? AND b.itemId=?`;
    const params: any[] = [firmId, itemId];
    if (includeZero !== 'true') q += ' AND b.quantity > 0';
    if (search) { q += ' AND COALESCE(b.batchNumber,\'\') LIKE ?'; params.push(`%${search}%`); }
    q += ' ORDER BY CASE WHEN b.expiryYear IS NULL OR b.expiryMonth IS NULL THEN 1 ELSE 0 END, b.expiryYear ASC, b.expiryMonth ASC, b.updatedAt DESC';
    res.json({ success:true, data: db.prepare(q).all(params) });
  } catch(e:any) { res.status(500).json({error:e.message}); }
});

router.get('/report', (req: Request, res: Response) => {
  try {
    const { firmId, itemId, status, expiryFrom, expiryTo, search } = req.query;
    if (!firmId) return res.status(400).json({error:'firmId required'});
    let q=`SELECT b.*,i.name itemName,i.itemCode,i.barcode FROM inventory_batches b JOIN items i ON i.id=b.itemId WHERE b.firmId=?`;
    const p:any[]=[firmId]; if(itemId){q+=' AND b.itemId=?';p.push(itemId)}
    const searchTerm=String(search||'').trim();
    if(searchTerm){ const term=`%${searchTerm}%`; q+=` AND (COALESCE(i.name,'') LIKE ? OR COALESCE(i.itemCode,'') LIKE ? OR COALESCE(i.barcode,'') LIKE ? OR COALESCE(i.sku,'') LIKE ? OR COALESCE(b.batchNumber,'') LIKE ?)`; p.push(term,term,term,term,term); }
    const now=new Date();
    const currentYear=now.getFullYear(); const currentMonth=now.getMonth()+1;
    const expiryValue=(year:any,month:any)=>Number(year)*12+Number(month);
    const currentValue=expiryValue(currentYear,currentMonth);
    if(status==='available') q+=' AND b.quantity>0';
    if(status==='zero') q+=' AND b.quantity<=0';
    if(status==='expired') {
      q+=' AND b.expiryYear IS NOT NULL AND b.expiryMonth IS NOT NULL AND (b.expiryYear*12+b.expiryMonth) < ?'; p.push(currentValue);
    }
    if(status==='near_expiry') {
      const fromYear=typeof expiryFrom==='string' && /^\d{4}-\d{2}$/.test(expiryFrom) ? Number(expiryFrom.slice(0,4)) : currentYear;
      const fromMonth=typeof expiryFrom==='string' && /^\d{4}-\d{2}$/.test(expiryFrom) ? Number(expiryFrom.slice(5,7)) : currentMonth;
      const toDate=new Date(currentYear,currentMonth-1,1); toDate.setMonth(toDate.getMonth()+3);
      const toYear=typeof expiryTo==='string' && /^\d{4}-\d{2}$/.test(expiryTo) ? Number(expiryTo.slice(0,4)) : toDate.getFullYear();
      const toMonth=typeof expiryTo==='string' && /^\d{4}-\d{2}$/.test(expiryTo) ? Number(expiryTo.slice(5,7)) : toDate.getMonth()+1;
      const fromValue=expiryValue(fromYear,fromMonth); const toValue=expiryValue(toYear,toMonth);
      if(!fromMonth || fromMonth>12 || !toMonth || toMonth>12 || toValue < fromValue) return res.status(400).json({error:'Expiry To month/year must be on or after Expiry From month/year'});
      q+=' AND b.quantity>0 AND b.expiryYear IS NOT NULL AND b.expiryMonth IS NOT NULL AND (b.expiryYear*12+b.expiryMonth)>=? AND (b.expiryYear*12+b.expiryMonth)<=?'; p.push(fromValue,toValue);
    }
    q+=' ORDER BY i.name,CASE WHEN b.expiryYear IS NULL OR b.expiryMonth IS NULL THEN 1 ELSE 0 END,b.expiryYear,b.expiryMonth,b.batchNumber';
    const rows:any[]=db.prepare(q).all(p); res.json({success:true,data:rows.map(r=>({...r,expiryDate:null,expiryDisplay:expiryDisplay(r.expiryMonth,r.expiryYear)}))});
  } catch(e:any){res.status(500).json({error:e.message})}
});

router.get('/:id/transactions', (req: Request, res: Response) => {
  try {
    const b=db.prepare('SELECT b.*,i.name itemName FROM inventory_batches b JOIN items i ON i.id=b.itemId WHERE b.id=?').get(req.params.id) as any;
    if(!b)return res.status(404).json({error:'Batch not found'});
    const documentRows:any[] = db.prepare(`SELECT di.id,d.id documentId,d.documentType,d.documentNumber,d.documentDate,d.partyName,d.partyType,
      di.quantity,di.freeQuantity,di.price,di.amount,di.taxAmount,di.batchNumber,di.expiryMonth,di.expiryYear,di.expiryDate,di.mfgDate,
      CASE WHEN d.documentType IN ('purchase_invoice','purchase_order','purchase_challan') THEN 'PURCHASE'
           WHEN d.documentType IN ('sale_invoice','sale_order','delivery_challan') THEN 'SALE'
           WHEN d.documentType IN ('purchase_return','purchase_return_challan') THEN 'PURCHASE_RETURN'
           WHEN d.documentType IN ('sale_return','sale_return_challan') THEN 'SALE_RETURN'
           ELSE 'DOCUMENT' END sourceType
      FROM document_items di JOIN documents d ON d.id=di.documentId
      WHERE di.batchId=? AND d.firmId=? AND d.isDeleted=0 ORDER BY d.documentDate ASC,d.createdAt ASC`).all(req.params.id,b.firmId);

    // Manufacturing batches do not have a document_items row. Their source of truth
    // is manufacturing_movements, which keeps the production number, material issue /
    // receipt number, movement type, quantity, cost and batch link. Merge both sources
    // into the same batch-history response so Item > Batch works uniformly for purchase,
    // sale and manufacturing-origin batches.
    const manufacturingRows:any[] = db.prepare(`SELECT mm.id, m.id manufacturingEntryId,
      'manufacturing' documentType, m.productionNo documentNumber, m.productionDate documentDate,
      'B-MAX Manufacturing' partyName, 'MANUFACTURING' partyType,
      mm.quantity, 0 freeQuantity, mm.unitCost price, mm.amount, 0 taxAmount,
      mm.batchNumber, b.expiryMonth, b.expiryYear, NULL expiryDate, b.mfgDate mfgDate,
      mm.movementType, mm.movementNo, mm.godownId, mm.notes,
      CASE WHEN mm.movementType='ISSUE' THEN 'MANUFACTURING_MATERIAL_ISSUE'
           WHEN mm.movementType='RECEIPT' THEN 'MANUFACTURING_FINISHED_RECEIPT'
           WHEN mm.movementType='BY_PRODUCT_RECEIPT' THEN 'MANUFACTURING_BYPRODUCT_RECEIPT'
           WHEN mm.movementType='LOSS' THEN 'MANUFACTURING_LOSS'
           ELSE 'MANUFACTURING' END sourceType
      FROM manufacturing_movements mm
      JOIN manufacturing_entries m ON m.id=mm.entryId
      LEFT JOIN inventory_batches b ON b.id=mm.batchId
      WHERE mm.batchId=? AND mm.firmId=? AND m.status='posted'
      ORDER BY mm.movementDate ASC,mm.createdAt ASC`).all(req.params.id,b.firmId);

    const transactions=[...documentRows,...manufacturingRows].sort((a:any,c:any)=>String(a.documentDate||'').localeCompare(String(c.documentDate||'')) || String(a.documentNumber||'').localeCompare(String(c.documentNumber||'')));
    const manufacturingSources=manufacturingRows.filter((r:any)=>String(r.movementType||'').includes('RECEIPT'));
    const purchaseSources=documentRows.filter((r:any)=>String(r.sourceType||'').startsWith('PURCHASE'));
    const saleSources=documentRows.filter((r:any)=>String(r.sourceType||'').startsWith('SALE'));
    let originType='UNKNOWN'; let originLabel='Unknown / legacy batch'; let originRef=null; let originDate=null;
    if(manufacturingSources.length){ originType='MANUFACTURING'; originLabel='Manufactured'; originRef=manufacturingSources[0].documentNumber; originDate=manufacturingSources[0].documentDate; }
    else if(purchaseSources.length){ originType='PURCHASE'; originLabel='Purchased'; originRef=purchaseSources[0].documentNumber; originDate=purchaseSources[0].documentDate; }
    else if(saleSources.length){ originType='SALE'; originLabel='Sale transaction'; originRef=saleSources[0].documentNumber; originDate=saleSources[0].documentDate; }
    res.json({success:true,data:{batch:{...b,expiryDate:null,expiryDisplay:expiryDisplay(b.expiryMonth,b.expiryYear)},origin:{type:originType,label:originLabel,reference:originRef,date:originDate},transactions:transactions.map((r:any)=>({...r,expiryDate:null,expiryDisplay:expiryDisplay(r.expiryMonth,r.expiryYear)}))}});
  } catch(e:any){res.status(500).json({error:e.message})}
});

// Exact batch lookup used by purchase entry to restore saved batch metadata
// (expiry, manufacturing month/year, cost, MRP, selling rate, packing and scheme).
router.get('/lookup', (req: Request, res: Response) => {
  try {
    const { firmId, itemId, batchNumber } = req.query;
    if (!firmId || !itemId || !batchNumber) return res.status(400).json({error:'firmId, itemId and batchNumber required'});
    const b:any = db.prepare(`SELECT b.*,i.name itemName FROM inventory_batches b JOIN items i ON i.id=b.itemId
      WHERE b.firmId=? AND b.itemId=? AND b.batchNumber=? LIMIT 1`).get(String(firmId),String(itemId),String(batchNumber).trim());
    if (!b) return res.status(404).json({error:'Batch not found'});
    res.json({success:true,data:{...b,expiryDate:null,expiryDisplay:expiryDisplay(b.expiryMonth,b.expiryYear),mfgDate:b.mfgDate||null,mfgDisplay:b.mfgDate||null}});
  } catch(e:any) { res.status(500).json({error:e.message}); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const {firmId,itemId,batchNumber=null,expiryMonth=null,expiryYear=null,expiryDate=null,mfgDate=null,packing=null,purchaseRate=0,mrp=0,sellingRate=0,markup=0,schemeBuyQty=0,schemeFreeQty=0,quantity=0,source=''}=req.body;
    if(!firmId||!itemId)return res.status(400).json({error:'firmId and itemId required'});
    if (String(source).toLowerCase() !== 'purchase') return res.status(403).json({error:'New batches can only be created from Purchase. Select an existing batch in Sales.'});
    const parsedExpiry=parseExpiryInput(expiryDate);
    const legacy=expiryFromLegacyDate(expiryDate);
    const em=normalizeExpiryMonth(expiryMonth) ?? parsedExpiry.month ?? legacy.month;
    const ey=normalizeExpiryYear(expiryYear) ?? parsedExpiry.year ?? legacy.year;
    const commercial = { schemeBuyQty: Math.max(0, Number(schemeBuyQty)||0), schemeFreeQty: Math.max(0, Number(schemeFreeQty)||0) };
    if ((commercial.schemeBuyQty > 0) !== (commercial.schemeFreeQty > 0)) return res.status(400).json({error:'Scheme Buy Qty and Free Qty must both be greater than 0, or both be 0'});
    const canonicalExpiryDate = null; // Expiry is stored canonically as expiryMonth + expiryYear.
    const rawMfg = String(mfgDate || '').trim();
    const mfgMatch = rawMfg.match(/^(\d{1,2})\s*[/.-]\s*(\d{4})$/);
    const mfgIsoMatch = rawMfg.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
    const canonicalMfgDate = mfgMatch ? `${String(Number(mfgMatch[1])).padStart(2,'0')}/${mfgMatch[2]}`
      : mfgIsoMatch ? `${mfgIsoMatch[2]}/${mfgIsoMatch[1]}` : (rawMfg || null);
    const mfgParts = canonicalMfgDate ? canonicalMfgDate.match(/^(\d{2})\/(\d{4})$/) : null;
    const nowLocal = new Date();
    const todayLocal = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}`;
    const currentMonthLocal = todayLocal.slice(0,7);
    // Historical/expired batches are valid inventory history. Expiry is only
    // rejected when malformed or earlier than the manufacturing month; sales
    // and reports decide how an already-expired batch may be used.
    if (mfgParts && (Number(mfgParts[2])*12+Number(mfgParts[1])) > (nowLocal.getFullYear()*12 + nowLocal.getMonth()+1))
      return res.status(400).json({error:'Manufacturing month/year cannot be after the current month'});
    if (mfgParts && em && ey && (Number(ey)*12+Number(em)) < (Number(mfgParts[2])*12+Number(mfgParts[1])))
      return res.status(400).json({error:'Expiry month/year cannot be before Manufacturing month/year'});
    const legacyDate=canonicalExpiryDate;
    if((req.body.requireExpiry === true || String(req.body.requireExpiry).toLowerCase() === 'true') && (!em || !ey)) return res.status(400).json({error:'Expiry Month and Expiry Year are required for a batch'});
    const now=new Date().toISOString();
    const existing=batchNumber ? db.prepare('SELECT * FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=?').get(firmId,itemId,batchNumber) as any : null;
    if(existing){
      db.prepare(`UPDATE inventory_batches SET expiryDate=?,expiryMonth=?,expiryYear=?,mfgDate=COALESCE(?,mfgDate),packing=COALESCE(?,packing),purchaseRate=?,mrp=?,sellingRate=?,markup=?,schemeBuyQty=?,schemeFreeQty=?,quantity=quantity+?,updatedAt=? WHERE id=?`)
        .run(canonicalExpiryDate,em,ey,canonicalMfgDate,packing,Number(purchaseRate)||0,Number(mrp)||0,Number(sellingRate)||0,Number(markup)||0,commercial.schemeBuyQty,commercial.schemeFreeQty,Number(quantity)||0,now,existing.id);
      const saved:any=db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(existing.id); return res.json({success:true,data:{...saved,expiryDate:null,expiryDisplay:expiryDisplay(saved.expiryMonth,saved.expiryYear)}});
    }
    const id=uuidv4();
    db.prepare(`INSERT INTO inventory_batches(id,firmId,itemId,batchNumber,expiryDate,expiryMonth,expiryYear,mfgDate,packing,purchaseRate,mrp,sellingRate,markup,schemeBuyQty,schemeFreeQty,quantity,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,firmId,itemId,batchNumber,canonicalExpiryDate,em,ey,canonicalMfgDate,packing,Number(purchaseRate)||0,Number(mrp)||0,Number(sellingRate)||0,Number(markup)||0,commercial.schemeBuyQty,commercial.schemeFreeQty,Number(quantity)||0,now,now);
    const saved:any=db.prepare('SELECT * FROM inventory_batches WHERE id=?').get(id); res.status(201).json({success:true,data:{...saved,expiryDate:null,expiryDisplay:expiryDisplay(saved.expiryMonth,saved.expiryYear)}});
  }catch(e:any){res.status(500).json({error:e.message})}
});


// Batch deletion is intentionally history-safe. Once a batch participates in a
// transaction it must remain available for audit/history. In particular, a sold
// batch can never be deleted. When negative stock is enabled, subsequent sales
// continue against the same batch record and its quantity may become negative.
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const batch:any = db.prepare(`SELECT b.id,b.firmId,b.itemId,b.batchNumber,b.quantity,i.name itemName
      FROM inventory_batches b JOIN items i ON i.id=b.itemId WHERE b.id=?`).get(req.params.id);
    if (!batch) return res.status(404).json({error:'Batch not found'});
    const firmId=String(req.body?.firmId||req.query?.firmId||batch.firmId);
    if (firmId!==String(batch.firmId)) return res.status(403).json({error:'Batch does not belong to firm'});

    const doc:any=db.prepare(`SELECT COUNT(*) count FROM document_items di
      JOIN documents d ON d.id=di.documentId
      WHERE di.batchId=? AND d.firmId=? AND d.isDeleted=0`).get(batch.id,firmId);
    const counter:any=db.prepare(`SELECT COUNT(*) count FROM counter_sale_items csi
      JOIN counter_sales cs ON cs.id=csi.counterSaleId
      WHERE csi.batchId=? AND cs.firmId=?`).get(batch.id,firmId);
    const manufacturing:any=db.prepare(`SELECT COUNT(*) count FROM manufacturing_movements
      WHERE batchId=? AND firmId=?`).get(batch.id,firmId);
    const transactionCount=Number(doc?.count||0)+Number(counter?.count||0)+Number(manufacturing?.count||0);

    if(transactionCount>0) {
      return res.status(409).json({
        error:'Batch cannot be deleted because it has transaction history. Sold batches must be retained for stock and audit history.',
        data:{batchId:batch.id,batchNumber:batch.batchNumber,itemId:batch.itemId,currentQuantity:Number(batch.quantity||0),transactionCount}
      });
    }

    db.prepare('DELETE FROM inventory_batches WHERE id=? AND firmId=?').run(batch.id,firmId);
    res.json({success:true,message:'Batch deleted'});
  } catch(e:any) { res.status(500).json({error:e.message}); }
});

export default router;



