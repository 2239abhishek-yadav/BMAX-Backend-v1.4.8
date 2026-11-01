import { Router, Request, Response } from 'express';
import { getNegativeStockAllowed } from '../lib/moduleSettings';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { generateSeriesNumber } from './series.routes';
import { getModuleSettings } from '../lib/moduleSettings';
import { expiryFromLegacyDate, parseExpiryInput, normalizeExpiryMonth, normalizeExpiryYear } from '../lib/batchExpiry';
import { assertDocumentItemQuantities } from '../lib/quantityPolicy';

const router = Router();
const ensureRoundOffColumn=()=>{
  // Route modules are evaluated before server.ts calls initializeDatabase().
  // Keep the Counter Sale schema self-initialising on a brand-new database.
  db.exec(`
    CREATE TABLE IF NOT EXISTS counter_sales (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, counterNo INTEGER NOT NULL,
      saleDate TEXT NOT NULL, saleTime TEXT, customerName TEXT,
      total REAL NOT NULL DEFAULT 0, roundOff REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open', convertedDocumentId TEXT,
      stockReserved INTEGER NOT NULL DEFAULT 0, stockReservedAt TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_counter_sales_firm_date ON counter_sales(firmId,saleDate,status);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_counter_sales_firm_date_no ON counter_sales(firmId,saleDate,counterNo);
    CREATE TABLE IF NOT EXISTS counter_sale_items (
      id TEXT PRIMARY KEY, counterSaleId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT,
      name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, unit TEXT, unitId TEXT,
      isSecondaryUnit INTEGER DEFAULT 0, baseQuantity REAL NOT NULL DEFAULT 0,
      secondaryQuantity REAL NOT NULL DEFAULT 0, secondaryUnitId TEXT, price REAL NOT NULL DEFAULT 0,
      taxRate REAL DEFAULT 0, taxAmount REAL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
      batchId TEXT, batchNumber TEXT, expiryDate TEXT, expiryMonth INTEGER, expiryYear INTEGER, mfgDate TEXT, packing TEXT, mrp REAL DEFAULT 0,
      godownId TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY (counterSaleId) REFERENCES counter_sales(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_counter_sale_items_parent ON counter_sale_items(counterSaleId);
    CREATE INDEX IF NOT EXISTS idx_counter_sale_items_item ON counter_sale_items(firmId,itemId);
  `);
  const saleCols=db.prepare('PRAGMA table_info(counter_sales)').all() as any[];
  const hadStockReserved=saleCols.some(c=>c.name==='stockReserved');
  if(!hadStockReserved) db.exec('ALTER TABLE counter_sales ADD COLUMN stockReserved INTEGER NOT NULL DEFAULT 0');
  if(!saleCols.some(c=>c.name==='stockReservedAt')) db.exec('ALTER TABLE counter_sales ADD COLUMN stockReservedAt TEXT');
  const itemCols=db.prepare('PRAGMA table_info(counter_sale_items)').all() as any[];
  if(!itemCols.some(c=>c.name==='godownId')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN godownId TEXT');
  // Do not mark existing open rows as reserved merely because the column is new.
  // Some older releases created the queue row before reserving stock, so falsely
  // setting this flag causes Billing handoff to reject an actually-unreserved row.
  // The reserve endpoint and Billing handoff both safely reserve rows whose flag is 0.
};
ensureRoundOffColumn();
const isNegativeStockAllowed = (firmId: string) => getNegativeStockAllowed(firmId);

const resolveDefaultGodown = (firmId:string) => {
  let g:any=db.prepare("SELECT * FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC, name LIMIT 1").get(firmId);
  if(!g){
    const now=new Date().toISOString(),id=uuidv4();
    db.prepare("INSERT INTO godowns(id,firmId,name,address,isDefault,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)").run(id,firmId,'Main Store',null,1,now,now);
    g=db.prepare("SELECT * FROM godowns WHERE id=?").get(id);
  }
  return g;
};
const applyStoreStockForCounter = (firmId:string,itemId:string,godownId:string,delta:number,itemName:string,allowNegative:boolean,now:string) => {
  if(!godownId || !delta) return;
  const existingAny:any=db.prepare('SELECT COALESCE(SUM(quantity),0) qty FROM inventory_stock WHERE firmId=? AND itemId=?').get(firmId,itemId);
  let row:any=db.prepare('SELECT id,quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,itemId,godownId);
  // Legacy stock may exist only in items.currentStock. When there is no location
  // allocation at all, seed Main Store from that legacy total before reserving.
  if(!row && Math.abs(Number(existingAny?.qty||0))<0.0001){
    const item:any=db.prepare('SELECT currentStock FROM items WHERE id=? AND firmId=?').get(itemId,firmId);
    const opening=Math.max(0,Number(item?.currentStock||0));
    if(opening>0){
      db.prepare('INSERT INTO inventory_stock(id,firmId,itemId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?)').run(uuidv4(),firmId,itemId,godownId,opening,now);
      row=db.prepare('SELECT id,quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1').get(firmId,itemId,godownId);
    }
  }
  const next=Number(row?.quantity||0)+delta;
  if(delta<0 && !allowNegative && next < -0.0001) throw new Error(`Insufficient stock for ${itemName} in Main Store. Available: ${Number(row?.quantity||0)}, Required: ${Math.abs(delta)}`);
  if(row) db.prepare('UPDATE inventory_stock SET quantity=?,updatedAt=? WHERE id=?').run(next,now,row.id);
  else db.prepare('INSERT INTO inventory_stock(id,firmId,itemId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?)').run(uuidv4(),firmId,itemId,godownId,next,now);
};
const resolveBaseQty = (firmId:string,item:any,line:any) => {
  const q1=Number(line.quantity)||0, q2=Number(line.secondaryQuantity)||0;
  if(!getModuleSettings(firmId,'sale_invoice').unitsEnabled || !item) return q1;
  return +(q1 + (item.secondaryUnitId && q2 ? q2*(Number(item.conversionFactor)||1) : 0)).toFixed(4);
};
const calculateLine = (price:number, quantity:number, discountPercentage:number, taxRate:number) => {
  const p=Math.max(0,Number(price)||0);
  const q=Math.max(0,Number(quantity)||0);
  const d=Math.max(0,Math.min(100,Number(discountPercentage)||0));
  const rate=Math.max(0,Number(taxRate)||0);
  const gross=+(p*q).toFixed(2);
  const discount=+(gross*d/100).toFixed(2);
  const amount=+(gross-discount).toFixed(2);
  const taxAmount=+(amount*rate/100).toFixed(2);
  return {gross,discount,amount,taxAmount,total:+(amount+taxAmount).toFixed(2),discountPercentage:d,taxRate:rate};
};

router.get('/', (req:Request,res:Response)=>{
  try {
    const {firmId,startDate,endDate,status='open'}=req.query;
    if(!firmId) return res.status(400).json({error:'firmId required'});
    let q='SELECT * FROM counter_sales WHERE firmId=?'; const p:any[]=[firmId];
    if(status && status!=='all'){q+=' AND status=?';p.push(status)}
    if(startDate){q+=' AND saleDate>=?';p.push(startDate)} if(endDate){q+=' AND saleDate<=?';p.push(endDate)}
    q+=' ORDER BY saleDate DESC, createdAt DESC';
    const rows=db.prepare(q).all(p) as any[];
    const itemsStmt=db.prepare('SELECT * FROM counter_sale_items WHERE counterSaleId=? ORDER BY createdAt ASC');
    const data=rows.map(r=>({...r,items:itemsStmt.all(r.id)}));
    res.json({success:true,data,total:data.length});
  }catch(e:any){res.status(500).json({error:e.message})}
});

router.post('/', (req:Request,res:Response)=>{
  try{
    const {firmId,saleDate=new Date().toISOString().slice(0,10),saleTime=new Date().toTimeString().slice(0,8),customerName='',items=[],roundOff=0,total:requestedTotal}=req.body;
    if(!firmId || !Array.isArray(items) || !items.length) return res.status(400).json({error:'firmId and at least one item are required'});
    const id=uuidv4(), now=new Date().toISOString();
    const run=db.transaction(()=>{
      const next=(db.prepare('SELECT COALESCE(MAX(counterNo),0)+1 n FROM counter_sales WHERE firmId=? AND saleDate=?').get(firmId,saleDate) as any).n;
      let total=0;
      const normalized:any[]=[];
      for(const line of items){
        if(!line.itemId) throw new Error('Every counter-sale line must have an item');
        const item=db.prepare('SELECT * FROM items WHERE id=? AND firmId=? AND isActive=1').get(line.itemId,firmId) as any;
        if(!item) throw new Error('Item not found or inactive');
        assertDocumentItemQuantities(item, line);
        const baseQuantity=resolveBaseQty(firmId,item,line);
        if(baseQuantity<=0) throw new Error(`Quantity must be greater than zero for ${item.name}`);
        if(!isNegativeStockAllowed(firmId) && Number(item.currentStock||0)-baseQuantity < -0.0001) throw new Error(`Insufficient stock for ${item.name}. Available: ${Number(item.currentStock||0)}, Required: ${baseQuantity}`);
        const price=Number(line.price ?? item.salePrice)||0;
        const taxRate=Number(line.taxRate ?? item.taxRate)||0;
        if(![0,5,18].includes(taxRate)) throw new Error('GST rate must be one of 0%, 5% or 18%');
        const calc=calculateLine(price,Number(line.quantity)||0,Number(line.discountPercentage)||0,taxRate);
        const amount=calc.amount;
        const batchId=line.batchId||null, batchNo=line.batchNumber?String(line.batchNumber).trim():null;
        let batch:any=null;
        if(batchId) batch=db.prepare('SELECT * FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?').get(batchId,firmId,line.itemId);
        else if(batchNo) batch=db.prepare('SELECT * FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=?').get(firmId,line.itemId,batchNo);
        const activeBatches=db.prepare('SELECT COUNT(*) n FROM inventory_batches WHERE firmId=? AND itemId=? AND quantity>0').get(firmId,line.itemId) as any;
        if(Number(activeBatches?.n||0)>0 && !batch) throw new Error(`Please select an available batch for ${item.name}`);
        const schemeBuyQty = Math.max(0, Number(batch?.schemeBuyQty || 0));
        const schemeFreeQty = Math.max(0, Number(batch?.schemeFreeQty || 0));
        const freeQuantity = schemeBuyQty > 0 && schemeFreeQty > 0 ? Math.floor(baseQuantity / schemeBuyQty) * schemeFreeQty : 0;
        const stockRequired = baseQuantity + freeQuantity;
        if(batch && !isNegativeStockAllowed(firmId) && Number(batch.quantity||0)-stockRequired < -0.0001) throw new Error(`Insufficient batch stock for ${item.name} / ${batch.batchNumber||batchNo||''}. Required: ${stockRequired}`);
        if(!isNegativeStockAllowed(firmId) && Number(item.currentStock||0)-stockRequired < -0.0001) throw new Error(`Insufficient stock for ${item.name}. Available: ${Number(item.currentStock||0)}, Required: ${stockRequired}`);
        total+=calc.total;
        normalized.push({line,item,baseQuantity,freeQuantity,amount,taxAmount:calc.taxAmount,taxRate:calc.taxRate,discountPercentage:calc.discountPercentage,discountAmount:calc.discount,batch,price,godownId:line.godownId||null,schemeBuyQty,schemeFreeQty});
      }
      const rawTotal=+total.toFixed(2); const finalTotal=Number.isFinite(Number(requestedTotal)) ? Number(requestedTotal) : +(rawTotal + Number(roundOff||0)).toFixed(2); const finalRoundOff=+(finalTotal-rawTotal).toFixed(2);
      db.prepare('INSERT INTO counter_sales(id,firmId,counterNo,saleDate,saleTime,customerName,total,roundOff,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,firmId,next,saleDate,saleTime,customerName||null,finalTotal,finalRoundOff,'open',now,now);
      for(const x of normalized){
        const {line,item,baseQuantity,freeQuantity,amount,taxAmount,taxRate,discountPercentage,discountAmount,batch,price,godownId,schemeBuyQty,schemeFreeQty}=x;
        db.prepare(`INSERT INTO counter_sale_items(id,counterSaleId,firmId,itemId,name,quantity,unit,unitId,isSecondaryUnit,baseQuantity,secondaryQuantity,secondaryUnitId,price,taxRate,taxAmount,amount,batchId,batchNumber,expiryDate,expiryMonth,expiryYear,mfgDate,packing,mrp,freeQuantity,sellingRate,schemeBuyQty,schemeFreeQty,godownId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuidv4(),id,firmId,item.id,item.name,Number(line.quantity)||0,line.unit||item.unitName||'',item.unitId||null,line.isSecondaryUnit?1:0,baseQuantity,Number(line.secondaryQuantity)||0,line.secondaryUnitId||null,price,taxRate,taxAmount,amount,batch?.id||line.batchId||null,batch?.batchNumber||line.batchNumber||null,null,normalizeExpiryMonth(batch?.expiryMonth ?? line.expiryMonth ?? parseExpiryInput(line.expiryDate).month ?? expiryFromLegacyDate(line.expiryDate).month),normalizeExpiryYear(batch?.expiryYear ?? line.expiryYear ?? parseExpiryInput(line.expiryDate).year ?? expiryFromLegacyDate(line.expiryDate).year),batch?.mfgDate||line.mfgDate||null,batch?.packing||line.packing||item.packing||null,Number(line.mrp)||Number(batch?.mrp)||Number(item.salePrice)||0,freeQuantity,Number(batch?.sellingRate||price||0),schemeBuyQty,schemeFreeQty,godownId,now,now);
      }
    });
    run();
    const saved=db.prepare('SELECT counterNo,total,roundOff FROM counter_sales WHERE id=? AND firmId=?').get(id,firmId) as any;
    res.status(201).json({success:true,data:{id,counterNo:saved?.counterNo,total:saved?.total,roundOff:saved?.roundOff}});
  }catch(e:any){res.status(400).json({error:e.message})}
});


router.get('/:id', (req:Request,res:Response)=>{
  try{
    const {firmId}=req.query as any; const id=String(req.params.id||'');
    if(!firmId||!id) return res.status(400).json({error:'firmId and counter sale id are required'});
    const row:any=db.prepare('SELECT * FROM counter_sales WHERE id=? AND firmId=?').get(id,firmId);
    if(!row) return res.status(404).json({error:'Counter sale not found'});
    const items:any[]=db.prepare('SELECT * FROM counter_sale_items WHERE counterSaleId=? AND firmId=? ORDER BY createdAt').all(id,firmId);
    res.json({success:true,data:{...row,items}});
  }catch(e:any){res.status(500).json({error:e.message});}
});

router.post('/:id/reserve', (req:Request,res:Response)=>{
  try{
    const {firmId}=req.query as any;
    const id=String(req.params.id||'');
    if(!firmId||!id) return res.status(400).json({error:'firmId and counter sale id are required'});
    const result=db.transaction(()=>{
      const row:any=db.prepare("SELECT * FROM counter_sales WHERE id=? AND firmId=? AND status='open'").get(id,firmId);
      if(!row) throw new Error('Open counter sale not found');
      if(Number(row.stockReserved||0)===1) return {id,status:'already-reserved',stockReserved:true};
      const items:any[]=db.prepare('SELECT * FROM counter_sale_items WHERE counterSaleId=? AND firmId=? ORDER BY createdAt').all(id,firmId);
      if(!items.length) throw new Error('Counter sale has no items');
      const allowNegative=isNegativeStockAllowed(firmId);
      const now=new Date().toISOString();
      const godown=resolveDefaultGodown(firmId);
      // Validate the entire reservation first so the transaction is all-or-nothing.
      for(const it of items){
        const item:any=db.prepare('SELECT * FROM items WHERE id=? AND firmId=? AND isActive=1').get(it.itemId,firmId);
        if(!item) throw new Error(`Item not found or inactive: ${it.name}`);
        const qty=Number(it.baseQuantity||it.quantity||0);
        if(qty<=0) throw new Error(`Quantity must be greater than zero for ${it.name}`);
        if(!allowNegative && Number(item.currentStock||0)-qty < -0.0001) throw new Error(`Insufficient stock for ${item.name}. Available: ${Number(item.currentStock||0)}, Required: ${qty}`);
        if(it.batchId){
          const b:any=db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=?').get(it.batchId,firmId);
          if(!b) throw new Error(`Selected batch not found for ${it.name}`);
          if(!allowNegative && Number(b.quantity||0)-qty < -0.0001) throw new Error(`Insufficient batch stock for ${it.name}`);
        }
      }
      for(const it of items){
        const qty=Number(it.baseQuantity||it.quantity||0);
        db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,now,it.itemId,firmId);
        if(it.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,now,it.batchId,firmId);
        applyStoreStockForCounter(firmId,it.itemId,String(it.godownId||godown.id),-qty,it.name,allowNegative,now);
        if(!it.godownId) db.prepare('UPDATE counter_sale_items SET godownId=?,updatedAt=? WHERE id=? AND firmId=?').run(godown.id,now,it.id,firmId);
      }
      db.prepare("UPDATE counter_sales SET stockReserved=1,stockReservedAt=?,updatedAt=? WHERE id=? AND firmId=? AND status='open'").run(now,now,id,firmId);
      return {id,status:'reserved',stockReserved:true,godownId:godown.id};
    });
    res.json({success:true,data:result});
  }catch(e:any){res.status(400).json({error:e.message});}
});

router.patch('/:id', (req:Request,res:Response)=>{
  try {
    const {firmId}=req.query as any;
    const id=String(req.params.id||'');
    const {quantity,discountPercentage,price}=req.body||{};
    if(!firmId || !id) return res.status(400).json({error:'firmId and counter sale id are required'});
    const result=db.transaction(()=>{
      const row=db.prepare("SELECT * FROM counter_sales WHERE id=? AND firmId=? AND status='open'").get(id,firmId) as any;
      if(!row) throw new Error('Open counter sale not found');
      const line=db.prepare('SELECT * FROM counter_sale_items WHERE counterSaleId=? AND firmId=? ORDER BY createdAt LIMIT 1').get(id,firmId) as any;
      if(!line) throw new Error('Counter sale has no item');
      const item=db.prepare('SELECT * FROM items WHERE id=? AND firmId=? AND isActive=1').get(line.itemId,firmId) as any;
      if(!item) throw new Error('Item not found or inactive');
      const nextQty=quantity===undefined?Number(line.quantity||0):Number(quantity);
      if(!Number.isFinite(nextQty)||nextQty<=0) throw new Error('Quantity must be greater than zero');
      const nextPrice=price===undefined?Number(line.price||0):Number(price);
      const nextDiscount=discountPercentage===undefined?Number(line.discountPercentage||0):Number(discountPercentage);
      if(!Number.isFinite(nextPrice)||nextPrice<0) throw new Error('Rate must be zero or greater');
      if(!Number.isFinite(nextDiscount)||nextDiscount<0||nextDiscount>100) throw new Error('Discount must be between 0% and 100%');
      const oldBase=Number(line.baseQuantity||line.quantity||0);
      const baseQuantity=resolveBaseQty(firmId,item,{quantity:nextQty,secondaryQuantity:line.secondaryQuantity,isSecondaryUnit:line.isSecondaryUnit});
      const delta=baseQuantity-oldBase;
      if(Number(row.stockReserved||0)===1 && delta>0 && !isNegativeStockAllowed(firmId) && Number(item.currentStock||0)-delta < -0.0001) throw new Error(`Insufficient stock for ${item.name}. Available: ${Number(item.currentStock||0)}, Required: ${delta}`);
      if(Number(row.stockReserved||0)===1 && delta!==0){
        const nowStock=new Date().toISOString();
        db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=? AND firmId=?').run(delta,nowStock,item.id,firmId);
        if(line.batchId){
          const b=db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=?').get(line.batchId,firmId) as any;
          if(!b) throw new Error('Selected batch not found');
          if(delta>0 && !isNegativeStockAllowed(firmId) && Number(b.quantity||0)-delta < -0.0001) throw new Error(`Insufficient batch stock for ${item.name}`);
          db.prepare('UPDATE inventory_batches SET quantity=quantity-?,updatedAt=? WHERE id=? AND firmId=?').run(delta,nowStock,line.batchId,firmId);
        }
        const godownId=line.godownId||resolveDefaultGodown(firmId).id;
        applyStoreStockForCounter(firmId,item.id,String(godownId),-delta,item.name,isNegativeStockAllowed(firmId),nowStock);
      }
      const calc=calculateLine(nextPrice,nextQty,nextDiscount,Number(line.taxRate||item.taxRate||0));
      const now=new Date().toISOString();
      db.prepare('UPDATE counter_sale_items SET quantity=?,baseQuantity=?,price=?,discountPercentage=?,taxRate=?,taxAmount=?,amount=?,updatedAt=? WHERE id=? AND firmId=?').run(nextQty,baseQuantity,nextPrice,calc.discountPercentage,calc.taxRate,calc.taxAmount,calc.amount,now,line.id,firmId);
      db.prepare('UPDATE counter_sales SET total=?,roundOff=0,updatedAt=? WHERE id=? AND firmId=?').run(calc.total,now,id,firmId);
      return {id,quantity:nextQty,price:nextPrice,discountPercentage:calc.discountPercentage,taxRate:calc.taxRate,taxAmount:calc.taxAmount,amount:calc.amount,total:calc.total};
    });
    res.json({success:true,data:result});
  } catch(e:any) { res.status(400).json({error:e.message}); }
});

router.delete('/:id', (req:Request,res:Response)=>{
  try{
    const {firmId}=req.query as any;
    const id=String(req.params.id||'');
    if(!firmId || !id) return res.status(400).json({error:'firmId and counter sale id are required'});
    const result=db.transaction(()=>{
      const row=db.prepare("SELECT * FROM counter_sales WHERE id=? AND firmId=? AND status='open'").get(id,firmId) as any;
      if(!row) throw new Error('Open counter sale not found');
      const items=db.prepare('SELECT * FROM counter_sale_items WHERE counterSaleId=? AND firmId=?').all(id,firmId) as any[];
      const now=new Date().toISOString();
      if(Number(row.stockReserved||0)===1){
        for(const it of items){
          const qty=Number(it.baseQuantity||0);
          if(qty>0){
            db.prepare('UPDATE items SET currentStock=currentStock+?,updatedAt=? WHERE id=? AND firmId=?').run(qty,now,it.itemId,firmId);
            if(it.batchId){
              db.prepare('UPDATE inventory_batches SET quantity=quantity+?,updatedAt=? WHERE id=? AND firmId=?').run(qty,now,it.batchId,firmId);
            }
            const godownId=it.godownId||resolveDefaultGodown(firmId).id;
            applyStoreStockForCounter(firmId,it.itemId,String(godownId),qty,it.name,true,now);
          }
        }
      }
      // Never physically delete a counter-sale transaction. A user-initiated
      // delete only changes its lifecycle state after stock restoration, so
      // the original transaction and audit trail remain recoverable.
      db.prepare("UPDATE counter_sales SET status='deleted',updatedAt=? WHERE id=? AND firmId=? AND status='open'").run(now,id,firmId);
      return {id,restoredItems:items.length,status:'deleted'};
    });
    res.json({success:true,data:result});
  }catch(e:any){res.status(400).json({error:e.message})}
});

router.post('/convert', (req:Request,res:Response)=>{
  try{
    const {firmId,ids=[]}=req.body;
    if(!firmId || !Array.isArray(ids) || !ids.length) return res.status(400).json({error:'firmId and at least one counter sale are required'});
    const now=new Date().toISOString(), documentId=uuidv4();
    const result=db.transaction(()=>{
      const placeholders=ids.map(()=>'?').join(',');
      const rows=db.prepare(`SELECT * FROM counter_sales WHERE firmId=? AND status='open' AND id IN (${placeholders}) ORDER BY createdAt`).all(firmId,...ids) as any[];
      if(!rows.length) throw new Error('No open counter sales selected');
      if(rows.length !== ids.length) throw new Error('One or more selected counter sales are no longer open or belong to another company');
      const itemRows=db.prepare(`SELECT * FROM counter_sale_items WHERE firmId=? AND counterSaleId IN (${placeholders}) ORDER BY createdAt`).all(firmId,...ids) as any[];
      if(!itemRows.length) throw new Error('Selected counter sales have no items');
      // Conversion never posts stock a second time. Any unreserved row is reserved
      // exactly once as part of conversion so Convert All remains safe.
      const unreserved=rows.filter(r=>Number(r.stockReserved||0)!==1);
      if(unreserved.length){
        const allowNegative=isNegativeStockAllowed(firmId);
        const godown=resolveDefaultGodown(firmId);
        for(const r of unreserved){
          const its=itemRows.filter(it=>it.counterSaleId===r.id);
          for(const it of its){
            const qty=Number(it.baseQuantity||it.quantity||0);
            const item=db.prepare('SELECT * FROM items WHERE id=? AND firmId=? AND isActive=1').get(it.itemId,firmId) as any;
            if(!item) throw new Error(`Item not found or inactive: ${it.name}`);
            if(qty<=0) throw new Error(`Invalid quantity for ${it.name}`);
            if(!allowNegative && Number(item.currentStock||0)-qty < -0.0001) throw new Error(`Insufficient stock for ${item.name}. Available: ${Number(item.currentStock||0)}, Required: ${qty}`);
            if(it.batchId){ const b=db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=?').get(it.batchId,firmId) as any; if(!b) throw new Error(`Selected batch not found for ${it.name}`); if(!allowNegative && Number(b.quantity||0)-qty < -0.0001) throw new Error(`Insufficient batch stock for ${it.name}`); }
          }
          const nowReserve=new Date().toISOString();
          for(const it of its){
            const qty=Number(it.baseQuantity||it.quantity||0);
            db.prepare('UPDATE items SET currentStock=currentStock-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,nowReserve,it.itemId,firmId);
            if(it.batchId) db.prepare('UPDATE inventory_batches SET quantity=quantity-?,updatedAt=? WHERE id=? AND firmId=?').run(qty,nowReserve,it.batchId,firmId);
            applyStoreStockForCounter(firmId,it.itemId,String(it.godownId||godown.id),-qty,it.name,allowNegative,nowReserve);
            if(!it.godownId) db.prepare('UPDATE counter_sale_items SET godownId=?,updatedAt=? WHERE id=? AND firmId=?').run(godown.id,nowReserve,it.id,firmId);
          }
          db.prepare('UPDATE counter_sales SET stockReserved=1,stockReservedAt=?,updatedAt=? WHERE id=? AND firmId=?').run(nowReserve,nowReserve,r.id,firmId);
        }
      }
      const total=rows.reduce((s,r)=>s+Number(r.total||0),0); const roundOff=rows.reduce((s,r)=>s+Number(r.roundOff||0),0);
      const taxTotal=itemRows.reduce((s,it)=>s+Number(it.taxAmount||0),0);
      const seriesSetting=getModuleSettings(firmId,'sale_invoice');
      let docNumber=''; let seriesId:any=null;
      if(seriesSetting.multiSeriesEnabled){ const ds=db.prepare('SELECT id FROM series WHERE firmId=? AND transactionType=? AND isActive=1 AND isDefault=1 LIMIT 1').get(firmId,'sale_invoice') as any; if(ds){const g=generateSeriesNumber(ds.id);docNumber=g.documentNumber;seriesId=g.seriesId;} }
      if(!docNumber){const firm=db.prepare('SELECT invoicePrefix,invoiceNumber FROM firms WHERE id=?').get(firmId) as any;docNumber=`${firm?.invoicePrefix||'INV'}-${String(firm?.invoiceNumber||1).padStart(4,'0')}`;db.prepare('UPDATE firms SET invoiceNumber=invoiceNumber+1 WHERE id=?').run(firmId)}
      const cols=new Set((db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c=>c.name));
      const vals:any={id:documentId,firmId,documentType:'sale_invoice',documentNumber:docNumber,seriesId,documentDate:new Date().toISOString().slice(0,10),documentTime:new Date().toTimeString().slice(0,8),partyId:null,partyName:'Counter Sale / Walk-in',partyType:'customer',phone:'',billingAddress:'',shippingAddress:'',transactionType:'cash',status:'active',subtotal:total-taxTotal,discountAmount:0,discountPercentage:0,taxAmount:taxTotal,shippingCharges:0,packagingCharges:0,adjustment:0,roundOff,total,paidAmount:total,balanceAmount:0,paymentType:'cash',description:`Converted from Counter Sale: ${rows.map(r=>`#${r.counterNo}`).join(', ')}`,createdAt:now,updatedAt:now};
      const dc=Object.keys(vals).filter(k=>cols.has(k)); db.prepare(`INSERT INTO documents (${dc.join(',')}) VALUES (${dc.map(()=>'?').join(',')})`).run(...dc.map(k=>vals[k]));
      const icols=new Set((db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c=>c.name));
      for(const it of itemRows){const v:any={id:uuidv4(),documentId,firmId,itemId:it.itemId,name:it.name,description:'',hsnCode:null,quantity:it.quantity,unit:it.unit,unitId:it.unitId,isSecondaryUnit:it.isSecondaryUnit,baseQuantity:it.baseQuantity,secondaryQuantity:it.secondaryQuantity,secondaryUnitId:it.secondaryUnitId,price:it.price,discount:0,discountType:'percentage',discountPercentage:0,discountAmount:0,taxRate:Number(it.taxRate)||0,taxAmount:Number(it.taxAmount)||0,amount:it.amount,batchId:it.batchId,batchNumber:it.batchNumber,expiryDate:null,expiryMonth:it.expiryMonth,expiryYear:it.expiryYear,mfgDate:it.mfgDate,packing:it.packing,freeQuantity:Number(it.freeQuantity||0),mrp:it.mrp,sellingRate:it.sellingRate||it.price,markup:0,manufacturingRate:0,schemeBuyQty:Number(it.schemeBuyQty||0),schemeFreeQty:Number(it.schemeFreeQty||0),createdAt:now,updatedAt:now};const c=Object.keys(v).filter(k=>icols.has(k));db.prepare(`INSERT INTO document_items (${c.join(',')}) VALUES (${c.map(()=>'?').join(',')})`).run(...c.map(k=>v[k]));}
      db.prepare(`UPDATE counter_sales SET status='converted',convertedDocumentId=?,updatedAt=? WHERE id IN (${placeholders}) AND firmId=?`).run(documentId,now,...ids,firmId);
      return {documentId,documentNumber:docNumber,convertedCount:rows.length,total,roundOff};
    });
    res.json({success:true,data:result});
  }catch(e:any){res.status(400).json({error:e.message})}
});

export default router;



