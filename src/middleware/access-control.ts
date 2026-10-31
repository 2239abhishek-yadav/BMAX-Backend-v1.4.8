import { Request, Response, NextFunction } from 'express';
import { checkPermission } from '../routes/users.routes';
import { db } from '../lib/db';
import { getSubscriptionAccess } from '../lib/subscription';
import { planTier, requiredTierForRoute } from '../lib/plan-entitlements';

function getFirmId(req:Request){
  const q=(req.query as any)?.firmId;
  if(q)return String(q);
  if((req.body as any)?.firmId)return String((req.body as any).firmId);
  if(req.headers['x-bmax-firm-id'])return String(req.headers['x-bmax-firm-id']);
  return '';
}
function actionFor(method:string){
  if(method==='GET'||method==='HEAD')return 'view';
  if(method==='POST')return 'create';
  if(method==='PUT'||method==='PATCH')return 'edit';
  if(method==='DELETE')return 'delete';
  return 'view';
}
function moduleFor(path:string, body:any){
  const p=path.replace(/^\/api\/?/,'').split('/')[0];
  if (p === 'stock-management') {
    const normalized = path.replace(/^\/api\/?/,'');
    if (normalized.includes('/physical')) return 'stock_adjustment';
    if (normalized.includes('/manufacturing/entries')) return 'manufacturing';
    return 'items';
  }
  const map:any={items:'items',parties:'parties',documents:'sale_invoice',payments:'payment_in',bank:'bank','bank-accounts':'bank','bank-transactions':'bank_transactions',reports:'report_pl',hr:'employees',categories:'items',units:'items',agents:'parties',godowns:'items',expenses:'expenses','expense-ledgers':'expenses',series:'settings',import:'items','gst-registrations':'report_gst',users:'settings',batches:'items','counter-sales':'counter_sale','job-work':'job_work','stock-transfers':'stock_transfer',crm:'parties',settings:'settings',firms:'settings'};
  if(p==='documents' && body?.documentType){
    const d=String(body.documentType); if(d.includes('purchase'))return 'purchase_invoice'; if(d.includes('return'))return 'sale_return'; if(d.includes('order'))return 'sale_order'; if(d.includes('quotation'))return 'sale_quotation'; if(d.includes('challan'))return 'delivery_challan'; if(d.includes('payment_in'))return 'payment_in'; if(d.includes('payment_out'))return 'payment_out';
  }
  return map[p]||'';
}
export function accessControl(req:Request,res:Response,next:NextFunction){
  if(req.path.startsWith('/uploads') || req.path.startsWith('/api/subscription')) return next();
  const email=String(req.headers['x-bmax-user-email']||'').trim().toLowerCase();
  const firmId=getFirmId(req);
  const module=moduleFor(req.path,req.body);

  // Subscription expiry is intentionally TRANSACTION-ONLY. This check must
  // run even when the desktop request does not carry optional user/firm headers;
  // otherwise a client could bypass the trial lock simply by omitting those headers.
  // After the trial expires, the customer can still open the application,
  // inspect reports/history, manage masters/settings, and create/update company
  // configuration. Only posting/modifying financial/inventory transactions is gated.
  const subscription = getSubscriptionAccess();
  const transactionModules = new Set([
    'sale_invoice', 'purchase_invoice', 'sale_return', 'sale_order', 'purchase_order',
    'sale_quotation', 'sale_proforma', 'delivery_challan', 'debit_note', 'credit_note',
    'counter_sale', 'payment_in', 'payment_out', 'expenses', 'bank_transactions',
    'job_work', 'stock_transfer', 'stock_adjustment', 'manufacturing'
  ]);

  // HARDCORE PLAN ENTITLEMENT: a paid plan can only open/use the feature tier
  // it owns. This is enforced on the backend for GET/POST/PUT/PATCH/DELETE so
  // hiding a menu item in the frontend is never the only protection. Trial and
  // expired-trial customers retain the full read-only product surface according
  // to the existing trial policy.
  let requiredTier = requiredTierForRoute(req.path);
  const documentType = String((req.body as any)?.documentType || '');
  if (req.path.replace(/^\/api\/?/, '').startsWith('documents') && documentType) {
    if (['sale_order','purchase_order','sale_quotation','delivery_challan','purchase_challan'].includes(documentType)) requiredTier = 2;
    if (documentType === 'sale_proforma') requiredTier = 3;
  }
  // CRM is tiered inside one route: loyalty is Business, leads/approval are Professional.
  const normalizedPath = req.path.replace(/^\/api\/?/, '');
  if (normalizedPath.startsWith('crm/loyalty')) requiredTier = 2;
  if (normalizedPath.startsWith('crm/leads') || normalizedPath.startsWith('crm/approvals')) requiredTier = 3;
  if (requiredTier && subscription.state) {
    const tier = planTier(subscription.state.planCode, subscription.state.status);
    if (tier !== null && tier < requiredTier) {
      return res.status(403).json({
        error: 'This feature is not included in your current B-MAX plan.',
        code: 'PLAN_FEATURE_LOCKED',
        requiredTier,
        currentPlan: subscription.state.planName || subscription.state.planCode || null,
        subscription: subscription.state,
      });
    }
  }

  if(!module)return next();

  // First-company creation is the bootstrap operation that establishes the firm
  // context. It must require a signed-in account, but cannot require firmId before
  // the firm exists. The /firms route separately binds ownership to that account.
  const isInitialFirmCreation = req.method === 'POST' && req.path.replace(/^\/api\/?/, '').replace(/\/$/, '') === 'firms';
  if (isInitialFirmCreation) {
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(401).json({ error: 'Authenticated account context is required to create a company.', code: 'ACCOUNT_CONTEXT_REQUIRED' });
    }
    return next();
  }

  const isMutation = actionFor(req.method) !== 'view';
  if (!subscription.allowed && isMutation && transactionModules.has(module)) {
    return res.status(402).json({
      error: subscription.reason || 'Your B-MAX trial/subscription does not allow new transaction entries.',
      code: '',
      module,
      action: actionFor(req.method),
      readOnlyTransactions: true,
      subscription: subscription.state || null
    });
  }

  // Company profiles are unlimited, but transaction rights are limited to the
  // first N companies associated with the signed-in account, where N is the
  // centrally activated plan's maxFirms (Starter=1, Business=3, Professional=10).
  // Older/primary companies remain first; extra companies open read-only for
  // transactions. The subscription expiry gate above still blocks all transaction
  // mutations when the trial/license is expired or revoked.
  if (isMutation && transactionModules.has(module) && String(subscription.state?.status || '').toLowerCase() === 'active') {
    if (!email || !firmId) {
      return res.status(403).json({
        error: 'Sign-in and company context are required before creating transactions.',
        code: 'TRANSACTION_CONTEXT_REQUIRED',
        readOnlyTransactions: true,
      });
    }
    const licensedCompanyCount = Math.max(0, Math.floor(Number(subscription.state?.maxFirms || 0)));
    if (licensedCompanyCount < 1) {
      return res.status(403).json({
        error: 'This license does not include a company enabled for transactions. Contact B-MAX support.',
        code: 'NO_LICENSED_COMPANY_SLOT',
        readOnlyTransactions: true,
      });
    }
    const licensedFirms = db.prepare(`
      SELECT DISTINCT f.id
      FROM firms f
      JOIN firm_users fu ON fu.firmId=f.id AND fu.isActive=1
      JOIN users u ON u.id=fu.userId AND u.isActive=1
      WHERE lower(u.email)=?
      ORDER BY f.createdAt ASC, f.id ASC
      LIMIT ?
    `).all(email, licensedCompanyCount) as Array<{id:string}>;
    if (!licensedFirms.some((firm) => String(firm.id) === firmId)) {
      return res.status(403).json({
        error: `Your ${subscription.state?.planName || 'current'} plan allows transactions in ${licensedCompanyCount} licensed company${licensedCompanyCount === 1 ? '' : 'ies'}. This company is available in read-only mode.`,
        code: 'COMPANY_NOT_LICENSED_FOR_TRANSACTIONS',
        module,
        action: actionFor(req.method),
        readOnlyTransactions: true,
        licensedCompanyCount,
        subscription: subscription.state,
      });
    }
  }

  // FAIL CLOSED: mapped business modules must never skip role authorization
  // because identity or company context is missing. Client headers are context
  // only; checkPermission still verifies an active local membership for the
  // supplied email + firm before allowing the operation.
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(401).json({
      error: 'Authenticated account context is required for this operation.',
      code: 'ACCOUNT_CONTEXT_REQUIRED',
    });
  }
  if (!firmId) {
    return res.status(400).json({
      error: 'Company context is required for this operation.',
      code: 'FIRM_CONTEXT_REQUIRED',
    });
  }
  const result=checkPermission(email,firmId,module,actionFor(req.method));
  if(result.allowed)return next();
  return res.status(403).json({error:`Permission denied: ${actionFor(req.method)} access to ${module}`,code:'PERMISSION_DENIED'});
}
