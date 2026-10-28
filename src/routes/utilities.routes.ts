import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { db } from '../lib/db';
import { snapshotOpenDatabase } from '../backup/database-backup';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function init(){
  db.exec(`CREATE TABLE IF NOT EXISTS utility_settings (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, settingKey TEXT NOT NULL, settingValue TEXT, updatedAt TEXT NOT NULL, UNIQUE(firmId,settingKey));
    CREATE TABLE IF NOT EXISTS utility_financial_years (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, label TEXT NOT NULL, startDate TEXT NOT NULL, endDate TEXT NOT NULL, isActive INTEGER DEFAULT 0, createdAt TEXT NOT NULL, UNIQUE(firmId,label));
    CREATE TABLE IF NOT EXISTS utility_transaction_locks (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, lockDate TEXT NOT NULL, lockType TEXT NOT NULL DEFAULT 'ALL', note TEXT, createdAt TEXT NOT NULL, UNIQUE(firmId,lockDate,lockType));`);
}
try{init();}catch{}

router.get('/status/:firmId',(req,res)=>{ try{ const firmId=String(req.params.firmId); const settings=db.prepare('SELECT settingKey,settingValue,updatedAt FROM utility_settings WHERE firmId=?').all(firmId); const years=db.prepare('SELECT * FROM utility_financial_years WHERE firmId=? ORDER BY startDate DESC').all(firmId); const locks=db.prepare('SELECT * FROM utility_transaction_locks WHERE firmId=? ORDER BY lockDate DESC').all(firmId); res.json({data:{settings,financialYears:years,locks}}); }catch(e:any){res.status(500).json({error:e.message})} });

router.post('/backup/:firmId',(req,res)=>{ try{ const result=snapshotOpenDatabase(db); res.json({data:{...result,downloadName:path.basename(result.path)}}); }catch(e:any){res.status(500).json({error:e.message})} });
router.get('/backup/download',(req,res)=>{ const name=path.basename(String(req.query.name||'')); if(!name||name.includes('..'))return res.status(400).json({error:'Invalid backup name'}); const root=process.env.DB_PATH ? path.join(process.env.DB_PATH,'backups') : path.join(process.cwd(),'data','backups'); const file=path.join(root,name); if(!fs.existsSync(file))return res.status(404).json({error:'Backup not found'}); res.download(file,name); });

router.get('/merge-master/:firmId',(req,res)=>{ try{ const firmId=String(req.params.firmId); const type=String(req.query.type||'items'); const table=type==='parties'?'parties':'items'; const nameCol='name'; const rows=db.prepare(`SELECT name,COUNT(*) count,GROUP_CONCAT(id) ids FROM ${table} WHERE firmId=? AND isActive=1 GROUP BY lower(trim(${nameCol})) HAVING COUNT(*)>1 ORDER BY count DESC`).all(firmId); res.json({data:rows.map((r:any)=>({...r,ids:String(r.ids||'').split(',')}))}); }catch(e:any){res.status(500).json({error:e.message})} });
router.post('/merge-master/:firmId',(req,res)=>{ try{ const firmId=String(req.params.firmId); const type=String(req.body?.type||'items'); const keep=String(req.body?.keepId||''); const remove=String(req.body?.removeId||''); if(!keep||!remove||keep===remove)return res.status(400).json({error:'keepId and removeId required'}); const table=type==='parties'?'parties':'items'; const keepRow:any=db.prepare(`SELECT * FROM ${table} WHERE id=? AND firmId=? AND isActive=1`).get(keep,firmId); const remRow:any=db.prepare(`SELECT * FROM ${table} WHERE id=? AND firmId=? AND isActive=1`).get(remove,firmId); if(!keepRow||!remRow)return res.status(404).json({error:'Master not found'});
    const tx=db.transaction(()=>{ if(table==='items'){ db.prepare('UPDATE document_items SET itemId=? WHERE firmId=? AND itemId=?').run(keep,firmId,remove); db.prepare('UPDATE inventory_batches SET itemId=? WHERE firmId=? AND itemId=?').run(keep,firmId,remove); } else { db.prepare('UPDATE documents SET partyId=? WHERE firmId=? AND partyId=?').run(keep,firmId,remove); db.prepare('UPDATE payments SET partyId=? WHERE firmId=? AND partyId=?').run(keep,firmId,remove); } db.prepare(`UPDATE ${table} SET isActive=0,updatedAt=? WHERE id=? AND firmId=?`).run(new Date().toISOString(),remove,firmId); }); tx(); res.json({data:{merged:true,kept:keep,removed:remove}}); }catch(e:any){res.status(400).json({error:e.message})} });

