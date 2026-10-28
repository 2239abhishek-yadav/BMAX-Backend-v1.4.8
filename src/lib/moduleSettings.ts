import { db } from './db';
import { v4 as uuidv4 } from 'uuid';

/**
 * Module Settings (per firm, per module)
 * Reuses the existing generic `firm_settings` table (settingType/settingKey/settingValue).
 *
 * Two categories of settings:
 *
 * A) FEATURE TOGGLES (settingType = moduleKey, e.g. 'sale_invoice')
 *    Controls per-billing-module behaviour:
 *    - multiSeriesEnabled   – independent numbering series
 *    - unitsEnabled         – Unit 2 / Unit Conversion on line items
 *    - itemDiscountEnabled  – item-wise discount column on billing lines
 *    - billDiscountEnabled  – bill-level discount on billing totals
 *
 * B) VISIBILITY TOGGLES (settingType = 'module_visibility')
 *    Controls which entire sections are shown in the sidebar/nav:
 *    - items, godowns, sale_invoice, sale_order, sale_return, sale_quotation,
 *      delivery_challan, payment_in, purchase_invoice, purchase_order,
 *      purchase_return, payment_out, expenses, accounting_entries, bank,
 *      employees, attendance, payroll, report_pl, report_stock,
 *      report_outstanding, report_daybook, report_gst, parties, ledger
 *
 * All default to ENABLED (true) on upgrade so nothing is silently disabled.
 */

// ── A. Feature-toggle types ──────────────────────────────────────────────────

export const DOCUMENT_MODULES = [
  'sale_invoice', 'pos_billing', 'counter_sale', 'sale_order', 'sale_return', 'sale_return_challan', 'sale_quotation', 'sale_proforma', 'delivery_challan', 'job_work_out',
  'purchase_invoice', 'purchase_order', 'purchase_challan', 'purchase_return', 'purchase_return_challan', 'job_work_in',
] as const;

export type ModuleKey = typeof DOCUMENT_MODULES[number] | 'items';

export interface ModuleSettings {
  multiSeriesEnabled: boolean;
  unitsEnabled: boolean;
  itemDiscountEnabled: boolean;
  billDiscountEnabled: boolean;
  packingEnabled: boolean;
  batchEnabled: boolean;
  expiryEnabled: boolean;
  mfgDateEnabled: boolean;
  freeQuantityEnabled: boolean;
  mrpEnabled: boolean;
  sellingRateEnabled: boolean;
  allowNegativeStock: boolean;
  allowDuplicateItemCode: boolean;
  gstPriceMode: 'exclusive' | 'inclusive';
  barcodeBillingEnabled: boolean;
  lastFiveTransactionsEnabled: boolean;
  notesDescriptionEnabled: boolean;
  transactionSidebarCollapsed: boolean;
  purchaseRateEnabled: boolean;
  discountPercentageEnabled: boolean;
  discountAmountEnabled: boolean;
  unit1Enabled: boolean;
  hsnEnabled: boolean;
  unit2Enabled: boolean;
  serialNumberEnabled: boolean;
  itemNameEnabled: boolean;
  barcodeEnabled: boolean;
  accessionCodeEnabled: boolean;
  netAmountEnabled: boolean;
  netRateEnabled: boolean;
  gstPercentageEnabled: boolean;
  printBarcodeAfterPurchase: boolean;
}

const FEATURE_DEFAULTS: ModuleSettings = {
  multiSeriesEnabled: true,
  unitsEnabled: true,
  itemDiscountEnabled: true,
  billDiscountEnabled: true,
  packingEnabled: true, batchEnabled: true, expiryEnabled: true, mfgDateEnabled: true,
  freeQuantityEnabled: true, mrpEnabled: true, sellingRateEnabled: true,
  allowNegativeStock: false,
  allowDuplicateItemCode: false,
  gstPriceMode: 'exclusive',
  barcodeBillingEnabled: true,
  lastFiveTransactionsEnabled: true,
  notesDescriptionEnabled: true,
  transactionSidebarCollapsed: false,
  purchaseRateEnabled: false,
  discountPercentageEnabled: true,
  discountAmountEnabled: true,
  unit1Enabled: true,
  hsnEnabled: true,
  unit2Enabled: false,
  serialNumberEnabled: true,
  itemNameEnabled: true,
  barcodeEnabled: true,
  accessionCodeEnabled: false,
  netAmountEnabled: true,
  netRateEnabled: true,
  gstPercentageEnabled: true,
  printBarcodeAfterPurchase: false,
};


