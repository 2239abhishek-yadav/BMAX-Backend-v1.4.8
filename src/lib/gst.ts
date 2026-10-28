import { db } from './db';

// Simplified GST engine built from existing document/document_items data.
// Follows the standard GSTR-1 / GSTR-3B table structure (as per CBIC norms) at
// invoice-level and HSN-level granularity. It does NOT model reverse charge,
// exempt/nil-rated/non-GST supplies, advances, ISD credit, or amendments —
// those need to be reviewed manually before filing. Treat this as a working
// summary computed from your own books, not a filing-ready return.

const B2C_LARGE_THRESHOLD = 250000; // Rule 46: interstate invoice value > ₹2.5L to unregistered person

function isInterstate(stateOfSupply: string | null | undefined, firmState: string | null | undefined) {
  if (!stateOfSupply || !firmState) return false;
  return stateOfSupply.trim().toLowerCase() !== firmState.trim().toLowerCase();
}

function firmInfo(firmId: string) {
  return db.prepare('SELECT state, gstin, name, legalName FROM firms WHERE id = ?').get(firmId) as any;
}

// ── GSTR-1 : Outward supplies (Sales) ───────────────────────────────────────
export function computeGstr1(firmId: string, startDate: string, endDate: string) {
  const firm = firmInfo(firmId);
  const firmState = firm?.state;

  const docs = db.prepare(
    `SELECT d.id, d.documentType, d.documentNumber, d.documentDate, d.partyId, d.partyName,
            d.stateOfSupply, d.subtotal, d.discountAmount, d.taxAmount, d.total,
            p.gstin as partyGstin
     FROM documents d LEFT JOIN parties p ON p.id = d.partyId
     WHERE d.firmId = ? AND d.documentType IN ('sale_invoice','sale_return') AND d.isDeleted = 0
       AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ?
     ORDER BY d.documentDate ASC`
  ).all(firmId, startDate, endDate) as any[];

  const b2b: any[] = [];
  const b2cLarge: any[] = [];
  const creditNotes: any[] = [];
  const b2cLargeIds = new Set<string>();

  for (const d of docs) {
    const taxableValue = +((d.subtotal || 0) - (d.discountAmount || 0)).toFixed(2);
    const interstate = isInterstate(d.stateOfSupply, firmState);
    const igst = interstate ? d.taxAmount : 0;
    const cgst = interstate ? 0 : +(d.taxAmount / 2).toFixed(2);
    const sgst = interstate ? 0 : +(d.taxAmount / 2).toFixed(2);
    const row = {
      documentNumber: d.documentNumber, documentDate: d.documentDate, partyName: d.partyName,
      partyGstin: d.partyGstin || '', placeOfSupply: d.stateOfSupply || '', interstate,
      taxableValue, igst, cgst, sgst, invoiceValue: d.total,
    };
    if (d.documentType === 'sale_return') { creditNotes.push(row); continue; }
    if (d.partyGstin) { b2b.push(row); continue; }
    if (interstate && d.total > B2C_LARGE_THRESHOLD) { b2cLarge.push(row); b2cLargeIds.add(d.id); continue; }
    // else: falls into B2C Small, aggregated below from item-level rows
  }

  // Item-level pass — needed for HSN summary (Table 12) and B2C-Small rate-wise
  // aggregation (Table 7), since a single invoice can mix multiple GST rates.
  const items = db.prepare(
    `SELECT di.hsnCode, di.name, di.unit, di.quantity, di.taxRate, di.taxAmount, di.amount,
            d.id as documentId, d.documentType, d.stateOfSupply, d.partyId,
            p.gstin as partyGstin
     FROM document_items di JOIN documents d ON d.id = di.documentId
     LEFT JOIN parties p ON p.id = d.partyId
     WHERE d.firmId = ? AND d.documentType IN ('sale_invoice','sale_return') AND d.isDeleted = 0
       AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ?`
  ).all(firmId, startDate, endDate) as any[];

  const hsnMap = new Map<string, any>();
  const b2cSmallMap = new Map<string, any>();

  for (const it of items) {
    const sign = it.documentType === 'sale_return' ? -1 : 1;
    const taxableValue = (it.amount - it.taxAmount) * sign;
    const taxAmount = it.taxAmount * sign;
    const interstate = isInterstate(it.stateOfSupply, firmState);
    const igst = interstate ? taxAmount : 0;
    const cgst = interstate ? 0 : +(taxAmount / 2).toFixed(2);
    const sgst = interstate ? 0 : +(taxAmount / 2).toFixed(2);

    const hKey = `${it.hsnCode || 'N/A'}|${it.taxRate}|${it.unit || ''}`;
    const h = hsnMap.get(hKey) || { hsnCode: it.hsnCode || 'N/A', description: it.name, unit: it.unit || '',
      taxRate: it.taxRate, quantity: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, totalValue: 0 };
    h.quantity += it.quantity * sign;
    h.taxableValue += taxableValue;
    h.igst += igst; h.cgst += cgst; h.sgst += sgst;
    h.totalValue += taxableValue + taxAmount;
    hsnMap.set(hKey, h);

    // Table 7 (B2C Small): unregistered party, and not already counted as B2C Large invoice.
    if (!it.partyGstin && !b2cLargeIds.has(it.documentId)) {
      const bKey = `${it.stateOfSupply || 'Unknown'}|${it.taxRate}`;
      const b = b2cSmallMap.get(bKey) || { placeOfSupply: it.stateOfSupply || 'Unknown', taxRate: it.taxRate,
        taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
      b.taxableValue += taxableValue; b.igst += igst; b.cgst += cgst; b.sgst += sgst;
      b2cSmallMap.set(bKey, b);
    }
  }

  const round2 = (n: number) => +(n || 0).toFixed(2);
  const hsnSummary = Array.from(hsnMap.values()).map(h => ({ ...h,
    quantity: round2(h.quantity), taxableValue: round2(h.taxableValue), igst: round2(h.igst),
    cgst: round2(h.cgst), sgst: round2(h.sgst), totalValue: round2(h.totalValue) }));
  const b2cSmall = Array.from(b2cSmallMap.values()).map(b => ({ ...b,
    taxableValue: round2(b.taxableValue), igst: round2(b.igst), cgst: round2(b.cgst), sgst: round2(b.sgst) }));

  const sumTax = (rows: any[]) => rows.reduce((s, r) => ({
    taxableValue: s.taxableValue + r.taxableValue, igst: s.igst + r.igst, cgst: s.cgst + r.cgst, sgst: s.sgst + r.sgst,
  }), { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });

  const allOutward = [...b2b, ...b2cLarge, ...b2cSmall];
  const totals = sumTax(allOutward);
  const creditNoteTotals = sumTax(creditNotes);

  return {
    firm: { name: firm?.legalName || firm?.name, gstin: firm?.gstin, state: firm?.state },
    period: { startDate, endDate },
    summary: {
      totalInvoices: b2b.length + b2cLarge.length,
      taxableValue: round2(totals.taxableValue), igst: round2(totals.igst), cgst: round2(totals.cgst), sgst: round2(totals.sgst),
      totalTax: round2(totals.igst + totals.cgst + totals.sgst),
      creditNoteValue: round2(creditNoteTotals.taxableValue), creditNoteTax: round2(creditNoteTotals.igst + creditNoteTotals.cgst + creditNoteTotals.sgst),
    },
    b2b, b2cLarge, b2cSmall, creditNotes, hsnSummary,
  };
}

// ── GSTR-3B : Summary return (outward tax vs input tax credit) ─────────────
export function computeGstr3b(firmId: string, startDate: string, endDate: string) {
  const firm = firmInfo(firmId);
  const firmState = firm?.state;

  const outward = db.prepare(
    `SELECT d.documentType, d.stateOfSupply, d.subtotal, d.discountAmount, d.taxAmount
     FROM documents d WHERE d.firmId = ? AND d.documentType IN ('sale_invoice','sale_return')
       AND d.isDeleted = 0 AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ?`
  ).all(firmId, startDate, endDate) as any[];

  const inward = db.prepare(
    `SELECT d.documentType, d.stateOfSupply, d.subtotal, d.discountAmount, d.taxAmount
     FROM documents d WHERE d.firmId = ? AND d.documentType IN ('purchase_invoice','purchase_return')
       AND d.isDeleted = 0 AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ?`
  ).all(firmId, startDate, endDate) as any[];

  const net = (rows: any[], positiveType: string) => {
    let taxableValue = 0, igst = 0, cgst = 0, sgst = 0;
    for (const d of rows) {
      const sign = d.documentType === positiveType ? 1 : -1;
      const tv = ((d.subtotal || 0) - (d.discountAmount || 0)) * sign;
      const interstate = isInterstate(d.stateOfSupply, firmState);
      const tax = (d.taxAmount || 0) * sign;
      taxableValue += tv;
      if (interstate) igst += tax; else { cgst += tax / 2; sgst += tax / 2; }
    }
    const round2 = (n: number) => +(n || 0).toFixed(2);
    return { taxableValue: round2(taxableValue), igst: round2(igst), cgst: round2(cgst), sgst: round2(sgst) };
  };

  const outwardTaxable = net(outward, 'sale_invoice');
  const itc = net(inward, 'purchase_invoice');

  const round2 = (n: number) => +(n || 0).toFixed(2);
  const netPayable = {
    igst: round2(Math.max(0, outwardTaxable.igst - itc.igst)),
    cgst: round2(Math.max(0, outwardTaxable.cgst - itc.cgst)),
    sgst: round2(Math.max(0, outwardTaxable.sgst - itc.sgst)),
  };

  return {
    firm: { name: firm?.legalName || firm?.name, gstin: firm?.gstin, state: firm?.state },
    period: { startDate, endDate },
    // Table 3.1(a) — outward taxable supplies (net of credit notes), other than zero-rated/nil/exempt
    outwardSupplies: outwardTaxable,
    // Table 4 — eligible ITC ("All other ITC"), net of debit notes to suppliers
    itc,
    // Table 6.1 — net tax payable in cash, per head (simplified: does not model
    // IGST credit set-off against CGST/SGST, which the GST portal applies automatically)
    netTaxPayable: netPayable,
  };
}


export function computeGstr2(firmId: string, startDate: string, endDate: string) {
 const rows=db.prepare(`SELECT d.documentNumber,d.documentDate,d.partyName,p.gstin partyGstin,d.stateOfSupply,d.subtotal,d.discountAmount,d.taxAmount,d.total FROM documents d LEFT JOIN parties p ON p.id=d.partyId WHERE d.firmId=? AND d.documentType IN ('purchase_invoice','purchase_return') AND d.isDeleted=0 AND d.status NOT IN ('cancelled','draft') AND d.documentDate BETWEEN ? AND ? ORDER BY d.documentDate,d.documentNumber`).all(firmId,startDate,endDate) as any[];
 return rows.map(r=>({documentNumber:r.documentNumber,documentDate:r.documentDate,supplier:r.partyName,supplierGstin:r.partyGstin||'',placeOfSupply:r.stateOfSupply||'',taxableValue:+((r.subtotal||0)-(r.discountAmount||0)).toFixed(2),tax:+(r.taxAmount||0).toFixed(2),invoiceValue:+(r.total||0).toFixed(2),status:'Book Entry'}));
}
export function computeGstReconciliation(firmId:string,startDate:string,endDate:string,source:'2A'|'2B'){ return computeGstr2(firmId,startDate,endDate).map(r=>({...r,reconciliationSource:`GSTR-2${source}`,matchStatus:'Pending external data'})); }
export function computeGstr9(firmId:string,startDate:string,endDate:string){ const one=computeGstr1(firmId,startDate,endDate); const two=computeGstr2(firmId,startDate,endDate); const pt=two.reduce((s,r)=>s+r.tax,0), pv=two.reduce((s,r)=>s+r.taxableValue,0); return {firm:one.firm,period:{startDate,endDate},outward:{taxableValue:one.summary.taxableValue,totalTax:one.summary.totalTax,invoices:one.summary.totalInvoices},inward:{taxableValue:+pv.toFixed(2),totalTax:+pt.toFixed(2),invoices:two.length},creditNotes:{taxableValue:one.summary.creditNoteValue,totalTax:one.summary.creditNoteTax},note:'Annual summary from books; verify statutory mapping before filing.'}; }
export function computeCompositionReturns(firmId:string,startDate:string,endDate:string){
 const firm=firmInfo(firmId);
 const q=(types:string[])=>db.prepare(`SELECT documentType,COALESCE(SUM(subtotal),0) subtotal,COALESCE(SUM(discountAmount),0) discount,COALESCE(SUM(total),0) total,COUNT(*) count FROM documents WHERE firmId=? AND documentType IN (${types.map(()=>'?').join(',')}) AND isDeleted=0 AND status NOT IN ('cancelled','draft') AND documentDate BETWEEN ? AND ? GROUP BY documentType`).all(firmId,...types,startDate,endDate) as any[];
 const rows=q(['sale_invoice','sale_return']);
 const inv=rows.find(r=>r.documentType==='sale_invoice')||{}; const ret=rows.find(r=>r.documentType==='sale_return')||{};
 const gross=Math.max(0,(inv.subtotal||0)-(inv.discount||0));
 const returns=Math.max(0,(ret.subtotal||0)-(ret.discount||0));
 const netTurnover=+(gross-returns).toFixed(2);
 const rate=1; // default working rate; UI exposes the composition rate for business-specific configuration
 const tax=+(netTurnover*rate/100).toFixed(2);
 return {firm:{name:firm?.legalName||firm?.name,gstin:firm?.gstin,state:firm?.state,gstType:firm?.gstType||'composition'},period:{startDate,endDate},grossOutwardTurnover:+gross.toFixed(2),creditNoteTurnover:+returns.toFixed(2),netTurnover,compositionTaxRate:rate,compositionTaxPayable:tax,outwardInvoices:Number(inv.count||0),creditNoteCount:Number(ret.count||0),note:'Working composition summary from books. CMP-08 is the quarterly statement for self-assessed tax; GSTR-4 is the annual return. Verify statutory applicability/rates before filing.'};
}

export function computeGstr4(firmId:string,startDate:string,endDate:string){ const r=computeCompositionReturns(firmId,startDate,endDate); return {period:r.period,firm:r.firm,summary:{netTurnover:r.netTurnover,compositionTaxRate:r.compositionTaxRate,compositionTaxPayable:r.compositionTaxPayable},sales:{taxableValue:r.netTurnover,tax:r.compositionTaxPayable,invoices:r.outwardInvoices},purchases:{taxableValue:0,tax:0,invoices:0},note:r.note}; }