router.post('/financial-year/:firmId',(req,res)=>{ try{const firmId=String(req.params.firmId); const label=String(req.body?.label||'').trim(); const start=String(req.body?.startDate||''); const end=String(req.body?.endDate||''); if(!label||!start||!end)return res.status(400).json({error:'Label, start date and end date are required'}); const now=new Date().toISOString(); const id=`fy-${firmId}-${start}`; db.prepare('UPDATE utility_financial_years SET isActive=0 WHERE firmId=?').run(firmId); db.prepare('INSERT INTO utility_financial_years(id,firmId,label,startDate,endDate,isActive,createdAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(firmId,label) DO UPDATE SET startDate=excluded.startDate,endDate=excluded.endDate,isActive=1').run(id,firmId,label,start,end,1,now); db.prepare('UPDATE firms SET financialYear=?,updatedAt=? WHERE id=?').run(label,now,firmId); res.json({data:db.prepare('SELECT * FROM utility_financial_years WHERE firmId=? AND label=?').get(firmId,label)}); }catch(e:any){res.status(400).json({error:e.message})} });

router.post('/transaction-lock/:firmId',(req,res)=>{ try{const firmId=String(req.params.firmId); const lockDate=String(req.body?.lockDate||''); const lockType=String(req.body?.lockType||'ALL'); const note=String(req.body?.note||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(lockDate))return res.status(400).json({error:'Valid lock date required'}); const id=`lock-${firmId}-${lockDate}-${lockType}`; db.prepare('INSERT INTO utility_transaction_locks(id,firmId,lockDate,lockType,note,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(firmId,lockDate,lockType) DO UPDATE SET note=excluded.note').run(id,firmId,lockDate,lockType,note,new Date().toISOString()); res.json({data:{locked:true,lockDate,lockType}}); }catch(e:any){res.status(400).json({error:e.message})} });
router.delete('/transaction-lock/:firmId/:lockDate/:lockType',(req,res)=>{try{db.prepare('DELETE FROM utility_transaction_locks WHERE firmId=? AND lockDate=? AND lockType=?').run(String(req.params.firmId),String(req.params.lockDate),String(req.params.lockType));res.json({data:{unlocked:true}})}catch(e:any){res.status(400).json({error:e.message})}});

router.get('/datasync/:firmId',async(req,res)=>{try{const rows=db.prepare('SELECT deviceId,deviceName,installationId,lastSeenAt,lastSyncAt,status,updatedAt FROM sync_devices ORDER BY deviceName').all(); const settings=db.prepare('SELECT * FROM sync_settings WHERE firmId=?').get(String(req.params.firmId)); res.json({data:{settings,devices:rows}})}catch(e:any){res.status(500).json({error:e.message})}});


// Barcode Template Studio: company-scoped persistence (never local-only).
const BARCODE_TEMPLATE_TYPE='barcode_template';
router.get('/barcode-templates/:firmId',(req,res)=>{try{
  const firmId=String(req.params.firmId); const row:any=db.prepare("SELECT settingValue FROM firm_settings WHERE firmId=? AND settingType=? AND settingKey='templates'").get(firmId,BARCODE_TEMPLATE_TYPE);
  let templates:any[]=[]; if(row){try{templates=JSON.parse(row.settingValue)||[]}catch{templates=[]}}
  res.json({success:true,data:{templates}});
}catch(e:any){res.status(500).json({error:e.message})}});
router.put('/barcode-templates/:firmId',(req,res)=>{try{
  const firmId=String(req.params.firmId); const templates=Array.isArray(req.body?.templates)?req.body.templates:[];
  const now=new Date().toISOString(); const existing:any=db.prepare("SELECT id FROM firm_settings WHERE firmId=? AND settingType=? AND settingKey='templates'").get(firmId,BARCODE_TEMPLATE_TYPE);
  const value=JSON.stringify(templates);
  if(existing) db.prepare('UPDATE firm_settings SET settingValue=?,updatedAt=? WHERE id=?').run(value,now,existing.id);
  else db.prepare("INSERT INTO firm_settings(id,firmId,settingType,settingKey,settingValue,updatedAt) VALUES(?,?,?,?,?,?)").run(`barcode-${firmId}-templates`,firmId,BARCODE_TEMPLATE_TYPE,'templates',value,now);
  res.json({success:true,data:{templates}});
}catch(e:any){res.status(400).json({error:e.message})}});