export function setNegativeStockAllowed(firmId: string, value: boolean): boolean {
  const now = new Date().toISOString();
  const normalized = value ? 'true' : 'false';
  // Canonicalize every legacy copy so the setting used by billing is deterministic.
  db.prepare("DELETE FROM firm_settings WHERE firmId=? AND settingKey='allowNegativeStock'").run(firmId);
  db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'inventory_global', 'allowNegativeStock', ?, ?)")
    .run(uuidv4(), firmId, normalized, now);
  return value;
}

export function syncNegativeStockFromRequest(firmId: string, raw: unknown): boolean {
  if (typeof raw === 'boolean') return setNegativeStockAllowed(firmId, raw);
  return getNegativeStockAllowed(firmId);
}

export function getNegativeStockAllowed(firmId: string): boolean {
  const globals:any[] = db.prepare(
    "SELECT id, settingValue, updatedAt FROM firm_settings WHERE firmId=? AND settingType='inventory_global' AND settingKey='allowNegativeStock' ORDER BY datetime(updatedAt) DESC, rowid DESC"
  ).all(firmId) as any[];

  if (globals.length > 1) {
    // Self-heal databases created by older builds that accidentally accumulated
    // multiple copies of this setting. The newest value is the user's latest
    // decision; collapse everything to one authoritative row immediately.
    const value = String(globals[0]?.settingValue || 'false');
    const now = new Date().toISOString();
    db.prepare("DELETE FROM firm_settings WHERE firmId=? AND settingType='inventory_global' AND settingKey='allowNegativeStock'").run(firmId);
    db.prepare("INSERT INTO firm_settings (id,firmId,settingType,settingKey,settingValue,updatedAt) VALUES (?,?,?,?,?,?)")
      .run(uuidv4(), firmId, 'inventory_global', 'allowNegativeStock', value, now);
    return /^(true|1|yes|on)$/i.test(value.trim());
  }

  if (globals.length === 1) {
    return /^(true|1|yes|on)$/i.test(String(globals[0].settingValue || '').trim());
  }

  // Legacy fallback only when no canonical global setting exists at all.
  const legacy:any = db.prepare(
    "SELECT settingValue FROM firm_settings WHERE firmId=? AND settingKey='allowNegativeStock' AND settingType <> 'inventory_global' ORDER BY datetime(updatedAt) DESC, rowid DESC LIMIT 1"
  ).get(firmId);
  return /^(true|1|yes|on)$/i.test(String(legacy?.settingValue || '').trim());
}

