#!/usr/bin/env node
/**
 * Demo seed.
 *
 * Masters are inserted directly; every financial document is posted through the
 * real services, so stock, batches, the ledger, receivables and payables end up
 * exactly as they would in production. Seeding is therefore also a smoke test
 * of the posting paths.
 *
 *   node db/seed/seed.mjs
 */
import 'dotenv/config';
import { withTransaction, query, closePool } from '../../src/lib/db.js';
import { hashPassword } from '../../src/services/authService.js';
import { createCropPurchase } from '../../src/services/cropPurchaseService.js';
import { createCropSale } from '../../src/services/cropSaleService.js';
import { createDealerPurchase, createDealerSale } from '../../src/services/dealerService.js';

const DEFAULT_PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';

/* ------------------------------------------------------------- permissions */

const PERMISSIONS = [
  ['dashboard.view', 'See the dashboard'],
  ['customer.view', 'View customers'], ['customer.create', 'Create customers'],
  ['customer.edit', 'Edit customers'],
  ['supplier.view', 'View suppliers'], ['supplier.create', 'Create suppliers'],
  ['company.view', 'View companies'],
  ['product.view', 'View products'],
  ['dealer.purchase.view', 'View dealer purchases'],
  ['dealer.purchase.create', 'Create dealer purchases'],
  ['dealer.purchase.post', 'Post dealer purchases'],
  ['dealer.purchase.cancel', 'Cancel dealer purchases'],
  ['dealer.sale.view', 'View dealer sales'],
  ['dealer.sale.create', 'Create dealer sales'],
  ['dealer.sale.post', 'Post dealer sales'],
  ['dealer.sale.cancel', 'Cancel dealer sales'],
  ['crop.purchase.view', 'View crop purchases'],
  ['crop.purchase.create', 'Create crop purchases'],
  ['crop.purchase.post', 'Post crop purchases'],
  ['crop.purchase.cancel', 'Cancel crop purchases'],
  ['crop.sale.view', 'View crop sales'],
  ['crop.sale.create', 'Create crop sales'],
  ['crop.sale.post', 'Post crop sales'],
  ['crop.sale.cancel', 'Cancel crop sales'],
  ['inventory.view', 'View stock'], ['inventory.adjust', 'Adjust stock'],
  ['inventory.transfer', 'Transfer stock'],
  ['payment.view', 'View payments'], ['payment.create', 'Record payments'],
  ['expense.view', 'View expenses'], ['expense.create', 'Record expenses'],
  ['approval.view', 'View the approval queue'],
  ['approval.decide', 'Approve or reject requests'],
  ['report.view', 'View reports'], ['report.profit', 'See profit figures'],
  ['employee.view', 'View employees'],
  ['settings.view', 'View settings'], ['settings.edit', 'Change settings'],
  ['audit.view', 'View the audit trail'],
];

/**
 * Role -> permissions, mirroring the permission matrix on the Settings screen.
 *
 * The codes listed here are the ones this file also creates. Later migrations
 * add more -- master-data maintenance, payment methods, role administration --
 * and grant them to the roles that should have them. A fresh database runs
 * every migration before this seed, so those rows already exist by the time
 * this runs: Admin is granted the whole `permissions` table rather than this
 * list, and the extras each other role is meant to hold are named below, so a
 * database built from scratch ends up where a migrated one is.
 */
const ROLE_PERMISSIONS = {
  Admin: PERMISSIONS.map(([code]) => code),
  Management: [
    'dashboard.view', 'customer.view', 'supplier.view', 'company.view', 'product.view',
    'dealer.purchase.view', 'dealer.sale.view', 'crop.purchase.view', 'crop.sale.view',
    'inventory.view', 'payment.view', 'expense.view',
    'approval.view', 'approval.decide',
    'report.view', 'report.profit', 'employee.view', 'settings.view', 'audit.view',
  ],
  Sales: [
    'dashboard.view', 'customer.view', 'customer.create', 'customer.edit', 'product.view',
    'dealer.sale.view', 'dealer.sale.create', 'dealer.sale.post',
    'crop.sale.view', 'crop.sale.create', 'crop.sale.post',
    'inventory.view', 'payment.view', 'payment.create', 'report.view',
  ],
  Purchase: [
    'dashboard.view', 'supplier.view', 'supplier.create', 'company.view', 'product.view',
    'dealer.purchase.view', 'dealer.purchase.create',
    'crop.purchase.view', 'crop.purchase.create',
    'inventory.view', 'report.view',
  ],
  Accounts: [
    'dashboard.view', 'customer.view', 'supplier.view', 'company.view', 'product.view',
    'dealer.purchase.view', 'dealer.sale.view', 'crop.purchase.view', 'crop.sale.view',
    'inventory.view', 'payment.view', 'payment.create', 'expense.view', 'expense.create',
    'approval.view', 'report.view', 'report.profit', 'audit.view',
  ],
  Warehouse: [
    'dashboard.view', 'product.view', 'inventory.view', 'inventory.adjust',
    'inventory.transfer', 'dealer.purchase.view', 'crop.purchase.view',
    'dealer.sale.view', 'crop.sale.view',
  ],
};

