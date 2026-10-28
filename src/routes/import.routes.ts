import { assertItemQuantityPrecision } from '../lib/quantityPolicy';
/**
 * Excel Import Routes — Items & Parties
 * POST /import/items/template   → download Excel template for items
 * POST /import/parties/template → download Excel template for parties
 * POST /import/items/preview    → parse + validate, return row results (no DB write)
 * POST /import/parties/preview  → parse + validate, return row results (no DB write)
 * POST /import/items/commit     → commit a validated preview to DB
 * POST /import/parties/commit   → commit a validated preview to DB
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { validateGSTIN, validateMobile } from '../lib/validators';
import { getModuleSettings } from '../lib/moduleSettings';
import { expiryFromLegacyDate, parseExpiryInput } from '../lib/batchExpiry';

const router = Router();
// Safe additive migration: keeps existing transaction quantities intact while allowing opening-stock imports to be re-run.
try { db.exec("ALTER TABLE inventory_batches ADD COLUMN openingQuantity REAL DEFAULT 0"); } catch {}
// Safe additive item-master migration for richer Excel imports. Existing item data is preserved.
try { db.exec("ALTER TABLE items ADD COLUMN mrp REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE items ADD COLUMN discount1 REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE items ADD COLUMN volumeDiscount REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE items ADD COLUMN mfgDate TEXT"); } catch {}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* ─── GSTIN rate slab lookup ────────────────────────────────────────────── */
const VALID_GST = ['0', '5', '18'];

/* ─── helper: coerce any cell value to a trimmed string ─────────────────── */
function cellStr(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}


