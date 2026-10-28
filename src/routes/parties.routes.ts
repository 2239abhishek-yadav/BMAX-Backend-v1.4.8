import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, ensureCashCustomer } from '../lib/db';
import { validateGSTIN, validateMobile } from '../lib/validators';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const { firmId, type, search, groupId } = req.query;
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    let q = 'SELECT p.*, g.name as groupName FROM parties p LEFT JOIN groups g ON p.groupId = g.id WHERE p.firmId = ? AND p.isActive = 1';
    const params: any[] = [firmId];
    if (type) { q += ' AND p.type = ?'; params.push(type); }
    if (groupId) { q += ' AND p.groupId = ?'; params.push(groupId); }
    if (search) {
      // Broad billing search: name, mobile, GSTIN, UUID/ID and party/customer code.
      // A name can legitimately match multiple parties; the UI shows all matches.
      const raw = String(search).trim();
      const term = `%${raw}%`;
      const digits = raw.replace(/\D/g, '');
      if (digits) {
        q += ' AND (p.name LIKE ? OR p.phone LIKE ? OR REPLACE(REPLACE(REPLACE(p.phone," ",""),"-",""),"+","") LIKE ? OR p.gstin LIKE ? OR p.id LIKE ? OR p.partyCode LIKE ?)';
        params.push(term, term, `%${digits}%`, term, term, term);
      } else {
        q += ' AND (p.name LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ? OR p.id LIKE ? OR p.partyCode LIKE ?)';
        params.push(term, term, term, term, term);
      }
    }
    q += ' ORDER BY p.name ASC';
    const parties = db.prepare(q).all(params);
    res.json({ success: true, data: parties });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/cash-customer', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '').trim();
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const party = ensureCashCustomer(firmId);
    res.json({ success: true, data: party });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});


