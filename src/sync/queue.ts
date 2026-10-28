import { db } from '../lib/db';

export function enqueueChange(changeId: string) {
  const now = new Date().toISOString();
  const settings = db.prepare('SELECT lanSyncEnabled FROM sync_settings WHERE firmId=(SELECT firmId FROM sync_changes WHERE changeId=? LIMIT 1)').get(changeId) as any;
  const targets = [
    ...(settings?.lanSyncEnabled !== 0 ? ['LAN'] : []),
  ];
  for (const target of targets) {
    db.prepare(`INSERT OR IGNORE INTO sync_queue(id,changeId,target,status,createdAt,updatedAt) VALUES(lower(hex(randomblob(16))),?,?, 'PENDING',?,?)`).run(changeId,target,now,now);
  }
}

export function enqueuePendingChanges() {
  const rows = db.prepare("SELECT changeId FROM sync_changes WHERE syncStatus='PENDING' ORDER BY version").all() as any[];
  for (const row of rows) enqueueChange(row.changeId);
}

export function getSyncStats() {
  const pending = Number((db.prepare("SELECT COUNT(*) c FROM sync_changes WHERE syncStatus='PENDING'").get() as any).c);
  const failed = Number((db.prepare("SELECT COUNT(*) c FROM sync_queue WHERE status='FAILED'").get() as any).c);
  const conflicts = Number((db.prepare("SELECT COUNT(*) c FROM sync_conflicts WHERE resolution='PENDING'").get() as any).c);
  const last = db.prepare('SELECT MAX(lastSyncAt) lastSyncAt FROM sync_devices').get() as any;
  return { pending, failed, conflicts, lastSyncAt: last?.lastSyncAt || null };
}



