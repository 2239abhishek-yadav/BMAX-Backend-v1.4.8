import { Router, Request, Response } from 'express';
import { db } from '../lib/db';

const router = Router();

// Read-only cross-module search. This is additive and does not change existing queries.
router.get('/', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '').trim();
    const q = String(req.query.q || '').trim();
    if (!firmId || !q) return res.json({ success: true, data: [] });
    const term = `%${q.replace(/[%_]/g, s => `\\${s}`)}%`;
    const esc = { escape: '\\' };
    const out: any[] = [];
    const push = (rows: any[], type: string, page: string, map: (r:any)=>any) => rows.forEach(r => out.push(map(r)));

    push(db.prepare(`SELECT id,name,itemCode,sku,barcode,currentStock FROM items WHERE firmId=? AND (name LIKE ? ESCAPE '\\' OR itemCode LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barcode LIKE ? ESCAPE '\\') ORDER BY name LIMIT 12`).all(firmId,term,term,term,term), 'item','items', (r:any)=>({type:'item',page:'item_history',id:r.id,title:r.name,subtitle:[r.itemCode,r.barcode,`Stock ${r.currentStock||0}`].filter(Boolean).join(' · ')}));
    push(db.prepare(`SELECT id,name,phone,partyCode FROM parties WHERE firmId=? AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR partyCode LIKE ? ESCAPE '\\') ORDER BY name LIMIT 12`).all(firmId,term,term,term), 'party','parties', (r:any)=>({type:'party',page:'parties',id:r.id,title:r.name,subtitle:[r.partyCode,r.phone].filter(Boolean).join(' · ')}));
    push(db.prepare(`SELECT id,documentType,documentNumber,documentDate,partyName,total FROM documents WHERE firmId=? AND isDeleted=0 AND (documentNumber LIKE ? ESCAPE '\\' OR partyName LIKE ? ESCAPE '\\') ORDER BY documentDate DESC, createdAt DESC LIMIT 16`).all(firmId,term,term), 'document','documents', (r:any)=>({type:'document',page:r.documentType,id:r.id,title:r.documentNumber,subtitle:[r.partyName,r.documentDate,`₹${Number(r.total||0).toLocaleString('en-IN')}`].filter(Boolean).join(' · ')}));
    push(db.prepare(`SELECT id,type,receiptNumber,paymentDate,amount,partyName FROM payments WHERE firmId=? AND COALESCE(isDeleted,0)=0 AND (receiptNumber LIKE ? ESCAPE '\\' OR partyName LIKE ? ESCAPE '\\') ORDER BY paymentDate DESC LIMIT 10`).all(firmId,term,term), 'payment','payments', (r:any)=>({type:'payment',page:r.type==='in'?'payment_in':'payment_out',id:r.id,title:r.receiptNumber||r.id,subtitle:[r.partyName,r.paymentDate,`₹${Number(r.amount||0).toLocaleString('en-IN')}`].filter(Boolean).join(' · ')}));
    const seen = new Set<string>();
    const data = out.filter(x => { const k=`${x.type}:${x.id}`; if(seen.has(k)) return false; seen.add(k); return true; }).slice(0,40);
    res.json({ success:true, data });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

export default router;