export function getModuleSettings(firmId: string, moduleKey: string): ModuleSettings {
  const rows = db.prepare(
    'SELECT settingKey, settingValue FROM firm_settings WHERE firmId = ? AND settingType = ?'
  ).all(firmId, moduleKey) as any[];

  const out: ModuleSettings = { ...FEATURE_DEFAULTS };
  const moduleStoredKeys = new Set<string>();
  for (const r of rows) {
    moduleStoredKeys.add(String(r.settingKey));
    if (r.settingKey === 'multiSeriesEnabled')  out.multiSeriesEnabled  = r.settingValue === 'true';
    if (r.settingKey === 'unitsEnabled')         out.unitsEnabled         = r.settingValue === 'true';
    if (r.settingKey === 'itemDiscountEnabled')  out.itemDiscountEnabled  = r.settingValue === 'true';
    if (r.settingKey === 'billDiscountEnabled')  out.billDiscountEnabled  = r.settingValue === 'true';
    if (r.settingKey === 'packingEnabled')       out.packingEnabled       = r.settingValue === 'true';
    if (r.settingKey === 'batchEnabled')         out.batchEnabled         = r.settingValue === 'true';
    if (r.settingKey === 'expiryEnabled')        out.expiryEnabled        = r.settingValue === 'true';
    if (r.settingKey === 'mfgDateEnabled')       out.mfgDateEnabled       = r.settingValue === 'true';
    if (r.settingKey === 'freeQuantityEnabled')  out.freeQuantityEnabled  = r.settingValue === 'true';
    if (r.settingKey === 'mrpEnabled')           out.mrpEnabled           = r.settingValue === 'true';
    if (r.settingKey === 'sellingRateEnabled')   out.sellingRateEnabled   = r.settingValue === 'true';
    if (r.settingKey === 'allowDuplicateItemCode') out.allowDuplicateItemCode = r.settingValue === 'true';
    if (r.settingKey === 'allowNegativeStock') out.allowNegativeStock = /^(true|1|yes|on)$/i.test(String(r.settingValue || '').trim());
    if (r.settingKey === 'gstPriceMode') out.gstPriceMode = r.settingValue === 'inclusive' ? 'inclusive' : 'exclusive';
    if (r.settingKey === 'barcodeBillingEnabled') out.barcodeBillingEnabled = r.settingValue === 'true';
    if (r.settingKey === 'lastFiveTransactionsEnabled') out.lastFiveTransactionsEnabled = r.settingValue === 'true';
    if (r.settingKey === 'notesDescriptionEnabled') out.notesDescriptionEnabled = r.settingValue === 'true';
    if (r.settingKey === 'transactionSidebarCollapsed') out.transactionSidebarCollapsed = r.settingValue === 'true';
    if (r.settingKey === 'purchaseRateEnabled') out.purchaseRateEnabled = r.settingValue === 'true';
    if (r.settingKey === 'discountPercentageEnabled') out.discountPercentageEnabled = r.settingValue === 'true';
    if (r.settingKey === 'discountAmountEnabled') out.discountAmountEnabled = r.settingValue === 'true';
    if (r.settingKey === 'unit1Enabled') out.unit1Enabled = r.settingValue === 'true';
    if (r.settingKey === 'hsnEnabled') out.hsnEnabled = r.settingValue === 'true';
    if (r.settingKey === 'unit2Enabled') out.unit2Enabled = r.settingValue === 'true';
    if (r.settingKey === 'serialNumberEnabled') out.serialNumberEnabled = r.settingValue === 'true';
    if (r.settingKey === 'itemNameEnabled') out.itemNameEnabled = r.settingValue === 'true';
    if (r.settingKey === 'barcodeEnabled') out.barcodeEnabled = r.settingValue === 'true';
    if (r.settingKey === 'accessionCodeEnabled') out.accessionCodeEnabled = r.settingValue === 'true';
    if (r.settingKey === 'netAmountEnabled') out.netAmountEnabled = r.settingValue === 'true';
    if (r.settingKey === 'netRateEnabled') out.netRateEnabled = r.settingValue === 'true';
    if (r.settingKey === 'gstPercentageEnabled') out.gstPercentageEnabled = r.settingValue === 'true';
    if (r.settingKey === 'printBarcodeAfterPurchase') out.printBarcodeAfterPurchase = r.settingValue === 'true';
  }
  const globalRows = db.prepare("SELECT settingKey, settingValue FROM firm_settings WHERE firmId=? AND settingType='inventory_global' ORDER BY datetime(updatedAt) DESC, rowid DESC").all(firmId) as any[];
  // Negative stock is a firm-wide inventory policy, not a per-document override.
  // Always let the inventory_global value be authoritative so a stale module-level
  // allowNegativeStock=false can never block billing after the firm setting is enabled.
  const seenGlobal = new Set<string>();
  for (const r of globalRows) {
    const key = String(r.settingKey);
    if (seenGlobal.has(key)) continue;
    seenGlobal.add(key);
    if (key === 'allowNegativeStock') {
      (out as any).allowNegativeStock = /^(true|1|yes|on)$/i.test(String(r.settingValue || '').trim());
    } else if (['packingEnabled','batchEnabled','expiryEnabled','mfgDateEnabled','freeQuantityEnabled','mrpEnabled','sellingRateEnabled'].includes(key) && key in out) {
      // Firm-wide inventory controls are authoritative everywhere. A stale
      // module-level value must never re-enable a feature disabled in
      // Module Management.
      (out as any)[key] = r.settingValue === 'true';
    } else if (key in out && !moduleStoredKeys.has(key)) {
      (out as any)[key] = r.settingValue === 'true';
    }
  }
  return out;
}