/* Automatic master creation for Excel imports. Preview stays side-effect free; commit creates missing masters. */
function ensureUnit(firmId: string, rawName: string, now: string): string | null {
  const name = cellStr(rawName);
  if (!name) return null;
  const existing = db.prepare('SELECT id FROM units WHERE firmId=? AND (lower(shortName)=lower(?) OR lower(name)=lower(?)) LIMIT 1').get(firmId, name, name) as any;
  if (existing) return existing.id;
  const id = uuidv4();
  db.prepare('INSERT INTO units(id,firmId,name,shortName,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(id, firmId, name, name, now, now);
  return id;
}
function ensureItemCategory(firmId: string, rawName: string, now: string): string | null {
  const name = cellStr(rawName); if (!name) return null;
  const existing = db.prepare("SELECT id FROM categories WHERE firmId=? AND type='item' AND lower(name)=lower(?) LIMIT 1").get(firmId, name) as any;
  if (existing) return existing.id;
  const id = uuidv4();
  db.prepare("INSERT INTO categories(id,firmId,name,type,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(id, firmId, name, 'item', now, now);
  return id;
}
function ensureItemCompany(firmId: string, rawName: string, now: string): string | null {
  const name = cellStr(rawName); if (!name) return null;
  db.exec(`CREATE TABLE IF NOT EXISTS item_companies (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_item_companies_firm_name ON item_companies(firmId,name COLLATE NOCASE)');
  const existing = db.prepare('SELECT id FROM item_companies WHERE firmId=? AND lower(name)=lower(?) LIMIT 1').get(firmId, name) as any;
  if (existing) return existing.id;
  const id = uuidv4();
  db.prepare('INSERT INTO item_companies(id,firmId,name,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(id, firmId, name, now, now);
  return id;
}
function resolveOrCreateItemMasters(firmId: string, d: any, now: string) {
  const unitId = d.unit1Short ? ensureUnit(firmId, d.unit1Short, now) : null;
  const secondaryUnitId = d.unit2Short ? ensureUnit(firmId, d.unit2Short, now) : null;
  const categoryId = d.catName ? ensureItemCategory(firmId, d.catName, now) : null;
  const companyId = d.companyName ? ensureItemCompany(firmId, d.companyName, now) : null;
  if (secondaryUnitId && unitId && secondaryUnitId === unitId) throw new Error(`Unit 1 and Unit 2 must be different for item "${d.name}"`);
  if (d.unit2Short && (!d.convFactor || Number(d.convFactor) <= 0)) throw new Error(`Unit Conversion must be > 0 when Unit 2 is specified for item "${d.name}"`);
  return { unitId, secondaryUnitId, categoryId, companyId };
}

/* ─── ITEMS TEMPLATE ────────────────────────────────────────────────────── */
router.get('/items/template', (_req: Request, res: Response) => {
  try {
    const wb = XLSX.utils.book_new();
    // Keep the import order aligned with the Item Master form. Only Item Name is mandatory;
    // all other master attributes are optional. This makes legacy/simple imports safe.
    const headers = [
      'Item Code', 'Barcode', 'Item Name*', 'Unit 1', 'Unit 2',
      'Unit Conversion (Unit 2 = how many Unit 1)', 'HSN Code', 'GST Rate (%)',
      'MRP', 'Selling Rate', 'Discount %', 'Discount 1 %', 'Volume Discount %',
      'Purchase Rate', 'Purchase Tax Inclusive (YES/NO)', 'Sale Tax Inclusive (YES/NO)',
      'Type (PRODUCT/SERVICE)', 'Category Name', 'Min Stock Level', 'Opening Stock',
      'Storage Location', 'Packing', 'Batch Number', 'MFG Date', 'Expiry Date', 'Description', 'Company Name'
    ];
    const sample = [
      'ITEM-001', '8901234567890', 'Basmati Rice 5kg', 'KG', 'BAG',
      '5', '1006', '5', '450', '430', '5', '2', '3',
      '380', 'NO', 'NO', 'PRODUCT', 'Grocery', '10', '100',
      'Shelf A-1', '5 KG', 'B240901', '2026-09-01', '2027-09-01', 'Premium brand', 'B-MAX Demo Company'
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    ws['!cols'] = headers.map((h) => ({ wch: Math.max(18, Math.min(38, h.length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, 'Items');

    const instr = [
      ['B-MAX — Items Import Template'],
      [''],
      ['REQUIRED: Item Name only.'],
      ['Optional: Item Code, Barcode, Unit 1, Unit 2, HSN, GST, MRP, Selling Rate, discounts, purchase rate, packing, batch and dates.'],
      ['Unit 1 and Unit 2 are unit-of-measure fields; they are NOT mandatory. Unit 1 may be PCS, Number, Kilogram, Box, etc. If Unit 2 is supplied, Unit Conversion must be greater than 0. Missing Unit, Category and Company masters are created automatically during commit.'],
      ['GST Rate (%) currently accepts 0, 5 or 18.'],
      ['Discount %, Discount 1 % and Volume Discount % are optional percentages from 0 to 100. They are stored on the item master for use by later billing/rate enhancements.'],
      ['MRP and Selling Rate are optional numeric rates.'],
      ['Batch Number, Packing, MFG Date and Expiry Date are optional. Batch-specific data is used only when batch tracking is enabled/configured.'],
      ['Existing item codes remain subject to the current duplicate-code setting.'],
      ['The importer matches existing items by Item Name as before; the overwrite checkbox controls updates.'],
      ['Missing Unit 1, Unit 2, Category Name and Company Name masters are created automatically during commit.'],
      ['Do NOT change column headers. Remove the Instructions sheet only if desired; the importer ignores it automatically.'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(instr);
    ws2['!cols'] = [{ wch: 115 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="bmax_items_import_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ─── PARTIES TEMPLATE ──────────────────────────────────────────────────── */
router.get('/parties/template', (_req: Request, res: Response) => {
  try {
    const wb = XLSX.utils.book_new();
    const headers = [
      'Name*', 'Type* (customer/supplier/both)', 'Phone', 'Email',
      'GSTIN', 'PAN', 'Address', 'City', 'State', 'Pincode',
      'Credit Limit', 'Opening Balance'
    ];
    const sample = [
      'Ramesh Traders', 'customer', '9876543210', 'ramesh@example.com',
      '22AAAAA0000A1Z5', 'AAAAA0000A', '123 Market Road', 'Mumbai', 'Maharashtra', '400001',
      '50000', '0'
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    ws['!cols'] = headers.map(() => ({ wch: 26 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Parties');

    const instr = [
      ['B-MAX — Parties Import Template'],
      [''],
      ['INSTRUCTIONS:'],
      ['1. Columns marked * are required.'],
      ['2. Type must be: customer, supplier, or both.'],
      ['3. Phone: 10-digit Indian mobile (optional).'],
      ['4. GSTIN: 15-character standard format (optional).'],
      ['5. State must match B-MAX state list exactly.'],
      ['6. Do NOT change column headers.'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(instr);
    ws2['!cols'] = [{ wch: 70 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Instructions');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="bmax_parties_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/* ─── ITEMS PREVIEW ─────────────────────────────────────────────────────── */
router.post('/items/preview', upload.single('file'), (req: Request, res: Response) => {
  try {
    const { firmId } = req.body;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    if (!req.file) return res.status(400).json({ error: 'Excel file required' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    // Use the first sheet that isn't "Instructions"
    const sheetName = wb.SheetNames.find(n => n.toLowerCase() !== 'instructions') || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (rows.length < 2) return res.json({ success: true, data: { rows: [], summary: { total: 0, ok: 0, errors: 0 } } });

    // Load lookup tables
    const units = db.prepare('SELECT id, shortName FROM units WHERE firmId = ?').all(firmId) as any[];
    const categories = db.prepare('SELECT id, name FROM categories WHERE firmId = ? AND type = ?').all(firmId, 'item') as any[];
    const existingItems = db.prepare('SELECT name, itemCode FROM items WHERE firmId = ? AND isActive = 1').all(firmId) as any[];

    const unitMap: Record<string, string> = {};
    for (const u of units) unitMap[u.shortName.trim().toUpperCase()] = u.id;

    const catMap: Record<string, string> = {};
    for (const c of categories) catMap[c.name.trim().toLowerCase()] = c.id;

    const existingCodes = new Set(existingItems.map((i: any) => (i.itemCode || '').trim().toLowerCase()).filter(Boolean));
    const allowDuplicateCodeRow = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId=? AND settingType='items' AND settingKey='allowDuplicateItemCode'").get(firmId) as any;
    const allowDuplicateItemCode = String(allowDuplicateCodeRow?.settingValue) === 'true';

    const headers = (rows[0] || []).map((v: any) => cellStr(v).toLowerCase());
    // Backward compatibility: accept the previous B-MAX item template as well as the new one.
    const isLegacyTemplate = headers[0] === 'name*' || headers[0] === 'name';
    const dataRows = rows.slice(1); // skip header
    const results: any[] = [];
    let ok = 0, errors = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2; // 1-based, header=1
      const errs: string[] = [];

      let itemCode='', barcode='', name='', unit1Short='', unit2Short='', hsnCode='', taxRate='0',
          mrp=0, salePrice=0, saleDiscount=0, discount1=0, volumeDiscount=0, purPrice=0,
          purTaxInc=0, saleTaxInc=0, type='PRODUCT', catName='', minStock=0, openStock=0,
          location='', packing='', batchNumber='', mfgDate='', expiryDate='', description='', companyName='', convFactor=0;
      if (isLegacyTemplate) {
        name=cellStr(row[0]); type=cellStr(row[1]).toUpperCase()||'PRODUCT'; hsnCode=cellStr(row[2]); itemCode=cellStr(row[3]);
        catName=cellStr(row[4]); unit1Short=cellStr(row[5]).toUpperCase(); unit2Short=cellStr(row[6]).toUpperCase(); convFactor=parseFloat(cellStr(row[7]))||0;
        salePrice=parseFloat(cellStr(row[8]))||0; saleTaxInc=cellStr(row[9]).toUpperCase()==='YES'?1:0; purPrice=parseFloat(cellStr(row[10]))||0;
        purTaxInc=cellStr(row[11]).toUpperCase()==='YES'?1:0; taxRate=cellStr(row[12])||'0'; openStock=parseFloat(cellStr(row[13]))||0;
        minStock=parseFloat(cellStr(row[14]))||0; location=cellStr(row[15]); description=cellStr(row[16]);
      } else {
        itemCode=cellStr(row[0]); barcode=cellStr(row[1]); name=cellStr(row[2]); unit1Short=cellStr(row[3]).toUpperCase(); unit2Short=cellStr(row[4]).toUpperCase();
        convFactor=parseFloat(cellStr(row[5]))||0; hsnCode=cellStr(row[6]); taxRate=cellStr(row[7])||'0'; mrp=parseFloat(cellStr(row[8]))||0; salePrice=parseFloat(cellStr(row[9]))||0;
        saleDiscount=parseFloat(cellStr(row[10]))||0; discount1=parseFloat(cellStr(row[11]))||0; volumeDiscount=parseFloat(cellStr(row[12]))||0; purPrice=parseFloat(cellStr(row[13]))||0;
        purTaxInc=cellStr(row[14]).toUpperCase()==='YES'?1:0; saleTaxInc=cellStr(row[15]).toUpperCase()==='YES'?1:0; type=cellStr(row[16]).toUpperCase()||'PRODUCT';
        catName=cellStr(row[17]); minStock=parseFloat(cellStr(row[18]))||0; openStock=parseFloat(cellStr(row[19]))||0; location=cellStr(row[20]); packing=cellStr(row[21]);
        batchNumber=cellStr(row[22]); mfgDate=cellStr(row[23]); expiryDate=cellStr(row[24]); description=cellStr(row[25]); companyName=cellStr(row[26]);
      }

      // Skip completely empty rows
      if (!name && !unit1Short && !cellStr(row[8])) continue;

      // Validations
      if (!name) errs.push('Name is required');
      if (!['PRODUCT', 'SERVICE'].includes(type)) errs.push(`Type must be PRODUCT or SERVICE (got "${type}")`);
      if (itemCode && existingCodes.has(itemCode.toLowerCase()) && !allowDuplicateItemCode) errs.push(`Item code "${itemCode}" already exists`);
      if (salePrice < 0) errs.push('Selling Rate cannot be negative');
      if (mrp < 0) errs.push('MRP cannot be negative');
      for (const [label, value] of [['Discount %', saleDiscount], ['Discount 1 %', discount1], ['Volume Discount %', volumeDiscount]] as const) { if (value < 0 || value > 100) errs.push(`${label} must be between 0 and 100`); }
      if (!VALID_GST.includes(taxRate)) errs.push(`GST Rate must be 0, 5, or 18 (got "${taxRate}")`);

      let unitId: string | undefined = unit1Short ? unitMap[unit1Short] : undefined;
      let secondaryUnitId: string | undefined = unit2Short ? unitMap[unit2Short] : undefined;
      let categoryId: string | undefined = catName ? catMap[catName.toLowerCase()] : undefined;
      const companyRows = db.prepare('SELECT id,name FROM item_companies WHERE firmId=?').all(firmId) as any[];
      const companyMap: Record<string,string> = {};
      for (const c of companyRows) companyMap[String(c.name).trim().toLowerCase()] = c.id;
      const companyId: string | undefined = companyName ? companyMap[companyName.toLowerCase()] : undefined;
      if (secondaryUnitId && secondaryUnitId === unitId) errs.push('Unit 1 and Unit 2 must be different');
      if (unit2Short && (!convFactor || convFactor <= 0)) errs.push('Unit Conversion must be > 0 when Unit 2 is specified');

      const status = errs.length === 0 ? 'ok' : 'error';
      if (status === 'ok') ok++; else errors++;

      results.push({
        rowNum, status, errors: errs,
        data: { name, type, hsnCode, itemCode, barcode, catName, unit1Short, unit2Short,
          convFactor, mrp, salePrice, saleDiscount, discount1, volumeDiscount, saleTaxInc,
          purPrice, purTaxInc, taxRate, openStock, minStock, location, packing, batchNumber,
          mfgDate, expiryDate, description, companyName, unitId, secondaryUnitId, categoryId, companyId, autoCreateMasters: { unit1: !!unit1Short && !unitId, unit2: !!unit2Short && !secondaryUnitId, category: !!catName && !categoryId, company: !!companyName && !companyId } }
      });
    }

    res.json({ success: true, data: { rows: results, summary: { total: results.length, ok, errors } } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── ITEMS COMMIT ──────────────────────────────────────────────────────── */
router.post('/items/commit', (req: Request, res: Response) => {
  try {
    const { firmId, rows, overwriteExisting = false } = req.body;
    if (!firmId || !Array.isArray(rows)) return res.status(400).json({ error: 'firmId and rows required' });

    const now = new Date().toISOString();
    let inserted = 0, updated = 0, skipped = 0;

    const insertStmt = db.prepare(`
      INSERT INTO items (id, firmId, name, type, hsnCode, itemCode, sku, barcode, description,
        categoryId, companyId, unitId, secondaryUnitId, conversionFactor,
        mrp, salePrice, salePriceTaxInclusive, saleDiscount, saleDiscountType, discount1, volumeDiscount,
        purchasePrice, purchasePriceTaxInclusive, taxRate, openingStock, currentStock, minStockLevel, location,
        packing, batchNumber, mfgDate, expiryDate,
        isActive, isFavorite, allowNegativeStock, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)
    `);

    const updateStmt = db.prepare(`
      UPDATE items SET type=?, hsnCode=?, itemCode=?, sku=?, barcode=?, description=?,
        categoryId=?, companyId=?, unitId=?, secondaryUnitId=?, conversionFactor=?,
        mrp=?, salePrice=?, salePriceTaxInclusive=?, saleDiscount=?, saleDiscountType=?,
        discount1=?, volumeDiscount=?, purchasePrice=?, purchasePriceTaxInclusive=?,
        taxRate=?, minStockLevel=?, location=?, packing=?, batchNumber=?, mfgDate=?, expiryDate=?, updatedAt=?
      WHERE firmId=? AND LOWER(name)=LOWER(?)
    `);

    const importRows = db.transaction(() => {
      for (const row of rows) {
        if (row.status !== 'ok') { skipped++; continue; }
        const d = row.data;
        const decimalEnabled = d.decimalEnabled === true || d.decimalEnabled === 1 || String(d.decimalEnabled||'').toLowerCase() === 'yes' ? 1 : 0;
        assertItemQuantityPrecision({name:d.name,decimalEnabled}, d.openingStock ?? 0, 'Opening stock');
        assertItemQuantityPrecision({name:d.name,decimalEnabled}, d.minStockLevel ?? 0, 'Minimum stock level');
        const masters = resolveOrCreateItemMasters(firmId, d, now);
        d.unitId = masters.unitId; d.secondaryUnitId = masters.secondaryUnitId; d.categoryId = masters.categoryId; d.companyId = masters.companyId;
        const existing = db.prepare('SELECT id FROM items WHERE firmId = ? AND LOWER(name) = LOWER(?)').get(firmId, d.name) as any;

        if (existing) {
          if (!overwriteExisting) { skipped++; continue; }
          updateStmt.run(
            d.type, d.hsnCode, d.itemCode, d.itemCode || null, d.barcode || null, d.description,
            d.categoryId || null, d.companyId || null, d.unitId || null, d.secondaryUnitId || null,
            d.secondaryUnitId ? (d.convFactor || 1) : 1,
            d.mrp, d.salePrice, d.saleTaxInc, d.saleDiscount, 'percentage', d.discount1, d.volumeDiscount,
            d.purPrice, d.purTaxInc, d.taxRate, d.minStock, d.location, d.packing || null, d.batchNumber || null,
            d.mfgDate || null, d.expiryDate || null, now,
            firmId, d.name
          );
          updated++;
        } else {
          insertStmt.run(
            uuidv4(), firmId, d.name, d.type, d.hsnCode, d.itemCode, d.itemCode || null, d.barcode || null, d.description,
            d.categoryId || null, d.companyId || null, d.unitId || null, d.secondaryUnitId || null,
            d.secondaryUnitId ? (d.convFactor || 1) : 1,
            d.mrp, d.salePrice, d.saleTaxInc, d.saleDiscount, 'percentage', d.discount1, d.volumeDiscount,
            d.purPrice, d.purTaxInc, d.taxRate, d.openStock, d.openStock, d.minStock, d.location,
            d.packing || null, d.batchNumber || null, d.mfgDate || null, d.expiryDate || null,
            now, now
          );
          inserted++;
        }
      }
    });

    importRows();
    res.json({ success: true, data: { inserted, updated, skipped } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── PARTIES PREVIEW ───────────────────────────────────────────────────── */
router.post('/parties/preview', upload.single('file'), (req: Request, res: Response) => {
  try {
    const { firmId } = req.body;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    if (!req.file) return res.status(400).json({ error: 'Excel file required' });

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.find(n => n.toLowerCase() !== 'instructions') || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (rows.length < 2) return res.json({ success: true, data: { rows: [], summary: { total: 0, ok: 0, errors: 0 } } });

    const existingParties = db.prepare('SELECT name, gstin FROM parties WHERE firmId = ? AND isActive = 1').all(firmId) as any[];
    const existingNames = new Set(existingParties.map((p: any) => p.name.trim().toLowerCase()));
    const existingGSTINs = new Set(existingParties.map((p: any) => (p.gstin || '').trim().toUpperCase()).filter(Boolean));

    const dataRows = rows.slice(1);
    const results: any[] = [];
    let ok = 0, errors = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2;
      const errs: string[] = [];

      const name     = cellStr(row[0]);
      const type     = cellStr(row[1]).toLowerCase() || 'customer';
      const phone    = cellStr(row[2]);
      const email    = cellStr(row[3]);
      const gstin    = cellStr(row[4]);
      const pan      = cellStr(row[5]);
      const address  = cellStr(row[6]);
      const city     = cellStr(row[7]);
      const state    = cellStr(row[8]);
      const pincode  = cellStr(row[9]);
      const creditLimit     = parseFloat(cellStr(row[10])) || 0;
      const openingBalance  = parseFloat(cellStr(row[11])) || 0;

      if (!name && !type) continue;

      // Validations
      if (!name) errs.push('Name is required');
      if (!['customer', 'supplier', 'both'].includes(type)) errs.push(`Type must be customer, supplier, or both (got "${type}")`);
      if (name && existingNames.has(name.toLowerCase())) errs.push(`Party "${name}" already exists`);

      let normalizedPhone = phone;
      if (phone) {
        const mCheck = validateMobile(phone);
        if (!mCheck.valid) errs.push(`Phone: ${mCheck.error}`);
        else normalizedPhone = mCheck.value || '';
      }

      let normalizedGstin = gstin;
      if (gstin) {
        const gCheck = validateGSTIN(gstin);
        if (!gCheck.valid) errs.push(`GSTIN: ${gCheck.error}`);
        else {
          normalizedGstin = gCheck.value || '';
          if (normalizedGstin && existingGSTINs.has(normalizedGstin)) errs.push(`GSTIN "${normalizedGstin}" already exists for another party`);
        }
      }

      const status = errs.length === 0 ? 'ok' : 'error';
      if (status === 'ok') ok++; else errors++;

      results.push({
        rowNum, status, errors: errs,
        data: { name, type, phone: normalizedPhone, email, gstin: normalizedGstin,
          pan, address, city, state, pincode, creditLimit, openingBalance }
      });
    }

    res.json({ success: true, data: { rows: results, summary: { total: results.length, ok, errors } } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── PARTIES COMMIT ────────────────────────────────────────────────────── */
router.post('/parties/commit', (req: Request, res: Response) => {
  try {
    const { firmId, rows, overwriteExisting = false } = req.body;
    if (!firmId || !Array.isArray(rows)) return res.status(400).json({ error: 'firmId and rows required' });

    const now = new Date().toISOString();
    let inserted = 0, updated = 0, skipped = 0;

    const insertStmt = db.prepare(`
      INSERT INTO parties (id, firmId, name, type, phone, email, gstin, pan,
        address, city, state, pincode, creditLimit, openingBalance, isActive, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE parties SET type=?, phone=?, email=?, gstin=?, pan=?,
        address=?, city=?, state=?, pincode=?, creditLimit=?, openingBalance=?, updatedAt=?
      WHERE firmId=? AND LOWER(name)=LOWER(?)
    `);

    const importRows = db.transaction(() => {
      for (const row of rows) {
        if (row.status !== 'ok') { skipped++; continue; }
        const d = row.data;
        const existing = db.prepare('SELECT id FROM parties WHERE firmId = ? AND LOWER(name) = LOWER(?)').get(firmId, d.name) as any;

        if (existing) {
          if (!overwriteExisting) { skipped++; continue; }
          updateStmt.run(
            d.type, d.phone, d.email, d.gstin, d.pan,
            d.address, d.city, d.state, d.pincode, d.creditLimit, d.openingBalance, now,
            firmId, d.name
          );
          updated++;
        } else {
          insertStmt.run(
            uuidv4(), firmId, d.name, d.type, d.phone, d.email, d.gstin, d.pan,
            d.address, d.city, d.state, d.pincode, d.creditLimit, d.openingBalance, now, now
          );
          inserted++;
        }
      }
    });

    importRows();
    res.json({ success: true, data: { inserted, updated, skipped } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


/* ─── OPENING STOCK TEMPLATE / IMPORT ────────────────────────────────────── */
router.get('/opening-stock/template', (_req: Request, res: Response) => {
  try {
    const wb = XLSX.utils.book_new();
    const headers = ['Item Name*','Opening Stock*','Item Code (optional)','Batch Number (optional)','Packing (optional)','MFG Date (optional)','Expiry Date (optional)','Purchase Rate (optional)','MRP (optional)','Selling Rate (optional)','Unit 1 (optional)','Category Name (optional)','Company Name (optional)'];
    const sample = ['Basmati Rice 5kg',100,'SKU-001','B240901','5 KG','2026-09-01','2027-09-01',380,450,450,'PCS','General','B-MAX Demo Company'];
    const ws = XLSX.utils.aoa_to_sheet([headers,sample]); ws['!cols']=headers.map(()=>({wch:27})); XLSX.utils.book_append_sheet(wb,ws,'Opening Stock');
    const ins=XLSX.utils.aoa_to_sheet([['B-MAX — Opening Stock Import'],[''],['Only Item Name and Opening Stock are required.'],['Batch, packing, MFG/Expiry dates and rates are optional.'],['If batch tracking is enabled in B-MAX, a supplied Batch Number creates/updates the batch record.'],['If batch tracking is disabled, batch-specific fields are ignored; the item opening stock is still imported.'],['Multiple rows for the same item are allowed; their quantities are added.'],['Item Code is optional but helps identify an item when names are duplicated.'],['If the item is missing, B-MAX creates it automatically. Unit 1, Category and Company are also created automatically when supplied.'],['Do not change the column headers.']]); ins['!cols']=[{wch:100}]; XLSX.utils.book_append_sheet(wb,ins,'Instructions');
    const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}); res.setHeader('Content-Disposition','attachment; filename="BMAX_opening_stock_template.xlsx"'); res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.send(buf);
  } catch(err:any){res.status(500).json({error:err.message});}
});

router.post('/opening-stock/preview', upload.single('file'), (req: Request,res: Response)=>{
  try{
    const firmId=String(req.body.firmId||'').trim(); if(!firmId)return res.status(400).json({error:'firmId required'}); if(!req.file)return res.status(400).json({error:'Excel file required'});
    const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:false}); const ws=wb.Sheets[wb.SheetNames[0]]; const rows=XLSX.utils.sheet_to_json(ws,{defval:''}) as any[];
    const out=rows.map((r:any,i:number)=>{ const name=cellStr(r['Item Name*']||r['Item Name']); const qty=Number(r['Opening Stock*']??r['Opening Stock']); const code=cellStr(r['Item Code (optional)']||r['Item Code']);
      if(!name)return {row:i+2,status:'error',error:'Item Name is required'}; if(!Number.isFinite(qty)||qty<0)return {row:i+2,status:'error',error:'Opening Stock must be a non-negative number'};
      let item:any=null; if(code)item=db.prepare('SELECT id,name,itemCode,firmId FROM items WHERE firmId=? AND itemCode=? LIMIT 1').get(firmId,code); if(!item)item=db.prepare('SELECT id,name,itemCode,firmId FROM items WHERE firmId=? AND lower(name)=lower(?) ORDER BY id LIMIT 2').all(firmId,name);
      if(Array.isArray(item)){ if(item.length>1)return {row:i+2,status:'error',error:`Multiple items match "${name}". Use Item Code.`}; item=item[0]||null; }
      return {row:i+2,status:'ok',itemId:item?.id||null,itemName:item?.name||name,itemCode:item?.itemCode||code,quantity:qty,batchNumber:cellStr(r['Batch Number (optional)']),packing:cellStr(r['Packing (optional)']),mfgDate:cellStr(r['MFG Date (optional)']),expiryDate:cellStr(r['Expiry Date (optional)']),purchaseRate:Number(r['Purchase Rate (optional)'])||0,mrp:Number(r['MRP (optional)'])||0,sellingRate:Number(r['Selling Rate (optional)'])||0,unit1Short:cellStr(r['Unit 1 (optional)']||r['Unit 1']),catName:cellStr(r['Category Name (optional)']||r['Category Name']),companyName:cellStr(r['Company Name (optional)']||r['Company Name']),autoCreateItem:!item}; });
    res.json({success:true,data:{rows:out}});
  }catch(err:any){res.status(400).json({error:`Unable to read opening stock Excel: ${err.message}`});}
});

router.post('/opening-stock/commit',(req:Request,res:Response)=>{
  try{
    const firmId=String(req.body.firmId||'').trim(); const rows=Array.isArray(req.body.rows)?req.body.rows:[]; if(!firmId)return res.status(400).json({error:'firmId required'});
    const ok=rows.filter((r:any)=>r.status==='ok'); if(!ok.length)return res.status(400).json({error:'No valid rows to import'});
    const batchEnabled = !!getModuleSettings(firmId, 'items').batchEnabled;
    let inserted=0,updated=0; const now=new Date().toISOString();
    const tx=db.transaction(()=>{ const sums=new Map<string,number>();
      for(const r of ok){
        if(!r.itemId){
          const masters=resolveOrCreateItemMasters(firmId,{name:r.itemName,unit1Short:r.unit1Short||'',unit2Short:'',catName:r.catName||'',companyName:r.companyName||'',convFactor:1},now);
          const id=uuidv4();
          db.prepare('INSERT INTO items (id,firmId,name,type,itemCode,sku,categoryId,companyId,unitId,secondaryUnitId,conversionFactor,openingStock,currentStock,isActive,isFavorite,allowNegativeStock,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,firmId,r.itemName,'PRODUCT',r.itemCode||null,r.itemCode||null,masters.categoryId,masters.companyId,masters.unitId,null,1,0,0,1,0,0,now,now);
          r.itemId=id;
        }
        sums.set(r.itemId,(sums.get(r.itemId)||0)+Number(r.quantity||0));
      }
      for(const [itemId,total] of sums){const item=db.prepare('SELECT openingStock,currentStock FROM items WHERE id=? AND firmId=?').get(itemId,firmId) as any; if(!item)continue; const old=Number(item.openingStock||0); const delta=Number(total)-old; db.prepare('UPDATE items SET openingStock=?, currentStock=COALESCE(currentStock,0)+?, updatedAt=? WHERE id=? AND firmId=?').run(Number(total),delta,now,itemId,firmId); updated++;}
      if(batchEnabled){ for(const r of ok){ if(!r.batchNumber)continue; const b=db.prepare('SELECT id,quantity,openingQuantity FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=? LIMIT 1').get(firmId,r.itemId,r.batchNumber) as any; const openingQty=Number(r.quantity||0); if(b){ const oldOpening=Number(b.openingQuantity||0); const delta=openingQty-oldOpening; db.prepare("UPDATE inventory_batches SET openingQuantity=?, quantity=COALESCE(quantity,0)+?,packing=COALESCE(NULLIF(?,''),packing),mfgDate=COALESCE(NULLIF(?,''),mfgDate),expiryDate=NULL,expiryMonth=?,expiryYear=?,purchaseRate=CASE WHEN ?!=0 THEN ? ELSE purchaseRate END,mrp=CASE WHEN ?!=0 THEN ? ELSE mrp END,sellingRate=CASE WHEN ?!=0 THEN ? ELSE sellingRate END,updatedAt=? WHERE id=?").run(openingQty,delta,r.packing,r.mfgDate,parseExpiryInput(r.expiryDate).month ?? expiryFromLegacyDate(r.expiryDate).month,parseExpiryInput(r.expiryDate).year ?? expiryFromLegacyDate(r.expiryDate).year,Number(r.purchaseRate||0),Number(r.purchaseRate||0),Number(r.mrp||0),Number(r.mrp||0),Number(r.sellingRate||0),Number(r.sellingRate||0),now,b.id); updated++; } else { db.prepare('INSERT INTO inventory_batches(id,firmId,itemId,batchNumber,expiryDate,expiryMonth,expiryYear,mfgDate,packing,purchaseRate,mrp,sellingRate,markup,quantity,openingQuantity,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(uuidv4(),firmId,r.itemId,r.batchNumber,null,parseExpiryInput(r.expiryDate).month ?? expiryFromLegacyDate(r.expiryDate).month,parseExpiryInput(r.expiryDate).year ?? expiryFromLegacyDate(r.expiryDate).year,r.mfgDate||null,r.packing||null,Number(r.purchaseRate||0),Number(r.mrp||0),Number(r.sellingRate||0),0,openingQty,openingQty,now,now); inserted++; } } }
    }); tx(); res.json({success:true,data:{inserted,updated,batchTrackingApplied:batchEnabled}});
  }catch(err:any){res.status(400).json({error:err.message});}
});

/* ─── OPENING BALANCE TEMPLATE / IMPORT ─────────────────────────────────── */
router.get('/opening-balance/template', (_req: Request,res:Response)=>{
  try{const wb=XLSX.utils.book_new(); const headers=['Party Name*','Opening Balance*','Balance Type (DEBIT/CREDIT, optional)','Party Code (optional)','Phone (optional)','Notes (optional)']; const sample=['ABC Traders',25000,'DEBIT','PARTY-00001','9876543210','Opening receivable']; const ws=XLSX.utils.aoa_to_sheet([headers,sample]); ws['!cols']=headers.map(()=>({wch:32})); XLSX.utils.book_append_sheet(wb,ws,'Opening Balance'); const ins=XLSX.utils.aoa_to_sheet([['B-MAX — Opening Balance Import'],[''],['Party Name and Opening Balance are required.'],['Balance Type is optional and defaults to DEBIT / To Receive.'],['Use CREDIT for To Pay.'],['Party Code or Phone can be used to identify a party when names are duplicated.'],['Do not change the column headers.']]); ins['!cols']=[{wch:100}]; XLSX.utils.book_append_sheet(wb,ins,'Instructions'); const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}); res.setHeader('Content-Disposition','attachment; filename="BMAX_opening_balance_template.xlsx"'); res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.send(buf);}catch(err:any){res.status(500).json({error:err.message});}
});

router.post('/opening-balance/preview',upload.single('file'),(req:Request,res:Response)=>{try{const firmId=String(req.body.firmId||'').trim();if(!firmId)return res.status(400).json({error:'firmId required'});if(!req.file)return res.status(400).json({error:'Excel file required'});const wb=XLSX.read(req.file.buffer,{type:'buffer'});const ws=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:''}) as any[];const out=rows.map((r:any,i:number)=>{const name=cellStr(r['Party Name*']||r['Party Name']);const amount=Number(r['Opening Balance*']??r['Opening Balance']);const type=cellStr(r['Balance Type (DEBIT/CREDIT, optional)']||r['Balance Type']).toLowerCase()||'debit';const code=cellStr(r['Party Code (optional)']||r['Party Code']);const phone=cellStr(r['Phone (optional)']||r['Phone']);if(!name)return{row:i+2,status:'error',error:'Party Name is required'};if(!Number.isFinite(amount)||amount<0)return{row:i+2,status:'error',error:'Opening Balance must be a non-negative number'};if(!['debit','credit'].includes(type))return{row:i+2,status:'error',error:'Balance Type must be DEBIT or CREDIT'};let party:any=null;if(code)party=db.prepare('SELECT id,name,partyCode,phone FROM parties WHERE firmId=? AND partyCode=? LIMIT 1').get(firmId,code);if(!party&&phone)party=db.prepare('SELECT id,name,partyCode,phone FROM parties WHERE firmId=? AND phone=? LIMIT 1').get(firmId,phone);if(!party){const a=db.prepare('SELECT id,name,partyCode,phone FROM parties WHERE firmId=? AND lower(name)=lower(?) AND isActive=1 ORDER BY id LIMIT 2').all(firmId,name) as any[];if(a.length===1)party=a[0];else if(a.length>1)return{row:i+2,status:'error',error:`Multiple parties match "${name}". Use Party Code or Phone.`};}return{row:i+2,status:'ok',partyId:party?.id||null,partyName:party?.name||name,partyCode:party?.partyCode||code,phone,amount,type,autoCreateParty:!party};});res.json({success:true,data:{rows:out}});}catch(err:any){res.status(400).json({error:`Unable to read opening balance Excel: ${err.message}`});}});

router.post('/opening-balance/commit',(req:Request,res:Response)=>{try{const firmId=String(req.body.firmId||'').trim();const rows=Array.isArray(req.body.rows)?req.body.rows:[];const ok=rows.filter((r:any)=>r.status==='ok');if(!firmId)return res.status(400).json({error:'firmId required'});if(!ok.length)return res.status(400).json({error:'No valid rows to import'});const now=new Date().toISOString();const tx=db.transaction(()=>{for(const r of ok){
  let partyId=r.partyId;
  if(!partyId){
    partyId=uuidv4();
    db.prepare('INSERT INTO parties (id,firmId,name,type,phone,openingBalance,openingBalanceType,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run(partyId,firmId,r.partyName,r.type==='credit'?'supplier':'customer',r.phone||null,Math.max(0,Number(r.amount)||0),r.type==='credit'?'credit':'debit',1,now,now);
  } else {
    db.prepare('UPDATE parties SET openingBalance=?, openingBalanceType=?, updatedAt=? WHERE id=? AND firmId=?').run(Math.max(0,Number(r.amount)||0),r.type==='credit'?'credit':'debit',now,partyId,firmId);
  }
}});tx();res.json({success:true,data:{updated:ok.length}});}catch(err:any){res.status(400).json({error:err.message});}});

export default router;