/** What each role is for, shown on the roles panel of the Settings screen. */
const ROLE_DESCRIPTIONS = {
  Admin: 'Everything, including roles, logins and settings',
  Management: 'Sees the whole business and decides approvals',
  Sales: 'Raises sales, collects payment, keeps the customer list',
  Purchase: 'Raises purchases and keeps the procurement master',
  Accounts: 'Money in, money out, and the books behind it',
  Warehouse: 'Stock in the godowns, and the movements between them',
};

/**
 * Grants the later migrations make, restated for a database built from
 * scratch. Migrations 010 to 013 add these codes and hand them out; on a fresh
 * install they run before any role exists, so the handing out has to happen
 * here instead.
 */
const MIGRATED_ROLE_PERMISSIONS = {
  Management: ['crop.view', 'warehouse.create', 'warehouse.edit', 'employee.create', 'employee.edit'],
  Sales: ['crop.view'],
  Purchase: [
    'crop.view', 'supplier.edit', 'company.create', 'company.edit',
    'crop.create', 'crop.edit', 'product.create', 'product.edit',
  ],
  Accounts: [
    'crop.view', 'account.create', 'account.edit',
    'expense.category.create', 'expense.category.edit',
    'payment.method.create', 'payment.method.edit',
  ],
  Warehouse: ['crop.view'],
};

/* ------------------------------------------------------------------ masters */

const EMPLOYEES = [
  ['EMP-01', 'Rakib Hasan', 'Managing Director', 'Management', '01711-330099', 'Admin', '2019-01-01'],
  ['EMP-02', 'Nasrin Akter', 'Accounts Manager', 'Accounts', '01715-882204', 'Accounts', '2020-03-12'],
  ['EMP-03', 'Sohel Rana', 'Purchase Officer', 'Purchase', '01816-445521', 'Purchase', '2021-07-05'],
  ['EMP-04', 'Shamim Reza', 'Senior Sales Officer', 'Sales', '01912-006733', 'Sales', '2021-09-18'],
  ['EMP-05', 'Jamal Uddin', 'Warehouse In-charge', 'Warehouse', '01755-119043', 'Warehouse', '2022-02-02'],
  ['EMP-06', 'Farhana Yeasmin', 'Accounts Officer', 'Accounts', '01633-220871', 'Accounts', '2022-06-20'],
  ['EMP-07', 'Mizanur Rahman', 'Sales Officer', 'Sales', '01521-778812', 'Sales', '2023-11-11'],
  ['EMP-08', 'Ashraful Islam', 'Field Officer — Crop', 'Operations', '01844-663019', 'Purchase', '2024-01-03'],
  ['EMP-09', 'Sumaiya Khatun', 'Data Entry Operator', 'Operations', '01977-334528', 'Sales', '2025-04-15'],
  ['EMP-10', 'Habibur Rahman', 'Store Assistant', 'Warehouse', '01686-901254', 'Warehouse', '2026-02-01'],
];