export function getAllModuleSettings(firmId: string): Record<string, ModuleSettings> {
  const modules: string[] = [...DOCUMENT_MODULES, 'items'];
  const out: Record<string, ModuleSettings> = {};
  for (const m of modules) out[m] = getModuleSettings(firmId, m);
  return out;
}


// ── C. Item Master column visibility (per firm) ─────────────────────────────
export const ITEM_COLUMN_KEYS = [
  'itemCode','barcode','name','currentStock','type','packing','unitShortName',
  'mrp','purchasePrice','salePrice','taxRate','hsnCode','company','category',
  'minStockLevel','actions',
] as const;
export type ItemColumnKey = typeof ITEM_COLUMN_KEYS[number];

export const ITEM_COLUMN_LABELS: Record<ItemColumnKey,string> = {
  itemCode:'Item Code', barcode:'Barcode', name:'Item Name', currentStock:'Stock',
  type:'Type', packing:'Packages', unitShortName:'Units', mrp:'MRP',
  purchasePrice:'Purchase Rate', salePrice:'Sale Rate', taxRate:'GST', hsnCode:'HSN',
  company:'Company', category:'Category', minStockLevel:'Minimum Stock', actions:'Actions',
};

const ITEM_COLUMN_DEFAULTS: Record<ItemColumnKey,boolean> = {
  itemCode:true, barcode:true, name:true, currentStock:true, type:true, packing:true,
  unitShortName:true, mrp:true, purchasePrice:true, salePrice:true, taxRate:true,
  hsnCode:false, company:false, category:false, minStockLevel:false, actions:true,
};

export function getItemColumnSettings(firmId: string): Record<ItemColumnKey,boolean> {
  const rows = db.prepare(
    "SELECT settingKey, settingValue FROM firm_settings WHERE firmId=? AND settingType='item_column_visibility'"
  ).all(firmId) as any[];
  const out = { ...ITEM_COLUMN_DEFAULTS };
  for (const r of rows) {
    if ((ITEM_COLUMN_KEYS as readonly string[]).includes(String(r.settingKey))) {
      (out as any)[r.settingKey] = String(r.settingValue) === 'true';
    }
  }
  // Never permit an empty table. Item Name is the safe fallback.
  if (!Object.values(out).some(Boolean)) out.name = true;
  return out;
}

export function setItemColumnVisibility(firmId: string, updates: Partial<Record<ItemColumnKey,boolean>>): Record<ItemColumnKey,boolean> {
  const current = getItemColumnSettings(firmId);
  const next = { ...current, ...updates };
  if (!Object.values(next).some(Boolean)) throw new Error('At least one Item Master column must remain enabled.');
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    for (const key of ITEM_COLUMN_KEYS) {
      if (!(key in updates)) continue;
      const value = !!(updates as any)[key];
      const existing = db.prepare("SELECT id FROM firm_settings WHERE firmId=? AND settingType='item_column_visibility' AND settingKey=?").get(firmId,key);
      if (existing) db.prepare("UPDATE firm_settings SET settingValue=?, updatedAt=? WHERE firmId=? AND settingType='item_column_visibility' AND settingKey=?").run(String(value),now,firmId,key);
      else db.prepare("INSERT INTO firm_settings (id,firmId,settingType,settingKey,settingValue,updatedAt) VALUES (?,?,?,?,?,?)").run(uuidv4(),firmId,'item_column_visibility',key,String(value),now);
    }
  });
  txn();
  return getItemColumnSettings(firmId);
}

// ── B. Visibility-toggle types ───────────────────────────────────────────────

/**
 * Every nav item that can be independently shown/hidden.
 * Groups (sales_group, purchase_group, hr_group, etc.) are derived in the
 * frontend from their children — they cannot be toggled independently here;
 * toggle individual children instead.
 */