// Unified Ledger Account directory. This is the single backend source for the
// Party Master > Ledger selector: parties, expense ledgers, banks, cash,
// employees, commission agents and core accounting heads are returned together.
router.get('/ledger-accounts', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '').trim();
    const classification = String(req.query.classification || 'all').trim().toLowerCase();
    const search = String(req.query.search || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 500));
    if (!firmId) return res.status(400).json({ error: 'firmId required' });

    const like = `%${search}%`;
    const accounts: any[] = [];
    const add = (rows: any[], source: string) => rows.forEach(r => accounts.push({ ...r, source }));

    if (!classification || classification === 'all' || classification === 'b2b' || classification === 'b2c' || classification === 'customers' || classification === 'suppliers' || classification === 'trade_parties') {
      let q = `SELECT p.id, p.name, p.partyCode as code, p.phone, p.gstin, p.type, p.partyKind,
          g.name as groupName,
          CASE
            WHEN p.partyKind='B2C' THEN 'B2C Customers'
            WHEN p.type='supplier' THEN 'Suppliers / Vendors'
            WHEN p.type='both' THEN 'Trade Parties'
            ELSE 'B2B Customers'
          END as classification,
          'party' as accountType, p.id as accountId,
          COALESCE(p.openingBalance,0) as openingBalance,
          p.openingBalanceType
        FROM parties p LEFT JOIN groups g ON g.id=p.groupId
        WHERE p.firmId=? AND p.isActive=1`;
      const params: any[] = [firmId];
      if (classification === 'b2b') q += ` AND p.partyKind='B2B' AND p.type='customer'`;
      else if (classification === 'b2c') q += ` AND p.partyKind='B2C'`;
      else if (classification === 'customers') q += ` AND p.type IN ('customer','both')`;
      else if (classification === 'suppliers') q += ` AND p.type IN ('supplier','both')`;
      else if (classification === 'trade_parties') q += ` AND p.type='both'`;
      if (search) { q += ` AND (LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.phone,'')) LIKE ? OR LOWER(COALESCE(p.partyCode,'')) LIKE ? OR LOWER(COALESCE(p.gstin,'')) LIKE ? OR LOWER(COALESCE(g.name,'')) LIKE ?)`; params.push(like,like,like,like,like); }
      add(db.prepare(q).all(params) as any[], 'parties');
    }

    if (classification === 'all' || classification === 'direct_expenses' || classification === 'indirect_expenses') {
      let q = `SELECT c.id,c.name,c.name as code,c.type,c.accountGroup,c.accountNature,
          CASE WHEN COALESCE(c.accountGroup,'Direct Expenses')='Indirect Expenses' THEN 'Indirect Expenses' ELSE 'Direct Expenses' END as classification,
          'expense' as accountType,c.id as accountId
        FROM categories c WHERE c.firmId=? AND c.type='expense'`;
      const params: any[] = [firmId];
      if (classification === 'direct_expenses') q += ` AND COALESCE(c.accountGroup,'Direct Expenses')='Direct Expenses'`;
      if (classification === 'indirect_expenses') q += ` AND COALESCE(c.accountGroup,'Direct Expenses')='Indirect Expenses'`;
      if (search) { q += ` AND (LOWER(c.name) LIKE ? OR LOWER(COALESCE(c.accountGroup,'')) LIKE ?)`; params.push(like,like); }
      add(db.prepare(q).all(params) as any[], 'expense_ledgers');
    }

    if (classification === 'all' || classification === 'bank_accounts') {
      let q = `SELECT id,accountName as name,accountName as code,bankName,accountNumber,ifscCode,
          'Bank Accounts' as classification,'bank' as accountType,id as accountId,
          COALESCE(currentBalance,0) as currentBalance
        FROM bank_accounts WHERE firmId=? AND isActive=1`;
      const params: any[] = [firmId];
      if (search) { q += ` AND (LOWER(accountName) LIKE ? OR LOWER(bankName) LIKE ? OR LOWER(COALESCE(accountNumber,'')) LIKE ? OR LOWER(COALESCE(ifscCode,'')) LIKE ?)`; params.push(like,like,like,like); }
      add(db.prepare(q).all(params) as any[], 'bank_accounts');
    }

    if (classification === 'all' || classification === 'employees') {
      let q = `SELECT id,TRIM(firstName||' '||COALESCE(lastName,'')) as name,employeeCode as code,phone,email,department,designation,
          'Employees / Staff' as classification,'employee' as accountType,id as accountId,status
        FROM employees WHERE firmId=? AND status='active'`;
      const params: any[] = [firmId];
      if (search) { q += ` AND (LOWER(firstName||' '||COALESCE(lastName,'')) LIKE ? OR LOWER(COALESCE(employeeCode,'')) LIKE ? OR LOWER(COALESCE(phone,'')) LIKE ? OR LOWER(COALESCE(department,'')) LIKE ? OR LOWER(COALESCE(designation,'')) LIKE ?)`; params.push(like,like,like,like,like); }
      add(db.prepare(q).all(params) as any[], 'employees');
    }

    if (classification === 'all' || classification === 'field_staff') {
      let q = `SELECT id,name,phone,email,commissionRate,commissionType,
          'Field Staff / Commission Agents' as classification,'agent' as accountType,id as accountId
        FROM agents WHERE firmId=? AND isActive=1`;
      const params: any[] = [firmId];
      if (search) { q += ` AND (LOWER(name) LIKE ? OR LOWER(COALESCE(phone,'')) LIKE ? OR LOWER(COALESCE(email,'')) LIKE ?)`; params.push(like,like,like); }
      add(db.prepare(q).all(params) as any[], 'agents');
    }

    const systemAccounts = [
      ['cash','CASH','Cash in Hand','Cash'],
      ['sales','SALES','Sales','Sales'],
      ['purchase','PURCHASE','Purchase','Purchase'],
      ['sales_return','SALES_RETURN','Sales Return','Sales Return'],
      ['purchase_return','PURCHASE_RETURN','Purchase Return','Purchase Return'],
      ['other_income','OTHER_INCOME','Other Income','Other Income'],
      ['duties_taxes','DUTIES_TAXES','Duties & Taxes','Duties & Taxes']
    ];
    if (classification === 'all' || ['cash','sales','purchase','sales_return','purchase_return','other_income','duties_taxes'].includes(classification)) {
      for (const [accountType,accountId,name,cls] of systemAccounts) {
        if (classification !== 'all' && classification !== accountType) continue;
        if (search && !name.toLowerCase().includes(search)) continue;
        accounts.push({ id: accountId, accountId, name, code: accountId, classification: cls, accountType, source: 'system' });
      }
    }

    // Real-time balance used by the Ledger list. Keep this calculation in the
    // same backend route as ledger detail so the list and popup stay consistent.
    const balanceFor = (a:any) => {
      try {
        if (a.accountType === 'party') {
          const p = db.prepare(`SELECT openingBalance, openingBalanceType FROM parties WHERE id=? AND firmId=?`).get(a.accountId,firmId) as any;
          if (!p) return 0;
          const sales = Number((db.prepare(`SELECT COALESCE(SUM(total),0) total FROM documents WHERE partyId=? AND firmId=? AND documentType='sale_invoice' AND isDeleted=0 AND status NOT IN ('draft','cancelled','hold')`).get(a.accountId,firmId) as any)?.total||0);
          const purchases = Number((db.prepare(`SELECT COALESCE(SUM(total),0) total FROM documents WHERE partyId=? AND firmId=? AND documentType='purchase_invoice' AND isDeleted=0 AND status NOT IN ('draft','cancelled','hold')`).get(a.accountId,firmId) as any)?.total||0);
          const saleReturns = Number((db.prepare(`SELECT COALESCE(SUM(total),0) total FROM documents WHERE partyId=? AND firmId=? AND documentType='sale_return' AND isDeleted=0 AND status NOT IN ('draft','cancelled','hold')`).get(a.accountId,firmId) as any)?.total||0);
          const purchaseReturns = Number((db.prepare(`SELECT COALESCE(SUM(total),0) total FROM documents WHERE partyId=? AND firmId=? AND documentType='purchase_return' AND isDeleted=0 AND status NOT IN ('draft','cancelled','hold')`).get(a.accountId,firmId) as any)?.total||0);
          const pin = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM payments WHERE partyId=? AND firmId=? AND type='payment_in' AND COALESCE(isDeleted,0)=0`).get(a.accountId,firmId) as any)?.total||0);
          const pout = Number((db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM payments WHERE partyId=? AND firmId=? AND type='payment_out' AND COALESCE(isDeleted,0)=0`).get(a.accountId,firmId) as any)?.total||0);
          const opening = Number(p.openingBalance||0) * (p.openingBalanceType==='credit' ? -1 : 1);
          return +(opening + sales + purchaseReturns - purchases - saleReturns + pout - pin).toFixed(2);
        }
        if (a.accountType === 'expense') {
          return +Number((db.prepare(`SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE id IN (SELECT e.id FROM expenses e WHERE e.firmId=? AND e.categoryId=? AND COALESCE(e.isDeleted,0)=0)`).get(firmId,a.accountId) as any)?.total||0).toFixed(2);
        }
        if (a.accountType === 'bank') {
          return +Number((db.prepare(`SELECT COALESCE(currentBalance,0) balance FROM bank_accounts WHERE id=? AND firmId=?`).get(a.accountId,firmId) as any)?.balance||0).toFixed(2);
        }
        if (a.accountType === 'cash') {
          return +Number((db.prepare(`SELECT COALESCE(cashInHand,0) balance FROM firms WHERE id=?`).get(firmId) as any)?.balance||0).toFixed(2);
        }
        const sys:any = {
          sales:{where:"documentType='sale_invoice'",sign:-1},
          purchase:{where:"documentType='purchase_invoice'",sign:1},
          sales_return:{where:"documentType='sale_return'",sign:1},
          purchase_return:{where:"documentType='purchase_return'",sign:-1},
          other_income:{where:"documentType='other_income'",sign:-1},
          duties_taxes:{where:"1=0",sign:1}
        };
        if (sys[a.accountType]) {
          const q=`SELECT COALESCE(SUM(total),0) total FROM documents WHERE firmId=? AND isDeleted=0 AND status NOT IN ('draft','cancelled','hold') AND ${sys[a.accountType].where}`;
          return +Number((db.prepare(q).get(firmId) as any)?.total||0 * sys[a.accountType].sign).toFixed(2);
        }
      } catch {}
      return 0;
    };

    for (const a of accounts) a.balance = balanceFor(a);

    const rank = (x:any) => {
      if (!search) return 0;
      const n=String(x.name||'').toLowerCase();
      const c=String(x.code||'').toLowerCase();
      if (n === search || c === search) return 0;
      if (n.startsWith(search) || c.startsWith(search)) return 1;
      if (n.includes(search) || c.includes(search)) return 2;
      return 3;
    };
    accounts.sort((a,b)=>rank(a)-rank(b) || String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'}));
    const unique = new Map<string,any>();
    for (const a of accounts) unique.set(`${a.accountType}:${a.accountId}`, a);
    const data = Array.from(unique.values()).slice(0,limit);

    res.json({ success:true, data, meta:{ total:unique.size, search, classification,
      classifications:[
        {key:'all',label:'All Accounts'},
        {key:'b2b',label:'B2B Customers'}, {key:'b2c',label:'B2C Customers'},
        {key:'customers',label:'Customers'}, {key:'suppliers',label:'Suppliers / Vendors'}, {key:'trade_parties',label:'Trade Parties'},
        {key:'direct_expenses',label:'Direct Expenses'}, {key:'indirect_expenses',label:'Indirect Expenses'},
        {key:'employees',label:'Employees / Staff'}, {key:'field_staff',label:'Field Staff / Commission Agents'},
        {key:'bank_accounts',label:'Bank Accounts'}, {key:'cash',label:'Cash'}, {key:'sales',label:'Sales'}, {key:'purchase',label:'Purchase'},
        {key:'sales_return',label:'Sales Return'}, {key:'purchase_return',label:'Purchase Return'}, {key:'other_income',label:'Other Income'}, {key:'duties_taxes',label:'Duties & Taxes'}
      ]
    }});
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

// Unified ledger detail for non-party accounts. Party accounts continue to use
// the existing bill-wise party ledger endpoint below, preserving its balance logic.
router.get('/ledger-account/:accountType/:accountId', (req: Request, res: Response) => {
  try {
    const firmId = String(req.query.firmId || '').trim();
    const { accountType, accountId } = req.params;
    if (!firmId) return res.status(400).json({error:'firmId required'});
    const rows:any[]=[];
    const push=(date:any,kind:any,reference:any,debit:any,credit:any,description:any,sourceId:any)=>rows.push({date,kind,reference,debit:Number(debit||0),credit:Number(credit||0),description:description||'',sourceId});

    if(accountType==='expense'){
      const c=db.prepare(`SELECT id,name,COALESCE(accountGroup,'Direct Expenses') accountGroup FROM categories WHERE id=? AND firmId=? AND type='expense'`).get(accountId,firmId) as any;
      if(!c)return res.status(404).json({error:'Expense ledger not found'});
      const entries=db.prepare(`SELECT id,date,amount,description,partyName,paymentMethod,bankId FROM expenses WHERE firmId=? AND categoryId=? AND COALESCE(isDeleted,0)=0 ORDER BY date,createdAt`).all(firmId,accountId) as any[];
      entries.forEach(e=>push(e.date,'expense',e.id,e.amount,0,e.description||e.partyName,e.id));
      const running=rows.reduce((n,e)=>(e.runningBalance=+(n+e.debit-e.credit).toFixed(2),e.runningBalance),0);
      return res.json({success:true,data:{account:{id:accountId,name:c.name,classification:c.accountGroup,accountType},openingBalance:0,currentBalance:running,ledger:rows}});
    }

    if(accountType==='bank'){
      const b=db.prepare(`SELECT id,accountName as name,bankName,currentBalance FROM bank_accounts WHERE id=? AND firmId=? AND isActive=1`).get(accountId,firmId) as any;
      if(!b)return res.status(404).json({error:'Bank account not found'});
      const tx=db.prepare(`SELECT id,date,type,amount,description,reference FROM bank_transactions WHERE accountId=? AND firmId=? ORDER BY date,createdAt`).all(accountId,firmId) as any[];
      tx.forEach(e=>push(e.date,'bank_transaction',e.reference||e.id,e.type==='debit'?e.amount:0,e.type==='credit'?e.amount:0,e.description,e.id));
      const payments=db.prepare(`SELECT id,paymentDate date,type,amount,receiptNumber reference,description FROM payments WHERE firmId=? AND bankId=? AND COALESCE(isDeleted,0)=0 ORDER BY paymentDate,createdAt`).all(firmId,accountId) as any[];
      payments.forEach(e=>push(e.date,'payment',e.reference||e.id,e.type==='payment_out'?e.amount:0,e.type==='payment_in'?e.amount:0,e.description,e.id));
      const expenses=db.prepare(`SELECT id,date,amount,description,partyName FROM expenses WHERE firmId=? AND bankId=? AND COALESCE(isDeleted,0)=0 ORDER BY date,createdAt`).all(firmId,accountId) as any[];
      expenses.forEach(e=>push(e.date,'expense',e.id,e.amount,0,e.description||e.partyName,e.id));
      rows.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
      const opening=Number(b.currentBalance||0)-rows.reduce((n,e)=>n+e.debit-e.credit,0);
      let running=opening; rows.forEach(e=>{running=+(running+e.debit-e.credit).toFixed(2);e.runningBalance=running;});
      return res.json({success:true,data:{account:{id:accountId,name:b.name,classification:'Bank Accounts',accountType},openingBalance:+opening.toFixed(2),currentBalance:running,ledger:rows}});
    }

    if(accountType==='cash'){
      const f=db.prepare('SELECT id,name,cashInHand FROM firms WHERE id=?').get(firmId) as any;
      if(!f)return res.status(404).json({error:'Firm not found'});
      const payments=db.prepare(`SELECT id,paymentDate date,type,amount,receiptNumber reference,description FROM payments WHERE firmId=? AND paymentMethod='cash' AND COALESCE(isDeleted,0)=0 ORDER BY paymentDate,createdAt`).all(firmId) as any[];
      payments.forEach(e=>push(e.date,'payment',e.reference||e.id,e.type==='payment_out'?e.amount:0,e.type==='payment_in'?e.amount:0,e.description,e.id));
      const expenses=db.prepare(`SELECT id,date,amount,description,partyName FROM expenses WHERE firmId=? AND paymentMethod='cash' AND COALESCE(isDeleted,0)=0 ORDER BY date,createdAt`).all(firmId) as any[];
      expenses.forEach(e=>push(e.date,'expense',e.id,e.amount,0,e.description||e.partyName,e.id));
      const net=rows.reduce((n,e)=>n+e.debit-e.credit,0); const opening=Number(f.cashInHand||0)-net; let running=opening; rows.forEach(e=>{running=+(running+e.debit-e.credit).toFixed(2);e.runningBalance=running;});
      return res.json({success:true,data:{account:{id:'CASH',name:'Cash in Hand',classification:'Cash',accountType:'cash'},openingBalance:+opening.toFixed(2),currentBalance:running,ledger:rows}});
    }

    const systemMap:any={
      sales:{name:'Sales',classification:'Sales',where:`documentType='sale_invoice'`,side:'credit'},
      purchase:{name:'Purchase',classification:'Purchase',where:`documentType='purchase_invoice'`,side:'debit'},
      sales_return:{name:'Sales Return',classification:'Sales Return',where:`documentType='sale_return'`,side:'debit'},
      purchase_return:{name:'Purchase Return',classification:'Purchase Return',where:`documentType='purchase_return'`,side:'credit'},
      other_income:{name:'Other Income',classification:'Other Income',where:`documentType='other_income'`,side:'credit'},
      duties_taxes:{name:'Duties & Taxes',classification:'Duties & Taxes',where:`1=0`,side:'credit'}
    };
    if(systemMap[accountType]){
      const m=systemMap[accountType];
      const docs=db.prepare(`SELECT id,documentDate date,documentNumber reference,total,taxAmount,description FROM documents WHERE firmId=? AND isDeleted=0 AND status NOT IN ('draft','cancelled','hold') AND ${m.where} ORDER BY documentDate,createdAt`).all(firmId) as any[];
      docs.forEach(d=>push(d.date,accountType,d.reference,m.side==='debit'?d.total:0,m.side==='credit'?d.total:0,d.description,d.id));
      let running=0; rows.forEach(e=>{running=+(running+e.debit-e.credit).toFixed(2);e.runningBalance=running;});
      return res.json({success:true,data:{account:{id:accountId,name:m.name,classification:m.classification,accountType},openingBalance:0,currentBalance:running,ledger:rows}});
    }

    if(accountType==='employee' || accountType==='agent'){
      const table=accountType==='employee'?'employees':'agents';
      const nameExpr=accountType==='employee'?"TRIM(firstName||' '||COALESCE(lastName,''))":'name';
      const found=db.prepare(`SELECT id,${nameExpr} as name FROM ${table} WHERE id=? AND firmId=?`).get(accountId,firmId) as any;
      if(!found)return res.status(404).json({error:`${accountType} not found`});
      return res.json({success:true,data:{account:{id:accountId,name:found.name,classification:accountType==='employee'?'Employees / Staff':'Field Staff / Commission Agents',accountType},openingBalance:0,currentBalance:0,ledger:[]}});
    }
    return res.status(400).json({error:'Unsupported ledger account'});
  } catch(err:any){res.status(500).json({error:err.message});}
});

router.get('/:id', (req: Request, res: Response) => {
  try {
    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Party not found' });
    // Calculate balance
    const salesTotal = (db.prepare("SELECT COALESCE(SUM(total),0) as total FROM documents WHERE partyId=? AND documentType='sale_invoice' AND isDeleted=0").get(req.params.id) as any)?.total || 0;
    const purchasesTotal = (db.prepare("SELECT COALESCE(SUM(total),0) as total FROM documents WHERE partyId=? AND documentType='purchase_invoice' AND isDeleted=0").get(req.params.id) as any)?.total || 0;
    const paymentsIn = (db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE partyId=? AND COALESCE(isDeleted,0)=0 AND type='payment_in'").get(req.params.id) as any)?.total || 0;
    const paymentsOut = (db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE partyId=? AND COALESCE(isDeleted,0)=0 AND type='payment_out'").get(req.params.id) as any)?.total || 0;
    // An advance is the part of a receipt/payment that is not allocated to any bill yet.
    // This is intentionally calculated from payment_allocations so prior customer
    // advances can be carried forward and automatically adjusted against a later invoice.
    const advanceRow = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN p.type='payment_in' THEN p.amount ELSE 0 END),0) -
             COALESCE(SUM(CASE WHEN p.type='payment_in' THEN COALESCE(a.allocated,0) ELSE 0 END),0) AS customerAdvance,
             COALESCE(SUM(CASE WHEN p.type='payment_out' THEN p.amount ELSE 0 END),0) -
             COALESCE(SUM(CASE WHEN p.type='payment_out' THEN COALESCE(a.allocated,0) ELSE 0 END),0) AS supplierAdvance
      FROM payments p
      LEFT JOIN (SELECT paymentId, SUM(amount) AS allocated FROM payment_allocations GROUP BY paymentId) a ON a.paymentId=p.id
      WHERE p.partyId=? AND COALESCE(p.isDeleted,0)=0`).get(req.params.id) as any;
    const advanceAvailable = Math.max(0, Number(advanceRow?.customerAdvance || 0));
    const supplierAdvanceAvailable = Math.max(0, Number(advanceRow?.supplierAdvance || 0));
    res.json({ success: true, data: { ...party as any, salesTotal, purchasesTotal, paymentsIn, paymentsOut, totalPaid: paymentsIn, advanceAvailable, supplierAdvanceAvailable } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const id = uuidv4();
    let { firmId, name, type = 'customer', partyKind = 'B2B', partyCode, phone, email, gstin, pan, address, city, state, pincode, groupId, creditLimit = 0, creditDays = 15, openingBalance = 0, openingBalanceType = 'debit' } = req.body;
    if (!firmId || !name) return res.status(400).json({ error: 'firmId and name required' });
    partyKind = partyKind === 'B2C' ? 'B2C' : 'B2B';
    if (partyKind === 'B2C') { type='customer'; email=null; gstin=null; pan=null; groupId=null; creditLimit=0; creditDays=0; openingBalance=0; }
    if (!partyCode) { const prefix=partyKind==='B2C'?'CUSTOMER-':'PARTY-'; const last=db.prepare("SELECT partyCode FROM parties WHERE firmId=? AND partyCode LIKE ? ORDER BY partyCode DESC LIMIT 1").get(firmId,`${prefix}%`) as any; const n=last?.partyCode?Number(String(last.partyCode).slice(prefix.length))+1:1; partyCode=`${prefix}${String(n).padStart(5,'0')}`; }


    if (partyKind !== 'B2C' && !String(state||'').trim()) return res.status(400).json({ error: 'State is required' });
    creditLimit = Math.max(0, Number(creditLimit) || 0);
    creditDays = Math.max(0, Math.min(3650, Math.floor(Number(creditDays) || 0)));
    const gstinCheck = validateGSTIN(gstin);
    if (!gstinCheck.valid) return res.status(400).json({ error: gstinCheck.error });
    gstin = gstinCheck.value;

    const mobileCheck = validateMobile(phone);
    if (!mobileCheck.valid) return res.status(400).json({ error: mobileCheck.error });
    phone = mobileCheck.value;
    if (partyKind === 'B2C' && phone) {
      const duplicate = db.prepare("SELECT id FROM parties WHERE firmId=? AND partyKind='B2C' AND phone=? AND isActive=1 LIMIT 1").get(firmId, phone);
      if (duplicate) return res.status(409).json({ error: 'This B2C customer phone number is already registered.' });
    }

    db.prepare('INSERT INTO parties (id, firmId, name, type, partyKind, partyCode, phone, email, gstin, pan, address, city, state, pincode, groupId, creditLimit, creditDays, openingBalance, openingBalanceType, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, firmId, name, type, partyKind, partyCode, phone, email, gstin, pan, address, city, state, pincode, groupId, creditLimit, creditDays, openingBalance, openingBalanceType === 'credit' ? 'credit' : 'debit', now, now);
    res.status(201).json({ success: true, data: db.prepare('SELECT * FROM parties WHERE id = ?').get(id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Set opening balance independently without requiring the full party payload.
router.put('/:id/opening-balance', (req: Request, res: Response) => {
  try {
    const firmId = String(req.body.firmId || '').trim();
    const openingBalance = Math.max(0, Number(req.body.openingBalance) || 0);
    const openingBalanceType = req.body.openingBalanceType === 'credit' ? 'credit' : 'debit';
    if (!firmId) return res.status(400).json({ error: 'firmId required' });
    const party = db.prepare('SELECT id, firmId FROM parties WHERE id=?').get(req.params.id) as any;
    if (!party || party.firmId !== firmId) return res.status(404).json({ error: 'Party not found' });
    db.prepare('UPDATE parties SET openingBalance=?, openingBalanceType=?, updatedAt=? WHERE id=? AND firmId=?').run(openingBalance, openingBalanceType, new Date().toISOString(), req.params.id, firmId);
    res.json({ success:true, data: db.prepare('SELECT * FROM parties WHERE id=?').get(req.params.id) });
  } catch (err:any) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    let { name, type, partyKind='B2B', partyCode, phone, email, gstin, pan, address, city, state, pincode, groupId, creditLimit, creditDays, openingBalance, openingBalanceType='debit', isActive } = req.body;

    creditLimit = Math.max(0, Number(creditLimit) || 0);
    creditDays = Math.max(0, Math.min(3650, Math.floor(Number(creditDays) || 0)));
    const gstinCheck = validateGSTIN(gstin);    partyKind = partyKind === 'B2C' ? 'B2C' : 'B2B';
    if (partyKind === 'B2C') { type='customer'; email=null; gstin=null; pan=null; groupId=null; creditLimit=0; creditDays=0; openingBalance=0; }
    
    if (!gstinCheck.valid) return res.status(400).json({ error: gstinCheck.error });
    gstin = gstinCheck.value;

    const mobileCheck = validateMobile(phone);
    if (!mobileCheck.valid) return res.status(400).json({ error: mobileCheck.error });
    phone = mobileCheck.value;

    db.prepare('UPDATE parties SET name=?, type=?, partyKind=?, partyCode=?, phone=?, email=?, gstin=?, pan=?, address=?, city=?, state=?, pincode=?, groupId=?, creditLimit=?, creditDays=?, openingBalance=?, openingBalanceType=?, isActive=?, updatedAt=? WHERE id=?').run(name, type, partyKind, partyCode || null, phone, email, gstin, pan, address, city, state, pincode, groupId, creditLimit, creditDays, openingBalance, openingBalanceType==='credit'?'credit':'debit', isActive ? 1 : 0, now, req.params.id);
    res.json({ success: true, data: db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    db.prepare('UPDATE parties SET isActive = 0, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Party statement
router.get('/:id/statement', (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    let q = 'SELECT * FROM documents WHERE partyId = ? AND isDeleted = 0';
    const params: any[] = [req.params.id];
    if (startDate) { q += ' AND documentDate >= ?'; params.push(startDate); }
    if (endDate) { q += ' AND documentDate <= ?'; params.push(endDate); }
    q += ' ORDER BY documentDate ASC';
    const docs = db.prepare(q).all(params);
    const payments = db.prepare('SELECT * FROM payments WHERE partyId = ? AND COALESCE(isDeleted,0)=0 ORDER BY paymentDate ASC').all(req.params.id);
    res.json({ success: true, data: { documents: docs, payments } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Party Ledger — opening balance + running balance across all documents & payments, bill-wise.
router.get('/:id/ledger', (req: Request, res: Response) => {
  try {
    const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id) as any;
    if (!party) return res.status(404).json({ error: 'Party not found' });

    const docs = (db.prepare(
      `SELECT id, documentType, documentNumber, documentDate as date, total, paidAmount, balanceAmount, status
       FROM documents WHERE partyId = ? AND isDeleted = 0 AND status NOT IN ('hold','draft','cancelled') ORDER BY documentDate ASC, createdAt ASC`
    ).all(req.params.id) as any[]).map(d => ({
      ...d,
      kind: 'document',
      debit: ['sale_invoice', 'purchase_return'].includes(d.documentType) ? d.total : 0,
      credit: ['purchase_invoice', 'sale_return'].includes(d.documentType) ? d.total : 0,
    }));

    const payments = (db.prepare(
      `SELECT id, type, paymentDate as date, amount, paymentMethod, reference, description
       FROM payments WHERE partyId = ? AND COALESCE(isDeleted,0)=0 ORDER BY paymentDate ASC, createdAt ASC`
    ).all(req.params.id) as any[]).map(p => ({
      ...p,
      kind: 'payment',
      debit: p.type === 'payment_out' ? p.amount : 0,
      credit: p.type === 'payment_in' ? p.amount : 0,
    }));

    const entries = [...docs, ...payments].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let running = party.openingBalanceType === 'credit' ? -(party.openingBalance || 0) : (party.openingBalance || 0);
    const ledger = entries.map(e => {
      running = +(running + e.debit - e.credit).toFixed(2);
      return { ...e, runningBalance: running };
    });

    const outstandingBills = db.prepare(
      `SELECT id, documentType, documentNumber, documentDate, total, paidAmount, balanceAmount, status
       FROM documents WHERE partyId = ? AND isDeleted = 0 AND documentType IN ('sale_invoice','purchase_invoice') AND balanceAmount > 0 AND status NOT IN ('cancelled','draft')
       ORDER BY documentDate ASC, createdAt ASC`
    ).all(req.params.id);

    // Dedicated recent-document history. Do not derive LAST 5 from the mixed
    // document+payment ledger: a payment can otherwise push a valid invoice
    // out of the five visible rows. This list is persisted in SQLite and is
    // rebuilt every time the party is selected, so closing/reopening a bill
    // cannot erase transaction history.
    const recentTransactions = db.prepare(
      `SELECT id, documentType, documentNumber, documentDate, total, paidAmount, balanceAmount, status, createdAt, updatedAt
       FROM documents
       WHERE partyId = ? AND isDeleted = 0 AND status NOT IN ('hold','draft','cancelled')
         AND documentType IN ('sale_invoice','purchase_invoice','sale_return','purchase_return','sale_order','purchase_order','sale_quotation','delivery_challan','debit_note','credit_note')
       ORDER BY documentDate DESC, createdAt DESC, id DESC
       LIMIT 5`
    ).all(req.params.id);

    res.json({
      success: true,
      data: {
        openingBalance: party.openingBalanceType === 'credit' ? -(party.openingBalance || 0) : (party.openingBalance || 0),
        currentBalance: running,
        outstandingBills,
        recentTransactions,
        ledger
      }
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;



