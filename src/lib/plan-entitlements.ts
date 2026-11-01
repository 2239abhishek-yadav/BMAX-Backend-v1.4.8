/**
 * B-MAX commercial plan entitlements.
 *
 * Tiering is intentionally cumulative:
 * Starter = 1, Business = 2, Professional = 3.
 * Trial receives the full product surface until it expires; expiry is handled
 * separately by the transaction-only subscription gate.
 */
export type PlanTier = 1 | 2 | 3;

export const PLAN_TIERS: Record<string, PlanTier> = {
  STARTER: 1,
  BUSINESS: 2,
  PROFESSIONAL: 3,
};

export const PLAN_PRICING = {
  Starter: {
    '1 Year': { mrp: 2999, final: 2999, discount: 0 },
    '3 Years': { mrp: 8997, final: 7647, discount: 15 },
    '5 Years': { mrp: 14995, final: 11246, discount: 25 },
  },
  Business: {
    '1 Year': { mrp: 4999, final: 4999, discount: 0 },
    '3 Years': { mrp: 14997, final: 12747, discount: 15 },
    '5 Years': { mrp: 24995, final: 18746, discount: 25 },
  },
  Professional: {
    '1 Year': { mrp: 6999, final: 6999, discount: 0 },
    '3 Years': { mrp: 20997, final: 17847, discount: 15 },
    '5 Years': { mrp: 34995, final: 26246, discount: 25 },
  },
} as const;

export const ADDON_RATES = {
  additionalUserPercent: 10,
  additionalCompanyPercent: 30,
} as const;

export const PLAN_LIMITS = {
  Starter: { firms: 1, users: 1, multipleStores: false },
  Business: { firms: 2, users: 3, multipleStores: true },
  Professional: { firms: 3, users: 5, multipleStores: true },
} as const;

export const PLAN_FEATURES = {
  Starter: [
    'Sale Invoices & Billing', 'Purchase Management', 'Inventory Management',
    'GST & Tax Reports', 'Accounts & Ledgers', 'Payments In / Received',
    'Payments Out / Making', 'Expenses Management', 'Debit Note / Credit Note',
    'Cash & Bank', 'Day Book & Business Reports', 'Outstanding Management',
    'Profit & Loss / Stock Reports', 'Report Center', 'Basic Data Backup',
    'Import Templates', 'GST Regular / Composition / No-GST',
    'Appearance / Theme Modes', 'Account & Logout', 'Help & Support',
    'ESC Back / Cancel Safety', 'Main Store (1 included)',
  ],
  Business: [
    'Everything in Starter', 'Multiple Users & Administration', 'Role & Permissions',
    'POS / Fast Billing', 'POS Full Screen', 'Counter Sale', 'Hold / Resume Bills',
    'Multiple Payment Modes', 'Barcode Billing & Scanning', 'Barcode Templates',
    'Invoice Design & Templates', 'Advanced Inventory Controls', 'Batch & Expiry Management',
    'Multiple Stores / Godowns', 'Loyalty Points', 'Sales / Purchase Orders', 'Quotation',
    'Delivery Challan', 'Job Work In', 'Job Work Out', 'Advanced Reports & Analytics',
    'LAN / Device Sync', 'DataSync Details', 'Tally Export',
    'Export / Import Manager', 'AI Import & Item Mapping', 'Multiple Document Series',
    'Recycle Bin / Restore', 'New Financial Year', 'Module Visibility',
    'Module Management / Global Rename',
  ],
  Professional: [
    'Everything in Business', 'CRM', 'Lead Management', 'Proforma Invoice',
    'Multi-Godown Management', 'Stock Transfer', 'Physical Stock Management',
    'Advanced Accounting', 'Approval Matrix', 'Manufacturing / Production',
    'Transaction Locking', 'Advanced Business Controls', 'Extended Reports',
    'Advanced User Administration', 'HR / Payroll',
  ],
} as const;

const ROUTE_TIER: Record<string, PlanTier> = {
  // Business
  'counter-sales': 2,
  'batches': 2,
  // The Godowns page is available to all plans for the included Main Store.
  'barcodes': 2,
  'sync': 2,
  'ai-import': 2,
  'series': 2,
  'recycle-bin': 2,
  'job-work': 2,
  // Professional
  'crm': 3,
  'stock-transfers': 3,
  'stock-management/physical': 3,
  'stock-management/manufacturing': 3,
  'hr': 3,
};

export function normalizePlanCode(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function planTier(planCode: unknown, status?: unknown): PlanTier | null {
  if (String(status || '').toLowerCase() === 'trial') return 3;
  if (normalizePlanCode(planCode) === 'TRIAL') return 3;
  const code = normalizePlanCode(planCode);
  if (code === 'STARTER' || code === 'STARTER1Y' || code === 'STARTER3Y' || code === 'STARTER5Y') return 1;
  if (code === 'BUSINESS' || code === 'BUSINESS1Y' || code === 'BUSINESS3Y' || code === 'BUSINESS5Y') return 2;
  if (code === 'PROFESSIONAL' || code === 'PROFESSIONAL1Y' || code === 'PROFESSIONAL3Y' || code === 'PROFESSIONAL5Y') return 3;
  return null;
}

export function requiredTierForRoute(routePath: string): PlanTier | null {
  const normalized = String(routePath || '').replace(/^\/api\/?/, '').replace(/^\/+|\/+$/g, '');
  if (normalized.startsWith('stock-management/physical')) return 3;
  if (normalized.startsWith('stock-management/manufacturing')) return 3;
  for (const [prefix, tier] of Object.entries(ROUTE_TIER)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return tier;
  }
  return null;
}

export function getPlanCatalog() {
  return {
    pricing: PLAN_PRICING,
    addonRates: ADDON_RATES,
    features: PLAN_FEATURES,
    tiers: PLAN_TIERS,
    limits: PLAN_LIMITS,
  };
}
