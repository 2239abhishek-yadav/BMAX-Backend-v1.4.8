import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { assertItemQuantityPrecision } from '../lib/quantityPolicy';
import { getVisibilitySettings, getModuleSettings } from '../lib/moduleSettings';
import * as XLSX from 'xlsx';

const router = Router();
const VALID_GST_SLABS = [0, 5, 18];
const uploadRoot = process.env.UPLOADS_DIR || path.join(process.env.DB_PATH || path.join(process.cwd(), 'data'), 'uploads');
const itemImageDir = path.join(uploadRoot, 'items');
if (!fs.existsSync(itemImageDir)) fs.mkdirSync(itemImageDir, { recursive: true });
const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, itemImageDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif|avif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, GIF or AVIF images are allowed'));
  },
});


// GET item master Excel export — exports the active firm's current item master, including item-level MRP.
router.get('/export/excel', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '').trim();
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const search = String(req.query.search || '').trim();
    const companyId = String(req.query.companyId || '').trim();
    const categoryId = String(req.query.categoryId || '').trim();
    let q = `SELECT i.itemCode AS [Item Code], i.barcode AS [Barcode], i.name AS [Item Name],
      u.shortName AS [Unit 1], su.shortName AS [Unit 2], i.conversionFactor AS [Unit Conversion],
      i.hsnCode AS [HSN Code], i.taxRate AS [GST Rate (%)], i.mrp AS [MRP], i.salePrice AS [Selling Rate],
      i.saleDiscount AS [Discount %], i.discount1 AS [Discount 1 %], i.volumeDiscount AS [Volume Discount %],
      i.purchasePrice AS [Purchase Rate], CASE WHEN i.purchasePriceTaxInclusive=1 THEN 'YES' ELSE 'NO' END AS [Purchase Tax Inclusive (YES/NO)],
      CASE WHEN i.salePriceTaxInclusive=1 THEN 'YES' ELSE 'NO' END AS [Sale Tax Inclusive (YES/NO)],
      i.type AS [Type (PRODUCT/SERVICE)], c.name AS [Category Name], i.minStockLevel AS [Min Stock Level],
      i.openingStock AS [Opening Stock], i.location AS [Storage Location], i.packing AS [Packing],
      i.batchNumber AS [Batch Number], i.mfgDate AS [MFG Date], i.expiryDate AS [Expiry Date], i.description AS [Description]
      FROM items i LEFT JOIN units u ON u.id=i.unitId LEFT JOIN units su ON su.id=i.secondaryUnitId
      LEFT JOIN categories c ON c.id=i.categoryId
      WHERE i.firmId=? AND i.isActive=1`;
    const params: any[] = [firmId];
    if (companyId) { q += ' AND i.companyId=?'; params.push(companyId); }
    if (categoryId) { q += ' AND i.categoryId=?'; params.push(categoryId); }
    if (search) { q += ' AND (i.name LIKE ? OR i.itemCode LIKE ? OR i.barcode LIKE ? OR i.sku LIKE ?)'; const term=`%${search}%`; params.push(term,term,term,term); }
    q += ' ORDER BY i.name COLLATE NOCASE ASC';
    const rows = db.prepare(q).all(...params) as any[];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, { skipHeader: false });
    ws['!cols'] = Object.keys(rows[0] || {
      'Item Code':'','Barcode':'','Item Name':'','Unit 1':'','Unit 2':'','Unit Conversion':'','HSN Code':'','GST Rate (%)':'','MRP':'','Selling Rate':'','Discount %':'','Discount 1 %':'','Volume Discount %':'','Purchase Rate':'','Purchase Tax Inclusive (YES/NO)':'','Sale Tax Inclusive (YES/NO)':'','Type (PRODUCT/SERVICE)':'','Category Name':'','Min Stock Level':'','Opening Stock':'','Storage Location':'','Packing':'','Batch Number':'','MFG Date':'','Expiry Date':'','Description':''
    }).map((h:string)=>({wch:Math.max(16,Math.min(34,h.length+4))}));
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const info = XLSX.utils.aoa_to_sheet([
      ['B-MAX — Item Master Export'],
      [''],
      ['This export contains the current active item master for the selected firm.'],
      ['MRP is the item-level MRP. Batch-level MRP, when configured, remains stored separately and has priority during batch billing.'],
      ['The file can be edited and re-imported using the B-MAX Items Import Template.']
    ]);
    info['!cols']=[{wch:120}];
    XLSX.utils.book_append_sheet(wb, info, 'Instructions');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="bmax_item_master_export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

