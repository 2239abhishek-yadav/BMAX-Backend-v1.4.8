import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { getNegativeStockAllowed } from '../lib/moduleSettings';
import {
  getAllModuleSettings, getModuleSettings,
  getVisibilitySettings, setVisibilityBulk, VISIBILITY_MODULES,
  getItemColumnSettings, setItemColumnVisibility, ITEM_COLUMN_KEYS, ITEM_COLUMN_LABELS,
} from '../lib/moduleSettings';

const router = Router();

// ── Theme preference ────────────────────────────────────────────────────────
// Theme selection is persisted server-side per firm. The renderer may cache the
// last selection locally for the pre-login screen, but once a firm is loaded the
// backend value becomes the source of truth.
const THEME_MODES = ['ultra', 'dark', 'unique'];

router.get('/:firmId/theme', (req: Request, res: Response) => {
  try {
    const rows = db.prepare(
      "SELECT settingKey, settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'ui_theme'"
    ).all(req.params.firmId) as any[];
    const cfg: any = {};
    for (const row of rows) cfg[row.settingKey] = row.settingValue;
    const savedMode = String(cfg.mode || '');
    // B-MAX Light was removed; migrate legacy/unknown values to the approved Ultra default.
    const mode = THEME_MODES.includes(savedMode) ? savedMode : 'ultra';
    const enabled = cfg.enabled === undefined ? true : String(cfg.enabled) !== 'false';
    res.json({ success: true, data: { mode, enabled, modes: THEME_MODES } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:firmId/theme', (req: Request, res: Response) => {
  try {
    const firmId = String(req.params.firmId);
    const mode = String(req.body?.mode || 'ultra');
    const enabled = req.body?.enabled === undefined ? true : Boolean(req.body.enabled);
    if (!THEME_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid theme mode.' });
    const now = new Date().toISOString();
    const upsert = (key: string, value: string) => {
      const existing = db.prepare(
        "SELECT id FROM firm_settings WHERE firmId = ? AND settingType = 'ui_theme' AND settingKey = ?"
      ).get(firmId, key);
      if (existing) db.prepare(
        "UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'ui_theme' AND settingKey = ?"
      ).run(value, now, firmId, key);
      else db.prepare(
        "INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'ui_theme', ?, ?, ?)"
      ).run(uuidv4(), firmId, key, value, now);
    };
    upsert('mode', mode);
    upsert('enabled', enabled ? 'true' : 'false');
    res.json({ success: true, data: { mode, enabled, modes: THEME_MODES } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET all settings for a firm
router.get('/:firmId', (req: Request, res: Response) => {
  try {
    const settings = db.prepare('SELECT * FROM firm_settings WHERE firmId = ?').all(req.params.firmId);
    const obj: any = {};
    for (const s of settings as any[]) {
      if (!obj[s.settingType]) obj[s.settingType] = {};
      obj[s.settingType][s.settingKey] = s.settingValue;
    }
    res.json({ success: true, data: obj });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT update general settings
router.put('/:firmId', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const settings = req.body;
    for (const [type, values] of Object.entries(settings)) {
      for (const [key, value] of Object.entries(values as any)) {
        // Multi-tab billing was removed; legacy clients must not recreate this control.
        if (type === 'ui_controls' && key === 'posMultipleTabs') continue;
        const firmWideInventoryKeys = new Set([
          'packingEnabled','batchEnabled','expiryEnabled','mfgDateEnabled',
          'freeQuantityEnabled','mrpEnabled','sellingRateEnabled','allowNegativeStock'
        ]);
        if (type === 'inventory_global' && firmWideInventoryKeys.has(key)) {
          // These controls are genuinely firm-wide. Canonicalize the value and
          // remove stale module-level rows so no individual screen can override
          // the user's global decision. The underlying business data is retained.
          db.prepare('DELETE FROM firm_settings WHERE firmId=? AND settingType=? AND settingKey=?').run(req.params.firmId, 'inventory_global', key);
          db.prepare('DELETE FROM firm_settings WHERE firmId=? AND settingType<>? AND settingKey=?').run(req.params.firmId, 'inventory_global', key);
          db.prepare('INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), req.params.firmId, 'inventory_global', key, String(value === true || /^(true|1|yes|on)$/i.test(String(value))), now);
          continue;
        }
        const existing = db.prepare('SELECT id FROM firm_settings WHERE firmId = ? AND settingType = ? AND settingKey = ?').get(req.params.firmId, type, key);
        if (existing) {
          db.prepare('UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = ? AND settingKey = ?').run(String(value), now, req.params.firmId, type, key);
        } else {
          db.prepare('INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(uuidv4(), req.params.firmId, type, key, String(value), now);
        }
      }
    }
    res.json({ success: true, data: { inventory_global: { allowNegativeStock: getNegativeStockAllowed(req.params.firmId) } } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});


// ── Local OCR Import feature toggle ─────────────────────────────────────────
// This setting only enables/disables the local OCR workflow. No provider, API key,
// or remote OCR endpoint is configured or called from this feature.
router.get('/:firmId/ai', (req: Request, res: Response) => {
  try {
    const rows = db.prepare("SELECT settingKey, settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'ai'").all(req.params.firmId) as any[];
    const cfg: any = Object.fromEntries(rows.map((r:any) => [r.settingKey, r.settingValue]));
    // Remove obsolete cloud-AI credentials/configuration from earlier versions.
    db.prepare("DELETE FROM firm_settings WHERE firmId = ? AND settingType = 'ai' AND settingKey IN ('apiKey','provider','model')").run(req.params.firmId);
    res.json({ success:true, data:{ enabled: cfg.enabled === undefined ? true : String(cfg.enabled) !== 'false', engine:'tesseract.js-local' } });
  } catch (err:any) { res.status(500).json({ error:err.message }); }
});

router.put('/:firmId/ai', (req: Request, res: Response) => {
  try {
    const firmId = String(req.params.firmId);
    const enabled = req.body?.enabled === true || /^(true|1|yes|on)$/i.test(String(req.body?.enabled));
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM firm_settings WHERE firmId = ? AND settingType = 'ai' AND settingKey = 'enabled'").get(firmId) as any;
    if (existing) db.prepare("UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'ai' AND settingKey = 'enabled'").run(enabled ? 'true' : 'false', now, firmId);
    else db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'ai', 'enabled', ?, ?)").run(uuidv4(), firmId, enabled ? 'true' : 'false', now);
    // Delete legacy cloud provider settings and any previously saved API key.
    db.prepare("DELETE FROM firm_settings WHERE firmId = ? AND settingType = 'ai' AND settingKey IN ('apiKey','provider','model')").run(firmId);
    res.json({ success:true, data:{ enabled, engine:'tesseract.js-local' } });
  } catch (err:any) { res.status(500).json({ error:err.message }); }
});

// Persist first-time AI item-name mappings per firm. The source name is normalized
// so the same printed vendor description is resolved automatically on future bills.
router.get('/:firmId/ai/item-mappings', (req: Request, res: Response) => {
  try {
    const rows = db.prepare("SELECT settingKey, settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'ai_item_mapping'").all(req.params.firmId) as any[];
    const data:any = {};
    for (const r of rows) data[r.settingKey] = r.settingValue;
    res.json({success:true,data});
  } catch (err:any) { res.status(500).json({error:err.message}); }
});

router.post('/:firmId/ai/item-mapping', (req: Request, res: Response) => {
  try {
    const sourceName = String(req.body?.sourceName || '').trim();
    const itemId = String(req.body?.itemId || '').trim();
    if (!sourceName || !itemId) return res.status(400).json({error:'sourceName and itemId are required'});
    const key = sourceName.toLowerCase().replace(/\\s+/g,' ').trim().slice(0,180);
    const existing = db.prepare("SELECT id FROM firm_settings WHERE firmId = ? AND settingType = 'ai_item_mapping' AND settingKey = ?").get(req.params.firmId,key);
    if (existing) db.prepare("UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'ai_item_mapping' AND settingKey = ?").run(itemId,new Date().toISOString(),req.params.firmId,key);
    else db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'ai_item_mapping', ?, ?, ?)").run(uuidv4(),req.params.firmId,key,itemId,new Date().toISOString());
    res.json({success:true,data:{sourceName,itemId}});
  } catch (err:any) { res.status(500).json({error:err.message}); }
});



// ── Transaction template management ─────────────────────────────────────────
// Server is the source of truth for saved invoice/document layouts.  The
// frontend only edits the JSON schema below; the API validates the schema
// before it is stored so an arbitrary object cannot become a print template.
const TEMPLATE_FORMAT_IDS = ['thermal_3','thermal_4','a4','a4_half','a5','a5_half','batch_a4','colorful_a4'];
const TEMPLATE_TYPES = ['sale_invoice','pos_billing','sale_order','sale_quotation','sale_proforma','delivery_challan','sale_return','sale_return_challan','credit_note','job_work_out','purchase_invoice','purchase_order','purchase_challan','purchase_return','purchase_return_challan','debit_note','job_work_in','receipt_voucher','payment_voucher'];
const TEMPLATE_ELEMENT_TYPES = ['text','logo','company_field','document_title','document_meta','party','address','item_table','totals','amount_words','bank_details','upi_qr','upi_id','signature','terms','footer','payment_details','bill_adjustment','mode_details','narration','party_balance'];
const TEMPLATE_ALIGN = ['left','center','right'];
const DESIGN_MAX_BYTES = 700000;

function cleanTemplateDesign(input:any, formatId:string) {
  const d = input && typeof input === 'object' ? input : {};
  const settings = d.settings && typeof d.settings === 'object' ? d.settings : {};
  const upi = settings.upi && typeof settings.upi === 'object' ? settings.upi : {};
  const cols = settings.itemColumns && typeof settings.itemColumns === 'object' ? settings.itemColumns : {};
  const labels = settings.labels && typeof settings.labels === 'object' ? settings.labels : {};
  const elements = Array.isArray(d.elements) ? d.elements.slice(0, 80).map((e:any, i:number) => {
    const el = e && typeof e === 'object' ? e : {};
    const n = (v:any, fallback:number) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : fallback;
    const font = Number.isFinite(Number(el.fontSize)) ? Math.max(6, Math.min(72, Number(el.fontSize))) : 9;
    const weight = Number.isFinite(Number(el.fontWeight)) ? Math.max(300, Math.min(1000, Number(el.fontWeight))) : 700;
    return {
      id: String(el.id || `el_${i}`).slice(0, 80),
      type: TEMPLATE_ELEMENT_TYPES.includes(String(el.type)) ? String(el.type) : 'text',
      label: String(el.label || 'Element').slice(0, 120),
      x:n(el.x,4), y:n(el.y,4), w:Math.max(1,Math.min(100,n(el.w,30))), h:Math.max(1,Math.min(100,n(el.h,8))),
      enabled: el.enabled !== false, fontSize:font, fontWeight:weight,
      align:TEMPLATE_ALIGN.includes(String(el.align)) ? String(el.align) : 'left',
      text:String(el.text || '').slice(0, 2000), z:Math.max(0,Math.min(999,Number(el.z)||10)),
      settings: el.settings && typeof el.settings === 'object' ? JSON.parse(JSON.stringify(el.settings)).toString().length < 10000 ? el.settings : {} : {}
    };
  }) : [];
  const itemColumns:any = {};
  for (const k of ['serial','item','hsn','batch','expiry','mrp','qty','unit','rate','discount','gst','amount']) itemColumns[k] = cols[k] !== false;
  const cleanLabels:any = {};
  for (const k of ['item','hsn','batch','expiry','mrp','qty','unit','rate','discount','gst','amount']) cleanLabels[k] = String(labels[k] || k).slice(0,80);
  return {
    version:2, formatId,
    name:String(d.name || `${formatId} Template`).slice(0,120),
    settings:{
      fontFamily:['Arial','Verdana','Tahoma','Georgia'].includes(String(settings.fontFamily)) ? String(settings.fontFamily) : 'Arial',
      fontSize:Math.max(6,Math.min(30,Number(settings.fontSize)||9)), lineHeight:Math.max(1,Math.min(2.5,Number(settings.lineHeight)||1.35)),
      showBorder:settings.showBorder !== false,
      borderColor:String(settings.borderColor||'#cfd9df').slice(0,20),
      accentColor:String(settings.accentColor||'#1d6f72').slice(0,20),
      headerColor:String(settings.headerColor||'#ffffff').slice(0,20),
      tableHeaderColor:String(settings.tableHeaderColor||settings.accentColor||'#ffffff').slice(0,20),
      totalColor:String(settings.totalColor||settings.accentColor||'#ffffff').slice(0,20),
      footerColor:String(settings.footerColor||'#ffffff').slice(0,20),
      textColor:String(settings.textColor||'#182a33').slice(0,20),
      pageBackground:String(settings.pageBackground||'#ffffff').slice(0,20),
      pagePadding:Math.max(0,Math.min(12,Number.isFinite(Number(settings.pagePadding))?Number(settings.pagePadding):4)),
      upi:{enabled:upi.enabled !== false, vpa:String(upi.vpa||'').slice(0,120), payeeName:String(upi.payeeName||'').slice(0,120), amountMode:upi.amountMode==='blank'?'blank':'invoice', note:String(upi.note||'Payment').slice(0,120)},
      itemColumns, labels:cleanLabels
    }, elements
  };
}

function cleanTransactionTemplateConfig(incoming:any) {
  const body = incoming && typeof incoming === 'object' ? incoming : {};
  const clean:any = { defaults:{}, enabled:{}, designs:{} };
  for (const type of TEMPLATE_TYPES) {
    const def = String(body.defaults?.[type] || ((type === 'sale_invoice' || type === 'pos_billing' || type === 'receipt_voucher' || type === 'payment_voucher') ? 'thermal_3' : 'a4'));
    clean.defaults[type] = TEMPLATE_FORMAT_IDS.includes(def) ? def : ((type === 'sale_invoice' || type === 'pos_billing' || type === 'receipt_voucher' || type === 'payment_voucher') ? 'thermal_3' : 'a4');
    clean.enabled[type] = {};
    clean.designs[type] = {};
    for (const format of TEMPLATE_FORMAT_IDS) {
      clean.enabled[type][format] = body.enabled?.[type]?.[format] !== false;
      if (body.designs?.[type]?.[format]) clean.designs[type][format] = cleanTemplateDesign(body.designs[type][format], format);
    }
    if (clean.enabled[type][clean.defaults[type]] === false) {
      const first = TEMPLATE_FORMAT_IDS.find(f => clean.enabled[type][f] !== false);
      if (first) clean.defaults[type] = first;
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(clean), 'utf8');
  if (bytes > DESIGN_MAX_BYTES) throw new Error('Template configuration is too large. Please reduce the number of custom elements.');
  return clean;
}

router.get('/:firmId/transaction-templates', (req: Request, res: Response) => {
  try {
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(req.params.firmId) as any;
    let data:any = {};
    try { data = row?.settingValue ? JSON.parse(String(row.settingValue)) : {}; } catch { data = {}; }
    res.json({ success:true, data });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

router.put('/:firmId/transaction-templates', (req: Request, res: Response) => {
  try {
    const firmId = String(req.params.firmId);
    const clean = cleanTransactionTemplateConfig(req.body);
    const json = JSON.stringify(clean); const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(firmId) as any;
    if (existing) db.prepare("UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").run(json,now,firmId);
    else db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'transaction_templates', 'config', ?, ?)").run(uuidv4(),firmId,json,now);
    res.json({success:true,data:clean});
  } catch (err:any) { res.status(400).json({error:err.message}); }
});


// ── Transaction template direct design API ──────────────────────────────────
// These endpoints are intentionally document+format specific.  The billing
// preview uses them so it can never silently fall back to a generic/default
// renderer when a saved design exists on the server.
router.put('/:firmId/transaction-templates/:transactionType/default', (req: Request, res: Response) => {
  try {
    const { firmId, transactionType } = req.params; const formatId = String(req.body?.formatId || '');
    if (!TEMPLATE_TYPES.includes(transactionType)) return res.status(400).json({error:'Invalid transaction template type'});
    if (!TEMPLATE_FORMAT_IDS.includes(formatId)) return res.status(400).json({error:'Invalid template format'});
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(firmId) as any;
    let current:any = {}; try { current = row?.settingValue ? JSON.parse(String(row.settingValue)) : {}; } catch { current = {}; }
    const cfg = cleanTransactionTemplateConfig(current);
    if (cfg.enabled[transactionType][formatId] === false) return res.status(400).json({error:'Enable this format before setting it as default'});
    cfg.defaults[transactionType] = formatId;
    const json = JSON.stringify(cfg); const now = new Date().toISOString();
    if (row) db.prepare("UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").run(json,now,firmId);
    else db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'transaction_templates', 'config', ?, ?)").run(uuidv4(),firmId,json,now);
    res.json({success:true,data:{formatId}});
  } catch (err:any) { res.status(400).json({error:err.message}); }
});

router.put('/:firmId/transaction-templates/:transactionType/enabled/:formatId', (req: Request, res: Response) => {
  try {
    const { firmId, transactionType, formatId } = req.params; const enabled = req.body?.enabled !== false;
    if (!TEMPLATE_TYPES.includes(transactionType)) return res.status(400).json({error:'Invalid transaction template type'});
    if (!TEMPLATE_FORMAT_IDS.includes(formatId)) return res.status(400).json({error:'Invalid template format'});
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(firmId) as any;
    let current:any = {}; try { current = row?.settingValue ? JSON.parse(String(row.settingValue)) : {}; } catch { current = {}; }
    const cfg = cleanTransactionTemplateConfig(current); cfg.enabled[transactionType][formatId] = !!enabled;
    if (!enabled && cfg.defaults[transactionType] === formatId) { const alt=TEMPLATE_FORMAT_IDS.find(f=>cfg.enabled[transactionType][f]!==false); if (alt) cfg.defaults[transactionType]=alt; }
    const json=JSON.stringify(cfg); const now=new Date().toISOString();
    if (row) db.prepare("UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").run(json,now,firmId);
    else db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'transaction_templates', 'config', ?, ?)").run(uuidv4(),firmId,json,now);
    res.json({success:true,data:{enabled:cfg.enabled[transactionType][formatId],default:cfg.defaults[transactionType]}});
  } catch (err:any) { res.status(400).json({error:err.message}); }
});

router.get('/:firmId/transaction-templates/:transactionType/:formatId', (req: Request, res: Response) => {
  try {
    const { firmId, transactionType, formatId } = req.params;
    if (!TEMPLATE_TYPES.includes(transactionType)) return res.status(400).json({error:'Invalid transaction template type'});
    if (!TEMPLATE_FORMAT_IDS.includes(formatId)) return res.status(400).json({error:'Invalid template format'});
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(firmId) as any;
    let cfg:any = {};
    try { cfg = row?.settingValue ? JSON.parse(String(row.settingValue)) : {}; } catch { cfg = {}; }
    const raw = cfg?.designs?.[transactionType]?.[formatId];
    const design = raw ? cleanTemplateDesign(raw, formatId) : null;
    res.json({success:true,data:{firmId,transactionType,formatId,design,enabled:cfg?.enabled?.[transactionType]?.[formatId] !== false,isDefault:cfg?.defaults?.[transactionType] === formatId}});
  } catch (err:any) { res.status(500).json({error:err.message}); }
});

router.put('/:firmId/transaction-templates/:transactionType/:formatId', (req: Request, res: Response) => {
  try {
    const { firmId, transactionType, formatId } = req.params;
    if (!TEMPLATE_TYPES.includes(transactionType)) return res.status(400).json({error:'Invalid transaction template type'});
    if (!TEMPLATE_FORMAT_IDS.includes(formatId)) return res.status(400).json({error:'Invalid template format'});
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(firmId) as any;
    let current:any = {};
    try { current = row?.settingValue ? JSON.parse(String(row.settingValue)) : {}; } catch { current = {}; }
    const cfg = cleanTransactionTemplateConfig(current);
    const design = cleanTemplateDesign(req.body?.design || req.body, formatId);
    cfg.designs[transactionType][formatId] = design;
    const json = JSON.stringify(cfg); if (Buffer.byteLength(json,'utf8') > DESIGN_MAX_BYTES) throw new Error('Template configuration is too large.');
    const now = new Date().toISOString();
    if (row) db.prepare("UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").run(json,now,firmId);
    else db.prepare("INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, 'transaction_templates', 'config', ?, ?)").run(uuidv4(),firmId,json,now);
    res.json({success:true,data:{firmId,transactionType,formatId,design}});
  } catch (err:any) { res.status(400).json({error:err.message}); }
});

router.get('/:firmId/transaction-templates/:transactionType/:formatId/context', (req: Request, res: Response) => {
  try {
    const { firmId, transactionType, formatId } = req.params;
    if (!TEMPLATE_TYPES.includes(transactionType)) return res.status(400).json({error:'Invalid transaction template type'});
    if (!TEMPLATE_FORMAT_IDS.includes(formatId)) return res.status(400).json({error:'Invalid template format'});
    const row = db.prepare("SELECT settingValue FROM firm_settings WHERE firmId = ? AND settingType = 'transaction_templates' AND settingKey = 'config'").get(firmId) as any;
    let cfg:any = {}; try { cfg = row?.settingValue ? JSON.parse(String(row.settingValue)) : {}; } catch { cfg = {}; }
    const raw = cfg?.designs?.[transactionType]?.[formatId];
    const design = raw ? cleanTemplateDesign(raw, formatId) : null;
    const firm:any = db.prepare('SELECT * FROM firms WHERE id = ?').get(firmId);
    const banks:any[] = db.prepare('SELECT id, accountName, bankName, accountNumber, ifscCode, branchName, upiId, isActive FROM bank_accounts WHERE firmId = ? AND isActive = 1 ORDER BY accountName').all(firmId) as any[];
    const defaultBank = banks.find(b=>String(b?.upiId||'').trim()) || banks[0] || null;
    res.json({success:true,data:{firmId,transactionType,formatId,design,firm:firm||null,banks,defaultBank,enabled:cfg?.enabled?.[transactionType]?.[formatId] !== false,isDefault:cfg?.defaults?.[transactionType] === formatId}});
  } catch (err:any) { res.status(500).json({error:err.message}); }
});

router.get('/:firmId/transaction-templates/qr', async (req: Request, res: Response) => {
  try {
    const vpa = String(req.query.vpa || '').trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(vpa)) return res.status(400).json({error:'Enter a valid UPI ID (example: name@bank)'});
    const name = String(req.query.name || 'B-MAX').slice(0, 100);
    const amountRaw = String(req.query.amount || '').trim();
    const amount = amountRaw && /^\d+(\.\d{1,2})?$/.test(amountRaw) ? amountRaw : '';
    const note = String(req.query.note || 'Payment').slice(0, 100);
    const params = new URLSearchParams({pa:vpa,pn:name,cu:'INR'}); if(amount) params.set('am',amount); if(note) params.set('tn',note);
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(`upi://pay?${params.toString()}`, { errorCorrectionLevel:'M', margin:1, width:300 });
    res.json({success:true,data:{dataUrl,payload:`upi://pay?${params.toString()}`}});
  } catch (err:any) { res.status(400).json({error:err.message}); }
});

// ── Feature-toggle (Multi-Series, Units, Discounts) ──────────────────────────

// GET all module feature settings at once
router.get('/:firmId/modules', (req: Request, res: Response) => {
  try { res.json({ success: true, data: getAllModuleSettings(req.params.firmId) }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET a single module's feature settings
router.get('/:firmId/modules/:moduleKey', (req: Request, res: Response) => {
  try { res.json({ success: true, data: getModuleSettings(req.params.firmId, req.params.moduleKey) }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PUT toggle a module's feature settings
router.put('/:firmId/modules/:moduleKey', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const { firmId, moduleKey } = req.params;
    const { multiSeriesEnabled, unitsEnabled, itemDiscountEnabled, billDiscountEnabled,
      packingEnabled, batchEnabled, expiryEnabled, mfgDateEnabled, freeQuantityEnabled, mrpEnabled, sellingRateEnabled, purchaseRateEnabled, discountPercentageEnabled, discountAmountEnabled, unit1Enabled, unit2Enabled, hsnEnabled, serialNumberEnabled, itemNameEnabled, barcodeEnabled, accessionCodeEnabled, netAmountEnabled, netRateEnabled, gstPercentageEnabled, printBarcodeAfterPurchase, allowDuplicateItemCode, allowNegativeStock, gstPriceMode, barcodeBillingEnabled, lastFiveTransactionsEnabled, notesDescriptionEnabled, transactionSidebarCollapsed } = req.body;

    // Retire legacy quantity/purchase-unit selector settings. The canonical model is Unit 1 + Unit 2.
    db.prepare("DELETE FROM firm_settings WHERE firmId = ? AND settingType = ? AND settingKey IN ('quantity1Enabled','quantity2Enabled','purchaseUnitMode','purchaseRateUnit')").run(firmId, moduleKey);

    const upsert = (key: string, value: boolean | string, settingType = moduleKey) => {
      const existing = db.prepare('SELECT id FROM firm_settings WHERE firmId = ? AND settingType = ? AND settingKey = ?').get(firmId, settingType, key);
      if (existing) db.prepare('UPDATE firm_settings SET settingValue = ?, updatedAt = ? WHERE firmId = ? AND settingType = ? AND settingKey = ?').run(String(value), now, firmId, settingType, key);
      else db.prepare('INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(uuidv4(), firmId, settingType, key, String(value), now);
    };

    if (multiSeriesEnabled !== undefined) upsert('multiSeriesEnabled', !!multiSeriesEnabled);
    if (unitsEnabled !== undefined) upsert('unitsEnabled', !!unitsEnabled);
    if (itemDiscountEnabled !== undefined) upsert('itemDiscountEnabled', !!itemDiscountEnabled);
    if (billDiscountEnabled !== undefined) upsert('billDiscountEnabled', !!billDiscountEnabled);
    if (mrpEnabled !== undefined) upsert('mrpEnabled', !!mrpEnabled);
    if (sellingRateEnabled !== undefined) upsert('sellingRateEnabled', !!sellingRateEnabled);
    if (purchaseRateEnabled !== undefined) upsert('purchaseRateEnabled', !!purchaseRateEnabled);
    if (discountPercentageEnabled !== undefined) upsert('discountPercentageEnabled', !!discountPercentageEnabled);
    if (discountAmountEnabled !== undefined) upsert('discountAmountEnabled', !!discountAmountEnabled);
    if (unit1Enabled !== undefined) upsert('unit1Enabled', !!unit1Enabled);
    if (unit2Enabled !== undefined) upsert('unit2Enabled', !!unit2Enabled);
    if (hsnEnabled !== undefined) upsert('hsnEnabled', !!hsnEnabled);
    if (serialNumberEnabled !== undefined) upsert('serialNumberEnabled', !!serialNumberEnabled);
    if (itemNameEnabled !== undefined) upsert('itemNameEnabled', !!itemNameEnabled);
    if (barcodeEnabled !== undefined) upsert('barcodeEnabled', !!barcodeEnabled);
    if (accessionCodeEnabled !== undefined) upsert('accessionCodeEnabled', !!accessionCodeEnabled);
    if (netAmountEnabled !== undefined) upsert('netAmountEnabled', !!netAmountEnabled);
    if (netRateEnabled !== undefined) upsert('netRateEnabled', !!netRateEnabled);
    if (gstPercentageEnabled !== undefined) upsert('gstPercentageEnabled', !!gstPercentageEnabled);
    if (printBarcodeAfterPurchase !== undefined && moduleKey === 'purchase_invoice') upsert('printBarcodeAfterPurchase', !!printBarcodeAfterPurchase);
    if (allowDuplicateItemCode !== undefined && moduleKey === 'items') upsert('allowDuplicateItemCode', !!allowDuplicateItemCode);
    if (barcodeBillingEnabled !== undefined && ['sale_invoice','pos_billing','counter_sale','sale_order','sale_return','sale_return_challan','sale_quotation','sale_proforma','delivery_challan','job_work_out','purchase_invoice','purchase_order','purchase_challan','purchase_return','purchase_return_challan','job_work_in'].includes(moduleKey)) upsert('barcodeBillingEnabled', !!barcodeBillingEnabled);
    if (lastFiveTransactionsEnabled !== undefined) upsert('lastFiveTransactionsEnabled', !!lastFiveTransactionsEnabled);
    if (notesDescriptionEnabled !== undefined) upsert('notesDescriptionEnabled', !!notesDescriptionEnabled);
    if (transactionSidebarCollapsed !== undefined) upsert('transactionSidebarCollapsed', !!transactionSidebarCollapsed);
    const documentModuleKeys = new Set([
      'sale_invoice','pos_billing','counter_sale','sale_order','sale_return','sale_return_challan','sale_quotation','sale_proforma','delivery_challan','job_work_out',
      'purchase_invoice','purchase_order','purchase_challan','purchase_return','purchase_return_challan','job_work_in',
    ]);
    if (gstPriceMode !== undefined && documentModuleKeys.has(moduleKey)) {
      if (!['exclusive','inclusive'].includes(String(gstPriceMode))) return res.status(400).json({error:'gstPriceMode must be exclusive or inclusive'});
      upsert('gstPriceMode', String(gstPriceMode));
    }
    for (const [key,value] of Object.entries({packingEnabled,batchEnabled,expiryEnabled,mfgDateEnabled,freeQuantityEnabled,mrpEnabled,sellingRateEnabled,allowNegativeStock})) {
      if (value !== undefined) {
        if (key === 'allowNegativeStock') {
          // Canonicalize this policy to exactly ONE row. Older builds could leave
          // duplicate inventory_global rows; updating an arbitrary matching row
          // while the reader selected the newest row made the UI say ON while the
          // document API still saw OFF. Delete every stale copy, then insert the
          // authoritative value. Also remove any legacy module-local copy.
          db.prepare('DELETE FROM firm_settings WHERE firmId=? AND settingType=? AND settingKey=?').run(firmId, 'inventory_global', key);
          db.prepare('DELETE FROM firm_settings WHERE firmId=? AND settingKey=?').run(firmId, key);
          db.prepare('INSERT INTO firm_settings (id, firmId, settingType, settingKey, settingValue, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), firmId, 'inventory_global', key, String(!!value), now);
        } else {
          upsert(key, !!value, 'inventory_global');
        }
      }
    }

    res.json({ success: true, data: getModuleSettings(firmId, moduleKey) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Item Master column visibility ─────────────────────────────────────────────
router.get('/:firmId/item-columns', (req: Request, res: Response) => {
  try {
    res.json({ success:true, data:getItemColumnSettings(req.params.firmId), labels:ITEM_COLUMN_LABELS, keys:ITEM_COLUMN_KEYS });
  } catch (err:any) { res.status(500).json({ error:err.message }); }
});

router.put('/:firmId/item-columns', (req: Request, res: Response) => {
  try {
    const updates:any = {};
    for (const key of ITEM_COLUMN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key) && typeof req.body[key] === 'boolean') updates[key] = req.body[key];
    }
    res.json({ success:true, data:setItemColumnVisibility(req.params.firmId, updates), labels:ITEM_COLUMN_LABELS, keys:ITEM_COLUMN_KEYS });
  } catch (err:any) { res.status(400).json({ error:err.message }); }
});

// ── Visibility (show/hide entire nav sections) ────────────────────────────────

/**
 * GET /settings/:firmId/visibility
 * Returns a map of moduleKey → boolean (true = visible / enabled).
 * Missing keys default to true (all modules are visible by default).
 */
router.get('/:firmId/visibility', (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: getVisibilitySettings(req.params.firmId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * PUT /settings/:firmId/visibility
 * Body: { moduleKey: boolean, ... }  (partial update — only sent keys are changed)
 * Unknown keys are silently ignored.
 */
router.put('/:firmId/visibility', (req: Request, res: Response) => {
  try {
    const { firmId } = req.params;
    const updates: any = {};
    for (const key of VISIBILITY_MODULES) {
      if (key in req.body && typeof req.body[key] === 'boolean') {
        updates[key] = req.body[key];
      }
    }
    setVisibilityBulk(firmId, updates);
    res.json({ success: true, data: getVisibilitySettings(firmId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

/**
 * PUT /settings/:firmId/visibility/:moduleKey
 * Body: { visible: boolean }
 * Convenience endpoint for toggling a single module.
 */
router.put('/:firmId/visibility/:moduleKey', (req: Request, res: Response) => {
  try {
    const { firmId, moduleKey } = req.params;
    if (!(VISIBILITY_MODULES as readonly string[]).includes(moduleKey)) {
      return res.status(400).json({ error: `Unknown visibility module: ${moduleKey}` });
    }
    const visible = req.body.visible !== undefined ? !!req.body.visible : !(getVisibilitySettings(firmId) as any)[moduleKey];
    setVisibilityBulk(firmId, { [moduleKey]: visible } as any);
    res.json({ success: true, data: getVisibilitySettings(firmId) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;



