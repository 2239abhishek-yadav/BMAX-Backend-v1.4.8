import fs from 'fs';
import path from 'path';

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



