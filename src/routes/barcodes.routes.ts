import { Router, Request, Response } from 'express';
import { db } from '../lib/db';

const router = Router();

function makeLabels(rows:any[], copies:number){
  const out:any[]=[];
  for(const row of rows){
    const qty=Math.max(1, Math.min(500, Number(row.quantity)||1));
    const count=Math.max(1, copies || qty);
    for(let i=0;i<count;i++) out.push({
      itemId:row.itemId,
      itemName:row.itemName || row.name || 'Item',
      barcode:row.barcode || row.itemCode || '',
      itemCode:row.itemCode || '',
      batchId:row.batchId || null,
      batchNumber:row.batchNumber || '',
      mrp:row.batchMrp ?? row.mrp ?? 0,
      sellingRate:row.batchSellingRate ?? row.sellingRate ?? 0,
    });
  }
  return out.slice(0,500);
}

router.post('/print-preview',(req:Request,res:Response)=>{
  try{
    const firmId=String(req.body?.firmId||'').trim();
    const itemId=String(req.body?.itemId||'').trim();
    const documentId=String(req.body?.documentId||'').trim();
    const batchId=String(req.body?.batchId||'').trim();
    const mode=String(req.body?.barcodeMode||'item');
    const copies=Math.max(1,Math.min(500,Number(req.body?.copies)||1));
    if(!firmId)return res.status(400).json({error:'firmId is required'});
    if(!itemId && !documentId)return res.status(400).json({error:'itemId or documentId is required'});

    let rows:any[]=[];
    if(documentId){
      rows=db.prepare(`SELECT di.itemId,di.quantity,di.batchId,di.batchNumber,
        i.name itemName,i.itemCode,i.barcode,i.mrp,i.salePrice sellingRate,
        b.mrp batchMrp,b.sellingRate batchSellingRate
        FROM document_items di
        JOIN documents d ON d.id=di.documentId AND d.firmId=?
        LEFT JOIN items i ON i.id=di.itemId
        LEFT JOIN inventory_batches b ON b.id=di.batchId
        WHERE di.documentId=?`).all(firmId,documentId) as any[];
    } else {
      const item:any=db.prepare(`SELECT id itemId,name itemName,itemCode,barcode,mrp,salePrice sellingRate
        FROM items WHERE id=? AND firmId=? AND isActive=1`).get(itemId,firmId);
      if(!item)return res.status(404).json({error:'Item not found'});
      if(mode==='batch' && batchId){
        const b:any=db.prepare('SELECT id batchId,batchNumber,mrp batchMrp,sellingRate batchSellingRate,quantity FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(batchId,firmId,itemId);
        if(!b)return res.status(404).json({error:'Batch not found'});
        rows=[{...item,...b,quantity:1}];
      } else rows=[{...item,quantity:1}];
    }
    if(!rows.length)return res.status(404).json({error:'No barcode source records found'});
    const labels=makeLabels(rows,copies);
    if(!labels.length)return res.status(400).json({error:'No barcode labels available'});
    res.json({success:true,data:{labels,barcodeMode:mode,copies:labels.length}});
  }catch(err:any){res.status(500).json({error:err?.message||'Barcode print preview failed'});}
});

export default router;