export const VISIBILITY_MODULES = [
  // Top-level navigation headers (Home and Settings remain protected/core)
  'master_items', 'master_parties', 'sales_group', 'purchase_group', 'accounting_group', 'stock_management', 'reports_group', 'crm_group', 'hr_group', 'data_sync', 'utilities_group',
  // Items
  'items', 'item_history', 'batch_report', 'godowns', 'opening_stock',
  // Stock Management
  'stock_transfer', 'physical_stock', 'manufacturing',
  // Parties
  'parties', 'ledger', 'opening_balance',
  // Sell
  'sale_invoice', 'pos_billing', 'counter_sale', 'sale_quotation', 'sale_proforma', 'sale_order', 'delivery_challan', 'sale_return', 'sale_return_challan', 'job_work_out',
  // Purchase
  'purchase_invoice', 'purchase_order', 'purchase_challan', 'purchase_return', 'purchase_return_challan', 'job_work_in',
  // Accounting Transaction
  'payment_in', 'payment_out', 'accounting_entries', 'debit_note', 'credit_note', 'bank', 'expenses',
  // Reports
  'report_pl', 'report_stock', 'report_outstanding', 'report_daybook', 'report_gst', 'report_center',
  // CRM
  'loyalty_points', 'lead_management', 'approval_matrix',
  // HR / Payroll
  'employees', 'attendance', 'payroll',
  // Utilities & Tools
  'utility_non_working_data', 'utility_data_backup', 'utility_merge_master', 'utility_invoice_design', 'utility_invoice_template', 'utility_barcode_template', 'utility_download_invoice_design', 'utility_recycle_bin', 'utility_import_method', 'utility_new_financial_year', 'utility_transaction_locking', 'utility_datasync_details', 'utility_tally_export', 'utility_export_import_manager',
] as const;

export type VisibilityKey = typeof VISIBILITY_MODULES[number];

export type VisibilityMap = Record<VisibilityKey, boolean>;

const VISIBILITY_TYPE = 'module_visibility';

export function getVisibilitySettings(firmId: string): VisibilityMap {
  const rows = db.prepare(
    'SELECT settingKey, settingValue FROM firm_settings WHERE firmId = ? AND settingType = ?'
  ).all(firmId, VISIBILITY_TYPE) as any[];

  // Default: core modules visible; advanced/optional workflows are opt-in.
  const defaultOff = new Set(['manufacturing', 'sale_proforma', 'job_work_in', 'job_work_out']);
  const out = Object.fromEntries(VISIBILITY_MODULES.map(k => [k, !defaultOff.has(k)])) as VisibilityMap;
  for (const r of rows) {
    if (r.settingKey in out) {
      (out as any)[r.settingKey] = r.settingValue === 'true';
    }
  }
  // Physical Stock is a core stock-control screen. Never let a stale/legacy
  // visibility row make the sidebar item clickable but immediately bounce
  // back to Dashboard. The module is always available; access can still be
  // controlled by the normal subscription/permission layer when applicable.
  out.physical_stock = true;

  // Manufacturing is the hard parent switch for manufacturing-specific workflows.
  // Job Work cannot surface anywhere while Manufacturing is disabled.
  if (out.manufacturing === false) {
    out.job_work_in = false;
    out.job_work_out = false;
  }
  return out;
}

export function setVisibility(firmId: string, moduleKey: string, visible: boolean): void {
  const now = new Date().toISOString();
  const existing = db.prepare(
    'SELECT id FROM firm_settings WHERE firmId = ? AND settingType = ? AND settingKey = ?'
  ).get(firmId, VISIBILITY_TYPE, moduleKey);

  if (existing) {
    db.prepare(
      'UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = ? AND settingKey = ?'
    ).run(String(visible), now, firmId, VISIBILITY_TYPE, moduleKey);
  } else {
    db.prepare(
      'INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), firmId, VISIBILITY_TYPE, moduleKey, String(visible), now);
  }
}

export function setVisibilityBulk(firmId: string, updates: Partial<VisibilityMap>): void {
  const txn = db.transaction(() => {
    for (const [key, val] of Object.entries(updates)) {
      setVisibility(firmId, key, !!val);
    }
  });
  txn();
}