// GET all items
router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, type, categoryId, companyId, search, active } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });

    let query = `SELECT i.*, c.name as categoryName, u.name as unitName, u.shortName as unitShortName,
      su.name as secondaryUnitName, su.shortName as secondaryUnitShortName, ic.name as companyName
      FROM items i LEFT JOIN categories c ON i.categoryId = c.id
      LEFT JOIN units u ON i.unitId = u.id
      LEFT JOIN units su ON i.secondaryUnitId = su.id
      LEFT JOIN item_companies ic ON i.companyId = ic.id
      WHERE i.firmId = ?`;
    const params: any[] = [firmId];

    if (type) { query += ' AND i.type = ?'; params.push(type); }
    if (categoryId) { query += ' AND i.categoryId = ?'; params.push(categoryId); }
    if (companyId) { query += ' AND i.companyId = ?'; params.push(companyId); }
    if (active !== undefined) { query += ' AND i.isActive = ?'; params.push(active === 'true' ? 1 : 0); }
    if (search) { query += ' AND (i.name LIKE ? OR i.itemCode LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ?)'; const term=`%${search}%`; params.push(term,term,term,term); }
    query += ' ORDER BY i.name ASC';

    const items = db.prepare(query).all(params);
    res.json({ success: true, data: items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET complete item transaction history
router.get('/:id/history', (req: Request, res: Response) => {
  try {
    const { firmId, startDate, endDate, type } = req.query;
    const item = db.prepare('SELECT id, firmId, name, itemCode, sku, barcode, currentStock FROM items WHERE id=?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error:'Item not found' });
    if (firmId && item.firmId !== firmId) return res.status(403).json({ error:'Item does not belong to firm' });
    let q=`SELECT di.id, d.id AS documentId, d.documentType, d.documentNumber, d.documentDate, d.partyId, d.partyName, d.partyType, di.quantity, di.unit, di.unitId, di.isSecondaryUnit, di.baseQuantity, di.secondaryQuantity, di.secondaryUnitId, su.name AS secondaryUnitName, su.shortName AS secondaryUnitShortName, di.price, di.amount FROM document_items di JOIN documents d ON d.id=di.documentId LEFT JOIN units su ON su.id=di.secondaryUnitId WHERE di.itemId=? AND d.firmId=? AND d.isDeleted=0`;
    const params:any[]=[req.params.id,item.firmId];
    if(startDate){q+=' AND d.documentDate>=?';params.push(startDate)} if(endDate){q+=' AND d.documentDate<=?';params.push(endDate)} if(type){q+=' AND d.documentType=?';params.push(type)}
    q+=' ORDER BY d.documentDate DESC,d.createdAt DESC';
    const transactions=(db.prepare(q).all(params) as any[]).map(r=>({...r,direction:['purchase_invoice','purchase_return'].includes(r.documentType)?'purchase':['sale_invoice','sale_return'].includes(r.documentType)?'sale':'other'}));
    res.json({success:true,data:{item,transactions}});
  } catch(err:any){res.status(500).json({error:err.message})}
});

// POST upload/update item image
router.post('/:id/image', imageUpload.single('file'), (req: Request, res: Response) => {
  try {
    const { firmId } = req.body;
    const item = db.prepare('SELECT id, firmId, imageUrl FROM items WHERE id=?').get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (firmId && item.firmId !== firmId) return res.status(403).json({ error: 'Item does not belong to firm' });
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    if (item.imageUrl && item.imageUrl.startsWith('/uploads/items/')) {
      const oldPath = path.join(uploadRoot, item.imageUrl.replace(/^\/uploads\//, ''));
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
    }
    const imageUrl = `/uploads/items/${req.file.filename}`;
    db.prepare('UPDATE items SET imageUrl=?, updatedAt=? WHERE id=?').run(imageUrl, new Date().toISOString(), req.params.id);
    const updated = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id);
    res.json({ success: true, data: updated });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// Set opening stock independently. The current stock is adjusted by the delta so existing transaction movements are preserved.
router.put('/:id/opening-stock', (req: Request, res: Response) => {
  try {
    const firmId = String(req.body.firmId || '').trim();
    const openingStock = Math.max(0, Number(req.body.openingStock) || 0);
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const item = db.prepare('SELECT id, firmId, openingStock, currentStock FROM items WHERE id=?').get(req.params.id) as any;
    if (!item || item.firmId !== firmId) return res.status(404).json({ error: 'Item not found' });
    const oldOpening = Number(item.openingStock || 0);
    const delta = openingStock - oldOpening;
    const tx = db.transaction(() => {
      db.prepare('UPDATE items SET openingStock=?, currentStock=COALESCE(currentStock,0)+?, updatedAt=? WHERE id=? AND firmId=?').run(openingStock, delta, new Date().toISOString(), req.params.id, firmId);
    });
    tx();
    res.json({ success:true, data: db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id) });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

// GET item by id
router.get('/:id', (req: Request, res: Response) => {
  try {
    const item = db.prepare(`SELECT i.*, c.name as categoryName, u.name as unitName, u.shortName as unitShortName,
      su.name as secondaryUnitName, su.shortName as secondaryUnitShortName, ic.name as companyName
      FROM items i LEFT JOIN categories c ON i.categoryId = c.id
      LEFT JOIN units u ON i.unitId = u.id
      LEFT JOIN units su ON i.secondaryUnitId = su.id
      LEFT JOIN item_companies ic ON i.companyId = ic.id
      WHERE i.id = ?`).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true, data: item });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create item
router.post('/', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const id = uuidv4();
    const {
      firmId, name, type = 'PRODUCT', itemRole = 'FINISHED_GOOD', hsnCode, itemCode, sku, barcode, description, imageUrl,
      categoryId, companyId, unitId, secondaryUnitId, conversionFactor = 1,
      mrp = 0, salePrice = 0, salePriceTaxInclusive = 0,
      saleDiscount = 0, saleDiscountType = 'percentage',
      purchasePrice = 0, purchasePriceTaxInclusive = 0,
      taxRate = '0', openingStock = 0, minStockLevel = 0,
      location, batchNumber, expiryDate, packing,
      enableBatchTracking = 0, enableSerialTracking = 0,
      isActive = 1, isFavorite = 0, allowNegativeStock = 0, decimalEnabled = 0
    } = req.body;

    if (!firmId || !name) return res.status(400).json({ error: 'firmId and name are required' });
    const manufacturingEnabled = getVisibilitySettings(String(firmId)).manufacturing !== false;
    const effectiveItemRole = manufacturingEnabled && ['RAW_MATERIAL','FINISHED_GOOD'].includes(itemRole) ? itemRole : 'FINISHED_GOOD';
    const normalizedTaxRate = Number(String(taxRate ?? 0).replace('%','').trim() || 0);
    if (!Number.isFinite(normalizedTaxRate) || !VALID_GST_SLABS.includes(normalizedTaxRate)) { return res.status(400).json({ error: 'GST rate must be one of 0%, 5% or 18%' }); }
    const mrpSetting = getModuleSettings(String(firmId), 'items').mrpEnabled;
    const normalizedMrp = mrpSetting ? Number(mrp ?? 0) : 0;
    if (!Number.isFinite(normalizedMrp) || normalizedMrp < 0) return res.status(400).json({ error: 'MRP cannot be negative' });

    const normalizedName = String(name).trim();
    const precisionItem = { name: normalizedName, decimalEnabled: decimalEnabled ? 1 : 0 };
    assertItemQuantityPrecision(precisionItem, openingStock, 'Opening stock');
    assertItemQuantityPrecision(precisionItem, minStockLevel, 'Minimum stock level');
    // Item names may be similar/duplicate. Item Code is the identity field and is
    // unique by default; the firm can explicitly allow duplicate codes in Settings.
    const allowDuplicateCode = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId=? AND settingType='items' AND settingKey='allowDuplicateItemCode'").get(firmId) as any;
    if (itemCode && String(allowDuplicateCode?.settingValue) !== 'true') {
      const duplicateCode = db.prepare('SELECT id FROM items WHERE firmId=? AND LOWER(TRIM(itemCode))=LOWER(?) AND isActive=1 LIMIT 1').get(firmId, String(itemCode).trim()) as any;
      if (duplicateCode) return res.status(409).json({ error: 'Item code already exists. Use a different item code or enable Allow Duplicate Item Code in Item Settings.' });
    }

    // Unit 2 (secondary/larger unit) is optional, but if provided it must have a
    // sensible conversion quantity into Unit 1 (base) — e.g. 1 Strip = 10 Tablets.
    const convFactor = secondaryUnitId ? (parseFloat(conversionFactor) || 1) : 1;
    if (secondaryUnitId && convFactor <= 0) {
      return res.status(400).json({ error: 'Conversion quantity must be greater than 0' });
    }

    db.prepare(`
      INSERT INTO items (id, firmId, name, type, itemRole, hsnCode, itemCode, sku, barcode, description, imageUrl,
        categoryId, companyId, unitId, secondaryUnitId, conversionFactor,
        mrp, salePrice, salePriceTaxInclusive, saleDiscount, saleDiscountType,
        purchasePrice, purchasePriceTaxInclusive, taxRate, openingStock, currentStock,
        minStockLevel, location, batchNumber, expiryDate, packing,
        enableBatchTracking, enableSerialTracking, isActive, isFavorite, allowNegativeStock, decimalEnabled,
        createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, firmId, name, type, effectiveItemRole, hsnCode, itemCode, sku || null, barcode || null, description, imageUrl,
      categoryId, companyId, unitId, secondaryUnitId || null, convFactor,
      normalizedMrp, salePrice, salePriceTaxInclusive ? 1 : 0,
      saleDiscount, saleDiscountType, purchasePrice, purchasePriceTaxInclusive ? 1 : 0,
      normalizedTaxRate, openingStock, openingStock, minStockLevel, location, batchNumber, expiryDate, packing,
      enableBatchTracking ? 1 : 0, enableSerialTracking ? 1 : 0,
      isActive ? 1 : 0, isFavorite ? 1 : 0, allowNegativeStock ? 1 : 0, decimalEnabled ? 1 : 0, now, now);

    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    res.status(201).json({ success: true, data: item });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update item
router.put('/:id', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const {
      name, type, itemRole, hsnCode, itemCode, sku, barcode, description, imageUrl,
      categoryId, companyId, unitId, secondaryUnitId, conversionFactor,
      mrp, salePrice, salePriceTaxInclusive,
      saleDiscount, saleDiscountType, purchasePrice, purchasePriceTaxInclusive,
      taxRate, minStockLevel, location, batchNumber, expiryDate, packing,
      enableBatchTracking, enableSerialTracking, isActive, isFavorite, allowNegativeStock, decimalEnabled
    } = req.body;

    const convFactor = secondaryUnitId ? (parseFloat(conversionFactor) || 1) : 1;
    if (secondaryUnitId && convFactor <= 0) {
      return res.status(400).json({ error: 'Conversion quantity must be greater than 0' });
    }

    const normalizedName = String(name || '').trim();
    if (!normalizedName) return res.status(400).json({ error: 'Item name is required' });
    const manufacturingEnabled = getVisibilitySettings(String(req.body.firmId)).manufacturing !== false;
    const existingItemRole = (db.prepare('SELECT itemRole FROM items WHERE id=? AND firmId=?').get(req.params.id, req.body.firmId) as any)?.itemRole;
    const effectiveItemRole = manufacturingEnabled && ['RAW_MATERIAL','FINISHED_GOOD'].includes(itemRole) ? itemRole : (existingItemRole || 'FINISHED_GOOD');
    const normalizedTaxRate = Number(String(taxRate ?? 0).replace('%','').trim() || 0);
    if (!Number.isFinite(normalizedTaxRate) || !VALID_GST_SLABS.includes(normalizedTaxRate)) {
      return res.status(400).json({ error: 'GST rate must be one of 0%, 5% or 18%' });
    }
    const existingMrp = Number((db.prepare('SELECT mrp FROM items WHERE id=? AND firmId=?').get(req.params.id, req.body.firmId) as any)?.mrp ?? 0);
    const mrpSetting = getModuleSettings(String(req.body.firmId), 'items').mrpEnabled;
    const normalizedMrp = mrpSetting ? Number(mrp ?? 0) : existingMrp;
    if (!Number.isFinite(normalizedMrp) || normalizedMrp < 0) return res.status(400).json({ error: 'MRP cannot be negative' });
    const precisionItem = { name: normalizedName, decimalEnabled: decimalEnabled ? 1 : 0 };
    const current:any = db.prepare('SELECT openingStock,minStockLevel FROM items WHERE id=? AND firmId=?').get(req.params.id, req.body.firmId);
    assertItemQuantityPrecision(precisionItem, current?.openingStock ?? 0, 'Opening stock');
    assertItemQuantityPrecision(precisionItem, minStockLevel ?? 0, 'Minimum stock level');
    const allowDuplicateCode = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId=? AND settingType='items' AND settingKey='allowDuplicateItemCode'").get(req.body.firmId) as any;
    if (itemCode && String(allowDuplicateCode?.settingValue) !== 'true') {
      const duplicateCode = db.prepare('SELECT id FROM items WHERE firmId=? AND id<>? AND LOWER(TRIM(itemCode))=LOWER(?) AND isActive=1 LIMIT 1').get(req.body.firmId, req.params.id, String(itemCode).trim()) as any;
      if (duplicateCode) return res.status(409).json({ error: 'Item code already exists. Use a different item code or enable Allow Duplicate Item Code in Item Settings.' });
    }

    db.prepare(`
      UPDATE items SET name=?, type=?, itemRole=?, hsnCode=?, itemCode=?, sku=?, barcode=?, description=?, imageUrl=?,
        categoryId=?, companyId=?, unitId=?, secondaryUnitId=?, conversionFactor=?,
        mrp=?, salePrice=?, salePriceTaxInclusive=?, saleDiscount=?,
        saleDiscountType=?, purchasePrice=?, purchasePriceTaxInclusive=?, taxRate=?,
        minStockLevel=?, location=?, batchNumber=?, expiryDate=?, packing=?,
        enableBatchTracking=?, enableSerialTracking=?, isActive=?, isFavorite=?,
        allowNegativeStock=?, decimalEnabled=?, updatedAt=? WHERE id=?
    `).run(name, type, effectiveItemRole, hsnCode, itemCode, sku, barcode, description, imageUrl,
      categoryId, companyId, unitId, secondaryUnitId || null, convFactor,
      normalizedMrp, salePrice, salePriceTaxInclusive ? 1 : 0,
      saleDiscount, saleDiscountType, purchasePrice, purchasePriceTaxInclusive ? 1 : 0,
      normalizedTaxRate, minStockLevel, location, batchNumber, expiryDate, packing,
      enableBatchTracking ? 1 : 0, enableSerialTracking ? 1 : 0,
      isActive ? 1 : 0, isFavorite ? 1 : 0, allowNegativeStock ? 1 : 0, decimalEnabled ? 1 : 0, now, req.params.id);

    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: item });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Transaction guard: an item with any posted/held/cancelled document reference is never hard-deleted/deactivated.
router.get('/:id/transaction-check', (req: Request, res: Response) => {
  try {
    const item:any=db.prepare('SELECT id,firmId,name FROM items WHERE id=?').get(req.params.id);
    if(!item) return res.status(404).json({error:'Item not found'});
    const firmId=String(req.query.firmId||item.firmId);
    if(firmId!==String(item.firmId)) return res.status(403).json({error:'Item does not belong to firm'});
    const documents:any=db.prepare('SELECT COUNT(*) count FROM document_items di JOIN documents d ON d.id=di.documentId WHERE di.itemId=? AND d.firmId=?').get(req.params.id,firmId);
    const counter:any=db.prepare('SELECT COUNT(*) count FROM counter_sale_items csi JOIN counter_sales cs ON cs.id=csi.counterSaleId WHERE csi.itemId=? AND cs.firmId=?').get(req.params.id,firmId);
    const transactionCount=Number(documents?.count||0)+Number(counter?.count||0);
    res.json({success:true,data:{hasTransactions:transactionCount>0,transactionCount,itemId:item.id,firmId}});
  } catch(err:any){res.status(500).json({error:err.message});}
});

// DELETE item: server-side accounting safety guard. UI checks are advisory only.
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const item:any=db.prepare('SELECT id,firmId,name,isActive FROM items WHERE id=?').get(req.params.id);
    if(!item) return res.status(404).json({error:'Item not found'});
    const firmId=String(req.body?.firmId||req.query?.firmId||item.firmId);
    if(firmId!==String(item.firmId)) return res.status(403).json({error:'Item does not belong to firm'});
    const documents:any=db.prepare('SELECT COUNT(*) count FROM document_items di JOIN documents d ON d.id=di.documentId WHERE di.itemId=? AND d.firmId=?').get(item.id,firmId);
    const counter:any=db.prepare('SELECT COUNT(*) count FROM counter_sale_items csi JOIN counter_sales cs ON cs.id=csi.counterSaleId WHERE csi.itemId=? AND cs.firmId=?').get(item.id,firmId);
    const transactionCount=Number(documents?.count||0)+Number(counter?.count||0);
    if(transactionCount>0) return res.status(409).json({error:'Item cannot be deleted because transactions exist for it.',data:{hasTransactions:true,transactionCount}});
    db.prepare('UPDATE items SET isActive=0, updatedAt=? WHERE id=? AND firmId=?').run(new Date().toISOString(),item.id,firmId);
    res.json({success:true,message:'Item deleted'});
  } catch(err:any){res.status(500).json({error:err.message});}
});

// GET stock summary
router.get('/stock/summary', (req: Request, res: Response) => {
  try {
    const { firmId } = req.query;
    const items = db.prepare(`
      SELECT id, name, currentStock, minStockLevel, salePrice, purchasePrice
      FROM items WHERE firmId = ? AND type = 'PRODUCT' AND isActive = 1
      ORDER BY name ASC
    `).all([firmId]);
    res.json({ success: true, data: items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;



