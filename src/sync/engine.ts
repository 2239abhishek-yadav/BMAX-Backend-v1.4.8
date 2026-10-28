import { db } from '../lib/db';
import { getDeviceIdentity } from './device';
import { enqueuePendingChanges, getSyncStats } from './queue';

const identity = getDeviceIdentity();

function rowPayload(tableName: string, recordId: string) {
  const row = db.prepare(`SELECT * FROM ${tableName} WHERE id=?`).get(recordId) as any;
  return row || null;
}

export function listChanges(sinceVersion=0, limit=500) {
  const changes = db.prepare(`SELECT * FROM sync_changes WHERE version>? AND deviceId<>? ORDER BY version LIMIT ?`).all(sinceVersion, identity.deviceId, limit) as any[];
  return changes.map(c => ({ ...c, payload: c.operation === 'DELETE' ? null : rowPayload(c.tableName,c.recordId) }));
}

function applyRemoteChange(change: any) {
  const duplicate = db.prepare('SELECT 1 FROM sync_changes WHERE changeId=? LIMIT 1').get(change.changeId);
  if (duplicate) return { status:'ignored' };
  const now = new Date().toISOString();
  // Scope guard: a remote change must belong to a firm already present locally,
  // except the firm record itself (used during controlled initial setup).
  if (change.firmId && change.tableName !== 'firms') {
    const known = db.prepare('SELECT 1 FROM firms WHERE id=?').get(change.firmId);
    if (!known) return { status:'conflict' };
  }
  const existing = db.prepare(`SELECT * FROM sync_changes WHERE tableName=? AND recordId=? ORDER BY version DESC LIMIT 1`).get(change.tableName, change.recordId) as any;
  if (existing && Number(existing.version) > Number(change.version) && existing.deviceId !== change.deviceId) {
    const localPayload = existing.operation === 'DELETE' ? null : rowPayload(change.tableName, change.recordId);
    db.prepare(`INSERT INTO sync_conflicts(id,firmId,gstRegistrationId,tableName,recordId,localChangeId,remoteChangeId,localVersion,remoteVersion,localPayload,remotePayload,createdAt) VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?,?,?,?,?,?)`).run(
      change.firmId || null, change.gstRegistrationId || null, change.tableName, change.recordId, existing.changeId, change.changeId, existing.version, change.version,
      JSON.stringify(localPayload), JSON.stringify(change.payload), now
    );
    return { status:'conflict' };
  }

  db.transaction(() => {
    db.prepare('UPDATE sync_runtime SET suppressTriggers=1,currentRemoteDeviceId=? WHERE id=1').run(change.deviceId);
    try {
      if (change.operation === 'DELETE') {
        db.prepare(`DELETE FROM ${change.tableName} WHERE id=?`).run(change.recordId);
      } else if (change.payload) {
        const cols = db.prepare(`PRAGMA table_info(${change.tableName})`).all() as any[];
        const names = cols.map(c=>c.name).filter((n:string)=>Object.prototype.hasOwnProperty.call(change.payload,n));
        const values = names.map(n=>change.payload[n]);
        const placeholders = names.map(()=>'?').join(',');
        db.prepare(`INSERT OR REPLACE INTO ${change.tableName} (${names.map((n:string)=>`[${n}]`).join(',')}) VALUES (${placeholders})`).run(...values);
      }
      db.prepare('UPDATE sync_runtime SET suppressTriggers=0,currentRemoteDeviceId=NULL WHERE id=1').run();
    } catch (e) {
      db.prepare('UPDATE sync_runtime SET suppressTriggers=0,currentRemoteDeviceId=NULL WHERE id=1').run();
      throw e;
    }
    db.prepare(`INSERT OR IGNORE INTO sync_changes(id,changeId,deviceId,firmId,gstRegistrationId,tableName,recordId,operation,version,changedAt,syncStatus,payloadHash) VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?,?,?,?,'SYNCED',NULL)`).run(
      change.changeId, change.deviceId, change.firmId || null, change.gstRegistrationId || null, change.tableName, change.recordId, change.operation, change.version, change.changedAt
    );
    if (change.operation === 'DELETE') {
      db.prepare(`INSERT OR REPLACE INTO sync_tombstones(id,firmId,gstRegistrationId,tableName,recordId,deletedByDevice,deletedAt,version) VALUES(lower(hex(randomblob(16))),?,?,?,?,?,?,?)`).run(
        change.firmId || null, change.gstRegistrationId || null, change.tableName, change.recordId, change.deviceId, change.changedAt, change.version
      );
    }
  })();
  return { status:'applied' };
}

