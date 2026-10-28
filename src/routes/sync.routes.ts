import { Router } from 'express';
import { db } from '../lib/db';
import { getDeviceIdentity } from '../sync/device';
import { getSyncStats, enqueuePendingChanges } from '../sync/queue';
import { listChanges, importChanges, markChangesSynced, syncLocalQueue } from '../sync/engine';
import { getLanPeers } from '../sync/lan/discovery';
import { syncWithPeer } from '../sync/engine';

const router=Router();
const identity=getDeviceIdentity();
function lanAuthorized(req:any){ const expected=process.env.BMAX_LAN_SECRET; return !!expected && req.headers['x-bmax-lan-secret']===expected; }


router.get('/settings/:firmId',(req,res)=>{
  const firmId=String(req.params.firmId); const now=new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO sync_settings(id,firmId,automaticSync,lanSyncEnabled,googleDriveEnabled,createdAt,updatedAt) VALUES(lower(hex(randomblob(16))),?,1,1,0,?,?)`).run(firmId,now,now);
  const row=db.prepare('SELECT * FROM sync_settings WHERE firmId=?').get(firmId);
  res.json({data:row});
});
router.put('/settings/:firmId',(req,res)=>{
  const firmId=String(req.params.firmId); const now=new Date().toISOString();
  db.prepare(`INSERT INTO sync_settings(id,firmId,automaticSync,lanSyncEnabled,googleDriveEnabled,lastSyncAt,createdAt,updatedAt) VALUES(lower(hex(randomblob(16))),?,?,?,0,NULL,?,?) ON CONFLICT(firmId) DO UPDATE SET automaticSync=excluded.automaticSync,lanSyncEnabled=excluded.lanSyncEnabled,googleDriveEnabled=0,updatedAt=excluded.updatedAt`).run(firmId,req.body?.automaticSync===false?0:1,req.body?.lanSyncEnabled===false?0:1,now,now);
  res.json({data:db.prepare('SELECT * FROM sync_settings WHERE firmId=?').get(firmId)});
});

router.get('/status',(req,res)=>res.json({data:{device:identity,...getSyncStats()}}));
router.get('/devices',(req,res)=>{
  const rows=db.prepare('SELECT deviceId,deviceName,installationId,lastSeenAt,lastSyncAt,status,updatedAt FROM sync_devices ORDER BY deviceName').all();
  res.json({data:rows,lan:getLanPeers()});
});
router.post('/queue',(req,res)=>{ enqueuePendingChanges(); res.json({data:getSyncStats()}); });
router.get('/changes',(req,res)=>{ if(!lanAuthorized(req)) return res.status(401).json({error:'LAN authentication failed'}); const since=Number(req.query.since||0); const limit=Math.min(Number(req.query.limit||500),1000); res.json({data:listChanges(since,limit)}); });
router.post('/changes/import',(req,res)=>{ if(!lanAuthorized(req)) return res.status(401).json({error:'LAN authentication failed'}); const changes=Array.isArray(req.body?.changes)?req.body.changes:[]; res.json({data:importChanges(changes)}); });
router.post('/changes/ack',(req,res)=>{ if(!lanAuthorized(req)) return res.status(401).json({error:'LAN authentication failed'}); const ids=Array.isArray(req.body?.changeIds)?req.body.changeIds:[]; markChangesSynced(ids); res.json({data:getSyncStats()}); });
router.post('/lan/sync-now',async(req,res)=>{const peers=getLanPeers();const results=[];for(const peer of peers){try{results.push(await syncWithPeer(peer))}catch(e:any){results.push({peer:peer.deviceName,error:e.message})}}res.json({data:{results,stats:getSyncStats()}});});
router.post('/sync-now',(req,res)=>{ try { const stats=syncLocalQueue(); res.json({data:stats}); } catch(e:any){res.status(500).json({error:e.message})} });
router.post('/conflicts/:id/resolve',(req,res)=>{
  const id=String(req.params.id); const resolution=String(req.body?.resolution||'PENDING');
  const c=db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id) as any; if(!c)return res.status(404).json({error:'Conflict not found'});
  if(!['LOCAL','REMOTE'].includes(resolution)) return res.status(400).json({error:'Resolution must be LOCAL or REMOTE'});
  if(resolution==='REMOTE' && c.remotePayload){
    const payload=JSON.parse(c.remotePayload); const cols=db.prepare(`PRAGMA table_info(${c.tableName})`).all() as any[]; const names=cols.map(x=>x.name).filter((n:string)=>Object.prototype.hasOwnProperty.call(payload,n));
    db.transaction(()=>{db.prepare('UPDATE sync_runtime SET suppressTriggers=1 WHERE id=1').run();try{db.prepare(`INSERT OR REPLACE INTO ${c.tableName} (${names.map((n:string)=>`[${n}]`).join(',')}) VALUES (${names.map(()=>'?').join(',')})`).run(...names.map((n:string)=>payload[n]));db.prepare('UPDATE sync_runtime SET suppressTriggers=0 WHERE id=1').run()}catch(e){db.prepare('UPDATE sync_runtime SET suppressTriggers=0 WHERE id=1').run();throw e}})();
  }
  db.prepare("UPDATE sync_conflicts SET resolution=?,resolvedBy=?,resolvedAt=? WHERE id=?").run(resolution,identity.deviceId,new Date().toISOString(),id);
  res.json({data:{resolved:true,resolution}});
});

export default router;



