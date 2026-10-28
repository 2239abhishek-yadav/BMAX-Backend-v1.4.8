import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { v4 as uuidv4 } from 'uuid';
import { assertItemQuantityPrecision } from '../lib/quantityPolicy';

const router = Router();
const uid = () => uuidv4();
const now = () => new Date().toISOString();

function ensureSchema(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_work_orders (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('OUT','IN')),
      orderNo TEXT NOT NULL, partyId TEXT, partyName TEXT, processName TEXT, orderDate TEXT NOT NULL,
      dueDate TEXT, status TEXT NOT NULL DEFAULT 'OPEN', notes TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_jw_orders_firm_dir ON job_work_orders(firmId,direction,orderDate,status);
    CREATE TABLE IF NOT EXISTS job_work_lines (
      id TEXT PRIMARY KEY, orderId TEXT NOT NULL, itemId TEXT, itemName TEXT NOT NULL, itemRole TEXT NOT NULL DEFAULT 'RAW_MATERIAL',
      orderedQty REAL NOT NULL DEFAULT 0, issuedQty REAL NOT NULL DEFAULT 0, receivedQty REAL NOT NULL DEFAULT 0,
      unit TEXT, rate REAL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(orderId) REFERENCES job_work_orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_jw_lines_order ON job_work_lines(orderId);
    CREATE TABLE IF NOT EXISTS job_work_movements (
      id TEXT PRIMARY KEY, orderId TEXT NOT NULL, lineId TEXT NOT NULL, movementType TEXT NOT NULL,
      quantity REAL NOT NULL, notes TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(orderId) REFERENCES job_work_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(lineId) REFERENCES job_work_lines(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_jw_movements_order ON job_work_movements(orderId,createdAt);
  `);
}
ensureSchema();

function recalcOrder(orderId:string){
  const lines:any[] = db.prepare('SELECT * FROM job_work_lines WHERE orderId=?').all(orderId) as any[];
  const order:any = db.prepare('SELECT * FROM job_work_orders WHERE id=?').get(orderId);
  if(!order) return;
  const complete = lines.length>0 && lines.every(l => { const required = order.direction==='OUT' ? (l.itemRole==='RAW_MATERIAL' ? l.issuedQty : l.receivedQty) : (l.itemRole==='RAW_MATERIAL' ? l.receivedQty : l.issuedQty); return Number(required||0) >= Number(l.orderedQty||0); });
  const started = lines.some(l => Number(l.issuedQty)>0 || Number(l.receivedQty)>0);
  const status = complete ? 'COMPLETED' : started ? 'IN_PROGRESS' : 'OPEN';
  db.prepare('UPDATE job_work_orders SET status=?,updatedAt=? WHERE id=?').run(status,now(),orderId);
}

router.get('/', (req:Request,res:Response)=>{
  try{
    const {firmId,direction,status}=req.query;
    if(!firmId) return res.status(400).json({error:'firmId required'});
    let q='SELECT * FROM job_work_orders WHERE firmId=?'; const p:any[]=[firmId];
    if(direction){q+=' AND direction=?';p.push(direction)} if(status){q+=' AND status=?';p.push(status)}
    q+=' ORDER BY orderDate DESC, createdAt DESC';
    const rows:any[]=db.prepare(q).all(p) as any[];
    for(const r of rows){ r.lines=db.prepare('SELECT * FROM job_work_lines WHERE orderId=? ORDER BY createdAt').all(r.id); }
    res.json({success:true,data:rows});
  }catch(e:any){res.status(500).json({error:e.message})}
});

router.post('/',(req:Request,res:Response)=>{
  try{
    const {firmId,direction='OUT',orderNo,partyId,partyName,processName,orderDate,dueDate,notes,lines=[]}=req.body;
    if(!firmId||!orderNo||!['OUT','IN'].includes(direction)||!Array.isArray(lines)||!lines.length) return res.status(400).json({error:'firmId, direction, orderNo and at least one line are required'});
    const id=uid(), ts=now();
    const tx=db.transaction(()=>{
      db.prepare(`INSERT INTO job_work_orders(id,firmId,direction,orderNo,partyId,partyName,processName,orderDate,dueDate,status,notes,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,firmId,direction,String(orderNo).trim(),partyId||null,partyName||'',processName||'',orderDate||ts.slice(0,10),dueDate||null,'OPEN',notes||'',ts,ts);
      const ins=db.prepare(`INSERT INTO job_work_lines(id,orderId,itemId,itemName,itemRole,orderedQty,issuedQty,receivedQty,unit,rate,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const l of lines){ const qty=Number(l.orderedQty||l.quantity||0); if(qty<=0) throw new Error('Line quantity must be greater than 0'); ins.run(uid(),id,l.itemId||null,String(l.itemName||'').trim(),l.itemRole==='FINISHED_GOOD'?'FINISHED_GOOD':'RAW_MATERIAL',qty,0,0,l.unit||'',Number(l.rate||0),ts,ts); }
    }); tx();
    const data:any=db.prepare('SELECT * FROM job_work_orders WHERE id=?').get(id); data.lines=db.prepare('SELECT * FROM job_work_lines WHERE orderId=?').all(id);
    res.status(201).json({success:true,data});
  }catch(e:any){res.status(400).json({error:e.message})}
});

router.post('/:id/movement',(req:Request,res:Response)=>{
  try{
    const order:any=db.prepare('SELECT * FROM job_work_orders WHERE id=?').get(req.params.id);
    if(!order) return res.status(404).json({error:'Job work order not found'});
    const {lineId,movementType,quantity,notes}=req.body; const qty=Number(quantity||0);
    if(!lineId||qty<=0||!['ISSUE','RECEIPT'].includes(movementType)) return res.status(400).json({error:'lineId, positive quantity and movementType ISSUE/RECEIPT are required'});
    const line:any=db.prepare('SELECT * FROM job_work_lines WHERE id=? AND orderId=?').get(lineId,order.id);
    if(!line) return res.status(404).json({error:'Job work line not found'});
    const expectedType = order.direction==='OUT'
      ? (line.itemRole==='RAW_MATERIAL' ? 'ISSUE' : 'RECEIPT')
      : (line.itemRole==='RAW_MATERIAL' ? 'RECEIPT' : 'ISSUE');
    if(movementType!==expectedType) return res.status(400).json({error:`For ${order.direction==='OUT'?'Job Work Out':'Job Work In'}, ${line.itemRole==='RAW_MATERIAL'?'Raw Material':'Finished Good'} must be recorded as ${expectedType.toLowerCase()}.`});
    if(movementType==='ISSUE' && Number(line.issuedQty)+qty>Number(line.orderedQty)+1e-9) return res.status(400).json({error:`Issue exceeds ordered quantity. Remaining: ${Math.max(0,Number(line.orderedQty)-Number(line.issuedQty))}`});
    if(movementType==='RECEIPT' && Number(line.receivedQty)+qty>Number(line.orderedQty)+1e-9) return res.status(400).json({error:`Receipt exceeds ordered quantity. Pending: ${Math.max(0,Number(line.orderedQty)-Number(line.receivedQty))}`});
    const ts=now();
    db.transaction(()=>{
      // Job Work Out is the company's stock movement: raw material goes out,
      // finished goods come back in. Job Work In tracks principal-owned goods
      // off-book, so it never changes the firm's own stock balance.
      if(order.direction==='OUT' && line.itemId){
        const item:any=db.prepare('SELECT name,currentStock,allowNegativeStock,decimalEnabled FROM items WHERE id=? AND firmId=?').get(line.itemId,order.firmId);
        if(!item) throw new Error('Item not found for this firm');
        assertItemQuantityPrecision(item, qty, 'Job Work quantity');
        if(movementType==='ISSUE'){
          const next=Number(item.currentStock||0)-qty;
          if(next<0 && !item.allowNegativeStock) throw new Error(`Insufficient stock for ${line.itemName}. Available: ${Number(item.currentStock||0)}`);
          db.prepare('UPDATE items SET currentStock=?,updatedAt=? WHERE id=?').run(next,ts,line.itemId);
        } else if(movementType==='RECEIPT') {
          db.prepare('UPDATE items SET currentStock=currentStock+?,updatedAt=? WHERE id=?').run(qty,ts,line.itemId);
        }
      }
      if(movementType==='ISSUE') db.prepare('UPDATE job_work_lines SET issuedQty=issuedQty+?,updatedAt=? WHERE id=?').run(qty,ts,line.id);
      else db.prepare('UPDATE job_work_lines SET receivedQty=receivedQty+?,updatedAt=? WHERE id=?').run(qty,ts,line.id);
      db.prepare('INSERT INTO job_work_movements(id,orderId,lineId,movementType,quantity,notes,createdAt) VALUES(?,?,?,?,?,?,?)').run(uid(),order.id,line.id,movementType,qty,notes||'',ts);
    })();
    recalcOrder(order.id);
    const data:any=db.prepare('SELECT * FROM job_work_orders WHERE id=?').get(order.id); data.lines=db.prepare('SELECT * FROM job_work_lines WHERE orderId=?').all(order.id); data.movements=db.prepare('SELECT * FROM job_work_movements WHERE orderId=? ORDER BY createdAt DESC').all(order.id);
    res.json({success:true,data});
  }catch(e:any){res.status(400).json({error:e.message})}
});

router.get('/:id',(req:Request,res:Response)=>{
  try{const data:any=db.prepare('SELECT * FROM job_work_orders WHERE id=?').get(req.params.id);if(!data)return res.status(404).json({error:'Job work order not found'});data.lines=db.prepare('SELECT * FROM job_work_lines WHERE orderId=?').all(data.id);data.movements=db.prepare('SELECT * FROM job_work_movements WHERE orderId=? ORDER BY createdAt DESC').all(data.id);res.json({success:true,data})}catch(e:any){res.status(500).json({error:e.message})}
});

export default router;



