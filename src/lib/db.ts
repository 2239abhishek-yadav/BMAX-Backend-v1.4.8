import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initializeSyncSchema } from '../sync/schema';
import { snapshotOpenDatabase } from '../backup/database-backup';
import { v4 as uuidv4 } from 'uuid';

const DB_DIR = process.env.DB_PATH || path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'bmax.db');
console.log('[DB] Database at:', DB_PATH);

export const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

export function initializeDatabase() {
  db.exec(`
    -- Firms
    CREATE TABLE IF NOT EXISTS firms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      legalName TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      country TEXT DEFAULT 'India',
      gstin TEXT,
      gstType TEXT DEFAULT 'regular',
      vatRate REAL DEFAULT 5,
      pan TEXT,
      tan TEXT,
      logoUrl TEXT,
      currency TEXT DEFAULT 'INR',
      financialYear TEXT DEFAULT '2024-25',
      invoicePrefix TEXT DEFAULT 'INV',
      invoiceNumber INTEGER DEFAULT 1,
      proformaNumber INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    -- Purchase-side automatic document counters. Operators may override the generated
    -- number manually; blank document numbers consume the next counter for that type.
    CREATE TABLE IF NOT EXISTS document_number_counters (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      documentType TEXT NOT NULL,
      prefix TEXT NOT NULL,
      nextNumber INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      UNIQUE(firmId, documentType)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_num_counter_firm ON document_number_counters(firmId, documentType);

    -- Categories
    -- GST registrations (one firm can have multiple GST registrations)
    CREATE TABLE IF NOT EXISTS gst_registrations (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      gstin TEXT NOT NULL,
      legalName TEXT,
      tradeName TEXT,
      state TEXT,
      stateCode TEXT,
      address TEXT,
      pincode TEXT,
      isPrimary INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gst_reg_firm ON gst_registrations(firmId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gst_reg_unique ON gst_registrations(firmId, gstin);

    -- Users and firm membership (multi-user, multi-firm access control)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      passwordHash TEXT,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      description TEXT,
      permissionsJson TEXT DEFAULT '{}',
      isSystem INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_firm_code ON user_roles(firmId, code);
    CREATE INDEX IF NOT EXISTS idx_user_roles_firm ON user_roles(firmId);

    CREATE TABLE IF NOT EXISTS firm_users (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      roleId TEXT,
      permissionsJson TEXT DEFAULT '{}',
      accessScopeJson TEXT DEFAULT '{}',
      isOwner INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      inviteStatus TEXT DEFAULT 'active',
      invitedAt TEXT,
      acceptedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (roleId) REFERENCES user_roles(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_firm_users_unique ON firm_users(firmId, userId);
    CREATE INDEX IF NOT EXISTS idx_firm_users_user ON firm_users(userId);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('item', 'party', 'expense')) DEFAULT 'item',
      accountGroup TEXT,
      accountNature TEXT,
      isSystemLedger INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Units
    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      shortName TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Items (Products & Services)
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('PRODUCT', 'SERVICE')) NOT NULL DEFAULT 'PRODUCT',
      hsnCode TEXT,
      itemCode TEXT,
      sku TEXT,
      barcode TEXT,
      description TEXT,
      imageUrl TEXT,
      categoryId TEXT,
      unitId TEXT,
      secondaryUnitId TEXT,
      conversionFactor REAL NOT NULL DEFAULT 1,
      salePrice REAL NOT NULL DEFAULT 0,
      salePriceTaxInclusive INTEGER DEFAULT 0,
      saleDiscount REAL DEFAULT 0,
      saleDiscountType TEXT CHECK(saleDiscountType IN ('percentage', 'amount')) DEFAULT 'percentage',
      purchasePrice REAL DEFAULT 0,
      purchasePriceTaxInclusive INTEGER DEFAULT 0,
      taxRate TEXT DEFAULT '0',
      openingStock REAL DEFAULT 0,
      currentStock REAL DEFAULT 0,
      minStockLevel REAL DEFAULT 0,
      location TEXT,
      batchNumber TEXT,
      expiryDate TEXT,
      packing TEXT,
      enableBatchTracking INTEGER DEFAULT 0,
      enableSerialTracking INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      isFavorite INTEGER DEFAULT 0,
      allowNegativeStock INTEGER DEFAULT 0,
      decimalEnabled INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (categoryId) REFERENCES categories(id)
    );

    -- Groups (Party groups)
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Parties (Customers & Suppliers)
    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('customer', 'supplier', 'both')) DEFAULT 'customer',
      partyKind TEXT CHECK(partyKind IN ('B2B','B2C')) DEFAULT 'B2B',
      partyCode TEXT,
      phone TEXT,
      email TEXT,
      gstin TEXT,
      gstType TEXT DEFAULT 'regular',
      pan TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      groupId TEXT,
      creditLimit REAL DEFAULT 0,
      creditDays INTEGER DEFAULT 0,
      openingBalance REAL DEFAULT 0,
      openingBalanceType TEXT CHECK(openingBalanceType IN ('debit', 'credit')) DEFAULT 'debit',
      loyaltyPoints INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (groupId) REFERENCES groups(id)
    );

    -- Documents (Sales, Purchases, Expenses)
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      documentType TEXT NOT NULL CHECK(documentType IN (
        'sale_invoice', 'sale_order', 'sale_return', 'sale_quotation', 'delivery_challan',
        'purchase_invoice', 'purchase_order', 'purchase_return', 'expense', 'other_income'
      )),
      documentNumber TEXT NOT NULL,
      documentDate TEXT NOT NULL,
      documentTime TEXT,
      partyId TEXT,
      partyName TEXT NOT NULL,
      partyType TEXT CHECK(partyType IN ('customer', 'supplier')) NOT NULL,
      phone TEXT,
      billingAddress TEXT,
      shippingAddress TEXT,
      transactionType TEXT CHECK(transactionType IN ('credit', 'cash')) DEFAULT 'cash',
      status TEXT DEFAULT 'draft',
      stateOfSupply TEXT,
      subtotal REAL DEFAULT 0,
      discountAmount REAL DEFAULT 0,
      discountPercentage REAL DEFAULT 0,
      taxAmount REAL DEFAULT 0,
      shippingCharges REAL DEFAULT 0,
      packagingCharges REAL DEFAULT 0,
      adjustment REAL DEFAULT 0,
      roundOff REAL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paidAmount REAL DEFAULT 0,
      balanceAmount REAL DEFAULT 0,
      paymentType TEXT DEFAULT 'cash',
      bankId TEXT,
      poNumber TEXT,
      poDate TEXT,
      description TEXT,
      documentSubtype TEXT,
      validUntil TEXT,
      paymentTerms TEXT,
      dueDate TEXT,
      ewaybillNo TEXT,
      vehicleNumber TEXT,
      transportName TEXT,
      deliveryDate TEXT,
      isDeleted INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (partyId) REFERENCES parties(id)
    );

    -- Document Items
    -- Document audit trail: immutable history for create/modify/delete actions.
    CREATE TABLE IF NOT EXISTS document_audit_logs (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      documentId TEXT NOT NULL,
      action TEXT NOT NULL,
      changesJson TEXT DEFAULT '{}',
      note TEXT,
      actorId TEXT,
      actorName TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_audit_logs_doc ON document_audit_logs(documentId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_document_audit_logs_firm ON document_audit_logs(firmId, createdAt);

    CREATE TABLE IF NOT EXISTS document_items (
      id TEXT PRIMARY KEY,
      documentId TEXT NOT NULL,
      firmId TEXT NOT NULL,
      itemId TEXT,
      name TEXT NOT NULL,
      description TEXT,
      hsnCode TEXT,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT,
      unitId TEXT,
      isSecondaryUnit INTEGER DEFAULT 0,
      baseQuantity REAL NOT NULL DEFAULT 0,
      secondaryQuantity REAL NOT NULL DEFAULT 0,
      secondaryUnitId TEXT,
      price REAL NOT NULL DEFAULT 0,
      discount REAL DEFAULT 0,
      discountType TEXT DEFAULT 'percentage',
      discountPercentage REAL NOT NULL DEFAULT 0,
      discountAmount REAL NOT NULL DEFAULT 0,
      taxRate REAL DEFAULT 0,
      taxAmount REAL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      batchId TEXT,
      batchNumber TEXT,
      expiryDate TEXT,
      expiryMonth INTEGER,
      expiryYear INTEGER,
      mfgDate TEXT,
      packing TEXT,
      freeQuantity REAL DEFAULT 0,
      mrp REAL DEFAULT 0,
      sellingRate REAL DEFAULT 0,
      markup REAL DEFAULT 0,
      schemeBuyQty REAL DEFAULT 0,
      schemeFreeQty REAL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (itemId) REFERENCES items(id)
    );

    -- Inventory Batches (firm/item scoped; zero-stock batches are retained for history)
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      batchNumber TEXT,
      expiryDate TEXT,
      expiryMonth INTEGER,
      expiryYear INTEGER,
      mfgDate TEXT,
      packing TEXT,
      purchaseRate REAL DEFAULT 0,
      mrp REAL DEFAULT 0,
      sellingRate REAL DEFAULT 0,
      markup REAL DEFAULT 0,
      manufacturingRate REAL DEFAULT 0,
      schemeBuyQty REAL DEFAULT 0,
      schemeFreeQty REAL DEFAULT 0,
      quantity REAL DEFAULT 0,
      reservedQuantity REAL DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_item ON inventory_batches(firmId,itemId);
    CREATE INDEX IF NOT EXISTS idx_inventory_batches_lookup ON inventory_batches(firmId,itemId,batchNumber);

    -- Counter Sales (sales-only, non-invoice walk-in entries). Stock is reserved once
    -- when the user selects/scans an item; conversion later creates the invoice
    -- without applying stock a second time.
    CREATE TABLE IF NOT EXISTS counter_sales (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      counterNo INTEGER NOT NULL,
      saleDate TEXT NOT NULL,
      saleTime TEXT,
      customerName TEXT,
      total REAL NOT NULL DEFAULT 0,
      roundOff REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      convertedDocumentId TEXT,
      stockReserved INTEGER NOT NULL DEFAULT 0,
      stockReservedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_counter_sales_firm_date ON counter_sales(firmId,saleDate,status);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_counter_sales_firm_date_no ON counter_sales(firmId,saleDate,counterNo);

    CREATE TABLE IF NOT EXISTS counter_sale_items (
      id TEXT PRIMARY KEY,
      counterSaleId TEXT NOT NULL,
      firmId TEXT NOT NULL,
      itemId TEXT,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit TEXT,
      unitId TEXT,
      isSecondaryUnit INTEGER DEFAULT 0,
      baseQuantity REAL NOT NULL DEFAULT 0,
      secondaryQuantity REAL NOT NULL DEFAULT 0,
      secondaryUnitId TEXT,
      price REAL NOT NULL DEFAULT 0,
      taxRate REAL DEFAULT 0,
      taxAmount REAL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      batchId TEXT,
      batchNumber TEXT,
      expiryDate TEXT,
      expiryMonth INTEGER,
      expiryYear INTEGER,
      mfgDate TEXT,
      packing TEXT,
      mrp REAL DEFAULT 0,
      freeQuantity REAL DEFAULT 0,
      sellingRate REAL DEFAULT 0,
      schemeBuyQty REAL DEFAULT 0,
      schemeFreeQty REAL DEFAULT 0,
      godownId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (counterSaleId) REFERENCES counter_sales(id) ON DELETE CASCADE,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (itemId) REFERENCES items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_counter_sale_items_parent ON counter_sale_items(counterSaleId);
    CREATE INDEX IF NOT EXISTS idx_counter_sale_items_item ON counter_sale_items(firmId,itemId);

    -- Payments
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      type TEXT CHECK(type IN ('payment_in', 'payment_out')) NOT NULL,
      partyId TEXT,
      partyName TEXT NOT NULL,
      amount REAL NOT NULL,
      paymentMethod TEXT DEFAULT 'cash',
      bankId TEXT,
      receiptNumber TEXT,
      paymentDate TEXT NOT NULL,
      reference TEXT,
      description TEXT,
      linkedDocumentId TEXT,
      isDeleted INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (partyId) REFERENCES parties(id)
    );

    -- Bank Accounts
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      accountName TEXT NOT NULL,
      bankName TEXT NOT NULL,
      accountNumber TEXT,
      ifscCode TEXT,
      branchName TEXT,
      openingBalance REAL DEFAULT 0,
      currentBalance REAL DEFAULT 0,
      upiId TEXT,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Bank Transactions
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      accountId TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('credit','debit')),
      amount REAL NOT NULL CHECK(amount >= 0),
      description TEXT,
      reference TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (accountId) REFERENCES bank_accounts(id) ON DELETE CASCADE
    );

    -- Expenses
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      categoryId TEXT,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      paymentMethod TEXT DEFAULT 'cash',
      bankId TEXT,
      description TEXT,
      partyId TEXT,
      partyName TEXT,
      isDeleted INTEGER DEFAULT 0,
      receiptUrl TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Godowns (Warehouses)
    CREATE TABLE IF NOT EXISTS godowns (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      isDefault INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Inventory Stock
    CREATE TABLE IF NOT EXISTS inventory_stock (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      godownId TEXT,
      quantity REAL DEFAULT 0,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (itemId) REFERENCES items(id) ON DELETE CASCADE
    );

    -- Employees (HR)
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      employeeCode TEXT,
      firstName TEXT NOT NULL,
      lastName TEXT,
      phone TEXT,
      email TEXT,
      department TEXT,
      designation TEXT,
      joiningDate TEXT,
      salary REAL DEFAULT 0,
      salaryType TEXT DEFAULT 'monthly',
      bankAccountName TEXT,
      bankAccountNumber TEXT,
      ifscCode TEXT,
      panNumber TEXT,
      aadharNumber TEXT,
      address TEXT,
      status TEXT DEFAULT 'active',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Attendance
    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      employeeId TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT CHECK(status IN ('present', 'absent', 'half_day', 'holiday', 'leave')) DEFAULT 'present',
      checkIn TEXT,
      checkOut TEXT,
      notes TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE
    );

    -- Payroll Runs
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      month TEXT NOT NULL,
      year TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      totalAmount REAL DEFAULT 0,
      paidAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Payroll Items
    CREATE TABLE IF NOT EXISTS payroll_items (
      id TEXT PRIMARY KEY,
      payrollRunId TEXT NOT NULL,
      employeeId TEXT NOT NULL,
      employeeName TEXT NOT NULL,
      basicSalary REAL DEFAULT 0,
      totalDays INTEGER DEFAULT 0,
      presentDays REAL DEFAULT 0,
      earnedSalary REAL DEFAULT 0,
      allowances REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      netSalary REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (payrollRunId) REFERENCES payroll_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (employeeId) REFERENCES employees(id)
    );

    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      partyId TEXT,
      partyName TEXT,
      startDate TEXT,
      endDate TEXT,
      status TEXT DEFAULT 'active',
      budget REAL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Commission Agents
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      commissionRate REAL DEFAULT 0,
      commissionType TEXT DEFAULT 'percentage',
      isActive INTEGER DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Reminders
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      partyId TEXT,
      partyName TEXT,
      amount REAL,
      phone TEXT,
      message TEXT,
      scheduledDate TEXT,
      isCompleted INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Firm Settings
    CREATE TABLE IF NOT EXISTS firm_settings (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      settingType TEXT NOT NULL,
      settingKey TEXT,
      settingValue TEXT,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Number Series (Multiple Series feature)
    CREATE TABLE IF NOT EXISTS series (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      transactionType TEXT NOT NULL CHECK(transactionType IN (
        'sale_invoice', 'sale_order', 'sale_return', 'sale_quotation', 'delivery_challan',
        'purchase_invoice', 'purchase_order', 'purchase_return', 'expense'
      )),
      startingNumber INTEGER NOT NULL DEFAULT 1,
      currentNumber INTEGER NOT NULL DEFAULT 1,
      numberLength INTEGER NOT NULL DEFAULT 4,
      financialYear TEXT,
      includeFinancialYearInNumber INTEGER DEFAULT 0,
      resetYearly INTEGER DEFAULT 0,
      isActive INTEGER DEFAULT 1,
      isDefault INTEGER DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Payment Allocations (bill-wise linking of a Payment In/Out against one or more documents)
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      paymentId TEXT NOT NULL,
      documentId TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
      FOREIGN KEY (paymentId) REFERENCES payments(id) ON DELETE CASCADE,
      FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations(paymentId);
    CREATE INDEX IF NOT EXISTS idx_alloc_document ON payment_allocations(documentId);

    -- Cheques
    CREATE TABLE IF NOT EXISTS cheques (
      id TEXT PRIMARY KEY,
      firmId TEXT NOT NULL,
      paymentId TEXT,
      chequeNumber TEXT NOT NULL,
      bankName TEXT,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      partyName TEXT,
      status TEXT DEFAULT 'pending',
      depositedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_items_firmId ON items(firmId);
    CREATE INDEX IF NOT EXISTS idx_parties_firmId ON parties(firmId);
    CREATE INDEX IF NOT EXISTS idx_documents_firmId ON documents(firmId);
    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(firmId, documentType);
    CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(documentId);
    CREATE INDEX IF NOT EXISTS idx_payments_firmId ON payments(firmId);
    CREATE INDEX IF NOT EXISTS idx_employees_firmId ON employees(firmId);
    CREATE INDEX IF NOT EXISTS idx_attendance_emp ON attendance(firmId, employeeId, date);
    CREATE INDEX IF NOT EXISTS idx_series_firmId ON series(firmId);
    CREATE INDEX IF NOT EXISTS idx_series_type ON series(firmId, transactionType);
  `);
  // v1.18.70: pending-document partial conversion linkage. Each invoice line can
  // point back to the exact source document + source item so remaining quantities
  // stay accurate across partial PO/SO/challan conversions.
  try {
    const diCols = (db.prepare('PRAGMA table_info(document_items)').all() as any[]).map(c=>c.name);
    if (!diCols.includes('sourceDocumentId')) db.exec('ALTER TABLE document_items ADD COLUMN sourceDocumentId TEXT');
    if (!diCols.includes('sourceDocumentItemId')) db.exec('ALTER TABLE document_items ADD COLUMN sourceDocumentItemId TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_items_source ON document_items(sourceDocumentId, sourceDocumentItemId)');
  } catch (e) { console.error('[DB] v1.18.70 source-item linkage migration failed:', (e as any).message); }

  // v1.10.0: purchase-reference/accounting metadata. These columns are additive and
  // backwards-safe for existing installations. sourceDocumentIdsJson links a purchase
  // bill to the pending PO/challan documents consumed into that bill; reference* links
  // returns/debit-credit notes back to the original bill.
  try {
    const docCols = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c=>c.name);
    const addDocCol = (name:string, type:string) => { if (!docCols.includes(name)) db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`); };
    addDocCol('referenceDocumentId','TEXT');
    addDocCol('referenceDocumentNumber','TEXT');
    addDocCol('referenceDocumentDate','TEXT');
    addDocCol('sourceDocumentIdsJson','TEXT');
  } catch (e) { console.error('[DB] v1.10.0 document reference migration failed:', (e as any).message); }

  // Note: intentionally NOT adding a hard UNIQUE constraint on (firmId, documentNumber) here —
  // older installs upgrading from pre-series versions may already have edge-case duplicates from
  // manual document numbers, and a migration that fails to apply would block the whole upgrade.
  // Duplicate prevention for series-generated numbers is instead enforced at generation time
  // via a synchronous DB transaction (see routes/series.routes.ts -> generateSeriesNumber).

  // v1.6.85 migration: stock transfer numbering is optional and backwards-safe.
  try {
    const firmCols = (db.prepare('PRAGMA table_info(firms)').all() as any[]).map(c => c.name);
    if (!firmCols.includes('transferNumber')) db.exec('ALTER TABLE firms ADD COLUMN transferNumber INTEGER DEFAULT 1');
  } catch (e) { console.error('[DB] transferNumber migration failed:', (e as any).message); }

  // In-place migration: fix the legacy parties.openingBalanceType CHECK constraint.
  // Older B-MAX builds accidentally constrained `type` instead of `openingBalanceType`.
  // SQLite cannot ALTER a CHECK constraint, so rebuild the table only when the legacy
  // schema is detected. Existing party data is preserved; invalid balance types default to debit.
  try {
    const partySchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'parties'").get() as any;
    const legacyCheck = !!partySchema?.sql && partySchema.sql.includes("openingBalanceType TEXT CHECK(type IN ('debit', 'credit'))");
    if (legacyCheck) {
      db.pragma('foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(`
          CREATE TABLE parties_new (
            id TEXT PRIMARY KEY,
            firmId TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT CHECK(type IN ('customer', 'supplier', 'both')) DEFAULT 'customer',
            phone TEXT,
            email TEXT,
            gstin TEXT,
            pan TEXT,
            address TEXT,
            city TEXT,
            state TEXT,
            pincode TEXT,
            groupId TEXT,
            creditLimit REAL DEFAULT 0,
            openingBalance REAL DEFAULT 0,
            openingBalanceType TEXT CHECK(openingBalanceType IN ('debit', 'credit')) DEFAULT 'debit',
            loyaltyPoints INTEGER DEFAULT 0,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
            FOREIGN KEY (groupId) REFERENCES groups(id)
          );
          INSERT INTO parties_new (
            id, firmId, name, type, phone, email, gstin, pan, address, city, state, pincode,
            groupId, creditLimit, openingBalance, openingBalanceType, loyaltyPoints, isActive,
            createdAt, updatedAt
          )
          SELECT
            id, firmId, name, type, phone, email, gstin, pan, address, city, state, pincode,
            groupId, creditLimit, openingBalance,
            CASE WHEN openingBalanceType IN ('debit', 'credit') THEN openingBalanceType ELSE 'debit' END,
            loyaltyPoints, isActive, createdAt, updatedAt
          FROM parties;
          DROP TABLE parties;
          ALTER TABLE parties_new RENAME TO parties;
          CREATE INDEX IF NOT EXISTS idx_parties_firmId ON parties(firmId);
        `);
        db.exec('COMMIT');
        console.log('[DB] Migrated: fixed parties.openingBalanceType CHECK constraint');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }
  } catch (e) {
    console.error('[DB] parties openingBalanceType migration failed:', (e as any).message);
    throw e;
  }

  // In-place migration: add seriesId to documents if upgrading from a pre-series database.
  // CREATE TABLE IF NOT EXISTS above only applies to brand-new databases, so existing
  // installs need this explicit ALTER TABLE to gain the new column without any data loss.
  try {
    const documentCols = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c => c.name);
    if (!documentCols.includes('seriesId')) {
      db.exec('ALTER TABLE documents ADD COLUMN seriesId TEXT');
      console.log('[DB] Migrated: added documents.seriesId');
    }
  } catch (e) {
    console.warn('[DB] documents.seriesId migration skipped:', (e as any).message);
  }

  // In-place migration: Two Units + Conversion feature.
  // Item-level quantity precision policy: 0 = whole units only, 1 = decimals allowed.
  {
    const itemCols = (db.prepare('PRAGMA table_info(items)').all() as any[]).map(c => c.name);
    if (!itemCols.includes('decimalEnabled')) {
      db.exec('ALTER TABLE items ADD COLUMN decimalEnabled INTEGER DEFAULT 0');
      console.log('[DB] Migrated: added items.decimalEnabled');
    }
  }

  // items gains secondaryUnitId (Unit 2) + conversionFactor (how many Unit 1 = 1 Unit 2).
  // document_items gains unitId (which unit was picked on that line), isSecondaryUnit flag,
  // and baseQuantity (quantity converted into Unit 1 terms — this is what stock math uses).
  // All additive, nullable/defaulted — existing rows and installs are unaffected.
  try {
    const itemCols = (db.prepare("PRAGMA table_info(items)").all() as any[]).map(c => c.name);
    if (!itemCols.includes('secondaryUnitId')) {
      db.exec('ALTER TABLE items ADD COLUMN secondaryUnitId TEXT');
      console.log('[DB] Migrated: added items.secondaryUnitId');
    }
    if (!itemCols.includes('conversionFactor')) {
      db.exec('ALTER TABLE items ADD COLUMN conversionFactor REAL NOT NULL DEFAULT 1');
      console.log('[DB] Migrated: added items.conversionFactor');
    }
  } catch (e) {
    console.warn('[DB] items unit-conversion migration skipped:', (e as any).message);
  }
  try {
    const diCols = (db.prepare("PRAGMA table_info(document_items)").all() as any[]).map(c => c.name);
    if (!diCols.includes('unitId')) {
      db.exec('ALTER TABLE document_items ADD COLUMN unitId TEXT');
      console.log('[DB] Migrated: added document_items.unitId');
    }
    if (!diCols.includes('isSecondaryUnit')) {
      db.exec('ALTER TABLE document_items ADD COLUMN isSecondaryUnit INTEGER DEFAULT 0');
      console.log('[DB] Migrated: added document_items.isSecondaryUnit');
    }
    if (!diCols.includes('baseQuantity')) {
      db.exec('ALTER TABLE document_items ADD COLUMN baseQuantity REAL NOT NULL DEFAULT 0');
      console.log('[DB] Migrated: added document_items.baseQuantity');
      // Backfill: for pre-existing rows, baseQuantity was never tracked separately —
      // the old behavior always treated `quantity` as base-unit quantity (no Unit 2
      // existed yet), so backfilling baseQuantity = quantity is exactly correct and
      // keeps historical stock math identical to what already happened.
      db.exec('UPDATE document_items SET baseQuantity = quantity WHERE baseQuantity = 0');
    }
    if (!diCols.includes('secondaryQuantity')) db.exec('ALTER TABLE document_items ADD COLUMN secondaryQuantity REAL NOT NULL DEFAULT 0');
    if (!diCols.includes('secondaryUnitId')) db.exec('ALTER TABLE document_items ADD COLUMN secondaryUnitId TEXT');
    if (!diCols.includes('discountPercentage')) db.exec('ALTER TABLE document_items ADD COLUMN discountPercentage REAL NOT NULL DEFAULT 0');
    if (!diCols.includes('discountAmount')) db.exec('ALTER TABLE document_items ADD COLUMN discountAmount REAL NOT NULL DEFAULT 0');
    // Backfill the new split discount fields from legacy single discount values.
    db.exec("UPDATE document_items SET discountPercentage = CASE WHEN discountType='percentage' THEN COALESCE(discount,0) ELSE 0 END, discountAmount = CASE WHEN discountType='amount' THEN COALESCE(discount,0) ELSE 0 END WHERE COALESCE(discountPercentage,0)=0 AND COALESCE(discountAmount,0)=0 AND COALESCE(discount,0)<>0");
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_items_item ON document_items(itemId, documentId)');
  } catch (e) {
    console.warn('[DB] document_items unit-conversion migration skipped:', (e as any).message);
  }

  // Expense ledger migration: expense types are accounting ledgers under Direct Expenses.
  try {
    const ccols = (db.prepare("PRAGMA table_info(categories)").all() as any[]).map(c => c.name);
    if (!ccols.includes('accountGroup')) db.exec('ALTER TABLE categories ADD COLUMN accountGroup TEXT');
    if (!ccols.includes('accountNature')) db.exec('ALTER TABLE categories ADD COLUMN accountNature TEXT');
    if (!ccols.includes('isSystemLedger')) db.exec('ALTER TABLE categories ADD COLUMN isSystemLedger INTEGER DEFAULT 0');
    db.exec("UPDATE categories SET accountGroup='Direct Expenses', accountNature='expense', isSystemLedger=0 WHERE type='expense'");
  } catch (e) { console.warn('[DB] expense ledger migration skipped:', (e as any).message); }

  // In-place migration: Store/Godown allocation on billing documents.
  // The document-level godownId is the billing-window default; each document line
  // also stores its own godownId so one invoice can send different items to
  // different stores.
  try {
    const dcols = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c => c.name);
    if (!dcols.includes('godownId')) db.exec('ALTER TABLE documents ADD COLUMN godownId TEXT');
    const icols = (db.prepare("PRAGMA table_info(document_items)").all() as any[]).map(c => c.name);
    if (!icols.includes('godownId')) db.exec('ALTER TABLE document_items ADD COLUMN godownId TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_items_godown ON document_items(firmId, godownId, itemId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inventory_stock_location ON inventory_stock(firmId, godownId, itemId)');
  } catch (e) { console.warn('[DB] billing store allocation migration skipped:', (e as any).message); }

  // AI document import metadata — keeps the original source reference with the bill.
  try {
    const docCols2=(db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c=>c.name);
    if(!docCols2.includes('aiSourceFileName')) db.exec('ALTER TABLE documents ADD COLUMN aiSourceFileName TEXT');
    if(!docCols2.includes('aiSourceFilePath')) db.exec('ALTER TABLE documents ADD COLUMN aiSourceFilePath TEXT');
    if(!docCols2.includes('aiImportedAt')) db.exec('ALTER TABLE documents ADD COLUMN aiImportedAt TEXT');
  } catch(e){ console.warn('[DB] AI import metadata migration:',(e as any).message); }

  // In-place migration: flexible custom document charges/expenses stored as JSON.
  // Keeps custom labels and signed amounts (positive or negative) without changing
  // the core fixed shipping/packaging/adjustment columns.
  try {
    const chargeCols = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c => c.name);
    if (!chargeCols.includes('extraChargesJson')) {
      db.exec('ALTER TABLE documents ADD COLUMN extraChargesJson TEXT');
      console.log('[DB] Migrated: added documents.extraChargesJson');
    }
  } catch (e) {
    console.warn('[DB] documents.extraChargesJson migration skipped:', (e as any).message);
  }

  // v1.8.5 forward migration: VAT configuration on existing firms.
  try { const firmCols = (db.prepare("PRAGMA table_info(firms)").all() as any[]).map(c => c.name); if (!firmCols.includes('vatRate')) db.exec('ALTER TABLE firms ADD COLUMN vatRate REAL DEFAULT 5'); } catch (e) { console.warn('[DB] firms.vatRate migration skipped:', (e as any).message); }

  // Accounting-boundary cleanup: quotations, orders and delivery documents are not bills.
  // Legacy builds could leave their paid/balance fields populated, which then leaked into
  // outstanding screens. Zero those fields once on startup; invoices/returns are untouched.
  try {
    db.exec("UPDATE documents SET paidAmount = 0, balanceAmount = 0 WHERE documentType NOT IN ('sale_invoice','purchase_invoice','sale_return','purchase_return') AND (COALESCE(paidAmount,0) <> 0 OR COALESCE(balanceAmount,0) <> 0)");
    console.log('[DB] Migrated: cleared non-accounting document balances');
  } catch (e) {
    console.warn('[DB] accounting-boundary cleanup skipped:', (e as any).message);
  }

  // GST registration mode migration: regular or composition.
  try {
    const firmCols = (db.prepare("PRAGMA table_info(firms)").all() as any[]).map(c => c.name);
    if (!firmCols.includes('gstType')) {
      db.exec("ALTER TABLE firms ADD COLUMN gstType TEXT NOT NULL DEFAULT 'regular'");
      console.log('[DB] Migrated: added firms.gstType');
    }
    db.exec("UPDATE firms SET gstType='regular' WHERE gstType IS NULL OR gstType=''");
  } catch (e) { console.warn('[DB] firms.gstType migration skipped:', (e as any).message); }

  // In-place migration: Cash in Hand per firm (mirrors bank_accounts.currentBalance but for cash).
  try {
    const firmCols = (db.prepare("PRAGMA table_info(firms)").all() as any[]).map(c => c.name);
    if (!firmCols.includes('cashInHand')) {
      db.exec('ALTER TABLE firms ADD COLUMN cashInHand REAL NOT NULL DEFAULT 0');
      console.log('[DB] Migrated: added firms.cashInHand');
    }
  } catch (e) {
    console.warn('[DB] firms.cashInHand migration skipped:', (e as any).message);
  }

  // B-MAX 1.13.58 item-company master. Company is optional and firm-scoped.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS item_companies (
      id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE
    );`);
    const itemColsNow = (db.prepare('PRAGMA table_info(items)').all() as any[]).map(c=>c.name);
    if (!itemColsNow.includes('companyId')) db.exec('ALTER TABLE items ADD COLUMN companyId TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_item_companies_firm_name ON item_companies(firmId, name COLLATE NOCASE)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_items_company ON items(firmId, companyId)');
  } catch (e) { console.warn('[DB] item-company migration skipped:', e); }

  // Search/identity migration: SKU + barcode and separate B2B/B2C party identities.
  try {
    const itemCols = (db.prepare("PRAGMA table_info(items)").all() as any[]).map(c => c.name);
    if (!itemCols.includes('itemRole')) db.exec("ALTER TABLE items ADD COLUMN itemRole TEXT NOT NULL DEFAULT 'FINISHED_GOOD' CHECK(itemRole IN ('RAW_MATERIAL','FINISHED_GOOD'))");
    if (!itemCols.includes('sku')) db.exec('ALTER TABLE items ADD COLUMN sku TEXT');
    if (!itemCols.includes('barcode')) db.exec('ALTER TABLE items ADD COLUMN barcode TEXT');
    db.exec("CREATE INDEX IF NOT EXISTS idx_items_search ON items(firmId, name, itemCode, sku, barcode)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode_unique ON items(firmId, barcode) WHERE barcode IS NOT NULL AND TRIM(barcode) <> ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_items_sku_unique ON items(firmId, sku) WHERE sku IS NOT NULL AND TRIM(sku) <> ''");
  } catch (e) { console.warn('[DB] item search migration:', (e as any).message); }
  try {
    const partyCols = (db.prepare("PRAGMA table_info(parties)").all() as any[]).map(c => c.name);
    if (!partyCols.includes('partyKind')) db.exec("ALTER TABLE parties ADD COLUMN partyKind TEXT DEFAULT 'B2B'");
    if (!partyCols.includes('partyCode')) db.exec('ALTER TABLE parties ADD COLUMN partyCode TEXT');
    if (!partyCols.includes('creditDays')) db.exec('ALTER TABLE parties ADD COLUMN creditDays INTEGER DEFAULT 0');
    const firms = db.prepare('SELECT id FROM firms').all() as any[];
    for (const firm of firms) {
      let b2b = 0, b2c = 0;
      const codes = db.prepare('SELECT partyCode FROM parties WHERE firmId=? AND partyCode IS NOT NULL').all(firm.id) as any[];
      for (const row of codes) { const code=String(row.partyCode); const m=code.match(/^(PARTY|CUSTOMER)-(\d+)$/); if(m){ if(m[1]==='CUSTOMER') b2c=Math.max(b2c,Number(m[2])); else b2b=Math.max(b2b,Number(m[2])); } }
      const missing = db.prepare("SELECT id, partyKind FROM parties WHERE firmId=? AND (partyCode IS NULL OR TRIM(partyCode)='') ORDER BY createdAt,id").all(firm.id) as any[];
      for (const row of missing) { const kind=row.partyKind==='B2C'?'B2C':'B2B'; const code=kind==='B2C'?`CUSTOMER-${String(++b2c).padStart(5,'0')}`:`PARTY-${String(++b2b).padStart(5,'0')}`; db.prepare('UPDATE parties SET partyKind=?, partyCode=? WHERE id=?').run(kind,code,row.id); }
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_parties_search ON parties(firmId, name, phone, partyCode)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_b2c_phone_unique ON parties(firmId, phone) WHERE partyKind='B2C' AND phone IS NOT NULL AND TRIM(phone) <> ''");
  } catch (e) { console.warn('[DB] party identity migration:', (e as any).message); }

  // Proforma Invoice foundation: keep proforma documents separate from quotations
  // without changing the legacy document CHECK constraint. Proformas are stored as
  // sale_quotation + documentSubtype='proforma', so old databases remain safe.
  try {
    const docCols = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c=>c.name);
    if (!docCols.includes('documentSubtype')) db.exec("ALTER TABLE documents ADD COLUMN documentSubtype TEXT");
    if (!docCols.includes('validUntil')) db.exec("ALTER TABLE documents ADD COLUMN validUntil TEXT");
    if (!docCols.includes('paymentTerms')) db.exec("ALTER TABLE documents ADD COLUMN paymentTerms TEXT");
    if (!docCols.includes('dueDate')) db.exec("ALTER TABLE documents ADD COLUMN dueDate TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_subtype ON documents(firmId,documentType,documentSubtype)");
  } catch(e) { console.warn('[DB] proforma document migration:', (e as any).message); }
  try {
    const firmCols = (db.prepare("PRAGMA table_info(firms)").all() as any[]).map(c=>c.name);
    if (!firmCols.includes('proformaNumber')) db.exec("ALTER TABLE firms ADD COLUMN proformaNumber INTEGER DEFAULT 1");
  } catch(e) { console.warn('[DB] proforma numbering migration:', (e as any).message); }

  // In-place migration: preserve a separate Entry Date on every document.
  // Older documents used documentDate as their effective entry date, so backfill
  // existing rows instead of leaving edit forms with an empty value.
  try {
    const entryCols = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c=>c.name);
    if (!entryCols.includes('entryDate')) db.exec("ALTER TABLE documents ADD COLUMN entryDate TEXT");
    db.exec("UPDATE documents SET entryDate=documentDate WHERE entryDate IS NULL OR TRIM(entryDate)=''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_documents_entry_date ON documents(firmId,entryDate)');
  } catch(e) { console.warn('[DB] documents.entryDate migration skipped:', (e as any).message); }

  // Documents now carry the selected GST registration. Existing bills remain linked to the primary registration.
  try {
    const cols = (db.prepare('PRAGMA table_info(documents)').all() as any[]).map(c=>c.name);
    if (!cols.includes('gstRegistrationId')) {
      db.exec('ALTER TABLE documents ADD COLUMN gstRegistrationId TEXT');
      db.exec(`UPDATE documents SET gstRegistrationId=(SELECT id FROM gst_registrations g WHERE g.firmId=documents.firmId AND g.isPrimary=1 LIMIT 1) WHERE gstRegistrationId IS NULL`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_documents_gst ON documents(firmId,gstRegistrationId)');
    }
  } catch(e) { console.warn('[DB] documents GST registration migration skipped:', (e as any).message); }

  // Role/permission migration: add role mapping columns to existing installations.
  try {
    const fuCols = (db.prepare('PRAGMA table_info(firm_users)').all() as any[]).map(c=>c.name);
    if (!fuCols.includes('roleId')) db.exec('ALTER TABLE firm_users ADD COLUMN roleId TEXT');
    if (!fuCols.includes('accessScopeJson')) db.exec("ALTER TABLE firm_users ADD COLUMN accessScopeJson TEXT DEFAULT '{}'");
    if (!fuCols.includes('inviteStatus')) db.exec("ALTER TABLE firm_users ADD COLUMN inviteStatus TEXT DEFAULT 'active'");
    if (!fuCols.includes('invitedAt')) db.exec('ALTER TABLE firm_users ADD COLUMN invitedAt TEXT');
    if (!fuCols.includes('acceptedAt')) db.exec('ALTER TABLE firm_users ADD COLUMN acceptedAt TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS user_roles (id TEXT PRIMARY KEY, firmId TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL, description TEXT, permissionsJson TEXT DEFAULT '{}', isSystem INTEGER DEFAULT 0, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE)`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_firm_code ON user_roles(firmId, code)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_roles_firm ON user_roles(firmId)');
    console.log('[DB] Role/permission migration ready');
  } catch (e) { console.warn('[DB] role/permission migration skipped:', (e as any).message); }

  // Multi-GST migration: mirror the existing firm's GSTIN into the new registrations table.
  try {
    const firms = db.prepare("SELECT id, name, legalName, address, state, pincode, gstin FROM firms WHERE gstin IS NOT NULL AND TRIM(gstin) <> ''").all() as any[];
    const now = new Date().toISOString();
    const exists = db.prepare('SELECT id FROM gst_registrations WHERE firmId=? AND gstin=?');
    const add = db.prepare(`INSERT INTO gst_registrations (id,firmId,gstin,legalName,tradeName,state,address,pincode,isPrimary,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`);
    for (const f of firms) {
      if (!exists.get(f.id, f.gstin)) add.run(uuidv4(), f.id, String(f.gstin).trim().toUpperCase(), f.legalName || null, f.name || null, f.state || null, f.address || null, f.pincode || null, 1, now, now);
    }
  } catch (e) { console.warn('[DB] GST registration migration skipped:', (e as any).message); }

  // Multi-user migration: create a local owner account for existing firms so the
  // new access-control structure is usable without changing existing data.
  try {
    const firms = db.prepare('SELECT id, name, email, phone FROM firms').all() as any[];
    const now = new Date().toISOString();
    const getUser = db.prepare('SELECT id FROM users WHERE email=?');
    const insertUser = db.prepare('INSERT INTO users (id,name,email,phone,isActive,createdAt,updatedAt) VALUES (?,?,?,?,1,?,?)');
    const insertMember = db.prepare(`INSERT OR IGNORE INTO firm_users (id,firmId,userId,role,permissionsJson,isOwner,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,1,1,?,?)`);
    const ownerPermissions = JSON.stringify({ '*': ['view','create','edit','delete','cancel','print','export','manage'] });
    for (const f of firms) {
      const email = String(f.email || `owner+${f.id.slice(0,8)}@bmax.local`).trim().toLowerCase();
      let u = getUser.get(email) as any;
      if (!u) {
        const uid = uuidv4();
        insertUser.run(uid, String(f.name || 'Owner') + ' Owner', email, f.phone || null, now, now);
        u = { id: uid };
      }
      insertMember.run(uuidv4(), f.id, u.id, 'owner', ownerPermissions, 1, now, now);
    }
    console.log('[DB] Multi-user migration: owner memberships ready');
  } catch (e) {
    console.warn('[DB] multi-user migration skipped:', (e as any).message);
  }

  // Safety snapshot immediately before the first sync migration only.
  try {
    const syncExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_devices'").get();
    if (!syncExists) {
      const snapshot = snapshotOpenDatabase(db);
      console.log('[DB] Pre-sync snapshot:', snapshot.path);
    }
  } catch (e) {
    console.error('[DB] Pre-sync snapshot failed; sync foundation will NOT modify this database:', (e as any).message);
    throw e;
  }

  // Sync foundation is additive and runs only after all business tables/migrations exist.
  try {
    initializeSyncSchema(db);
    console.log('[DB] Sync foundation initialized');
  } catch (e) {
    console.error('[DB] Sync foundation initialization failed:', (e as any).message);
    throw e;
  }

  // Safe soft-delete migration for payment recycle-bin support.
  try {
    const paymentCols = new Set((db.prepare('PRAGMA table_info(payments)').all() as any[]).map(c => c.name));
    if (!paymentCols.has('isDeleted')) db.exec('ALTER TABLE payments ADD COLUMN isDeleted INTEGER DEFAULT 0');
  } catch (e) { console.warn('[DB] payments recycle-bin migration skipped:', e); }

  try {
    const expenseCols = new Set((db.prepare('PRAGMA table_info(expenses)').all() as any[]).map(c => c.name));
    if (!expenseCols.has('isDeleted')) db.exec('ALTER TABLE expenses ADD COLUMN isDeleted INTEGER DEFAULT 0');
  } catch (e) { console.warn('[DB] expenses recycle-bin migration skipped:', e); }

  // GST price-mode migration for billing documents (exclusive/inclusive).
  try {
    const docCols = (db.prepare("PRAGMA table_info(documents)").all() as any[]).map(c=>c.name);
    if (!docCols.includes('gstPriceMode')) db.exec("ALTER TABLE documents ADD COLUMN gstPriceMode TEXT DEFAULT 'exclusive'");
  } catch(e) { console.warn('[DB] gst price-mode migration:', (e as any).message); }

  // Item master schema migration: MRP and related optional item fields must be
  // available before ANY item create/import route runs. Keeping this in the core
  // database initializer prevents 'table items has no column named mrp' on
  // existing installations created before these fields were introduced.
  try {
    const itemCols = new Set((db.prepare("PRAGMA table_info(items)").all() as any[]).map(c => c.name));
    const itemAdditions: Record<string,string> = {
      mrp:'REAL DEFAULT 0',
      discount1:'REAL DEFAULT 0',
      volumeDiscount:'REAL DEFAULT 0',
      mfgDate:'TEXT'
    };
    for (const [col,type] of Object.entries(itemAdditions)) {
      if (!itemCols.has(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${type}`);
    }
  } catch (e) {
    console.error('[DB] item master schema migration failed:', (e as any).message);
    throw e;
  }

  // Batch/packing migrations for existing firms/databases.
  try {
    const itemCols = (db.prepare("PRAGMA table_info(items)").all() as any[]).map(c=>c.name);
    if (!itemCols.includes('packing')) db.exec('ALTER TABLE items ADD COLUMN packing TEXT');
    const diCols = (db.prepare("PRAGMA table_info(document_items)").all() as any[]).map(c=>c.name);
    const additions: Record<string,string> = {
      batchId:'TEXT', batchNumber:'TEXT', expiryDate:'TEXT', mfgDate:'TEXT', packing:'TEXT',
      freeQuantity:'REAL DEFAULT 0', mrp:'REAL DEFAULT 0', sellingRate:'REAL DEFAULT 0', markup:'REAL DEFAULT 0', schemeBuyQty:'REAL DEFAULT 0', schemeFreeQty:'REAL DEFAULT 0'
    };
    for (const [col,type] of Object.entries(additions)) if (!diCols.includes(col)) db.exec(`ALTER TABLE document_items ADD COLUMN ${col} ${type}`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_document_items_batch ON document_items(batchId,batchNumber)');
  } catch(e) { console.warn('[DB] batch/packing migration:', (e as any).message); }
  // Batch commercial terms: manufacturing rate and buy-X-get-Y scheme are batch-scoped.
  try {
    const batchCols = new Set((db.prepare("PRAGMA table_info(inventory_batches)").all() as any[]).map(c => c.name));
    if (!batchCols.has('manufacturingRate')) db.exec('ALTER TABLE inventory_batches ADD COLUMN manufacturingRate REAL DEFAULT 0');
    if (!batchCols.has('schemeBuyQty')) db.exec('ALTER TABLE inventory_batches ADD COLUMN schemeBuyQty REAL DEFAULT 0');
    if (!batchCols.has('schemeFreeQty')) db.exec('ALTER TABLE inventory_batches ADD COLUMN schemeFreeQty REAL DEFAULT 0');
  } catch(e) { console.warn('[DB] batch commercial terms migration:', (e as any).message); }
  // Canonical batch expiry migration: month + year replace day-specific expiry.
  try {
    const batchCols = new Set((db.prepare("PRAGMA table_info(inventory_batches)").all() as any[]).map(c => c.name));
    if (!batchCols.has('expiryMonth')) db.exec('ALTER TABLE inventory_batches ADD COLUMN expiryMonth INTEGER');
    if (!batchCols.has('expiryYear')) db.exec('ALTER TABLE inventory_batches ADD COLUMN expiryYear INTEGER');
    const diCols = new Set((db.prepare("PRAGMA table_info(document_items)").all() as any[]).map(c => c.name));
    if (!diCols.has('expiryMonth')) db.exec('ALTER TABLE document_items ADD COLUMN expiryMonth INTEGER');
    if (!diCols.has('expiryYear')) db.exec('ALTER TABLE document_items ADD COLUMN expiryYear INTEGER');
    db.exec("UPDATE inventory_batches SET expiryYear=CAST(substr(expiryDate,1,4) AS INTEGER), expiryMonth=CAST(substr(expiryDate,6,2) AS INTEGER) WHERE (expiryYear IS NULL OR expiryMonth IS NULL) AND expiryDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
    db.exec("UPDATE document_items SET expiryYear=CAST(substr(expiryDate,1,4) AS INTEGER), expiryMonth=CAST(substr(expiryDate,6,2) AS INTEGER) WHERE (expiryYear IS NULL OR expiryMonth IS NULL) AND expiryDate GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry ON inventory_batches(firmId,expiryYear,expiryMonth)');
  } catch(e) { console.warn('[DB] batch expiry month/year migration:', (e as any).message); }
  try {
    const csCols = new Set((db.prepare("PRAGMA table_info(counter_sale_items)").all() as any[]).map(c => c.name));
    if (!csCols.has('freeQuantity')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN freeQuantity REAL DEFAULT 0');
    if (!csCols.has('sellingRate')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN sellingRate REAL DEFAULT 0');
    if (!csCols.has('schemeBuyQty')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN schemeBuyQty REAL DEFAULT 0');
    if (!csCols.has('schemeFreeQty')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN schemeFreeQty REAL DEFAULT 0');
    if (!csCols.has('expiryMonth')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN expiryMonth INTEGER');
    if (!csCols.has('expiryYear')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN expiryYear INTEGER');
  } catch(e) { console.warn('[DB] counter sale batch expiry migration:', (e as any).message); }

  // Store/Godown master enhancements: additive migration for location management.
  try {
    const godownCols = (db.prepare("PRAGMA table_info(godowns)").all() as any[]).map(c => c.name);
    const additions: Record<string,string> = {
      contactPerson: 'TEXT', phone: 'TEXT', isActive: 'INTEGER DEFAULT 1'
    };
    for (const [col, type] of Object.entries(additions)) {
      if (!godownCols.includes(col)) db.exec(`ALTER TABLE godowns ADD COLUMN ${col} ${type}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_godowns_firm_active ON godowns(firmId,isActive,name)');
  } catch (e) { console.warn('[DB] store master migration:', (e as any).message); }

  // v1.4.10 cleanup: permanently remove the retired multi-tab billing control
  // so old databases cannot surface or persist the removed feature.
  try {
    db.prepare("DELETE FROM firm_settings WHERE settingType = 'ui_controls' AND settingKey = 'posMultipleTabs'").run();
  } catch (e) { console.warn('[DB] retired multi-tab control cleanup:', (e as any).message); }

  // Counter Sale persistence safety: ensure these tables also exist in databases
  // created before the Counter Sale feature was introduced. This is intentionally
  // additive and safe to run on every startup.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS counter_sales (
        id TEXT PRIMARY KEY, firmId TEXT NOT NULL, counterNo INTEGER NOT NULL,
        saleDate TEXT NOT NULL, saleTime TEXT, customerName TEXT, total REAL NOT NULL DEFAULT 0, roundOff REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', convertedDocumentId TEXT, stockReserved INTEGER NOT NULL DEFAULT 0, stockReservedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_counter_sales_firm_date ON counter_sales(firmId,saleDate,status);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_counter_sales_firm_date_no ON counter_sales(firmId,saleDate,counterNo);
      CREATE TABLE IF NOT EXISTS counter_sale_items (
        id TEXT PRIMARY KEY, counterSaleId TEXT NOT NULL, firmId TEXT NOT NULL, itemId TEXT, name TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1, unit TEXT, unitId TEXT, isSecondaryUnit INTEGER DEFAULT 0,
        baseQuantity REAL NOT NULL DEFAULT 0, secondaryQuantity REAL NOT NULL DEFAULT 0, secondaryUnitId TEXT,
        price REAL NOT NULL DEFAULT 0, taxRate REAL DEFAULT 0, taxAmount REAL DEFAULT 0, amount REAL NOT NULL DEFAULT 0,
        batchId TEXT, batchNumber TEXT, expiryDate TEXT, expiryMonth INTEGER, expiryYear INTEGER, mfgDate TEXT, packing TEXT, mrp REAL DEFAULT 0, freeQuantity REAL DEFAULT 0, sellingRate REAL DEFAULT 0, schemeBuyQty REAL DEFAULT 0, schemeFreeQty REAL DEFAULT 0, godownId TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_counter_sale_items_parent ON counter_sale_items(counterSaleId);
      CREATE INDEX IF NOT EXISTS idx_counter_sale_items_item ON counter_sale_items(firmId,itemId);
    `);
  } catch (e) {
    console.error('[DB] Counter Sale persistence schema check failed:', (e as any).message);
    throw e;
  }

  // Counter Sale stock reservation migration. Older releases deducted stock when
  // the entry was created, so existing open rows are marked reserved exactly once.
  try {
    const scols=(db.prepare("PRAGMA table_info(counter_sales)").all() as any[]);
    if(!scols.some(c=>c.name==='stockReserved')) {
      // Leave existing open rows at 0 until stock is actually reserved. Do not
      // infer reservation from the presence of the new column.
      db.exec('ALTER TABLE counter_sales ADD COLUMN stockReserved INTEGER NOT NULL DEFAULT 0');
    }
    if(!scols.some(c=>c.name==='stockReservedAt')) db.exec('ALTER TABLE counter_sales ADD COLUMN stockReservedAt TEXT');
    const icols=(db.prepare("PRAGMA table_info(counter_sale_items)").all() as any[]);
    if(!icols.some(c=>c.name==='godownId')) db.exec('ALTER TABLE counter_sale_items ADD COLUMN godownId TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_counter_sale_items_godown ON counter_sale_items(firmId,godownId,itemId)');
  } catch(e) { console.warn('[DB] Counter Sale reservation migration:', (e as any).message); }

  // Ensure legacy firms also receive the system Cash Customer. This is idempotent.
  try {
    const firms = db.prepare('SELECT id FROM firms').all() as any[];
    for (const firm of firms) ensureCashCustomer(String(firm.id));
    console.log(`[DB] Ensured Cash Customer for ${firms.length} firm(s)`);
  } catch (e) {
    console.warn('[DB] Cash Customer migration skipped:', (e as any).message);
  }

  // v1.13.85 multi-firm profile fields: alternate contact details are firm-scoped.
  try {
    const cols = (db.prepare("PRAGMA table_info(firms)").all() as any[]).map(c => c.name);
    if (!cols.includes('alternatePhone')) db.exec("ALTER TABLE firms ADD COLUMN alternatePhone TEXT");
    if (!cols.includes('alternateEmail')) db.exec("ALTER TABLE firms ADD COLUMN alternateEmail TEXT");
    if (!cols.includes('tradeName')) db.exec("ALTER TABLE firms ADD COLUMN tradeName TEXT");
    // v1.14.97 — invoice company identity fields used by Template Studio.
    if (!cols.includes('foodLicenseNumber')) db.exec("ALTER TABLE firms ADD COLUMN foodLicenseNumber TEXT");
    if (!cols.includes('dlNumber')) db.exec("ALTER TABLE firms ADD COLUMN dlNumber TEXT");
  } catch (e) { console.warn('[DB] firm profile contact migration skipped:', (e as any).message); }

  // HR / Payroll v1.16.34 migrations: richer employee master, attendance metadata,
  // configurable payroll periods, leave approvals and accommodation records.
  try {
    const addColumn = (table: string, column: string, definition: string) => {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name);
      if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    // Employee master / hierarchy / salary setup.
    addColumn('employees', 'reportingToId', 'TEXT');
    addColumn('employees', 'employmentType', "TEXT DEFAULT 'full_time'");
    addColumn('employees', 'workLocation', 'TEXT');
    addColumn('employees', 'gender', 'TEXT');
    addColumn('employees', 'dateOfBirth', 'TEXT');
    addColumn('employees', 'shiftName', 'TEXT');
    addColumn('employees', 'weeklyOff', "TEXT DEFAULT 'sunday'");
    addColumn('employees', 'basicSalary', 'REAL DEFAULT 0');
    addColumn('employees', 'hra', 'REAL DEFAULT 0');
    addColumn('employees', 'allowances', 'REAL DEFAULT 0');
    addColumn('employees', 'deductions', 'REAL DEFAULT 0');
    addColumn('employees', 'salaryEffectiveFrom', 'TEXT');
    addColumn('employees', 'emergencyContactName', 'TEXT');
    addColumn('employees', 'emergencyContactPhone', 'TEXT');
    addColumn('employees', 'notes', 'TEXT');
    addColumn('employees', 'salaryHold', 'INTEGER DEFAULT 0');
    addColumn('employees', 'salaryHoldReason', 'TEXT');
    addColumn('employees', 'salaryHoldAt', 'TEXT');
    // Attendance keeps its original status constraint for compatibility and uses
    // attendanceType/approvalStatus for OD and weekly-off semantics.
    addColumn('attendance', 'attendanceType', "TEXT DEFAULT 'regular'");
    addColumn('attendance', 'approvalStatus', "TEXT DEFAULT 'approved'");
    addColumn('attendance', 'approvedBy', 'TEXT');
    addColumn('attendance', 'approvedAt', 'TEXT');
    // Payroll run period and accounting linkage.
    addColumn('payroll_runs', 'startDate', 'TEXT');
    addColumn('payroll_runs', 'endDate', 'TEXT');
    addColumn('payroll_runs', 'workingDays', 'INTEGER DEFAULT 0');
    addColumn('payroll_runs', 'paidAt', 'TEXT');
    addColumn('payroll_runs', 'paymentMethod', "TEXT DEFAULT 'cash'");
    addColumn('payroll_runs', 'bankId', 'TEXT');
    addColumn('payroll_runs', 'paymentReference', 'TEXT');
    addColumn('payroll_runs', 'requestedEndDate', 'TEXT');
    addColumn('payroll_runs', 'calculatedThrough', 'TEXT');
    addColumn('payroll_runs', 'isFinalSettlement', 'INTEGER DEFAULT 0');
    addColumn('payroll_items', 'workingDays', 'INTEGER DEFAULT 0');
    addColumn('payroll_items', 'absentDays', 'REAL DEFAULT 0');
    addColumn('payroll_items', 'halfDays', 'REAL DEFAULT 0');
    addColumn('payroll_items', 'odDays', 'REAL DEFAULT 0');
    addColumn('payroll_items', 'leaveDays', 'REAL DEFAULT 0');
    addColumn('payroll_items', 'weeklyOffDays', 'REAL DEFAULT 0');
    addColumn('payroll_items', 'paymentId', 'TEXT');
    addColumn('payroll_items', 'paidAt', 'TEXT');
    addColumn('payroll_items', 'salaryBasisDays', 'REAL DEFAULT 0');

    // Hard guard: an employee can have only one generated payroll run per firm/month/year.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_duplicate_employee_monthly_payroll
      BEFORE INSERT ON payroll_items
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM payroll_items existingItem
          JOIN payroll_runs existingRun ON existingRun.id = existingItem.payrollRunId
          JOIN payroll_runs newRun ON newRun.id = NEW.payrollRunId
          WHERE existingItem.employeeId = NEW.employeeId
            AND existingRun.firmId = newRun.firmId
            AND existingRun.month = newRun.month
            AND existingRun.year = newRun.year
        ) THEN RAISE(ABORT, 'Payroll already generated for this employee for this month') END;
      END;
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id TEXT PRIMARY KEY,
        firmId TEXT NOT NULL,
        employeeId TEXT NOT NULL,
        leaveType TEXT NOT NULL DEFAULT 'casual',
        startDate TEXT NOT NULL,
        endDate TEXT NOT NULL,
        days REAL NOT NULL DEFAULT 0,
        reason TEXT,
        isPaid INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        approvedBy TEXT,
        approvedAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
        FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_leave_requests_firm_employee ON leave_requests(firmId,employeeId,startDate,endDate);
      CREATE TABLE IF NOT EXISTS accommodations (
        id TEXT PRIMARY KEY,
        firmId TEXT NOT NULL,
        employeeId TEXT NOT NULL,
        accommodationType TEXT NOT NULL DEFAULT 'company_accommodation',
        location TEXT,
        address TEXT,
        monthlyAmount REAL DEFAULT 0,
        fromDate TEXT,
        toDate TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
        FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_accommodations_firm_employee ON accommodations(firmId,employeeId);
      CREATE TABLE IF NOT EXISTS employee_leave_policies (
        id TEXT PRIMARY KEY,
        firmId TEXT NOT NULL,
        employeeId TEXT NOT NULL,
        leaveType TEXT NOT NULL DEFAULT 'casual',
        monthlyEntitlement REAL NOT NULL DEFAULT 0,
        effectiveFrom TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(firmId,employeeId,leaveType),
        FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
        FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_employee_leave_policies_firm_employee ON employee_leave_policies(firmId,employeeId);
      CREATE TABLE IF NOT EXISTS employee_advances_loans (
        id TEXT PRIMARY KEY,
        firmId TEXT NOT NULL,
        employeeId TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('advance','loan')),
        amount REAL NOT NULL DEFAULT 0,
        paymentMethod TEXT NOT NULL DEFAULT 'cash',
        bankId TEXT,
        paymentId TEXT,
        reference TEXT,
        notes TEXT,
        paidAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (firmId) REFERENCES firms(id) ON DELETE CASCADE,
        FOREIGN KEY (employeeId) REFERENCES employees(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_employee_advances_loans_firm_employee ON employee_advances_loans(firmId,employeeId,paidAt);
    `);
  } catch (e) { console.warn('[DB] HR/payroll migration skipped:', (e as any).message); }

  // Subscription schema is initialized at database startup, not lazily from a
  // route. Packaged EXE builds can open an older user database before the
  // activation module is touched; doing the migration here guarantees that
  // activation/add-on queries never hit a missing activationId column.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        installationId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        email TEXT,
        customerId TEXT,
        licenseKey TEXT,
        planCode TEXT,
        planName TEXT,
        durationCode TEXT,
        status TEXT NOT NULL DEFAULT 'trial',
        startsAt TEXT,
        activatedAt TEXT,
        expiresAt TEXT,
        isLifetime INTEGER DEFAULT 0,
        maxFirms INTEGER,
        maxUsers INTEGER,
        additionalUsers INTEGER DEFAULT 0,
        additionalFirms INTEGER DEFAULT 0,
        additionalGst INTEGER DEFAULT 0,
        lastVerifiedAt TEXT,
        cachedUntil TEXT,
        activationId TEXT,
        serverVerified INTEGER DEFAULT 0,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscription_addons (
        id TEXT PRIMARY KEY,
        activationId TEXT,
        addonType TEXT NOT NULL,
        durationCode TEXT NOT NULL,
        activatedAt TEXT NOT NULL,
        expiresAt TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        codeHash TEXT,
        createdAt TEXT NOT NULL
      );
    `);
    const stateCols = new Set((db.prepare('PRAGMA table_info(subscription_state)').all() as any[]).map((c:any)=>String(c.name)));
    const stateMigrations: Record<string,string> = {
      activatedAt:'TEXT', additionalUsers:'INTEGER DEFAULT 0', additionalFirms:'INTEGER DEFAULT 0',
      additionalGst:'INTEGER DEFAULT 0', lastVerifiedAt:'TEXT', cachedUntil:'TEXT',
      activationId:'TEXT', serverVerified:'INTEGER DEFAULT 0'
    };
    for (const [column, definition] of Object.entries(stateMigrations)) {
      if (!stateCols.has(column)) db.exec(`ALTER TABLE subscription_state ADD COLUMN ${column} ${definition}`);
    }
    const addonCols = new Set((db.prepare('PRAGMA table_info(subscription_addons)').all() as any[]).map((c:any)=>String(c.name)));
    const addonMigrations: Record<string,string> = {
      activationId:'TEXT', expiresAt:'TEXT', quantity:'INTEGER DEFAULT 1', codeHash:'TEXT', createdAt:'TEXT'
    };
    for (const [column, definition] of Object.entries(addonMigrations)) {
      if (!addonCols.has(column)) db.exec(`ALTER TABLE subscription_addons ADD COLUMN ${column} ${definition}`);
    }
    console.log('[DB] Subscription schema verified/migrated successfully');
  } catch (e) {
    console.error('[DB] Subscription schema migration failed:', (e as any)?.stack || (e as any)?.message || e);
    throw e;
  }

  // v1.4.7 opening-stock reconciliation: repair legacy items whose opening quantity
  // was saved but currentStock stayed at zero. Never overwrite a stock balance if
  // the item has transaction history, a non-zero godown balance, or batch stock.
  try {
    const repaired = db.prepare(`
      UPDATE items
      SET currentStock=COALESCE(openingStock,0), updatedAt=?
      WHERE COALESCE(currentStock,0)=0 AND COALESCE(openingStock,0)>0
        AND NOT EXISTS (SELECT 1 FROM document_items di WHERE di.itemId=items.id)
        AND NOT EXISTS (SELECT 1 FROM counter_sale_items csi WHERE csi.itemId=items.id)
        AND NOT EXISTS (SELECT 1 FROM inventory_stock ist WHERE ist.itemId=items.id AND COALESCE(ist.quantity,0)<>0)
        AND NOT EXISTS (SELECT 1 FROM inventory_batches ib WHERE ib.itemId=items.id AND COALESCE(ib.quantity,0)<>0)
    `).run(new Date().toISOString());
    if (Number(repaired.changes||0)>0) console.log(`[DB] Reconciled opening stock for ${repaired.changes} legacy item(s)`);
  } catch (e) {
    console.warn('[DB] Opening-stock reconciliation skipped:', (e as any)?.message || e);
  }

  console.log('[DB] Tables initialized successfully');
}

/** Ensure every firm has one system Cash Customer used for walk-in/quick sales. */
export function ensureCashCustomer(firmId: string) {
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT * FROM parties WHERE firmId=? AND (partyCode='CASH-CUSTOMER' OR lower(trim(name))='cash customer') ORDER BY CASE WHEN partyCode='CASH-CUSTOMER' THEN 0 ELSE 1 END, createdAt LIMIT 1"
  ).get(firmId) as any;
  if (existing) {
    if (existing.partyCode !== 'CASH-CUSTOMER' || existing.partyKind !== 'B2C' || existing.type !== 'customer') {
      db.prepare("UPDATE parties SET name='Cash Customer', partyCode='CASH-CUSTOMER', partyKind='B2C', type='customer', phone=NULL, email=NULL, gstin=NULL, pan=NULL, groupId=NULL, isActive=1, updatedAt=? WHERE id=? AND firmId=?").run(now, existing.id, firmId);
      return db.prepare('SELECT * FROM parties WHERE id=? AND firmId=?').get(existing.id, firmId);
    }
    return existing;
  }
  const id = `${firmId}-cash-customer`;
  db.prepare(`INSERT INTO parties (id,firmId,name,type,partyKind,partyCode,phone,email,gstin,pan,address,city,state,pincode,groupId,creditLimit,creditDays,openingBalance,openingBalanceType,isActive,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
    .run(id, firmId, 'Cash Customer', 'customer', 'B2C', 'CASH-CUSTOMER', null, null, null, null, null, null, null, null, null, 0, 0, 0, 'debit', now, now);
  return db.prepare('SELECT * FROM parties WHERE id=? AND firmId=?').get(id, firmId);
}

// Seed default data for a new firm
export function seedDefaultData(firmId: string) {
  const now = new Date().toISOString();
  
  // System walk-in customer used by all sales/POS flows when no party is selected.
  ensureCashCustomer(firmId);

  // Default units
  const units = [
    { id: `${firmId}-unit-1`, name: 'Pieces', shortName: 'PCS' },
    { id: `${firmId}-unit-2`, name: 'Kilograms', shortName: 'KG' },
    { id: `${firmId}-unit-3`, name: 'Meters', shortName: 'MTR' },
    { id: `${firmId}-unit-4`, name: 'Liters', shortName: 'LTR' },
    { id: `${firmId}-unit-5`, name: 'Box', shortName: 'BOX' },
    { id: `${firmId}-unit-6`, name: 'Dozen', shortName: 'DZ' },
  ];

  const insertUnit = db.prepare('INSERT OR IGNORE INTO units (id, firmId, name, shortName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)');
  for (const unit of units) {
    insertUnit.run(unit.id, firmId, unit.name, unit.shortName, now, now);
  }

  // Default categories
  const categories = [
    { id: `${firmId}-cat-1`, name: 'General', type: 'item' },
    { id: `${firmId}-cat-2`, name: 'Electronics', type: 'item' },
    { id: `${firmId}-cat-3`, name: 'Food & Beverages', type: 'item' },
    { id: `${firmId}-cat-4`, name: 'Customer', type: 'party' },
    { id: `${firmId}-cat-5`, name: 'Supplier', type: 'party' },
  ];

  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (id, firmId, name, type, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)');
  for (const cat of categories) {
    insertCat.run(cat.id, firmId, cat.name, cat.type, now, now);
  }
}



