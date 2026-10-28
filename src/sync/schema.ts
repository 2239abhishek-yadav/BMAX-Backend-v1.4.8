import { getDeviceIdentity } from './device';

const SYNC_TABLES = [
  'firms','gst_registrations','firm_users','categories','units','items','groups','parties',
  'documents','document_items','payments','payment_allocations','bank_accounts','expenses',
  'godowns','inventory_stock','employees','attendance','payroll_runs','payroll_items',
  'projects','agents','reminders','firm_settings','series','cheques','users'
];

export function initializeSyncSchema(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_devices (
      id TEXT PRIMARY KEY,
      deviceId TEXT NOT NULL UNIQUE,
      deviceName TEXT NOT NULL,
      installationId TEXT NOT NULL,
      lastSeenAt TEXT,
      lastSyncAt TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_changes (
      id TEXT PRIMARY KEY,
      changeId TEXT NOT NULL UNIQUE,
      deviceId TEXT NOT NULL,
      firmId TEXT,
      gstRegistrationId TEXT,
      tableName TEXT NOT NULL,
      recordId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('CREATE','UPDATE','DELETE')),
      version INTEGER NOT NULL,
      changedAt TEXT NOT NULL,
      syncStatus TEXT NOT NULL DEFAULT 'PENDING',
      payloadHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_changes_status ON sync_changes(syncStatus, version);
    CREATE INDEX IF NOT EXISTS idx_sync_changes_record ON sync_changes(tableName, recordId, version);
    CREATE INDEX IF NOT EXISTS idx_sync_changes_scope ON sync_changes(firmId, gstRegistrationId, version);
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      changeId TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('LAN','DRIVE')),
      attempts INTEGER NOT NULL DEFAULT 0,
      nextRetryAt TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      lastError TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(changeId,target)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_ready ON sync_queue(status,nextRetryAt);
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      id TEXT PRIMARY KEY,
      deviceId TEXT NOT NULL,
      target TEXT NOT NULL,
      lastPulledVersion INTEGER NOT NULL DEFAULT 0,
      lastPushedVersion INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL,
      UNIQUE(deviceId,target)
    );
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      firmId TEXT,
      gstRegistrationId TEXT,
      tableName TEXT NOT NULL,
      recordId TEXT NOT NULL,
      localChangeId TEXT NOT NULL,
      remoteChangeId TEXT NOT NULL,
      localVersion INTEGER NOT NULL,
      remoteVersion INTEGER NOT NULL,
      localPayload TEXT,
      remotePayload TEXT,
      resolution TEXT NOT NULL DEFAULT 'PENDING',
      resolvedBy TEXT,
      resolvedAt TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_tombstones (
      id TEXT PRIMARY KEY,
      firmId TEXT,
      gstRegistrationId TEXT,
      tableName TEXT NOT NULL,
      recordId TEXT NOT NULL,
      deletedByDevice TEXT NOT NULL,
      deletedAt TEXT NOT NULL,
      version INTEGER NOT NULL,
      UNIQUE(tableName,recordId)
    );
    CREATE TABLE IF NOT EXISTS sync_settings (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL UNIQUE,
      automaticSync INTEGER NOT NULL DEFAULT 1,
      lanSyncEnabled INTEGER NOT NULL DEFAULT 1,
      googleDriveEnabled INTEGER NOT NULL DEFAULT 0,
      lastSyncAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_files (
      id TEXT PRIMARY KEY,
      firmId TEXT,
      recordType TEXT NOT NULL,
      recordId TEXT NOT NULL,
      localPath TEXT,
      fileHash TEXT,
      fileSize INTEGER,
      remotePath TEXT,
      syncStatus TEXT NOT NULL DEFAULT 'PENDING',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_runtime (
      id INTEGER PRIMARY KEY CHECK(id=1),
      suppressTriggers INTEGER NOT NULL DEFAULT 0,
      currentRemoteDeviceId TEXT
    );
    INSERT OR IGNORE INTO sync_runtime(id,suppressTriggers) VALUES(1,0);
  `);

  const identity = getDeviceIdentity();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sync_devices (id,deviceId,deviceName,installationId,status,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET deviceName=excluded.deviceName,installationId=excluded.installationId,updatedAt=excluded.updatedAt`).run(
    identity.deviceId, identity.deviceId, identity.deviceName, identity.installationId, 'online', now, now
  );

  // Capture business-table changes without rewriting every existing route. Payload is
  // read at sync time from the authoritative local table; DELETE is preserved by tombstone.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>;
  const existing = new Set(tables.map(t=>t.name));
  const maxVersion = () => Number((db.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM sync_changes').get() as any).v);
  for (const table of SYNC_TABLES) {
    if (!existing.has(table)) continue;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some(c=>c.name==='id')) continue;
    const hasFirm = cols.some(c=>c.name==='firmId');
    const firmNew = hasFirm ? 'NEW.firmId' : table === 'firms' ? 'NEW.id' : 'NULL';
    const firmOld = hasFirm ? 'OLD.firmId' : table === 'firms' ? 'OLD.id' : 'NULL';
    const updatedNew = cols.some(c=>c.name==='updatedAt') ? 'COALESCE(NEW.updatedAt,datetime(\'now\'))' : "datetime('now')";
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_ai AFTER INSERT ON ${table}
      WHEN (SELECT suppressTriggers FROM sync_runtime WHERE id=1)=0
      BEGIN
        INSERT INTO sync_changes(id,changeId,deviceId,firmId,tableName,recordId,operation,version,changedAt,payloadHash)
        VALUES (lower(hex(randomblob(16))), lower(hex(randomblob(16))), '${identity.deviceId}', ${firmNew}, '${table}', NEW.id, 'CREATE', (SELECT COALESCE(MAX(version),0)+1 FROM sync_changes), ${updatedNew}, NULL);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_au AFTER UPDATE ON ${table}
      WHEN (SELECT suppressTriggers FROM sync_runtime WHERE id=1)=0
      BEGIN
        INSERT INTO sync_changes(id,changeId,deviceId,firmId,tableName,recordId,operation,version,changedAt,payloadHash)
        VALUES (lower(hex(randomblob(16))), lower(hex(randomblob(16))), '${identity.deviceId}', ${firmNew}, '${table}', NEW.id, 'UPDATE', (SELECT COALESCE(MAX(version),0)+1 FROM sync_changes), ${updatedNew}, NULL);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_${table}_ad AFTER DELETE ON ${table}
      WHEN (SELECT suppressTriggers FROM sync_runtime WHERE id=1)=0
      BEGIN
        INSERT INTO sync_changes(id,changeId,deviceId,firmId,tableName,recordId,operation,version,changedAt,payloadHash)
        VALUES (lower(hex(randomblob(16))), lower(hex(randomblob(16))), '${identity.deviceId}', ${firmOld}, '${table}', OLD.id, 'DELETE', (SELECT COALESCE(MAX(version),0)+1 FROM sync_changes), datetime('now'), NULL);
        INSERT OR REPLACE INTO sync_tombstones(id,firmId,tableName,recordId,deletedByDevice,deletedAt,version)
        VALUES (lower(hex(randomblob(16))), ${firmOld}, '${table}', OLD.id, '${identity.deviceId}', datetime('now'), (SELECT MAX(version) FROM sync_changes));
      END;
    `);
  }
}



