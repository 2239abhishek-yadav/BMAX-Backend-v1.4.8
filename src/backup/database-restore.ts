import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const cryptoSafeStamp = () => `${stamp()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;

export function validateBackupFile(filePath: string) {
  if (!fs.existsSync(filePath)) throw new Error('Backup file not found.');
  const stat = fs.statSync(filePath);
  if (stat.size < 100 || stat.size > 1024 * 1024 * 1024) throw new Error('Backup file size is invalid (must be under 1 GB).');
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(16);
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (header.toString('binary') !== 'SQLite format 3\u0000') throw new Error('This is not a valid B-MAX SQLite database backup.');
  const checkDb = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = checkDb.pragma('integrity_check') as any[];
    if (!integrity.length || String(integrity[0].integrity_check).toLowerCase() !== 'ok') throw new Error('Backup integrity check failed.');
    const tables = new Set((checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(x => String(x.name)));
    if (!tables.has('firms') || !tables.has('items') || !tables.has('documents')) throw new Error('Backup does not contain the required B-MAX business tables.');
  } finally { checkDb.close(); }
  return { size: stat.size };
}

// Restore is staged and applied before the SQLite connection opens on next launch.
// The current database is copied to a rollback backup before replacement.
export function applyPendingDatabaseRestore(dbPath: string) {
  const dir = path.dirname(dbPath);
  const pending = path.join(dir, 'bmax-restore-pending.db');
  if (!fs.existsSync(pending)) return { applied: false };
  validateBackupFile(pending);
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  if (fs.existsSync(dbPath)) {
    const rollback = path.join(dir, 'backups', `bmax-before-restore-${stamp()}.db`);
    // Open/checkpoint the current DB and use SQLite VACUUM INTO so any committed WAL
    // content is included in the rollback copy before sidecars are removed.
    const current = new Database(dbPath);
    try {
      current.pragma('wal_checkpoint(FULL)');
      const escaped = rollback.replace(/'/g, "''");
      current.exec(`VACUUM INTO '${escaped}'`);
    } finally { current.close(); }
  }
  // At startup no application DB connection is open. The rollback snapshot above
  // already contains committed WAL data; remove stale sidecars before the new DB
  // is installed so they can never be replayed against the restored database.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

  // Windows does not reliably allow rename-over-existing-file. Move the old DB
  // aside, install the validated replacement, and restore the old path if the
  // install fails. Keep the pending file on failure so startup can report/retry.
  const replacement = `${dbPath}.restore-replacement`;
  const displaced = `${dbPath}.pre-restore-${cryptoSafeStamp()}.tmp`;
  try { fs.rmSync(replacement, { force: true }); } catch {}
  fs.copyFileSync(pending, replacement);
  validateBackupFile(replacement);
  let movedOld = false;
  try {
    if (fs.existsSync(dbPath)) { fs.renameSync(dbPath, displaced); movedOld = true; }
    fs.renameSync(replacement, dbPath);
  } catch (error) {
    try { fs.rmSync(dbPath, { force: true }); } catch {}
    if (movedOld && fs.existsSync(displaced)) {
      try { fs.renameSync(displaced, dbPath); } catch (rollbackError) {
        throw new Error(`Restore installation failed and automatic rollback also failed. Original DB is preserved at ${displaced}. Details: ${String(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    try { fs.rmSync(replacement, { force: true }); } catch {}
  }
  if (movedOld) { try { fs.rmSync(displaced, { force: true }); } catch {} }
  fs.rmSync(pending, { force: true });
  return { applied: true };
}


/** Merge one isolated firm backup into the existing live database without
 * replacing or deleting any other firm. Existing rows for only this Firm ID
 * are replaced inside a single transaction; unrelated firms are untouched.
 */