export function importChanges(changes:any[]) {
  let applied=0, conflicts=0;
  for (const change of changes) {
    if (change.deviceId === identity.deviceId) continue;
    const result = applyRemoteChange(change);
    if (result.status === 'applied') applied++; else if (result.status === 'conflict') conflicts++;
  }
  return { applied, conflicts };
}

export function markChangesSynced(changeIds:string[]) {
  if (!changeIds.length) return;
  const stmt = db.prepare("UPDATE sync_changes SET syncStatus='SYNCED' WHERE changeId=?");
  db.transaction(()=>{for(const id of changeIds)stmt.run(id)})();
  db.prepare('UPDATE sync_devices SET lastSyncAt=?,lastSeenAt=?,status=\'online\',updatedAt=? WHERE deviceId=?').run(new Date().toISOString(),new Date().toISOString(),new Date().toISOString(),identity.deviceId);
}

export function syncLocalQueue() {
  enqueuePendingChanges();
  return getSyncStats();
}

export async function syncWithPeer(peer:{deviceId:string,host:string,port:number,deviceName?:string}) {
  const target=`LAN:${peer.deviceId}`; const current=db.prepare('SELECT * FROM sync_checkpoints WHERE deviceId=? AND target=?').get(identity.deviceId,target) as any;
  const since=Number(current?.lastPulledVersion||0); const base=`http://${peer.host}:${peer.port}/api/sync`;
  const lanHeaders:any={}; if(process.env.BMAX_LAN_SECRET) lanHeaders['x-bmax-lan-secret']=process.env.BMAX_LAN_SECRET;
  const remoteRes=await fetch(`${base}/changes?since=${since}&limit=500`,{headers:lanHeaders}); const remote=await remoteRes.json() as any; if(!remoteRes.ok) throw new Error(remote.error||`Peer ${peer.deviceName} rejected changes`);
  const imported=importChanges(remote.data||[]);
  const localRows=db.prepare(`SELECT * FROM sync_changes WHERE version>? AND deviceId=? ORDER BY version LIMIT 500`).all(Number(current?.lastPushedVersion||0),identity.deviceId) as any[];
  const localChanges=localRows.map(c=>({...c,payload:c.operation==='DELETE'?null:rowPayload(c.tableName,c.recordId)}));
  if(localChanges.length){
    const push=await fetch(`${base}/changes/import`,{method:'POST',headers:{'Content-Type':'application/json',...lanHeaders},body:JSON.stringify({changes:localChanges})});
    const pushData=await push.json() as any; if(!push.ok) throw new Error(pushData.error||`Peer ${peer.deviceName} rejected upload`);
    await fetch(`${base}/changes/ack`,{method:'POST',headers:{'Content-Type':'application/json',...lanHeaders},body:JSON.stringify({changeIds:localChanges.map((c:any)=>c.changeId)})});
  }
  const maxRemote=(remote.data||[]).reduce((m:any,c:any)=>Math.max(m,Number(c.version||0)),since);
  const maxLocal=localChanges.reduce((m:any,c:any)=>Math.max(m,Number(c.version||0)),Number(current?.lastPushedVersion||0));
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO sync_checkpoints(id,deviceId,target,lastPulledVersion,lastPushedVersion,updatedAt) VALUES(lower(hex(randomblob(16))),?,?,?,?,?) ON CONFLICT(deviceId,target) DO UPDATE SET lastPulledVersion=excluded.lastPulledVersion,lastPushedVersion=excluded.lastPushedVersion,updatedAt=excluded.updatedAt`).run(identity.deviceId,target,maxRemote,maxLocal,now);
  return {peer:peer.deviceName,imported,uploaded:localChanges.length};
}



