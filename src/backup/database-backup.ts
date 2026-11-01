import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

function safeFileNameStamp(){ return new Date().toISOString().replace(/[:.]/g,'-'); }

export function snapshotOpenDatabase(db:any, destinationRoot?:string){
  const dbDir=process.env.DB_PATH || path.join(process.cwd(),'data');
  const root=destinationRoot || path.join(dbDir,'backups');
  fs.mkdirSync(root,{recursive:true});
  const out=path.join(root,`bmax-pre-sync-${safeFileNameStamp()}.db`);
  const escaped=out.replace(/'/g,"''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return {created:true,path:out,size:fs.statSync(out).size};
}

/** Create an isolated backup containing exactly one existing B-MAX firm.
 * The live database is never modified: filtering happens only in a VACUUM copy.
 * Global account/license tables are preserved; sync queues/history are cleared.
 */
export function snapshotFirmDatabase(db:any, firmIdRaw:string, destinationRoot?:string){
  const firmId=String(firmIdRaw||'').trim();
  if(!firmId || firmId.length>100) throw new Error('A valid company ID is required for a company backup.');
  const snapshot=snapshotOpenDatabase(db,destinationRoot);
  let copy:any=null;
  try {
    copy=new Database(snapshot.path);
    copy.pragma('foreign_keys = ON');
    const firm=copy.prepare('SELECT id,name FROM firms WHERE id=?').get(firmId) as any;
    if(!firm) throw new Error('The selected company does not exist on this PC. Refresh the company list and try again.');
    const tables=(copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map(x=>String(x.name));
    const columns=new Map<string,Set<string>>();
    for(const table of tables){
      const cols=copy.prepare(`PRAGMA table_info(\`${table.replace(/`/g,'``')}\`)`).all() as any[];
      columns.set(table,new Set(cols.map(c=>String(c.name))));
    }
    const tx=copy.transaction(()=>{
      // Remove rows belonging to other firms from every tenant-scoped table.
      for(const table of tables){
        if(table==='firms') continue;
        if(columns.get(table)?.has('firmId')){
          const safe=table.replace(/`/g,'``');
          copy.prepare(`DELETE FROM \`${safe}\` WHERE firmId IS NULL OR firmId<>?`).run(firmId);
        }
      }
      // Keep only users who are members of the selected firm. User records are
      // global identities; their firm membership and roles remain firm-scoped.
      if(tables.includes('firm_users') && tables.includes('users')){
        copy.prepare('DELETE FROM users WHERE id NOT IN (SELECT userId FROM firm_users WHERE firmId=?)').run(firmId);
      }
      // Licensing is installation/account scoped, not company business data.
      for(const table of ['subscription_state','subscription_addons']) if(tables.includes(table)) copy.exec(`DELETE FROM \`${table}\``);
      // Sync metadata is device-specific, not company business data. Do not
      // transfer another PC's queue, conflicts, tombstones, or device registry.
      for(const table of ['sync_changes','sync_queue','sync_checkpoints','sync_conflicts','sync_tombstones','sync_files','sync_devices']){
        if(tables.includes(table)) copy.exec(`DELETE FROM \`${table}\``);
      }
      if(tables.includes('sync_settings')) copy.prepare('DELETE FROM sync_settings WHERE firmId<>? OR firmId IS NULL').run(firmId);
      if(tables.includes('sync_runtime')) copy.prepare('UPDATE sync_runtime SET suppressTriggers=0,currentRemoteDeviceId=NULL WHERE id=1').run();
      copy.prepare('DELETE FROM firms WHERE id<>?').run(firmId);
    });
    tx();
    const firmsLeft=copy.prepare('SELECT id,name FROM firms').all() as any[];
    if(firmsLeft.length!==1 || String(firmsLeft[0].id)!==firmId) throw new Error('Company backup isolation check failed.');
    const integrity=copy.pragma('integrity_check') as any[];
    if(!integrity.length || String(integrity[0].integrity_check).toLowerCase()!=='ok') throw new Error('Company backup integrity check failed.');
    const fk=copy.pragma('foreign_key_check') as any[];
    if(fk.length) throw new Error('Company backup contains unresolved database relationships; backup was not accepted.');
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.exec('VACUUM');
    copy.close(); copy=null;
    return {created:true,path:snapshot.path,size:fs.statSync(snapshot.path).size,firmId,firmName:String(firm.name)};
  } catch(error){
    if(copy) try{copy.close()}catch{}
    try{fs.rmSync(snapshot.path,{force:true})}catch{}
    throw error;
  }
}