export function mergeFirmBackupIntoDatabase(targetDb:any, backupPath:string, firmIdRaw:string){
  const firmId=String(firmIdRaw||'').trim();
  if(!firmId || firmId.length>100) throw new Error('A valid company ID is required for restore.');
  validateBackupFile(backupPath);
  const source=new Database(backupPath,{readonly:true,fileMustExist:true});
  const excluded=new Set(['sync_devices','sync_changes','sync_queue','sync_checkpoints','sync_conflicts','sync_tombstones','sync_files','sync_settings','sync_runtime','subscription_state','subscription_addons']);
  try{
    const sourceFirmRows=source.prepare('SELECT id,name FROM firms').all() as any[];
    if(sourceFirmRows.length!==1 || String(sourceFirmRows[0].id)!==firmId) throw new Error('This backup belongs to a different company. Restore was stopped.');
    const sourceTables=(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map(x=>String(x.name)).filter(x=>!excluded.has(x));
    const sourceCols=new Map<string,Set<string>>();
    const sourceFks=new Map<string,any[]>();
    for(const table of sourceTables){
      sourceCols.set(table,new Set((source.prepare(`PRAGMA table_info(\`${table.replace(/`/g,'``')}\`)`).all() as any[]).map(c=>String(c.name))));
      sourceFks.set(table,source.prepare(`PRAGMA foreign_key_list(\`${table.replace(/`/g,'``')}\`)`).all() as any[]);
    }
    const included=new Set<string>(['firms']);
    for(const table of sourceTables) if(sourceCols.get(table)?.has('firmId')) included.add(table);
    // Include child tables without firmId (for example payroll_items) only when
    // their declared FK points into an already selected firm-scoped table.
    let changed=true;
    while(changed){
      changed=false;
      for(const table of sourceTables){
        if(included.has(table) || table==='users') continue;
        if((sourceFks.get(table)||[]).some(fk=>included.has(String(fk.table)))){included.add(table);changed=true;}
      }
    }
    if(included.has('firm_users') && sourceTables.includes('users')) included.add('users');
    const order:string[]=[]; const pending=new Set([...included]);
    while(pending.size){
      let progressed=false;
      for(const table of Array.from(pending)){
        const parents=(sourceFks.get(table)||[]).map(fk=>String(fk.table)).filter(parent=>included.has(parent)&&parent!==table);
        if(parents.every(parent=>order.includes(parent) || !pending.has(parent))){order.push(table);pending.delete(table);progressed=true;}
      }
      if(!progressed) throw new Error('Backup table relationships could not be safely ordered.');
    }
    const getRows=(table:string)=>{
      const cols=sourceCols.get(table)||new Set<string>();
      if(table==='firms') return source.prepare('SELECT * FROM firms WHERE id=?').all(firmId) as any[];
      if(table==='users') return source.prepare('SELECT * FROM users WHERE id IN (SELECT userId FROM firm_users WHERE firmId=?)').all(firmId) as any[];
      if(cols.has('firmId')) return source.prepare(`SELECT * FROM \`${table.replace(/`/g,'``')}\` WHERE firmId=?`).all(firmId) as any[];
      const predicates=(sourceFks.get(table)||[]).filter(fk=>included.has(String(fk.table))).map(fk=>{
        const child=String(fk.from).replace(/"/g,'""'); const parent=String(fk.table).replace(/"/g,'""'); const parentCol=String(fk.to||'id').replace(/"/g,'""');
        return `\`${child}\` IN (SELECT \`${parentCol}\` FROM \`${parent}\`)`;
      });
      if(!predicates.length) return [];
      return source.prepare(`SELECT * FROM \`${table.replace(/`/g,'``')}\` WHERE ${predicates.join(' OR ')}`).all() as any[];
    };
    const targetTables=new Set((targetDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[]).map(x=>String(x.name)));
    const targetCols=new Map<string,Set<string>>();
    for(const table of targetTables) targetCols.set(table,new Set((targetDb.prepare(`PRAGMA table_info(\`${table.replace(/`/g,'``')}\`)`).all() as any[]).map((c:any)=>String(c.name))));
    const targetFks=new Map<string,any[]>();
    for(const table of targetTables) targetFks.set(table,targetDb.prepare(`PRAGMA foreign_key_list(\`${table.replace(/`/g,'``')}\`)`).all() as any[]);
    const targetFirmTables=[...targetTables].filter(table=>targetCols.get(table)?.has('firmId')&&!excluded.has(table));
    const tx=targetDb.transaction(()=>{
      targetDb.pragma('defer_foreign_keys = ON');
      if(targetTables.has('sync_runtime')) targetDb.prepare('UPDATE sync_runtime SET suppressTriggers=1 WHERE id=1').run();
      if(targetTables.has('sync_changes')){
        if(targetTables.has('sync_queue')) targetDb.prepare('DELETE FROM sync_queue WHERE changeId IN (SELECT changeId FROM sync_changes WHERE firmId=?)').run(firmId);
        targetDb.prepare('DELETE FROM sync_changes WHERE firmId=?').run(firmId);
      }
      for(const table of ['sync_conflicts','sync_tombstones','sync_files']) if(targetTables.has(table)) targetDb.prepare(`DELETE FROM \`${table}\` WHERE firmId=?`).run(firmId);
      // Remove every existing tenant-scoped row for this Firm ID, including
      // newer tables absent from an older backup. FK cascades remove dependent
      // no-firmId children such as payroll_items.
      for(const table of targetFirmTables){
        targetDb.prepare(`DELETE FROM \`${table.replace(/`/g,'``')}\` WHERE firmId=?`).run(firmId);
      }
      if(targetTables.has('firms')) targetDb.prepare('DELETE FROM firms WHERE id=?').run(firmId);
      // Users are global identities and can be shared by multiple firms. Map
      // source user IDs to existing local users by email so recovery-workspace
      // users created on a fresh PC are not duplicated or orphaned.
      const userIdMap=new Map<string,string>();
      for(const table of order){
        if(!targetTables.has(table)) continue;
        const rows=getRows(table); if(!rows.length) continue;
        const destCols=targetCols.get(table)||new Set<string>();
        const names=Object.keys(rows[0]).filter(name=>destCols.has(name));
        if(!names.length) continue;
        const sql=`INSERT ${table==='users'?'OR IGNORE':'OR REPLACE'} INTO \`${table.replace(/`/g,'``')}\` (${names.map(n=>`\`${n.replace(/`/g,'``')}\``).join(',')}) VALUES (${names.map(()=>'?').join(',')})`;
        const stmt=targetDb.prepare(sql);
        for(const originalRow of rows){
          const row={...originalRow};
          if(table==='users'){
            let existing=targetDb.prepare('SELECT id,email FROM users WHERE id=? LIMIT 1').get(String(row.id||'')) as any;
            if(existing && row.email && String(existing.email||'').toLowerCase()!==String(row.email).toLowerCase()) existing=null;
            if(!existing && row.email) existing=targetDb.prepare('SELECT id,email FROM users WHERE lower(email)=lower(?) LIMIT 1').get(String(row.email)) as any;
            if(existing?.id){userIdMap.set(String(row.id),String(existing.id));continue;}
            stmt.run(...names.map(name=>row[name]));
            const inserted=targetDb.prepare('SELECT id FROM users WHERE id=? LIMIT 1').get(String(row.id||'')) as any;
            const byEmail=!inserted&&row.email?targetDb.prepare('SELECT id FROM users WHERE lower(email)=lower(?) LIMIT 1').get(String(row.email)) as any:null;
            const actual=inserted||byEmail;
            if(!actual?.id) throw new Error('A company user could not be restored safely.');
            userIdMap.set(String(row.id),String(actual.id));
            continue;
          }
          for(const fk of (sourceFks.get(table)||[]).filter(f=>String(f.table)==='users')){
            const from=String(fk.from); const oldId=String(row[from]||'');
            if(userIdMap.has(oldId)) row[from]=userIdMap.get(oldId);
          }
          stmt.run(...names.map(name=>row[name]));
        }
      }
      if(targetTables.has('sync_runtime')) targetDb.prepare('UPDATE sync_runtime SET suppressTriggers=0 WHERE id=1').run();
      const fk=targetDb.pragma('foreign_key_check') as any[];
      if(fk.length) throw new Error('Company restore left unresolved database relationships.');
      const verify=targetDb.prepare('SELECT id FROM firms WHERE id=?').get(firmId) as any;
      if(!verify) throw new Error('Company restore verification failed.');
    });
    tx();
    return {restored:true,firmId,firmName:String(sourceFirmRows[0].name||''),tables:order.length};
  } finally { source.close(); }
}
