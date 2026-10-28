import { Router, Request, Response } from 'express';
import { getNegativeStockAllowed, syncNegativeStockFromRequest } from '../lib/moduleSettings';
import { db } from '../lib/db';

const router = Router();


// Resolve an item barcode for billing. The item master is authoritative for
// barcode identity; batch selection remains a separate concern because legacy
// inventory_batches do not have a barcode column. If exactly one active batch
// exists it is returned as a convenience, otherwise the frontend can prompt
// for the batch using /batches.
router.get('/barcode/resolve', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '').trim();
    const barcode = String(req.query.barcode || '').trim();
    if (!firmId) return res.status(400).json({ error: 'firmId is required' });
    if (!barcode) return res.status(400).json({ error: 'barcode is required' });

    const item:any = db.prepare(`
      SELECT i.*, u.shortName AS unitShortName
      FROM items i
      LEFT JOIN units u ON u.id=i.unitId
      WHERE i.firmId=? AND i.isActive=1
        AND (TRIM(COALESCE(i.barcode,''))=? OR TRIM(COALESCE(i.itemCode,''))=? OR TRIM(COALESCE(i.sku,''))=?)
      LIMIT 1
    `).get(firmId, barcode, barcode, barcode);
    if (!item) return res.status(404).json({ error: 'Barcode/item code not found' });

    const batches:any[] = db.prepare(`
      SELECT * FROM inventory_batches
      WHERE firmId=? AND itemId=?
      ORDER BY CASE WHEN quantity>0 THEN 0 ELSE 1 END, updatedAt DESC
    `).all(firmId, item.id) as any[];
    const batch = batches.length === 1 ? batches[0] : null;
    const availableStock = batch ? Number(batch.quantity || 0) : Number(item.currentStock || 0);

    res.json({
      success:true,
      data:{
        item:{...item, unit:item.unitShortName || ''},
        batch: batch ? {...batch, barcode: item.barcode || barcode} : null,
        batchCount:batches.length,
        availableStock
      }
    });
  } catch (err:any) {
    res.status(500).json({ error: err?.message || 'Barcode resolution failed' });
  }
});

/**
 * Lightweight authoritative pre-check used by the Billing screen before a NEW
 * sales transaction is posted. Document PUT has its own atomic stock validation
 * after reversing the old transaction, so edits intentionally do not call this
 * route from the frontend.
 */
router.post('/validate-document', (req: Request, res: Response) => {
  try {
    const firmId = String(req.body?.firmId || '').trim();
    const documentType = String(req.body?.documentType || '').trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!firmId) return res.status(400).json({ error: 'Company/Firm is required' });

    const stockDecreaseTypes = new Set(['sale_invoice','sale_order','delivery_challan']);
    if (!stockDecreaseTypes.has(documentType)) {
      return res.json({ success:true, data:{valid:true} });
    }

    // Authoritative firm-wide negative-stock policy. This pre-check is called
    // immediately before NEW sale posting from the Billing UI. It must use the
    // same backend setting as the final /documents transaction; otherwise the
    // UI can report "Insufficient stock" even when Negative Stock Billing is
    // enabled. The final document route repeats the policy check atomically.
    const allowNegativeStock = syncNegativeStockFromRequest(firmId, req.body?.allowNegativeStock);
    if (allowNegativeStock) {
      return res.json({ success:true, data:{valid:true, allowNegativeStock:true} });
    }

    for (const line of items) {
      if (!line?.itemId) continue;

      const item:any = db.prepare(
        'SELECT id,name,currentStock,decimalEnabled FROM items WHERE id=? AND firmId=? AND isActive=1'
      ).get(line.itemId, firmId);

      if (!item) {
        return res.json({ success:true, data:{valid:false,message:`Item not found or inactive: ${line.name || line.itemId}`} });
      }

      const qty = Math.max(0, Number(line.quantity || 0));
      const freeQty = Math.max(0, Number(line.freeQuantity || 0));
      const required = qty + freeQty;
      if (required <= 0) continue;

      const available = Number(item.currentStock || 0);
      if (available - required < -0.0001) {
        return res.json({
          success:true,
          data:{valid:false,message:`Insufficient stock for ${item.name || line.name}. Available: ${available}, Required: ${required}`}
        });
      }

      if (line.batchId || line.batchNumber) {
        const batch:any = line.batchId
          ? db.prepare('SELECT quantity FROM inventory_batches WHERE id=? AND firmId=? AND itemId=?')
              .get(line.batchId, firmId, line.itemId)
          : db.prepare('SELECT quantity FROM inventory_batches WHERE firmId=? AND itemId=? AND batchNumber=?')
              .get(firmId, line.itemId, String(line.batchNumber).trim());

        if (!batch) {
          return res.json({success:true,data:{valid:false,message:`Selected batch not found for ${item.name || line.name}`}});
        }
        if (Number(batch.quantity || 0) - required < -0.0001) {
          return res.json({
            success:true,
            data:{valid:false,message:`Insufficient batch stock for ${item.name || line.name} / ${line.batchNumber || line.batchId}`}
          });
        }
      }

      const godownId = line.godownId || null;
      if (godownId) {
        const stock:any = db.prepare(
          'SELECT quantity FROM inventory_stock WHERE firmId=? AND itemId=? AND godownId=? LIMIT 1'
        ).get(firmId, line.itemId, godownId);
        if (Number(stock?.quantity || 0) - required < -0.0001) {
          return res.json({
            success:true,
            data:{valid:false,message:`Insufficient stock for ${item.name || line.name} in selected store. Available: ${Number(stock?.quantity || 0)}, Required: ${required}`}
          });
        }
      }
    }

    return res.json({ success:true, data:{valid:true} });
  } catch (err:any) {
    return res.status(500).json({ error: err?.message || 'Inventory validation failed' });
  }
});

export default router;
