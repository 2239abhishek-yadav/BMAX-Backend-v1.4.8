import { Router, Request, Response } from 'express';
import { getNegativeStockAllowed } from '../lib/moduleSettings';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { assertItemQuantityPrecision } from '../lib/quantityPolicy';
import { normalizeExpiryMonth, normalizeExpiryYear } from '../lib/batchExpiry';

const router = Router();
const uid = () => uuidv4();
const now = () => new Date().toISOString();
const n = (value: any, fallback = 0) => {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
};
const positive = (value: any, label: string) => {
  const x = n(value, NaN);
  if (!Number.isFinite(x) || x <= 0) throw new Error(`${label} must be greater than zero`);
  return x;
};
const nonNegative = (value: any, label: string) => {
  const x = n(value, NaN);
  if (!Number.isFinite(x) || x < 0) throw new Error(`${label} cannot be negative`);
  return x;
};

// Manufacturing uses the firm's inventory policy. When enabled, raw-material
// issue may take stock below zero; when disabled, stock is strictly checked.
function isNegativeStockAllowed(firmId: string): boolean { return getNegativeStockAllowed(firmId); }

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!columns.some((c: any) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS physical_stock_sessions (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, godownId TEXT, sessionDate TEXT NOT NULL,
      referenceNo TEXT NOT NULL, notes TEXT, status TEXT NOT NULL DEFAULT 'posted',
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS physical_stock_items (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT NOT NULL,
      bookQty REAL NOT NULL DEFAULT 0, actualQty REAL NOT NULL DEFAULT 0, differenceQty REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(sessionId) REFERENCES physical_stock_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_physical_stock_firm_date ON physical_stock_sessions(firmId,sessionDate);
    CREATE INDEX IF NOT EXISTS idx_physical_stock_items_session ON physical_stock_items(sessionId);

    CREATE TABLE IF NOT EXISTS manufacturing_boms (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, code TEXT, name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1', finishedItemId TEXT NOT NULL, outputQty REAL NOT NULL DEFAULT 1,
      overheadCost REAL NOT NULL DEFAULT 0, machineryCost REAL NOT NULL DEFAULT 0, additionalCost REAL NOT NULL DEFAULT 0,
      notes TEXT, isActive INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(finishedItemId) REFERENCES items(id)
    );
    CREATE TABLE IF NOT EXISTS manufacturing_bom_items (
      id TEXT PRIMARY KEY, bomId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT NOT NULL,
      quantity REAL NOT NULL, unitCost REAL NOT NULL DEFAULT 0, scrapPercent REAL NOT NULL DEFAULT 0,
      operation TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(bomId) REFERENCES manufacturing_boms(id) ON DELETE CASCADE,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id)
    );
    CREATE TABLE IF NOT EXISTS manufacturing_bom_byproducts (
      id TEXT PRIMARY KEY, bomId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT NOT NULL,
      quantity REAL NOT NULL, unitCost REAL NOT NULL DEFAULT 0, notes TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(bomId) REFERENCES manufacturing_boms(id) ON DELETE CASCADE,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mfg_bom_firm ON manufacturing_boms(firmId,isActive);
    CREATE INDEX IF NOT EXISTS idx_mfg_bom_items_bom ON manufacturing_bom_items(bomId);
    CREATE INDEX IF NOT EXISTS idx_mfg_bom_byproducts_bom ON manufacturing_bom_byproducts(bomId);

    CREATE TABLE IF NOT EXISTS manufacturing_entries (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, productionNo TEXT NOT NULL,
      productionDate TEXT NOT NULL, bomId TEXT, finishedItemId TEXT NOT NULL,
      plannedQty REAL NOT NULL DEFAULT 0, producedQty REAL NOT NULL DEFAULT 0,
      wastageQty REAL NOT NULL DEFAULT 0, overheadCost REAL NOT NULL DEFAULT 0, machineryCost REAL NOT NULL DEFAULT 0, additionalCost REAL NOT NULL DEFAULT 0,
      totalMaterialCost REAL NOT NULL DEFAULT 0, totalByproductValue REAL NOT NULL DEFAULT 0,
      netProductionCost REAL NOT NULL DEFAULT 0, effectiveCost REAL NOT NULL DEFAULT 0,
      materialIssueNo TEXT, materialReceiptNo TEXT, batchNumber TEXT, finishedBatchId TEXT, operatorName TEXT,
      godownId TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'posted',
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(bomId) REFERENCES manufacturing_boms(id),
      FOREIGN KEY(finishedItemId) REFERENCES items(id)
    );
    CREATE TABLE IF NOT EXISTS manufacturing_entry_items (
      id TEXT PRIMARY KEY, entryId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT NOT NULL,
      requiredQty REAL NOT NULL DEFAULT 0, consumedQty REAL NOT NULL DEFAULT 0,
      unitCost REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'RAW_MATERIAL', createdAt TEXT NOT NULL,
      FOREIGN KEY(entryId) REFERENCES manufacturing_entries(id) ON DELETE CASCADE,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id)
    );
    CREATE TABLE IF NOT EXISTS manufacturing_entry_byproducts (
      id TEXT PRIMARY KEY, entryId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT NOT NULL,
      requiredQty REAL NOT NULL DEFAULT 0, receivedQty REAL NOT NULL DEFAULT 0,
      unitCost REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, batchId TEXT, batchNumber TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(entryId) REFERENCES manufacturing_entries(id) ON DELETE CASCADE,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id)
    );
    CREATE TABLE IF NOT EXISTS manufacturing_movements (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, entryId TEXT NOT NULL,
      movementNo TEXT NOT NULL, movementType TEXT NOT NULL,
      movementDate TEXT NOT NULL, itemId TEXT, quantity REAL NOT NULL DEFAULT 0,
      unitCost REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, batchId TEXT, batchNumber TEXT,
      godownId TEXT, notes TEXT, createdAt TEXT NOT NULL,
      FOREIGN KEY(firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY(entryId) REFERENCES manufacturing_entries(id) ON DELETE CASCADE,
      FOREIGN KEY(itemId) REFERENCES items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mfg_entries_firm_date ON manufacturing_entries(firmId,productionDate);
    CREATE INDEX IF NOT EXISTS idx_mfg_entry_items_entry ON manufacturing_entry_items(entryId);
    CREATE INDEX IF NOT EXISTS idx_mfg_entry_byproducts_entry ON manufacturing_entry_byproducts(entryId);
    CREATE INDEX IF NOT EXISTS idx_mfg_movements_firm_date ON manufacturing_movements(firmId,movementDate);
    CREATE INDEX IF NOT EXISTS idx_mfg_movements_entry ON manufacturing_movements(entryId);
  `);

  // Migration for databases created by v1.13.6.
  ensureColumn('manufacturing_boms', 'code', 'TEXT');
  ensureColumn('manufacturing_boms', 'version', "TEXT NOT NULL DEFAULT '1'");
  ensureColumn('manufacturing_boms', 'overheadCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_boms', 'machineryCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_boms', 'additionalCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_bom_items', 'operation', 'TEXT');
  ensureColumn('manufacturing_entries', 'totalByproductValue', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_entries', 'overheadCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_entries', 'machineryCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_entries', 'additionalCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_entries', 'netProductionCost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('manufacturing_entries', 'materialIssueNo', 'TEXT');
  ensureColumn('manufacturing_entries', 'materialReceiptNo', 'TEXT');
  ensureColumn('manufacturing_entries', 'batchNumber', 'TEXT');
  ensureColumn('manufacturing_entries', 'finishedBatchId', 'TEXT');
  ensureColumn('manufacturing_entries', 'expiryMonth', 'INTEGER');
  ensureColumn('manufacturing_entries', 'expiryYear', 'INTEGER');
  ensureColumn('manufacturing_entry_byproducts', 'batchId', 'TEXT');
  ensureColumn('manufacturing_entry_byproducts', 'batchNumber', 'TEXT');
  ensureColumn('manufacturing_movements', 'batchId', 'TEXT');
  ensureColumn('manufacturing_movements', 'batchNumber', 'TEXT');
  ensureColumn('manufacturing_entries', 'operatorName', 'TEXT');
}
ensureSchema();

function defaultGodown(firmId: string) {
  const g: any = db.prepare("SELECT id FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC,name ASC LIMIT 1").get(firmId);
  return g?.id || null;
}

function storeQty(firmId: string, itemId: string, godownId: string | null) {
  if (!godownId) return n((db.prepare('SELECT currentStock FROM items WHERE id=? AND firmId=?').get(itemId, firmId) as any)?.currentStock);
  return n((db.prepare('SELECT quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=?').get(firmId, itemId, godownId) as any)?.quantity);
}

function adjustStock(firmId: string, itemId: string, delta: number, godownId: string | null, allowNegative = false) {
  const item: any = db.prepare('SELECT id,name,currentStock,decimalEnabled FROM items WHERE id=? AND firmId=? AND isActive=1').get(itemId, firmId);
  if (!item) throw new Error(`Item not found or inactive: ${itemId}`);
  const globalNext = n(item.currentStock) + delta;
  if (delta < 0 && !allowNegative && globalNext < -0.0001) {
    throw new Error(`Insufficient stock for ${item.name}. Available: ${n(item.currentStock)}, Required: ${Math.abs(delta)}`);
  }
  const ts = now();
  if (godownId) {
    const row: any = db.prepare('SELECT id,quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=?').get(firmId, itemId, godownId);
    const next = n(row?.quantity) + delta;
    if (delta < 0 && !allowNegative && next < -0.0001) {
      throw new Error(`Insufficient stock in selected store for ${item.name}. Available: ${n(row?.quantity)}, Required: ${Math.abs(delta)}`);
    }
    if (row) db.prepare('UPDATE inventory_stock SET quantity=?,updatedAt=? WHERE id=?').run(next, ts, row.id);
    else db.prepare('INSERT INTO inventory_stock(id,firmId,itemId,godownId,quantity,updatedAt) VALUES(?,?,?,?,?,?)').run(uid(), firmId, itemId, godownId, next, ts);
  }
  db.prepare('UPDATE items SET currentStock=?,updatedAt=? WHERE id=? AND firmId=?').run(globalNext, ts, itemId, firmId);
}

function ensureManufacturingBatch(firmId: string, item: any, batchNumber: string, quantity: number, unitCost: number, godownId: string | null, productionDate: string, expiryMonth: any = null, expiryYear: any = null, explicitMfgDate: string | null = null, commercial: any = {}) {
  const batch = String(batchNumber || '').trim();
  if (!batch) throw new Error(`Manufacturing batch number is required for ${item.name}`);
  const em = normalizeExpiryMonth(expiryMonth);
  const ey = normalizeExpiryYear(expiryYear);
  if (em !== null && (em < 1 || em > 12)) throw new Error('Expiry month must be between 1 and 12');
  if (ey !== null && (ey < 2000 || ey > 2100)) throw new Error('Expiry year is invalid');
  if ((em === null) !== (ey === null)) throw new Error('Expiry Month and Expiry Year are both required for a manufacturing batch');
  const ts = now();
  const mrp = Math.max(0, n(commercial?.mrp, n(item?.mrp)));
  const sellingRate = Math.max(0, n(commercial?.sellingRate, n(item?.salePrice)));
  const schemeBuyQty = Math.max(0, n(commercial?.schemeBuyQty));
  const schemeFreeQty = Math.max(0, n(commercial?.schemeFreeQty));
  if ((schemeBuyQty > 0) !== (schemeFreeQty > 0)) throw new Error('Scheme Buy Qty and Free Qty must both be greater than zero, or both be zero');
  const existing: any = db.prepare('SELECT * FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=? LIMIT 1').get(firmId, item.id, batch);
  const rawMfg = String(explicitMfgDate || '').trim();
  const mfgMatch = rawMfg.match(/^(\d{1,2})\s*[/.-]\s*(\d{2}|\d{4})$/);
  const mfgIsoMatch = rawMfg.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  const mfgYear = mfgMatch ? (mfgMatch[2].length===2 ? 2000+Number(mfgMatch[2]) : Number(mfgMatch[2])) : null;
  const mfgMonth = mfgMatch ? Number(mfgMatch[1]) : (mfgIsoMatch ? Number(mfgIsoMatch[2]) : null);
  const mfgDate = (mfgMatch && mfgMonth && mfgYear) ? `${String(mfgMonth).padStart(2,'0')}/${mfgYear}`
    : (mfgIsoMatch ? `${mfgIsoMatch[2]}/${mfgIsoMatch[1]}` : (productionDate || new Date().toISOString().slice(0,10)));
  if (mfgMatch && (!mfgMonth || mfgMonth<1 || mfgMonth>12 || !mfgYear || mfgYear<2000 || mfgYear>2099)) throw new Error('Manufacturing date is invalid');
  if (existing) {
    db.prepare(`UPDATE inventory_batches SET quantity=COALESCE(quantity,0)+?, manufacturingRate=?, purchaseRate=CASE WHEN purchaseRate=0 THEN ? ELSE purchaseRate END, mrp=CASE WHEN ? > 0 THEN ? ELSE mrp END, sellingRate=CASE WHEN ? > 0 THEN ? ELSE sellingRate END, schemeBuyQty=CASE WHEN ? > 0 THEN ? ELSE schemeBuyQty END, schemeFreeQty=CASE WHEN ? > 0 THEN ? ELSE schemeFreeQty END, mfgDate=COALESCE(mfgDate,?), expiryMonth=COALESCE(?,expiryMonth), expiryYear=COALESCE(?,expiryYear), updatedAt=? WHERE id=?`).run(quantity, unitCost, unitCost, mrp, mrp, sellingRate, sellingRate, schemeBuyQty, schemeBuyQty, schemeFreeQty, schemeFreeQty, mfgDate, em, ey, ts, existing.id);
    return existing.id;
  }
  const id = uid();
  db.prepare(`INSERT INTO inventory_batches(id,firmId,itemId,batchNumber,expiryDate,expiryMonth,expiryYear,mfgDate,packing,purchaseRate,mrp,sellingRate,markup,manufacturingRate,schemeBuyQty,schemeFreeQty,quantity,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, firmId, item.id, batch, null, em, ey, mfgDate, item.packing || null, unitCost, mrp, sellingRate, 0, unitCost, schemeBuyQty, schemeFreeQty, quantity, ts, ts);
  return id;
}

function nextNo(firmId: string, prefix: string, table: string, column: string) {
  const row: any = db.prepare(`SELECT MAX(CAST(SUBSTR(${column},${prefix.length + 2}) AS INTEGER)) n FROM ${table} WHERE firmId=? AND ${column} LIKE ?`).get(firmId, `${prefix}-%`);
  return `${prefix}-${String(n(row?.n) + 1).padStart(4, '0')}`;
}

function movementNo(firmId: string, prefix: string) {
  return nextNo(firmId, prefix, 'manufacturing_movements', 'movementNo');
}

function itemForFirm(firmId: string, itemId: string, label: string) {
  const item: any = db.prepare('SELECT id,name,currentStock,purchasePrice,decimalEnabled,itemRole FROM items WHERE id=? AND firmId=? AND isActive=1 AND type=\'PRODUCT\'').get(itemId, firmId);
  if (!item) throw new Error(`${label} not found or inactive`);
  return item;
}

function validateGodown(firmId: string, godownId: string | null) {
  if (!godownId) return;
  const g = db.prepare('SELECT id FROM godowns WHERE id=? AND firmId=? AND COALESCE(isActive,1)=1').get(godownId, firmId);
  if (!g) throw new Error('Selected store/godown is not valid');
}

// ---------- Physical Stock ----------
router.get('/physical', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const godownId = String(req.query.godownId || '') || null;
    const search = String(req.query.search || '').trim();
    const params: any[] = [];
    const stockSql = godownId
      ? 'COALESCE((SELECT s.quantity FROM inventory_stock s WHERE s.firmId=i.firmId AND s.itemId=i.id AND s.godownId=?),0)'
      : 'COALESCE(i.currentStock,0)';
    if (godownId) params.push(godownId);
    params.push(firmId);
    let q = `SELECT i.id,i.name,i.itemCode,i.sku,i.barcode,i.currentStock,u.shortName unitName,${stockSql} bookQty
      FROM items i LEFT JOIN units u ON u.id=i.unitId WHERE i.firmId=? AND i.type='PRODUCT' AND i.isActive=1`;
    if (search) { q += ' AND (i.name LIKE ? OR i.itemCode LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)'; const t = `%${search}%`; params.push(t, t, t, t); }
    q += ' ORDER BY i.name ASC LIMIT 2000';
    const rows: any[] = db.prepare(q).all(...params).map((r: any) => ({ ...r, bookQty: n(r.bookQty), actualQty: n(r.bookQty), differenceQty: 0 }));
    const stores = db.prepare("SELECT id,name,isDefault FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC,name ASC").all(firmId);
    const sessions = db.prepare(`SELECT p.*,g.name godownName,(SELECT COUNT(*) FROM physical_stock_items pi WHERE pi.sessionId=p.id) lineCount
      FROM physical_stock_sessions p LEFT JOIN godowns g ON g.id=p.godownId WHERE p.firmId=? ORDER BY p.sessionDate DESC,p.createdAt DESC LIMIT 100`).all(firmId);
    res.json({ success: true, data: { rows, stores, selectedGodownId: godownId, sessions } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/physical', (req: Request, res: Response) => {
  try {
    const { firmId, sessionDate, referenceNo, notes = '', godownId, items = [] } = req.body || {};
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required' });
    const gid = godownId || defaultGodown(String(firmId));
    validateGodown(String(firmId), gid);
    const tx = db.transaction(() => {
      const id = uid(), ts = now();
      const ref = String(referenceNo || nextNo(String(firmId), 'PHY', 'physical_stock_sessions', 'referenceNo'));
      db.prepare(`INSERT INTO physical_stock_sessions(id,firmId,godownId,sessionDate,referenceNo,notes,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, firmId, gid, sessionDate || new Date().toISOString().slice(0, 10), ref, notes || null, 'posted', ts, ts);
      const ins = db.prepare(`INSERT INTO physical_stock_items(id,sessionId,firmId,itemId,bookQty,actualQty,differenceQty,createdAt) VALUES(?,?,?,?,?,?,?,?)`);
      let changed = 0;
      for (const line of items) {
        const item: any = itemForFirm(String(firmId), line.itemId, 'Item');
        const book = storeQty(String(firmId), item.id, gid);
        const actual = nonNegative(line.actualQty, `Actual quantity for ${item.name}`);
        assertItemQuantityPrecision(item, actual, 'Physical stock');
        const diff = actual - book;
        ins.run(uid(), id, firmId, item.id, book, actual, diff, ts);
        if (Math.abs(diff) > 0.0000001) { adjustStock(String(firmId), item.id, diff, gid, false); changed++; }
      }
      return { id, referenceNo: ref, adjustedLines: changed };
    });
    res.status(201).json({ success: true, data: tx() });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/physical/:id', (req: Request, res: Response) => {
  try {
    const h: any = db.prepare('SELECT p.*,g.name godownName FROM physical_stock_sessions p LEFT JOIN godowns g ON g.id=p.godownId WHERE p.id=?').get(req.params.id);
    if (!h) return res.status(404).json({ error: 'Physical stock session not found' });
    h.items = db.prepare('SELECT pi.*,i.name itemName,i.itemCode,u.shortName unitName FROM physical_stock_items pi JOIN items i ON i.id=pi.itemId LEFT JOIN units u ON u.id=i.unitId WHERE pi.sessionId=? ORDER BY i.name').all(h.id);
    res.json({ success: true, data: h });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------- Manufacturing / BOM ----------
router.get('/manufacturing/boms', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const boms: any[] = db.prepare(`SELECT b.*,i.name finishedItemName,i.itemCode finishedItemCode,u.shortName finishedUnitName
      FROM manufacturing_boms b JOIN items i ON i.id=b.finishedItemId LEFT JOIN units u ON u.id=i.unitId
      WHERE b.firmId=? AND b.isActive=1 ORDER BY b.name,b.version`).all(firmId);
    for (const b of boms) {
      b.components = db.prepare(`SELECT bi.*,i.name itemName,i.itemRole,i.purchasePrice,u.shortName unitName
        FROM manufacturing_bom_items bi JOIN items i ON i.id=bi.itemId LEFT JOIN units u ON u.id=i.unitId WHERE bi.bomId=? ORDER BY bi.createdAt`).all(b.id);
      b.byproducts = db.prepare(`SELECT bp.*,i.name itemName,i.itemRole,u.shortName unitName
        FROM manufacturing_bom_byproducts bp JOIN items i ON i.id=bp.itemId LEFT JOIN units u ON u.id=i.unitId WHERE bp.bomId=? ORDER BY bp.createdAt`).all(b.id);
    }
    const itemSelect = `SELECT i.id,i.name,i.itemCode,i.currentStock,i.purchasePrice,i.itemRole,i.decimalEnabled,u.shortName unitName
      FROM items i LEFT JOIN units u ON u.id=i.unitId WHERE i.firmId=? AND i.isActive=1 AND i.type='PRODUCT'`;
    const items = db.prepare(`${itemSelect} ORDER BY i.name`).all(firmId);
    // Keep role-specific inventories explicit at the API boundary. This prevents
    // the production UI from accidentally mixing finished goods into material
    // issue selection, even if a caller also receives the complete item list.
    const rawItems = db.prepare(`${itemSelect} AND i.itemRole='RAW_MATERIAL' ORDER BY i.name`).all(firmId);
    const finishedItems = db.prepare(`${itemSelect} AND i.itemRole='FINISHED_GOOD' ORDER BY i.name`).all(firmId);
    const byproductItems = db.prepare(`${itemSelect} AND i.itemRole IN ('FINISHED_GOOD','BY_PRODUCT','SEMI_FINISHED') ORDER BY i.name`).all(firmId);
    const stores = db.prepare("SELECT id,name,isDefault FROM godowns WHERE firmId=? AND COALESCE(isActive,1)=1 ORDER BY isDefault DESC,name").all(firmId);
    res.json({ success: true, data: { boms, items, rawItems, finishedItems, byproductItems, stores } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/manufacturing/boms', (req: Request, res: Response) => {
  try {
    const { firmId, code, name, version = '1', finishedItemId, outputQty = 1, overheadCost = 0, machineryCost = 0, additionalCost = 0, notes = '', components = [], byproducts = [] } = req.body || {};
    if (!firmId || !String(name || '').trim() || !finishedItemId) return res.status(400).json({ error: 'BOM name and finished item are required' });
    const outQty = positive(outputQty, 'BOM output quantity');
    const bomOverhead = nonNegative(overheadCost, 'BOM overhead cost');
    const bomMachinery = nonNegative(machineryCost, 'BOM machinery cost');
    const bomAdditional = nonNegative(additionalCost === '' || additionalCost === null || additionalCost === undefined ? 0 : additionalCost, 'BOM additional cost');
    if (!Array.isArray(components) || !components.length) return res.status(400).json({ error: 'At least one raw material is required' });
    const tx = db.transaction(() => {
      const id = uid(), ts = now();
      const fg: any = itemForFirm(String(firmId), finishedItemId, 'Finished good');
      const bomCode = String(code || '').trim() || `BOM-${String(n((db.prepare('SELECT COUNT(*) c FROM manufacturing_boms WHERE firmId=?').get(firmId) as any)?.c) + 1).padStart(4, '0')}`;
      if (db.prepare('SELECT id FROM manufacturing_boms WHERE firmId=? AND code=?').get(firmId, bomCode)) throw new Error(`BOM code already exists: ${bomCode}`);
      db.prepare('UPDATE manufacturing_boms SET isActive=0,updatedAt=? WHERE firmId=? AND finishedItemId=? AND name=?').run(ts, firmId, finishedItemId, String(name).trim());
      db.prepare(`INSERT INTO manufacturing_boms(id,firmId,code,name,version,finishedItemId,outputQty,overheadCost,machineryCost,additionalCost,notes,isActive,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, firmId, bomCode, String(name).trim(), String(version || '1'), fg.id, outQty, bomOverhead, bomMachinery, bomAdditional, notes || null, 1, ts, ts);
      const ins = db.prepare('INSERT INTO manufacturing_bom_items(id,bomId,firmId,itemId,quantity,unitCost,scrapPercent,operation,createdAt) VALUES(?,?,?,?,?,?,?,?,?)');
      const seen = new Set<string>();
      for (const c of components) {
        const it: any = itemForFirm(String(firmId), c.itemId, 'Raw material');
        if (it.itemRole !== 'RAW_MATERIAL') throw new Error(`${it.name} is not marked as Raw Material in Item Master`);
        if (String(it.id) === String(fg.id)) throw new Error('Finished good cannot be its own raw material');
        if (seen.has(String(it.id))) throw new Error(`Duplicate raw material in BOM: ${it.name}`);
        seen.add(String(it.id));
        const qty = positive(c.quantity, `BOM quantity for ${it.name}`);
        const scrap = nonNegative(c.scrapPercent ?? 0, `Scrap % for ${it.name}`);
        if (scrap > 100) throw new Error(`Scrap % for ${it.name} cannot exceed 100`);
        assertItemQuantityPrecision(it, qty, 'BOM quantity');
        ins.run(uid(), id, firmId, it.id, qty, Math.max(0, n(c.unitCost, n(it.purchasePrice))), scrap, c.operation ? String(c.operation).trim() : null, ts);
      }
      const bpIns = db.prepare('INSERT INTO manufacturing_bom_byproducts(id,bomId,firmId,itemId,quantity,unitCost,notes,createdAt) VALUES(?,?,?,?,?,?,?,?)');
      const bpSeen = new Set<string>();
      for (const b of (Array.isArray(byproducts) ? byproducts : [])) {
        const it: any = itemForFirm(String(firmId), b.itemId, 'By-product');
        if (String(it.id) === String(fg.id)) throw new Error('Finished good should not also be a by-product');
        if (bpSeen.has(String(it.id))) throw new Error(`Duplicate by-product in BOM: ${it.name}`);
        bpSeen.add(String(it.id));
        const qty = positive(b.quantity, `By-product quantity for ${it.name}`);
        assertItemQuantityPrecision(it, qty, 'BOM by-product quantity');
        bpIns.run(uid(), id, firmId, it.id, qty, Math.max(0, n(b.unitCost, n(it.purchasePrice))), b.notes ? String(b.notes) : null, ts);
      }
      return { id, code: bomCode, version: String(version || '1') };
    });
    res.status(201).json({ success: true, data: tx() });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/manufacturing/preview', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    const bomId = String(req.query.bomId || '');
    const qty = positive(req.query.producedQty, 'Produced quantity');
    if (!firmId || !bomId) return res.status(400).json({ error: 'firmId and bomId are required' });
    const bom: any = db.prepare('SELECT * FROM manufacturing_boms WHERE id=? AND firmId=? AND isActive=1').get(bomId, firmId);
    if (!bom) return res.status(404).json({ error: 'Active BOM not found' });
    const scale = qty / Math.max(0.000001, n(bom.outputQty, 1));
    const components = db.prepare(`SELECT bi.*,i.name itemName,i.currentStock,i.purchasePrice,i.decimalEnabled,u.shortName unitName
      FROM manufacturing_bom_items bi JOIN items i ON i.id=bi.itemId LEFT JOIN units u ON u.id=i.unitId WHERE bi.bomId=? ORDER BY bi.createdAt`).all(bomId).map((c: any) => ({
        ...c, requiredQty: n(c.quantity) * scale * (1 + n(c.scrapPercent) / 100), availableQty: storeQty(firmId, c.itemId, String(req.query.godownId || '') || null), shortfallQty: Math.max(0, n(c.quantity) * scale * (1 + n(c.scrapPercent) / 100) - storeQty(firmId, c.itemId, String(req.query.godownId || '') || null))
      }));
    const byproducts = db.prepare(`SELECT bp.*,i.name itemName,u.shortName unitName FROM manufacturing_bom_byproducts bp JOIN items i ON i.id=bp.itemId LEFT JOIN units u ON u.id=i.unitId WHERE bp.bomId=?`).all(bomId).map((b: any) => ({ ...b, requiredQty: n(b.quantity) * scale }));
    res.json({ success: true, data: { bom, components, byproducts, canIssue: components.every((c: any) => c.shortfallQty <= 0.0001) } });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/manufacturing/entries', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const rows: any[] = db.prepare(`SELECT m.*,b.name bomName,b.code bomCode,i.name finishedItemName,g.name godownName
      FROM manufacturing_entries m LEFT JOIN manufacturing_boms b ON b.id=m.bomId JOIN items i ON i.id=m.finishedItemId LEFT JOIN godowns g ON g.id=m.godownId
      WHERE m.firmId=? ORDER BY m.productionDate DESC,m.createdAt DESC LIMIT 300`).all(firmId);
    for (const r of rows) {
      r.materials = db.prepare(`SELECT me.*,i.name itemName,u.shortName unitName FROM manufacturing_entry_items me JOIN items i ON i.id=me.itemId LEFT JOIN units u ON u.id=i.unitId WHERE me.entryId=? ORDER BY me.createdAt`).all(r.id);
      r.byproducts = db.prepare(`SELECT mb.*,i.name itemName,u.shortName unitName FROM manufacturing_entry_byproducts mb JOIN items i ON i.id=mb.itemId LEFT JOIN units u ON u.id=i.unitId WHERE mb.entryId=? ORDER BY mb.createdAt`).all(r.id);
    }
    res.json({ success: true, data: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/manufacturing/entries/:id', (req: Request, res: Response) => {
  try {
    const entry: any = db.prepare(`SELECT m.*,b.name bomName,b.code bomCode,i.name finishedItemName,g.name godownName
      FROM manufacturing_entries m LEFT JOIN manufacturing_boms b ON b.id=m.bomId JOIN items i ON i.id=m.finishedItemId LEFT JOIN godowns g ON g.id=m.godownId WHERE m.id=?`).get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Production entry not found' });
    entry.materials = db.prepare(`SELECT me.*,i.name itemName,u.shortName unitName FROM manufacturing_entry_items me JOIN items i ON i.id=me.itemId LEFT JOIN units u ON u.id=i.unitId WHERE me.entryId=? ORDER BY me.createdAt`).all(entry.id);
    entry.byproducts = db.prepare(`SELECT mb.*,i.name itemName,u.shortName unitName FROM manufacturing_entry_byproducts mb JOIN items i ON i.id=mb.itemId LEFT JOIN units u ON u.id=i.unitId WHERE mb.entryId=? ORDER BY mb.createdAt`).all(entry.id);
    entry.movements = db.prepare(`SELECT mm.*,i.name itemName,u.shortName unitName FROM manufacturing_movements mm LEFT JOIN items i ON i.id=mm.itemId LEFT JOIN units u ON u.id=i.unitId WHERE mm.entryId=? ORDER BY mm.createdAt`).all(entry.id);
    res.json({ success: true, data: entry });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/manufacturing/movements', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const type = String(req.query.type || '').trim();
    const params: any[] = [firmId];
    let q = `SELECT mm.*,m.productionNo,i.name itemName,u.shortName unitName,g.name godownName
      FROM manufacturing_movements mm JOIN manufacturing_entries m ON m.id=mm.entryId LEFT JOIN items i ON i.id=mm.itemId
      LEFT JOIN units u ON u.id=i.unitId LEFT JOIN godowns g ON g.id=mm.godownId WHERE mm.firmId=?`;
    if (type) { q += ' AND mm.movementType=?'; params.push(type); }
    q += ' ORDER BY mm.movementDate DESC,mm.createdAt DESC LIMIT 500';
    res.json({ success: true, data: db.prepare(q).all(...params) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/manufacturing/entries', (req: Request, res: Response) => {
  try {
    const {
      firmId, productionDate, finishedItemId, bomId, plannedQty = 0, producedQty,
      wastageQty = 0, overheadCost = null, machineryCost = null, additionalCost = 0, godownId, notes = '', materials = [],
      byproducts = [], batchNumber = '', mfgDate = '', expiryMonth = null, expiryYear = null, operatorName = '',
      mrp = 0, sellingRate = 0, schemeBuyQty = 0, schemeFreeQty = 0
    } = req.body || {};
    if (!firmId || !finishedItemId) return res.status(400).json({ error: 'Finished good is required' });
    const out = positive(producedQty, 'Produced quantity');
    const pq = nonNegative(plannedQty, 'Planned quantity');
    const waste = nonNegative(wastageQty, 'Wastage / loss quantity');
    const manualExtra = nonNegative(additionalCost === '' || additionalCost === null || additionalCost === undefined ? 0 : additionalCost, 'Additional cost');
    const gid = godownId || defaultGodown(String(firmId));
    validateGodown(String(firmId), gid);

    const tx = db.transaction(() => {
      const ts = now(), id = uid();
      const prodNo = nextNo(String(firmId), 'PROD', 'manufacturing_entries', 'productionNo');
      const manufacturingBatchNumber = String(batchNumber || '').trim() || `MFG-${prodNo}`;
      const issueNo = movementNo(String(firmId), 'MI');
      const receiptNo = movementNo(String(firmId), 'MR');
      const fg: any = itemForFirm(String(firmId), finishedItemId, 'Finished good');
      assertItemQuantityPrecision(fg, out, 'Produced quantity');

      let bom: any = null;
      let componentRows: any[] = [];
      let bomByproducts: any[] = [];
      if (bomId) {
        bom = db.prepare('SELECT * FROM manufacturing_boms WHERE id=? AND firmId=? AND isActive=1').get(bomId, firmId);
        if (!bom) throw new Error('Active BOM not found');
        if (String(bom.finishedItemId) !== String(finishedItemId)) throw new Error('Selected BOM does not belong to this finished good');
        const scale = out / Math.max(0.000001, n(bom.outputQty, 1));
        componentRows = db.prepare(`SELECT bi.*,i.name itemName,i.currentStock,i.purchasePrice,i.decimalEnabled FROM manufacturing_bom_items bi JOIN items i ON i.id=bi.itemId WHERE bi.bomId=? ORDER BY bi.createdAt`).all(bomId).map((c: any) => ({
          ...c,
          requiredQty: n(c.quantity) * scale * (1 + n(c.scrapPercent) / 100)
        }));
        bomByproducts = db.prepare(`SELECT bp.*,i.name itemName,i.currentStock,i.decimalEnabled FROM manufacturing_bom_byproducts bp JOIN items i ON i.id=bp.itemId WHERE bp.bomId=? ORDER BY bp.createdAt`).all(bomId).map((b: any) => ({ ...b, requiredQty: n(b.quantity) * scale }));
      }

      const providedMaterials = Array.isArray(materials) ? materials : [];
      const lines = componentRows.length
        ? componentRows.map((c: any) => {
            const p = providedMaterials.find((x: any) => String(x.itemId) === String(c.itemId));
            const consumedQty = p && p.consumedQty !== undefined ? nonNegative(p.consumedQty, `Consumed quantity for ${c.itemName}`) : c.requiredQty;
            return { itemId: c.itemId, itemName: c.itemName, requiredQty: c.requiredQty, consumedQty, unitCost: Math.max(0, n(p?.unitCost, n(c.unitCost, n(c.purchasePrice)))) };
          })
        : providedMaterials.map((p: any) => ({
            itemId: p.itemId, itemName: p.itemName, requiredQty: nonNegative(p.requiredQty || 0, `Required quantity for ${p.itemName || p.itemId}`),
            consumedQty: nonNegative(p.consumedQty || 0, `Consumed quantity for ${p.itemName || p.itemId}`), unitCost: Math.max(0, n(p.unitCost))
          }));
      if (!lines.length) throw new Error('Add a BOM or at least one raw material');

      const bpLines = bomByproducts.length
        ? bomByproducts.map((b: any) => {
            const p = (Array.isArray(byproducts) ? byproducts : []).find((x: any) => String(x.itemId) === String(b.itemId));
            const receivedQty = p && p.receivedQty !== undefined ? nonNegative(p.receivedQty, `By-product quantity for ${b.itemName}`) : b.requiredQty;
            return { itemId: b.itemId, itemName: b.itemName, requiredQty: b.requiredQty, receivedQty, unitCost: Math.max(0, n(p?.unitCost, n(b.unitCost, n(b.purchasePrice)))) };
          })
        : (Array.isArray(byproducts) ? byproducts : []).map((p: any) => ({
            itemId: p.itemId, itemName: p.itemName, requiredQty: nonNegative(p.requiredQty || 0, `Required by-product quantity for ${p.itemName || p.itemId}`),
            receivedQty: nonNegative(p.receivedQty || 0, `Received by-product quantity for ${p.itemName || p.itemId}`), unitCost: Math.max(0, n(p.unitCost))
          }));

      const cleanLines: any[] = [];
      let materialCost = 0;
      for (const l of lines) {
        const it: any = itemForFirm(String(firmId), l.itemId, 'Raw material');
        if (it.itemRole !== 'RAW_MATERIAL') throw new Error(`${it.name} is not marked as Raw Material in Item Master`);
        if (String(it.id) === String(fg.id)) throw new Error('Finished good cannot be consumed as its own raw material');
        if (l.consumedQty <= 0) throw new Error(`Consumed quantity must be greater than zero for ${it.name}`);
        assertItemQuantityPrecision(it, l.consumedQty, 'Consumed quantity');
        const amount = l.consumedQty * l.unitCost;
        materialCost += amount;
        cleanLines.push({ ...l, itemName: it.name, unitCost: l.unitCost, amount });
      }

      const cleanByproducts: any[] = [];
      let byproductValue = 0;
      for (const b of bpLines) {
        if (b.receivedQty <= 0) continue;
        const it: any = itemForFirm(String(firmId), b.itemId, 'By-product');
        if (String(it.id) === String(fg.id)) throw new Error('Finished good should not be received as a by-product');
        assertItemQuantityPrecision(it, b.receivedQty, 'By-product quantity');
        const amount = b.receivedQty * b.unitCost;
        byproductValue += amount;
        cleanByproducts.push({ ...b, itemName: it.name, amount });
      }

      // Preflight all stock and item validations BEFORE changing anything.
      // Manufacturing follows the firm's Allow Negative Stock policy. When the
      // policy is enabled, raw-material issue is allowed to take stock below zero.
      // When disabled, the production is blocked before any stock is changed.
      const allowNegativeManufacturing = isNegativeStockAllowed(String(firmId));
      for (const l of cleanLines) {
        const available = storeQty(String(firmId), l.itemId, gid);
        if (!allowNegativeManufacturing && available + 0.0001 < l.consumedQty) {
          throw new Error(`Insufficient stock for ${l.itemName}. Available: ${available}, Required: ${l.consumedQty}`);
        }
      }

      const overhead = nonNegative(overheadCost ?? (bom ? bom.overheadCost : 0), 'Overhead cost');
      const machinery = nonNegative(machineryCost ?? (bom ? bom.machineryCost : 0), 'Machinery cost');
      const bomExtra = bom ? nonNegative(bom.additionalCost, 'BOM additional cost') : 0;
      const extra = bom ? bomExtra + manualExtra : manualExtra;
      const grossCost = materialCost + overhead + machinery + extra;
      if (byproductValue > grossCost + 0.0001) throw new Error('By-product value cannot exceed total production cost');
      const netCost = grossCost - byproductValue;
      const effective = netCost / out;
      const finishedExpiryMonth = normalizeExpiryMonth(expiryMonth);
      const finishedExpiryYear = normalizeExpiryYear(expiryYear);
      if ((finishedExpiryMonth === null) !== (finishedExpiryYear === null)) throw new Error('Expiry Month and Expiry Year are both required for a manufacturing batch');
      const finishedBatchId = ensureManufacturingBatch(String(firmId), fg, manufacturingBatchNumber, out, effective, gid, productionDate || new Date().toISOString().slice(0,10), finishedExpiryMonth, finishedExpiryYear, mfgDate || null, { mrp, sellingRate, schemeBuyQty, schemeFreeQty });
      const movementInsert = db.prepare(`INSERT INTO manufacturing_movements(id,firmId,entryId,movementNo,movementType,movementDate,itemId,quantity,unitCost,amount,batchId,batchNumber,godownId,notes,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      db.prepare(`INSERT INTO manufacturing_entries(id,firmId,productionNo,productionDate,bomId,finishedItemId,plannedQty,producedQty,wastageQty,overheadCost,machineryCost,additionalCost,totalMaterialCost,totalByproductValue,netProductionCost,effectiveCost,materialIssueNo,materialReceiptNo,batchNumber,finishedBatchId,expiryMonth,expiryYear,operatorName,godownId,notes,status,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, firmId, prodNo, productionDate || new Date().toISOString().slice(0, 10), bomId || null, finishedItemId, pq, out, waste, overhead, machinery, extra,
        materialCost, byproductValue, netCost, effective, issueNo, receiptNo, manufacturingBatchNumber, finishedBatchId, finishedExpiryMonth, finishedExpiryYear, operatorName || null, gid, notes || null, 'posted', ts, ts
      );

      const materialIns = db.prepare(`INSERT INTO manufacturing_entry_items(id,entryId,firmId,itemId,requiredQty,consumedQty,unitCost,amount,role,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const l of cleanLines) {
        adjustStock(String(firmId), l.itemId, -l.consumedQty, gid, allowNegativeManufacturing);
        materialIns.run(uid(), id, firmId, l.itemId, l.requiredQty, l.consumedQty, l.unitCost, l.amount, 'RAW_MATERIAL', ts);
        movementInsert.run(uid(), firmId, id, issueNo, 'ISSUE', productionDate || new Date().toISOString().slice(0, 10), l.itemId, -l.consumedQty, l.unitCost, l.amount, null, null, gid, `Material issue for ${prodNo}`, ts);
      }

      adjustStock(String(firmId), fg.id, out, gid, false);
      movementInsert.run(uid(), firmId, id, receiptNo, 'RECEIPT', productionDate || new Date().toISOString().slice(0, 10), fg.id, out, effective, out * effective, finishedBatchId, manufacturingBatchNumber, gid, `Finished good receipt for ${prodNo}`, ts);

      const bpIns = db.prepare(`INSERT INTO manufacturing_entry_byproducts(id,entryId,firmId,itemId,requiredQty,receivedQty,unitCost,amount,batchId,batchNumber,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      for (const b of cleanByproducts) {
        adjustStock(String(firmId), b.itemId, b.receivedQty, gid, false);
        const byproductBatchNumber = `${manufacturingBatchNumber}-BP-${String(cleanByproducts.indexOf(b)+1).padStart(2,'0')}`;
        const byproductBatchId = ensureManufacturingBatch(String(firmId), db.prepare('SELECT * FROM items WHERE id=? AND firmId=?').get(b.itemId, firmId) as any, byproductBatchNumber, b.receivedQty, b.unitCost, gid, productionDate || new Date().toISOString().slice(0,10));
        bpIns.run(uid(), id, firmId, b.itemId, b.requiredQty, b.receivedQty, b.unitCost, b.amount, byproductBatchId, byproductBatchNumber, ts);
        movementInsert.run(uid(), firmId, id, receiptNo, 'BY_PRODUCT_RECEIPT', productionDate || new Date().toISOString().slice(0, 10), b.itemId, b.receivedQty, b.unitCost, b.amount, byproductBatchId, byproductBatchNumber, gid, `By-product receipt for ${prodNo}`, ts);
      }

      if (waste > 0) movementInsert.run(uid(), firmId, id, prodNo, 'LOSS', productionDate || new Date().toISOString().slice(0, 10), null, waste, 0, 0, null, null, gid, `Production loss/wastage for ${prodNo}`, ts);
      if (extra > 0) movementInsert.run(uid(), firmId, id, prodNo, 'ADDITIONAL_COST', productionDate || new Date().toISOString().slice(0, 10), null, 0, 0, extra, null, null, gid, `Additional production cost for ${prodNo}`, ts);

      return {
        id, productionNo: prodNo, materialIssueNo: issueNo, materialReceiptNo: receiptNo, batchNumber: manufacturingBatchNumber, finishedBatchId,
        totalMaterialCost: materialCost, totalByproductValue: byproductValue, netProductionCost: netCost,
        effectiveCost: effective, overheadCost: overhead, machineryCost: machinery, bomAdditionalCost: bomExtra, manualAdditionalCost: manualExtra, rawMaterialLines: cleanLines.length, byproductLines: cleanByproducts.length
      };
    });
    res.status(201).json({ success: true, data: tx() });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/manufacturing/reports', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '');
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const boms: any[] = db.prepare(`SELECT b.id,b.code,b.name,b.version,b.outputQty,b.overheadCost,b.machineryCost,b.additionalCost,i.name finishedItemName,
      COALESCE((SELECT SUM(bi.quantity*(1+bi.scrapPercent/100)*bi.unitCost) FROM manufacturing_bom_items bi WHERE bi.bomId=b.id),0) materialCost,
      COALESCE((SELECT SUM(bp.quantity*bp.unitCost) FROM manufacturing_bom_byproducts bp WHERE bp.bomId=b.id),0) byproductValue
      FROM manufacturing_boms b JOIN items i ON i.id=b.finishedItemId WHERE b.firmId=? AND b.isActive=1 ORDER BY b.name`).all(firmId);
    const entries: any[] = db.prepare(`SELECT m.productionDate,m.productionNo,m.materialIssueNo,m.materialReceiptNo,i.name finishedItemName,m.producedQty,m.wastageQty,m.totalMaterialCost,m.totalByproductValue,m.overheadCost,m.machineryCost,m.additionalCost,m.netProductionCost,m.effectiveCost,m.godownId,g.name godownName
      FROM manufacturing_entries m JOIN items i ON i.id=m.finishedItemId LEFT JOIN godowns g ON g.id=m.godownId WHERE m.firmId=? ORDER BY m.productionDate DESC,m.createdAt DESC LIMIT 300`).all(firmId);
    const summary: any = db.prepare(`SELECT COUNT(*) productions,COALESCE(SUM(producedQty),0) producedQty,COALESCE(SUM(wastageQty),0) wastageQty,
      COALESCE(SUM(totalMaterialCost),0) materialCost,COALESCE(SUM(additionalCost),0) additionalCost,COALESCE(SUM(totalByproductValue),0) byproductValue,
      COALESCE(SUM(netProductionCost),0) netProductionCost FROM manufacturing_entries WHERE firmId=? AND status='posted'`).get(firmId);
    res.json({ success: true, data: { boms, entries, summary } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;