// Non-working data is a backend decision, not a UI-only filter.
router.get('/non-working-data',(req,res)=>{try{
  const firmId=String(req.query.firmId||''); if(!firmId)return res.status(400).json({error:'firmId required'});
  const type=String(req.query.type||'items'); const months=Math.max(1,Number(req.query.inactiveMonths||6));
  const cutoff=new Date(); cutoff.setMonth(cutoff.getMonth()-months); const cut=cutoff.toISOString().slice(0,10); let rows:any[]=[];
  if(type==='items'||type==='category'||type==='company'){
    let q=`SELECT i.*, COALESCE(MAX(d.documentDate),'') lastActivity,
      (SELECT COUNT(*) FROM document_items di JOIN documents dx ON dx.id=di.documentId WHERE di.itemId=i.id AND dx.firmId=i.firmId AND dx.isDeleted=0) transactions,
      COALESCE((SELECT SUM(ib.quantity) FROM inventory_batches ib WHERE ib.itemId=i.id AND ib.firmId=i.firmId),0) stock
      FROM items i LEFT JOIN document_items di ON di.itemId=i.id LEFT JOIN documents d ON d.id=di.documentId AND d.isDeleted=0
      WHERE i.firmId=? AND COALESCE(i.isActive,1)=1`;
    const params:any[]=[firmId];
    if(req.query.categoryId){q+=' AND i.categoryId=?';params.push(String(req.query.categoryId))}
    if(req.query.companyId){q+=' AND i.companyId=?';params.push(String(req.query.companyId))}
    q+=' GROUP BY i.id HAVING (lastActivity < ? OR lastActivity IS NULL) AND transactions=0 AND stock=0 ORDER BY i.name';params.push(cut);
    rows=db.prepare(q).all(params);
  } else if(type==='parties'||type==='ledgers'||type==='salePurchase'){
    let q=`SELECT p.*, COALESCE(MAX(d.documentDate),'') lastActivity,
      (SELECT COUNT(*) FROM documents dx WHERE dx.partyId=p.id AND dx.firmId=p.firmId AND dx.isDeleted=0) transactions,
      (SELECT COALESCE(SUM(CASE WHEN dx.documentType IN ('sale_invoice','purchase_invoice') THEN dx.balanceAmount ELSE 0 END),0) FROM documents dx WHERE dx.partyId=p.id AND dx.firmId=p.firmId AND dx.isDeleted=0) balance
      FROM parties p LEFT JOIN documents d ON d.partyId=p.id AND d.isDeleted=0 WHERE p.firmId=? AND COALESCE(p.isActive,1)=1 GROUP BY p.id HAVING (lastActivity < ? OR lastActivity IS NULL) AND transactions=0 AND ABS(balance)<0.005 ORDER BY p.name`;
    rows=db.prepare(q).all(firmId,cut);
  } else if(type==='companies'||type==='companyMaster'){
    try{rows=db.prepare(`SELECT c.*, '' lastActivity, 0 transactions, 0 stock FROM item_companies c WHERE c.firmId=? ORDER BY c.name`).all(firmId)}catch{rows=[]}
  }
  res.json({success:true,data:rows,asOf:new Date().toISOString(),cutoffDate:cut,type});
}catch(e:any){res.status(500).json({error:e.message})}});
router.post('/non-working-data/delete',(req,res)=>{try{
  const firmId=String(req.body?.firmId||''); const type=String(req.body?.type||'items'); const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String):[]; if(!firmId||!ids.length)return res.status(400).json({error:'firmId and ids required'});
  const table=(type==='items'||type==='category'||type==='company')?'items':(type==='parties'||type==='ledgers'||type==='salePurchase')?'parties':type==='companies'?'item_companies':'';
  if(!table)return res.status(400).json({error:'This non-working type is read-only'});
  const tx=db.transaction(()=>{let deletedCount=0;const blocked:any[]=[];for(const id of ids){const row:any=db.prepare(`SELECT * FROM ${table} WHERE id=? AND firmId=?`).get(id,firmId);if(!row){blocked.push({id,reason:'Not found'});continue}
    if(table==='items'){const deps:any=db.prepare(`SELECT (SELECT COUNT(*) FROM document_items di JOIN documents d ON d.id=di.documentId WHERE di.itemId=? AND d.isDeleted=0) transactions,(SELECT COALESCE(SUM(quantity),0) stock FROM inventory_batches WHERE itemId=? AND firmId=?) stock`).get(id,id,firmId);if(Number(deps.transactions)>0||Number(deps.stock)>0){blocked.push({id,reason:'Has transactions or stock'});continue}db.prepare('UPDATE items SET isActive=0,updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),id,firmId)}
    else if(table==='parties'){const deps:any=db.prepare(`SELECT COUNT(*) transactions,COALESCE(SUM(balanceAmount),0) balance FROM documents WHERE partyId=? AND firmId=? AND isDeleted=0`).get(id,firmId);if(Number(deps.transactions)>0||Math.abs(Number(deps.balance||0))>.005){blocked.push({id,reason:'Has transactions or balance'});continue}db.prepare('UPDATE parties SET isActive=0,updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),id,firmId)}
    else {db.prepare('UPDATE item_companies SET isActive=0,updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),id,firmId)} deletedCount++;}return {deletedCount,blocked};});
  const out=tx();res.json({success:true,...out});
}catch(e:any){res.status(400).json({error:e.message})}});

router.get('/export/:firmId',(req,res)=>{try{const firmId=String(req.params.firmId); const tables=['firms','items','parties','documents','document_items','payments','expenses','inventory_batches','categories','units','bank_accounts','bank_transactions']; const payload:any={format:'BMAX-EXPORT',version:1,exportedAt:new Date().toISOString(),firmId,tables:{}}; for(const t of tables){try{const cols=db.prepare(`PRAGMA table_info(${t})`).all() as any[]; if(!cols.length)continue; payload.tables[t]=db.prepare(`SELECT * FROM ${t} WHERE firmId=?`).all(firmId);}catch{}} res.json({data:payload})}catch(e:any){res.status(500).json({error:e.message})}});
router.post('/import/:firmId',upload.single('file'),(req,res)=>{try{if(!req.file)return res.status(400).json({error:'JSON export file required'}); const parsed=JSON.parse(req.file.buffer.toString('utf8')); if(parsed.format!=='BMAX-EXPORT')return res.status(400).json({error:'Invalid B-MAX export file'}); const firmId=String(req.params.firmId); const counts:any={}; for(const [table,rows] of Object.entries(parsed.tables||{})){ if(!Array.isArray(rows)||!rows.length)continue; if(!['items','parties','categories','units'].includes(table))continue; const cols=db.prepare(`PRAGMA table_info(${table})`).all() as any[]; const names=cols.map((c:any)=>c.name); const usable=names.filter((n:string)=>Object.prototype.hasOwnProperty.call((rows as any[])[0],n)); if(!usable.includes('id'))continue; const sql=`INSERT OR REPLACE INTO ${table} (${usable.map(n=>`[${n}]`).join(',')}) VALUES (${usable.map(()=>'?').join(',')})`; const stmt=db.prepare(sql); let n=0; for(const row of rows as any[]){if(row.firmId!==firmId)continue; stmt.run(...usable.map(k=>row[k]));n++;} counts[table]=n;} res.json({data:{imported:counts}})}catch(e:any){res.status(400).json({error:e.message})}});

router.get('/tally-export/:firmId',(req,res)=>{try{const firmId=String(req.params.firmId); const docs=db.prepare('SELECT documentNumber,documentDate,partyName,documentType,total,paidAmount,balanceAmount FROM documents WHERE firmId=? AND isDeleted=0 ORDER BY documentDate,documentNumber').all(firmId) as any[]; const head='Voucher No,Voucher Date,Party,Type,Amount,Paid,Balance\n'; const csv=head+docs.map(r=>[r.documentNumber,r.documentDate,r.partyName,r.documentType,r.total,r.paidAmount,r.balanceAmount].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n'); res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="bmax_tally_export.csv"'); res.send(csv);}catch(e:any){res.status(500).json({error:e.message})}});

export default router;
