import { Router, Request, Response } from 'express';
import { getNegativeStockAllowed } from '../lib/moduleSettings';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { assertItemQuantityPrecision } from '../lib/quantityPolicy';

const router = Router();
const now = () => new Date().toISOString();
const uid = () => uuidv4();

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, transferNo TEXT NOT NULL,
      transferDate TEXT NOT NULL, sourceGodownId TEXT NOT NULL, destinationGodownId TEXT NOT NULL,
      notes TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_firm_date ON stock_transfers(firmId,transferDate);
    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id TEXT PRIMARY KEY, transferId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT NOT NULL,
      quantity REAL NOT NULL, unit TEXT, batchId TEXT, batchNumber TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(transferId) REFERENCES stock_transfers(id) ON DELETE CASCADE,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON stock_transfer_items(transferId);
    CREATE TABLE IF NOT EXISTS inventory_batch_stock (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, itemId TEXT NOT NULL, batchId TEXT NOT NULL,
      godownId TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL,
      UNIQUE(firmId,itemId,batchId,godownId),
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY(batchId) REFERENCES inventory_batches(id) ON DELETE CASCADE,
      FOREIGN KEY(godownId) REFERENCES godowns(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_batch_stock_lookup ON inventory_batch_stock(firmId,itemId,batchId,godownId);
  `);
}
ensureSchema();

function negativeAllowed(firmId:string) { return getNegativeStockAllowed(firmId); }
function adjustStore(firmId:string,itemId:string,godownId:string,delta:number,allowNegative:boolean,ts:string) {
  const row:any=db.prepare('SELECT id,quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,itemId,godownId);
  const next=Number(row?.quantity||0)+delta;
  if(delta<0 && !allowNegative && next < -0.0001) throw new Error(`Insufficient stock in source store. Available: ${Number(row?.quantity||0)}, Required: ${Math.abs(delta)}`);
  if(row) db.prepare('UPDATE inventory_stock SET quantity=?,updatedAt=? WHERE id=?').run(next,ts,row.id);
  else db.prepare('INSERT INTO inventory_stock(id,firmId,itemId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?)').run(uid(),firmId,itemId,godownId,next,ts);
}
function ensureBatchAllocation(firmId:string,itemId:string,batchId:string,sourceGodownId:string,sourceStock:number,ts:string) {
  const any:any=db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM inventory_batch_stock WHERE firmId=? AND itemId=? AND batchId=?').get(firmId,itemId,batchId);
  if(Number(any?.q||0)>0) return;
  const batch:any=db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(batchId,firmId,itemId);
  if(!batch) throw new Error('Selected batch not found');
  const seed=Math.max(0,Math.min(Number(batch.quantity||0),Number(sourceStock||0)));
  if(seed<=0) throw new Error('Selected batch has no tracked stock in the source store. Receive/open the batch in that store first.');
  db.prepare(`INSERT INTO inventory_batch_stock(id,firmId,itemId,batchId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?,?)`).run(uid(),firmId,itemId,batchId,sourceGodownId,seed,ts);
}
function adjustBatchStore(firmId:string,itemId:string,batchId:string,godownId:string,delta:number,allowNegative:boolean,ts:string) {
  const row:any=db.prepare('SELECT id,quantity FROM inventory_batch_stock WHERE firmId=? AND itemId=? AND batchId=? AND godownId=?').get(firmId,itemId,batchId,godownId);
  const next=Number(row?.quantity||0)+delta;
  if(delta<0 && !allowNegative && next < -0.0001) throw new Error(`Insufficient selected batch stock in source store. Available: ${Number(row?.quantity||0)}, Required: ${Math.abs(delta)}`);
  if(row) db.prepare('UPDATE inventory_batch_stock SET quantity=?,updatedAt=? WHERE id=?').run(next,ts,row.id);
  else db.prepare('INSERT INTO inventory_batch_stock(id,firmId,itemId,batchId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?,?)').run(uid(),firmId,itemId,batchId,godownId,next,ts);
}

router.get('/',(req:Request,res:Response)=>{
  try {
    const firmId=String(req.query.firmId||'').trim(); if(!firmId)return res.status(400).json({error:'firmId required'});
    const rows:any[]=db.prepare(`SELECT t.*, sg.name sourceGodownName, dg.name destinationGodownName
      FROM stock_transfers t JOIN godowns sg ON sg.id=t.sourceGodownId JOIN godowns dg ON dg.id=t.destinationGodownId
      WHERE t.firmId=? ORDER BY t.transferDate DESC,t.createdAt DESC`).all(firmId) as any[];
    for(const r of rows) r.items=db.prepare(`SELECT sti.*,i.name itemName,i.itemCode,COALESCE(u.shortName,u.name,'') unitName FROM stock_transfer_items sti JOIN items i ON i.id=sti.itemId LEFT JOIN units u ON u.id=i.unitId WHERE sti.transferId=? ORDER BY sti.createdAt`).all(r.id);
    res.json({success:true,data:rows});
  }catch(e:any){res.status(500).json({error:e.message})}
});

router.post('/',(req:Request,res:Response)=>{
  try {
    const {firmId,transferDate,sourceGodownId,destinationGodownId,notes='',items=[]}=req.body;
    if(!firmId||!sourceGodownId||!destinationGodownId||sourceGodownId===destinationGodownId||!Array.isArray(items)||!items.length) return res.status(400).json({error:'Source, destination and at least one item are required'});
    const src=db.prepare('SELECT id,name FROM godowns WHERE id=? AND firmId=? AND COALESCE(isActive,1)=1').get(sourceGodownId,firmId) as any;
    const dst=db.prepare('SELECT id,name FROM godowns WHERE id=? AND firmId=? AND COALESCE(isActive,1)=1').get(destinationGodownId,firmId) as any;
    if(!src||!dst)return res.status(404).json({error:'Invalid source or destination store'});
    const ts=now(), date=String(transferDate||ts.slice(0,10));
    const firm:any=db.prepare('SELECT transferNumber FROM firms WHERE id=?').get(firmId);
    let no=`ST-${String(Number(firm?.transferNumber||1)).padStart(4,'0')}`;
    const tx=db.transaction(()=>{
      if(firm) db.prepare('UPDATE firms SET transferNumber=COALESCE(transferNumber,1)+1 WHERE id=?').run(firmId);
      const transferId=uid();
      db.prepare('INSERT INTO stock_transfers(id,firmId,transferNo,transferDate,sourceGodownId,destinationGodownId,notes,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(transferId,firmId,no,date,sourceGodownId,destinationGodownId,notes||'',ts);
      for(const x of items){
        const item:any=db.prepare('SELECT id,name,currentStock,decimalEnabled FROM items WHERE id=? AND firmId=? AND isActive=1').get(x.itemId,firmId);
        if(!item) throw new Error(`Item not found or inactive: ${x.itemId}`);
        assertItemQuantityPrecision(item, x.quantity, 'Transfer quantity');
        const qty=Number(x.quantity||0);
        if(!item||qty<=0) throw new Error('Every transfer line needs a valid item and positive quantity');
        const stock:any=db.prepare('SELECT quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=?').get(firmId,item.id,sourceGodownId);
        if(!negativeAllowed(firmId) && Number(stock?.quantity||0)<qty-1e-9) throw new Error(`${item.name}: insufficient source stock. Available ${Number(stock?.quantity||0)}, required ${qty}`);
        const batchId=x.batchId?String(x.batchId):'';
        if(batchId){
          const batch:any=db.prepare('SELECT * FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(batchId,firmId,item.id);
          if(!batch) throw new Error(`Batch not found for ${item.name}`);
          ensureBatchAllocation(firmId,item.id,batchId,sourceGodownId,Number(stock?.quantity||0),ts);
          adjustBatchStore(firmId,item.id,batchId,sourceGodownId,-qty,negativeAllowed(firmId),ts);
          adjustBatchStore(firmId,item.id,batchId,destinationGodownId,qty,negativeAllowed(firmId),ts);
        }
        adjustStore(firmId,item.id,sourceGodownId,-qty,negativeAllowed(firmId),ts);
        adjustStore(firmId,item.id,destinationGodownId,qty,negativeAllowed(firmId),ts);
        db.prepare('INSERT INTO stock_transfer_items(id,transferId,firmId,itemId,quantity,unit,batchId,batchNumber,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(uid(),transferId,firmId,item.id,qty,x.unit||'',batchId||null,x.batchNumber||null,ts);
      }
      return transferId;
    })();
    const data:any=db.prepare('SELECT * FROM stock_transfers WHERE id=?').get(tx); data.items=db.prepare('SELECT * FROM stock_transfer_items WHERE transferId=?').all(tx);
    res.status(201).json({success:true,data});
  }catch(e:any){res.status(400).json({error:e.message})}
});

router.get('/batch-stock',(req:Request,res:Response)=>{
  try{const {firmId,itemId,batchId}=req.query;if(!firmId||!itemId||!batchId)return res.status(400).json({error:'firmId, itemId and batchId required'});const rows=db.prepare(`SELECT bs.*,g.name godownName FROM inventory_batch_stock bs JOIN godowns g ON g.id=bs.godownId WHERE bs.firmId=? AND bs.itemId=? AND bs.batchId=? ORDER BY g.name`).all(firmId,itemId,batchId);res.json({success:true,data:rows});}catch(e:any){res.status(500).json({error:e.message})}
});

export default router;