const CUSTOMERS = [
  ['CUS-001', 'Messrs. Rahman Traders', 'মেসার্স রহমান ট্রেডার্স', 'Dealer', 'Abdur Rahman', '01712-335566', 'Rangpur', 'Badarganj', 1500000, 21],
  ['CUS-002', 'Bhai Bhai Agro Store', 'ভাই ভাই এগ্রো স্টোর', 'Retailer', 'Md. Jahangir Alam', '01815-772130', 'Bogura', 'Sherpur', 800000, 15],
  ['CUS-003', 'Nabin Krishi Bitan', 'নবীন কৃষি বিতান', 'Dealer', 'Shahin Mia', '01911-450288', 'Naogaon', 'Mohadevpur', 1200000, 21],
  ['CUS-004', 'Sonar Bangla Enterprise', 'সোনার বাংলা এন্টারপ্রাইজ', 'Corporate', 'Kamrul Hasan', '01733-661209', 'Dinajpur', 'Birampur', 2500000, 30],
  ['CUS-005', 'Jashore Agro Centre', 'যশোর এগ্রো সেন্টার', 'Retailer', 'Nazrul Islam', '01677-903455', 'Jashore', 'Jhikargachha', 600000, 15],
  ['CUS-006', 'Uttara Seed House', 'উত্তরা সীড হাউস', 'Dealer', 'Rafiqul Bari', '01521-330817', 'Rangpur', 'Mithapukur', 900000, 21],
];

const SUPPLIERS = [
  ['SUP-001', 'Abdul Karim Mondol', 'আব্দুল করিম মন্ডল', 'Farmer', '01718-224509', 'Naogaon', 'Mohadevpur', 'bKash 01718-224509'],
  ['SUP-002', 'Jashim Uddin Sarkar', 'জসিম উদ্দিন সরকার', 'Aratdar', '01812-667341', 'Dinajpur', 'Birampur', 'Islami Bank 20501...4417'],
  ['SUP-003', 'Aftab Ali Bepari', 'আফতাব আলী বেপারী', 'Trader', '01933-118240', 'Bogura', 'Shibganj', 'Nagad 01933-118240'],
  ['SUP-004', 'Nurul Haque Krishi Khamar', 'নুরুল হক কৃষি খামার', 'Farm', '01755-902611', 'Rangpur', 'Gangachara', 'DBBL 1471...8802'],
  ['SUP-005', 'Shahida Begum', 'শাহিদা বেগম', 'Farmer', '01640-773125', 'Jashore', 'Manirampur', 'bKash 01640-773125'],
];

const COMPANIES = [
  ['CMP-01', 'ACI Agrochemicals Ltd.', 'PRINCIPAL', 'Md. Shafiqul Islam', '01711-204588', 'Dhaka', 2500000, 30],
  ['CMP-02', 'Syngenta Bangladesh Ltd.', 'PRINCIPAL', 'Tanvir Ahmed', '01730-556018', 'Dhaka', 2000000, 30],
  ['CMP-03', 'Ispahani Agro Ltd.', 'SUPPLIER', 'Golam Mostafa', '01819-337265', 'Chattogram', 1200000, 21],
  ['CMP-04', 'PRAN Agro Business Ltd.', 'BUYER', 'Sabbir Rahman', '01777-880412', 'Natore', 0, 14],
  ['CMP-05', 'City Group (Rice Unit)', 'BUYER', 'Anisur Rahman', '01709-114523', 'Narayanganj', 0, 10],
  ['CMP-06', 'Akij Foods & Beverage Ltd.', 'SUPPLIER_AND_BUYER', 'Mahbub Alam', '01755-220149', 'Dhaka', 900000, 21],
  ['CMP-07', 'Square Feeds Ltd.', 'SUPPLIER_AND_BUYER', 'Sadia Afrin', '01711-908844', 'Gazipur', 1500000, 30],
];

const PRODUCTS = [
  ['P-1001', 'Ridomil Gold MZ 72 WP 100g', 'Agrochemical', 'Syngenta', 'Pcs', 245, 295, 400],
  ['P-1002', 'Virtako 40 WG 30g', 'Agrochemical', 'Syngenta', 'Pcs', 318, 385, 300],
  ['P-1003', 'ACI Zinc Sulphate 1kg', 'Fertilizer', 'ACI', 'Pcs', 180, 225, 250],
  ['P-1004', 'Hybrid Maize Seed NK-40 1kg', 'Seeds', 'Syngenta', 'Kg', 420, 510, 200],
  ['P-1005', 'Square Layer Grower Feed 50kg', 'Feed', 'Square', 'Bag', 2380, 2560, 60],
  ['P-1006', 'Ispahani TSP Fertilizer 50kg', 'Fertilizer', 'Ispahani', 'Bag', 1650, 1780, 120],
];

const CROPS = [
  ['CROP-01', 'Maize', 30500],
  ['CROP-02', 'Paddy (BRRI-28)', 26400],
  ['CROP-03', 'Rice (Miniket)', 58200],
  ['CROP-04', 'Wheat', 34800],
  ['CROP-05', 'Potato', 21500],
  ['CROP-06', 'Onion', 46000],
];

const WAREHOUSES = [
  ['WH-01', 'Naogaon Central Godown', 'Naogaon'],
  ['WH-02', 'Bogura Depot', 'Bogura'],
  ['WH-03', 'Rangpur Store', 'Rangpur'],
  ['WH-04', 'Dinajpur Godown', 'Dinajpur'],
];

/* ------------------------------------------------------------------- helpers */

const pick = (rows, code) => rows.find((r) => r.code === code);

async function insertMany(client, sql, rowsets) {
  const out = [];
  for (const params of rowsets) {
    const { rows } = await client.query(sql, params);
    out.push(rows[0]);
  }
  return out;
}

/* ---------------------------------------------------------------------- run */

async function seed() {
  const summary = await withTransaction(async (client) => {
    const existing = await client.query('SELECT COUNT(*)::int AS n FROM organizations');
    if (existing.rows[0].n > 0) {
      throw new Error(
        'The database already contains data. Run `npm run db:reset` first if you want to reseed.'
      );
    }

    /* ---- organisation ---- */
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations
         (code, name, system_name, trade_licence_no, bin_no, head_office, mobile, email,
          default_district)
       VALUES ('MEGHNA','Meghna Agro Enterprise','Business Suite','BOG-TL-2019-04471',
               '003912847-0201','Sherpur Road, Bogura Sadar, Bogura','01711-330099',
               'accounts@meghnaagro.com.bd','Bogura')
       RETURNING id`,
      []
    );
    const orgId = Number(orgRows[0].id);

    await client.query(
      `INSERT INTO fiscal_years (org_id, code, starts_on, ends_on, is_current, is_closed)
       VALUES ($1,'FY 2026-27','2026-07-01','2027-06-30',true,false),
              ($1,'FY 2025-26','2025-07-01','2026-06-30',false,true),
              ($1,'FY 2024-25','2024-07-01','2025-06-30',false,true)`,
      [orgId]
    );

    await client.query(
      `INSERT INTO business_types (code, name, description) VALUES
         ('DEALER','Dealer Business','Company to dealer to customer'),
         ('BULK_CROP','Bulk Crop Business','Farmer to us to buyer company')`
    );

    /* ---- settings the Settings screen maintains ---- */

    // Migration 015 backfills these for an organisation that already exists.
    // A fresh database is seeded after every migration has run, so the same
    // rows are inserted here or a new install would open with an empty
    // numbering panel and no notification rules.
    await client.query(
      `INSERT INTO document_number_formats (org_id, doc_type, prefix, padding) VALUES
         ($1,'crop_purchase','PC',3), ($1,'crop_sale','SC',3),
         ($1,'dealer_purchase','DP',3), ($1,'dealer_sale','DS',3),
         ($1,'crop_batch','BC',3), ($1,'receipt','RC',3),
         ($1,'payment','PY',3), ($1,'expense','EXP',3),
         ($1,'adjustment','ADJ',3), ($1,'transfer','TRF',3),
         ($1,'movement','MOV',3), ($1,'approval','AP',4)`,
      [orgId]
    );

    await client.query(
      `INSERT INTO notification_rules (org_id, code, name, description, threshold) VALUES
         ($1,'CUSTOMER_OVERDUE','Customer payment overdue','daily 9:00 am for invoices past due date',NULL),
         ($1,'SUPPLIER_DUE','Supplier payment due','fires {value} days before the due date',2),
         ($1,'LOW_STOCK','Low stock','when quantity falls below minimum stock',NULL),
         ($1,'DEAD_STOCK','Dead stock','a crop batch still held after {value} days',60),
         ($1,'LARGE_TRANSACTION','Large transaction','any single transaction above {value}',2000000),
         ($1,'EXPENSE_THRESHOLD','Expense threshold','an expense above {value}',50000)`,
      [orgId]
    );

    const warehouses = await insertMany(
      client,
      `INSERT INTO warehouses (org_id, code, name, district) VALUES ($1,$2,$3,$4)
       RETURNING id, code, name`,
      WAREHOUSES.map((w) => [orgId, ...w])
    );

    const departmentNames = [...new Set(EMPLOYEES.map((e) => e[3]))];
    const departments = await insertMany(
      client,
      'INSERT INTO departments (org_id, name) VALUES ($1,$2) RETURNING id, name',
      departmentNames.map((n) => [orgId, n])
    );

    /* ---- roles and permissions ---- */

    // Migrations have already inserted the permissions they introduced, so
    // these go in beside them rather than over them.
    await insertMany(
      client,
      `INSERT INTO permissions (code, description) VALUES ($1,$2)
       ON CONFLICT (code) DO NOTHING`,
      PERMISSIONS
    );

    // These six are the roles the system is set up around: `is_system` is what
    // stops one being deleted from the Settings screen, leaving a user holding
    // a role that no longer exists.
    const roles = await insertMany(
      client,
      `INSERT INTO roles (code, name, description, is_system)
       VALUES ($1,$2,$3,true) RETURNING id, code`,
      Object.keys(ROLE_PERMISSIONS).map((r) => [r, r, ROLE_DESCRIPTIONS[r] || null])
    );
    const roleByCode = new Map(roles.map((r) => [r.code, Number(r.id)]));

    // Admin holds the whole table, whatever is in it. Written as a join rather
    // than as a list so a permission added by a migration after this file was
    // last touched is still held by somebody -- which is the difference
    // between an Admin who can administer and one who cannot.
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM permissions p ON CONFLICT DO NOTHING`,
      [roleByCode.get('Admin')]
    );

    for (const [roleCode, codes] of Object.entries(ROLE_PERMISSIONS)) {
      if (roleCode === 'Admin') continue;
      const wanted = codes.concat(MIGRATED_ROLE_PERMISSIONS[roleCode] || []);
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM permissions p WHERE p.code = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [roleByCode.get(roleCode), wanted]
      );
    }

    /* ---- employees and users ---- */
    const passwordHash = await hashPassword(DEFAULT_PASSWORD);
    const employees = [];

    for (const [code, name, designation, dept, mobile, roleCode, joined] of EMPLOYEES) {
      const departmentId = departments.find((d) => d.name === dept)?.id ?? null;
      const { rows } = await client.query(
        `INSERT INTO employees (org_id, code, name, designation, department_id, mobile, joined_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code, name`,
        [orgId, code, name, designation, departmentId, mobile, joined]
      );
      const employeeId = Number(rows[0].id);
      employees.push({ ...rows[0], id: employeeId, roleCode });

      const username = name.split(' ')[0].toLowerCase() + code.slice(-2);
      const { rows: userRows } = await client.query(
        `INSERT INTO users (org_id, employee_id, username, password_hash, must_change_pw)
         VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [orgId, employeeId, username, passwordHash]
      );
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [
        Number(userRows[0].id),
        roleByCode.get(roleCode),
      ]);
      employees[employees.length - 1].userId = Number(userRows[0].id);
      employees[employees.length - 1].username = username;
    }

    const admin = employees[0];

    /* ---- lookups ---- */
    const units = await insertMany(
      client,
      'INSERT INTO units (code, name, factor) VALUES ($1,$2,$3) RETURNING id, code',
      [
        ['MT', 'Metric Tonne', 1],
        ['Maund', 'Maund', 0.037324],
        ['Kg', 'Kilogram', 0.001],
        ['Bag', 'Bag (50 kg)', 0.05],
        ['Pcs', 'Piece', 1],
      ]
    );
    const unitByCode = new Map(units.map((u) => [u.code, Number(u.id)]));

    // The crop units are fractions of a tonne; saying so on the row is what
    // lets the Settings screen derive '1 MT = 1,000 Kg' rather than print it.
    await client.query(
      `UPDATE units SET base_unit_id = $1 WHERE code IN ('Maund','Kg','Bag')`,
      [unitByCode.get('MT')]
    );

    const categories = await insertMany(
      client,
      'INSERT INTO product_categories (name) VALUES ($1) RETURNING id, name',
      [['Agrochemical'], ['Fertilizer'], ['Seeds'], ['Feed']]
    );
    const brands = await insertMany(
      client,
      'INSERT INTO brands (name) VALUES ($1) RETURNING id, name',
      [['Syngenta'], ['ACI'], ['Square'], ['Ispahani']]
    );
    const grades = await insertMany(
      client,
      'INSERT INTO crop_grades (code, name) VALUES ($1,$2) RETURNING id, code',
      [['A', 'A (Premium)'], ['B', 'B (Standard)'], ['C', 'C (Feed grade)']]
    );

    await insertMany(
      client,
      'INSERT INTO expense_categories (code, name) VALUES ($1,$2) RETURNING id',
      [
        ['TRANSPORT', 'Transport'], ['LABOUR', 'Loading / Unloading'], ['SALARY', 'Salary'],
        ['WAREHOUSE', 'Warehouse'], ['FUEL', 'Fuel'], ['COMMISSION', 'Commission'],
        ['OFFICE', 'Office & utility'],
      ]
    );

    /* ---- accounts and payment methods ---- */
    const accounts = await insertMany(
      client,
      `INSERT INTO accounts (org_id, code, name, account_type, opening_balance)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, code`,
      [
        [orgId, 'CASH-BOG', 'Office cash — Bogura', 'CASH', 385000],
        [orgId, 'BANK-IBBL', 'Islami Bank — 20501...4417', 'BANK', 2140000],
        [orgId, 'BANK-DBBL', 'DBBL — 1471...8802', 'BANK', 1520000],
        [orgId, 'MFS-BKASH', 'bKash Merchant — 01755...', 'MFS', 240000],
      ]
    );
    const accountByCode = new Map(accounts.map((a) => [a.code, Number(a.id)]));

    await insertMany(
      client,
      `INSERT INTO payment_methods (org_id, code, name, account_id, is_active)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        [orgId, 'CASH', 'Cash', accountByCode.get('CASH-BOG'), true],
        [orgId, 'BANK', 'Bank transfer', accountByCode.get('BANK-IBBL'), true],
        [orgId, 'CHEQUE', 'Cheque', accountByCode.get('BANK-DBBL'), true],
        [orgId, 'BKASH', 'bKash', accountByCode.get('MFS-BKASH'), true],
        [orgId, 'NAGAD', 'Nagad', accountByCode.get('MFS-BKASH'), true],
        [orgId, 'ROCKET', 'Rocket', null, false],
      ]
    );

    /* ---- parties ---- */
    const customers = await insertMany(
      client,
      `INSERT INTO customers
         (org_id, code, name, name_bn, customer_type, contact_person, mobile, district,
          upazila, credit_limit, credit_days, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, code, name`,
      CUSTOMERS.map((c) => [orgId, ...c, admin.userId])
    );

    const suppliers = await insertMany(
      client,
      `INSERT INTO suppliers
         (org_id, code, name, name_bn, supplier_type, mobile, district, upazila,
          bank_account, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, code, name`,
      SUPPLIERS.map((s) => [orgId, ...s, admin.userId])
    );

    const companies = await insertMany(
      client,
      `INSERT INTO companies
         (org_id, code, name, role, contact_person, mobile, district, credit_limit, credit_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code, name`,
      COMPANIES.map((c) => [orgId, ...c])
    );

    const products = await insertMany(
      client,
      `INSERT INTO products
         (org_id, code, name, category_id, brand_id, unit_id, purchase_rate, sale_rate, min_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code, name`,
      PRODUCTS.map(([code, name, cat, brand, unit, pur, sale, min]) => [
        orgId,
        code,
        name,
        categories.find((c) => c.name === cat)?.id ?? null,
        brands.find((b) => b.name === brand)?.id ?? null,
        unitByCode.get(unit),
        pur,
        sale,
        min,
      ])
    );

    const crops = await insertMany(
      client,
      `INSERT INTO crops (org_id, code, name, default_unit_id, last_rate)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, code, name`,
      CROPS.map(([code, name, rate]) => [orgId, code, name, unitByCode.get('MT'), rate])
    );

    /* ---- approval rules ---- */
    await insertMany(
      client,
      `INSERT INTO approval_rules
         (org_id, code, name, entity_type, business_type, condition_type, threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        [orgId, 'CROP_PUR_LIMIT', 'Purchase value above ৳5,00,000', 'crop_purchases', 'BULK_CROP', 'AMOUNT_ABOVE', 500000],
        [orgId, 'DEALER_PUR_LIMIT', 'Purchase value above ৳5,00,000', 'dealer_purchases', 'DEALER', 'AMOUNT_ABOVE', 500000],
        [orgId, 'CROP_SALE_LIMIT', 'Credit sale above ৳20,00,000', 'crop_sales', 'BULK_CROP', 'AMOUNT_ABOVE', 2000000],
        [orgId, 'DISCOUNT_CEILING', 'Discount above the 5% ceiling', 'dealer_sales', 'DEALER', 'DISCOUNT_PCT_ABOVE', 5],
        [orgId, 'STOCK_ADJ', 'Stock adjustment always requires approval', 'stock_adjustments', null, 'ALWAYS', null],
        [orgId, 'EXPENSE_LIMIT', 'Expense above ৳50,000', 'expenses', null, 'AMOUNT_ABOVE', 50000],
      ]
    );

    return {
      orgId,
      admin,
      employees,
      warehouses,
      customers,
      suppliers,
      companies,
      products,
      crops,
      grades,
      units: unitByCode,
      accounts: accountByCode,
    };
  });

  /* ---- transactions, posted through the real services ---- */

  const ctx = {
    orgId: summary.orgId,
    user: { id: summary.admin.userId },
    actor: { userId: summary.admin.userId, orgId: summary.orgId, ip: null, userAgent: 'seed' },
  };

  const mt = summary.units.get('MT');
  const gradeA = Number(summary.grades.find((g) => g.code === 'A').id);
  const gradeB = Number(summary.grades.find((g) => g.code === 'B').id);
  const wh = (code) => Number(pick(summary.warehouses, code).id);
  const crop = (code) => Number(pick(summary.crops, code).id);
  const supplier = (code) => Number(pick(summary.suppliers, code).id);
  const company = (code) => Number(pick(summary.companies, code).id);
  const customer = (code) => Number(pick(summary.customers, code).id);
  const product = (code) => Number(pick(summary.products, code).id);

  // Crop purchases build the batch pool FIFO will draw from. Kept under the
  // ৳5,00,000 approval limit except the last, which is left pending on purpose
  // so the approval queue has something real in it.
  const cropPurchases = [
    { date: '2026-07-22', sup: 'SUP-002', crop: 'CROP-02', grade: gradeA, wh: 'WH-01', qty: 40, moist: 1.0, rate: 11000, transport: 15000 },
    { date: '2026-08-08', sup: 'SUP-003', crop: 'CROP-01', grade: gradeB, wh: 'WH-02', qty: 12, moist: 1.5, rate: 29100, transport: 9000 },
    { date: '2026-08-12', sup: 'SUP-001', crop: 'CROP-01', grade: gradeA, wh: 'WH-01', qty: 14, moist: 1.5, rate: 30000, transport: 12000 },
    { date: '2026-08-19', sup: 'SUP-004', crop: 'CROP-05', grade: gradeB, wh: 'WH-03', qty: 20, moist: 2.0, rate: 20400, transport: 8000 },
  ];

  for (const p of cropPurchases) {
    await withTransaction((client) =>
      createCropPurchase(client, {
        ...ctx,
        input: {
          txnDate: p.date,
          supplierId: supplier(p.sup),
          warehouseId: wh(p.wh),
          transportCost: p.transport,
          loadingCost: 4000,
          unloadingCost: 3000,
          otherCost: 0,
          advancePaid: 0,
          lines: [
            {
              cropId: crop(p.crop),
              gradeId: p.grade,
              unitId: mt,
              grossQuantity: p.qty,
              moisturePct: p.moist,
              rate: p.rate,
            },
          ],
          action: 'POST',
        },
      })
    );
  }

  // Crop sales consume the oldest batches first.
  const cropSales = [
    { date: '2026-08-20', buyer: 'CMP-04', crop: 'CROP-01', qty: 10, rate: 34500, paid: 0 },
    { date: '2026-08-24', buyer: 'CMP-05', crop: 'CROP-02', qty: 18, rate: 28900, paid: 200000 },
  ];

  for (const s of cropSales) {
    await withTransaction((client) =>
      createCropSale(client, {
        ...ctx,
        input: {
          txnDate: s.date,
          buyerCompanyId: company(s.buyer),
          valuationMethod: 'FIFO',
          transportCost: 15000,
          otherCost: 5000,
          paidAmount: s.paid,
          lines: [{ cropId: crop(s.crop), unitId: mt, quantity: s.qty, rate: s.rate }],
          action: 'POST',
        },
      })
    );
  }

  // Dealer purchases bring product stock in, so dealer sales have something to
  // issue and a weighted-average cost to price against.
  await withTransaction((client) =>
    createDealerPurchase(client, {
      ...ctx,
      input: {
        txnDate: '2026-08-05',
        companyId: company('CMP-01'),
        warehouseId: wh('WH-02'),
        supplierInvoiceNo: 'ACI/DH/26-4471',
        paymentTerms: 'Credit 30 days',
        transportCost: 8000,
        otherCost: 2000,
        lines: [
          { productId: product('P-1001'), quantity: 600, freeQuantity: 24, rate: 245, discountPct: 3 },
          { productId: product('P-1003'), quantity: 200, freeQuantity: 0, rate: 180, discountPct: 0 },
        ],
        action: 'POST',
      },
    })
  );

  await withTransaction((client) =>
    createDealerPurchase(client, {
      ...ctx,
      input: {
        txnDate: '2026-08-07',
        companyId: company('CMP-02'),
        warehouseId: wh('WH-02'),
        supplierInvoiceNo: 'SYN/DH/26-8890',
        paymentTerms: 'Credit 30 days',
        transportCost: 6000,
        otherCost: 0,
        lines: [
          { productId: product('P-1002'), quantity: 300, freeQuantity: 0, rate: 318, discountPct: 2 },
          { productId: product('P-1004'), quantity: 250, freeQuantity: 0, rate: 420, discountPct: 0 },
        ],
        action: 'POST',
      },
    })
  );

  // Dealer sales, all within discount and credit limits so they post cleanly.
  const dealerSales = [
    { date: '2026-08-14', cust: 'CUS-003', lines: [['P-1001', 60, 295, 2]], paid: 100000 },
    { date: '2026-08-21', cust: 'CUS-001', lines: [['P-1002', 40, 385, 0], ['P-1004', 30, 510, 0]], paid: 200000 },
    { date: '2026-08-27', cust: 'CUS-004', lines: [['P-1001', 80, 295, 1], ['P-1003', 50, 225, 0]], paid: 150000 },
  ];

  for (const s of dealerSales) {
    await withTransaction((client) =>
      createDealerSale(client, {
        ...ctx,
        input: {
          txnDate: s.date,
          customerId: customer(s.cust),
          warehouseId: wh('WH-02'),
          salespersonId: Number(summary.employees[3].id),
          paymentTerms: 'Credit 15 days',
          paidAmount: s.paid,
          lines: s.lines.map(([code, qty, rate, disc]) => ({
            productId: product(code),
            quantity: qty,
            bonusQuantity: 0,
            rate,
            discountPct: disc,
          })),
          action: 'POST',
        },
      })
    );
  }

  // One purchase deliberately over the limit, so the approval queue is not empty.
  await withTransaction((client) =>
    createCropPurchase(client, {
      ...ctx,
      input: {
        txnDate: '2026-08-28',
        supplierId: supplier('SUP-001'),
        warehouseId: wh('WH-01'),
        transportCost: 50000,
        loadingCost: 12000,
        unloadingCost: 8000,
        otherCost: 0,
        advancePaid: 0,
        lines: [
          { cropId: crop('CROP-01'), gradeId: gradeA, unitId: mt, grossQuantity: 100, moisturePct: 1.5, rate: 30000 },
        ],
        action: 'POST',
      },
    })
  );

  return summary;
}

try {
  const summary = await seed();
  const counts = await query(`
    SELECT
      (SELECT COUNT(*) FROM customers)       AS customers,
      (SELECT COUNT(*) FROM suppliers)       AS suppliers,
      (SELECT COUNT(*) FROM products)        AS products,
      (SELECT COUNT(*) FROM crop_batches)    AS batches,
      (SELECT COUNT(*) FROM stock_movements) AS movements,
      (SELECT COUNT(*) FROM receivables)     AS receivables,
      (SELECT COUNT(*) FROM payables)        AS payables,
      (SELECT COUNT(*) FROM approvals WHERE status = 'PENDING') AS pending_approvals,
      (SELECT COUNT(*) FROM audit_logs)      AS audit_entries
  `);

  console.log('\nSeed complete.\n');
  console.table(counts.rows[0]);
  console.log(`\nSign in with any of these usernames and the password: ${DEFAULT_PASSWORD}`);
  for (const e of summary.employees) {
    console.log(`  ${e.username.padEnd(16)} ${e.roleCode.padEnd(12)} ${e.name}`);
  }
  console.log('\nEvery account is flagged must_change_pw; change them before real use.\n');
} catch (err) {
  // The stack matters here: a seed failure is nearly always a bug in this file
  // or in a service it posts through, and the message alone rarely locates it.
  console.error('\nSeed failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  await closePool();
}
