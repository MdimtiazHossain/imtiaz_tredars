/**
 * The rows a Business Suite database needs before it is a system at all.
 *
 * Access control, the operating organisation, its financial year, how documents
 * are numbered, when approval is required and when an alert fires. None of it
 * is anybody's trading history: it is the frame the trading happens inside, and
 * without it the API refuses to start and nobody can sign in.
 *
 * Both entry points build on this. `db/seed/seed.mjs` installs the foundation
 * and then a demonstration business on top of it; `db/fresh.mjs` installs the
 * foundation and stops, which is what a real business wants on day one.
 *
 * Keeping it here rather than in the seed is what stops the two drifting: the
 * permission matrix belongs to the product, not to the demo.
 */

/* ------------------------------------------------------------- permissions */

export const PERMISSIONS = [
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
  ['return.view', 'View returns and credit notes'],
  ['return.create', 'Record a return'],
  ['return.post', 'Post a return'],
  ['return.cancel', 'Cancel a posted return'],
  ['credit.note.create', 'Issue a credit or debit note without a return'],
];

/** Role -> permissions, mirroring the permission matrix on the Settings screen. */
export const ROLE_PERMISSIONS = {
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

export const ROLE_DESCRIPTIONS = {
  Admin: 'Everything, including roles, logins and settings',
  Management: 'Sees the whole business and decides approvals',
  Sales: 'Raises sales, collects payment, keeps the customer list',
  Purchase: 'Raises purchases and keeps the procurement master',
  Accounts: 'Money in, money out, and the books behind it',
  Warehouse: 'Stock in the godowns, and the movements between them',
};

/**
 * Grants the later migrations make, restated for a database built from
 * scratch. Migrations 010 to 015 add these codes and hand them out; on a fresh
 * install they run before any role exists, so the handing out has to happen
 * here instead.
 */
export const MIGRATED_ROLE_PERMISSIONS = {
  Management: ['crop.view', 'warehouse.create', 'warehouse.edit', 'employee.create', 'employee.edit',
    'return.view'],
  Sales: ['crop.view', 'return.view', 'return.create', 'return.post'],
  Purchase: [
    'crop.view', 'supplier.edit', 'company.create', 'company.edit',
    'crop.create', 'crop.edit', 'product.create', 'product.edit',
    'return.view', 'return.create',
  ],
  Accounts: [
    'crop.view', 'account.create', 'account.edit',
    'expense.category.create', 'expense.category.edit',
    'payment.method.create', 'payment.method.edit',
    'return.view', 'return.create', 'return.post', 'credit.note.create',
  ],
  Warehouse: ['crop.view', 'return.view'],
};

/**
 * Install the permissions, the six roles and the grants between them.
 *
 * @returns {Promise<Map<string, number>>} role code -> id
 */
export async function installAccessControl(client) {
  // Migrations have already inserted the permissions they introduced, so these
  // go in beside them rather than over them.
  for (const [code, description] of PERMISSIONS) {
    await client.query(
      'INSERT INTO permissions (code, description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING',
      [code, description]
    );
  }

  const roleByCode = new Map();
  for (const code of Object.keys(ROLE_PERMISSIONS)) {
    // `is_system` is what stops one being deleted, leaving a user holding a
    // role that no longer exists.
    const { rows } = await client.query(
      `INSERT INTO roles (code, name, description, is_system)
       VALUES ($1,$2,$3,true) RETURNING id`,
      [code, code, ROLE_DESCRIPTIONS[code] || null]
    );
    roleByCode.set(code, Number(rows[0].id));
  }

  // Admin holds the whole table, whatever is in it. Written as a join rather
  // than as a list so a permission added by a migration after this file was
  // last touched is still held by somebody -- which is the difference between
  // an Admin who can administer and one who cannot.
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

  return roleByCode;
}

/* ---------------------------------------------------------- the two ledgers */

export async function installBusinessTypes(client) {
  await client.query(
    `INSERT INTO business_types (code, name, description) VALUES
       ('DEALER','Dealer Business','Company to dealer to customer'),
       ('BULK_CROP','Bulk Crop Business','Farmer to us to buyer company')
     ON CONFLICT (code) DO NOTHING`
  );
}

/* ------------------------------------------------------------ organisation */

/**
 * Create the operating organisation.
 *
 * Only the code and the name are needed; everything else is what the Settings
 * screen exists to fill in, and is better left blank than filled with a
 * plausible-looking placeholder somebody later mistakes for a real licence.
 */
export async function installOrganization(client, profile) {
  const { rows } = await client.query(
    `INSERT INTO organizations
       (code, name, system_name, trade_licence_no, bin_no, head_office, mobile, email,
        currency_code, default_district)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      profile.code,
      profile.name,
      profile.systemName || 'Business Suite',
      profile.tradeLicenceNo || null,
      profile.binNo || null,
      profile.headOffice || null,
      profile.mobile || null,
      profile.email || null,
      profile.currency || 'BDT',
      profile.defaultDistrict || null,
    ]
  );
  return Number(rows[0].id);
}

/**
 * The Bangladeshi financial year containing a date: July to June.
 *
 * Derived rather than written down, so a database created in 2031 opens on the
 * year it is actually in.
 */
export function fiscalYearFor(date) {
  const d = date instanceof Date ? date : new Date(date);
  const startYear = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  const endYear = startYear + 1;
  return {
    code: `FY ${startYear}-${String(endYear).slice(-2)}`,
    startsOn: `${startYear}-07-01`,
    endsOn: `${endYear}-06-30`,
  };
}

export async function installFiscalYear(client, orgId, year) {
  await client.query(
    `INSERT INTO fiscal_years (org_id, code, starts_on, ends_on, is_current, is_closed)
     VALUES ($1,$2,$3,$4,true,false)`,
    [orgId, year.code, year.startsOn, year.endsOn]
  );
}

/* --------------------------------------------------------------- numbering */

/**
 * Prefixes and widths for every document type.
 *
 * Migration 015 backfills these for an organisation that already exists; an
 * organisation created afterwards needs them installed here, or it opens with
 * an empty numbering panel.
 */
export const DOCUMENT_NUMBER_FORMATS = [
  ['crop_purchase', 'PC', 3], ['crop_sale', 'SC', 3],
  ['dealer_purchase', 'DP', 3], ['dealer_sale', 'DS', 3],
  ['crop_batch', 'BC', 3], ['receipt', 'RC', 3],
  ['payment', 'PY', 3], ['expense', 'EXP', 3],
  ['adjustment', 'ADJ', 3], ['transfer', 'TRF', 3],
  ['movement', 'MOV', 3], ['approval', 'AP', 4],
  ['sale_return', 'SR', 3], ['purchase_return', 'PR', 3],
  ['credit_note', 'CN', 3], ['debit_note', 'DN', 3],
];

export async function installNumbering(client, orgId) {
  for (const [docType, prefix, padding] of DOCUMENT_NUMBER_FORMATS) {
    await client.query(
      `INSERT INTO document_number_formats (org_id, doc_type, prefix, padding)
       VALUES ($1,$2,$3,$4) ON CONFLICT (org_id, doc_type) DO NOTHING`,
      [orgId, docType, prefix, padding]
    );
  }
}

/* ------------------------------------------------------ rules and alerts */

/**
 * Default approval limits.
 *
 * Every business needs some ceiling above which a second pair of eyes is
 * required, and starting from nothing means nothing is ever routed for
 * approval. These are a starting point the Settings screen edits, not a
 * statement about how anyone trades.
 */
export const APPROVAL_RULES = [
  ['CROP_PUR_LIMIT', 'Crop purchase above the limit', 'crop_purchases', 'BULK_CROP', 'AMOUNT_ABOVE', 500000],
  ['DEALER_PUR_LIMIT', 'Dealer purchase above the limit', 'dealer_purchases', 'DEALER', 'AMOUNT_ABOVE', 500000],
  ['CROP_SALE_LIMIT', 'Crop sale above the limit', 'crop_sales', 'BULK_CROP', 'AMOUNT_ABOVE', 2000000],
  ['DISCOUNT_CEILING', 'Dealer sale discount above the ceiling', 'dealer_sales', 'DEALER', 'DISCOUNT_PCT_ABOVE', 5],
  ['STOCK_ADJ', 'Stock adjustment always requires approval', 'stock_adjustments', null, 'ALWAYS', null],
  ['EXPENSE_LIMIT', 'Expense above the limit', 'expenses', null, 'AMOUNT_ABOVE', 50000],
];

export async function installApprovalRules(client, orgId) {
  for (const [code, name, entity, business, condition, threshold] of APPROVAL_RULES) {
    await client.query(
      `INSERT INTO approval_rules
         (org_id, code, name, entity_type, business_type, condition_type, threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, code, name, entity, business, condition, threshold]
    );
  }
}

export const NOTIFICATION_RULES = [
  ['CUSTOMER_OVERDUE', 'Customer payment overdue', 'daily 9:00 am for invoices past due date', null],
  ['SUPPLIER_DUE', 'Supplier payment due', 'fires {value} days before the due date', 2],
  ['LOW_STOCK', 'Low stock', 'when quantity falls below minimum stock', null],
  ['DEAD_STOCK', 'Dead stock', 'a crop batch still held after {value} days', 60],
  ['LARGE_TRANSACTION', 'Large transaction', 'any single transaction above {value}', 2000000],
  ['EXPENSE_THRESHOLD', 'Expense threshold', 'an expense above {value}', 50000],
];

export async function installNotificationRules(client, orgId) {
  for (const [code, name, description, threshold] of NOTIFICATION_RULES) {
    await client.query(
      `INSERT INTO notification_rules (org_id, code, name, description, threshold)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, code, name, description, threshold]
    );
  }
}

/* ------------------------------------------------------ chart of accounts */

/**
 * The ledger accounts every posting path resolves by code.
 *
 * Migration 020 installs these for an organisation that already exists. An
 * organisation created afterwards -- which is every fresh install, since the
 * seed runs after the migrations -- needs them installed here, or the first
 * document posted fails: the journal's account column is NOT NULL and the
 * services refuse to invent an account that is not in the chart.
 */
export const CHART_OF_ACCOUNTS = [
  ['1000', 'Assets', 'ASSET', true],
  ['1100', 'Cash and bank', 'ASSET', false],
  ['1200', 'Accounts receivable', 'ASSET', false],
  ['1300', 'Inventory', 'ASSET', false],
  ['1400', 'Input VAT receivable', 'ASSET', false],
  ['2000', 'Liabilities', 'LIABILITY', true],
  ['2100', 'Accounts payable', 'LIABILITY', false],
  ['2200', 'Output VAT payable', 'LIABILITY', false],
  ['3000', 'Equity', 'EQUITY', true],
  ['3100', 'Opening balance equity', 'EQUITY', false],
  ['3200', 'Retained earnings', 'EQUITY', false],
  ['4000', 'Income', 'INCOME', true],
  ['4100', 'Dealer sales', 'INCOME', false],
  ['4200', 'Crop sales', 'INCOME', false],
  ['4900', 'Sales returns and allowances', 'INCOME', false],
  ['5000', 'Expenses', 'EXPENSE', true],
  ['5100', 'Cost of goods sold', 'EXPENSE', false],
  ['5200', 'Operating expenses', 'EXPENSE', false],
  ['5300', 'Selling expenses', 'EXPENSE', false],
];

export async function installChartOfAccounts(client, orgId) {
  for (const [code, name, klass, isGroup] of CHART_OF_ACCOUNTS) {
    await client.query(
      `INSERT INTO chart_of_accounts (org_id, code, name, account_class, is_group, is_system)
       VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, code, name, klass, isGroup]
    );
  }

  // Each account sits under the heading of its own class, so a statement can
  // be grouped from the data rather than from a rule written into a report.
  await client.query(
    `UPDATE chart_of_accounts child SET parent_id = parent.id
       FROM chart_of_accounts parent
      WHERE parent.org_id = child.org_id AND child.org_id = $1
        AND parent.is_group
        AND parent.code = left(child.code, 1) || '000'
        AND child.code <> parent.code
        AND child.parent_id IS NULL`,
    [orgId]
  );
}

/* --------------------------------------------------------------- tax rates */

/**
 * Bangladesh's VAT rates.
 *
 * The standard rate, the truncated rates particular trades pay, and the two
 * ways of charging nothing -- zero-rated, whose inputs are still reclaimable,
 * and exempt, whose are not. They are ordinary master data: rename them,
 * change them, add the one a new trade uses.
 *
 * Only the standard and zero rates carry an input credit. A truncated rate is
 * a settlement -- the trade charges less than 15% and gives up the credit that
 * would otherwise come with it -- so tax paid at one of them is part of what
 * the goods cost rather than something to claim back.
 *
 * A business that is not VAT-registered charges at none of them, which is the
 * default; registering is a settings change rather than a migration.
 */
export const TAX_RATES = [
  ['VAT15', 'VAT 15%', 'মূসক ১৫%', 'STANDARD', 15, true, true],
  ['VAT10', 'VAT 10% truncated', 'মূসক ১০%', 'REDUCED', 10, false, false],
  ['VAT7.5', 'VAT 7.5% truncated', 'মূসক ৭.৫%', 'REDUCED', 7.5, false, false],
  ['VAT5', 'VAT 5% truncated', 'মূসক ৫%', 'REDUCED', 5, false, false],
  ['ZERO', 'Zero-rated', 'শূন্য হার', 'ZERO', 0, true, false],
  ['EXEMPT', 'Exempt', 'অব্যাহতিপ্রাপ্ত', 'EXEMPT', 0, false, false],
];

export async function installTaxRates(client, orgId) {
  for (const [code, name, nameBn, kind, rate, reclaimable, isDefault] of TAX_RATES) {
    await client.query(
      `INSERT INTO tax_rates (org_id, code, name, name_bn, kind, rate, is_reclaimable, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, code, name, nameBn, kind, rate, reclaimable, isDefault]
    );
  }
}

/**
 * Unprocessed agricultural produce is exempt, which is the whole bulk crop
 * side of this business. Saying so on the crop means no service has to know
 * what a crop is.
 */
export async function exemptCrops(client, orgId) {
  await client.query(
    `UPDATE crops SET tax_rate_id = (
        SELECT id FROM tax_rates WHERE org_id = $1 AND code = 'EXEMPT'
      ) WHERE org_id = $1 AND tax_rate_id IS NULL`,
    [orgId]
  );
}

/* ------------------------------------------------------------------- units */

/**
 * Units of measure.
 *
 * The tonne, the maund, the kilogram, the 50 kg bag and the piece are how crops
 * and dealer goods are traded in Bangladesh; they describe the trade rather
 * than any one business, and nothing can be bought or sold until at least one
 * of them exists. More can be added from the Settings screen.
 */
export const UNITS = [
  ['MT', 'Metric Tonne', 1],
  ['Maund', 'Maund', 0.037324],
  ['Kg', 'Kilogram', 0.001],
  ['Bag', 'Bag (50 kg)', 0.05],
  ['Pcs', 'Piece', 1],
];

/** @returns {Promise<Map<string, number>>} unit code -> id */
export async function installUnits(client) {
  const byCode = new Map();
  for (const [code, name, factor] of UNITS) {
    const { rows } = await client.query(
      'INSERT INTO units (code, name, factor) VALUES ($1,$2,$3) RETURNING id',
      [code, name, factor]
    );
    byCode.set(code, Number(rows[0].id));
  }
  // The crop units are fractions of a tonne; saying so on the row is what lets
  // the Settings screen derive '1 MT = 1,000 Kg' rather than print it.
  await client.query("UPDATE units SET base_unit_id = $1 WHERE code IN ('Maund','Kg','Bag')", [
    byCode.get('MT'),
  ]);
  return byCode;
}

/* ------------------------------------------------------------ the first user */

/**
 * Create one person and the login that belongs to them.
 *
 * `must_change_pw` is set, so whatever password this account is created with is
 * a one-time key rather than a credential: the holder replaces it the first
 * time they sign in and nobody else ever knew it.
 *
 * @returns {Promise<{employeeId: number, userId: number}>}
 */
export async function installAdmin(client, { orgId, roleId, code, name, designation, mobile, username, passwordHash }) {
  const { rows: employee } = await client.query(
    `INSERT INTO employees (org_id, code, name, designation, mobile, joined_on)
     VALUES ($1,$2,$3,$4,$5,CURRENT_DATE) RETURNING id`,
    [orgId, code, name, designation || null, mobile || null]
  );
  const employeeId = Number(employee[0].id);

  const { rows: user } = await client.query(
    `INSERT INTO users (org_id, employee_id, username, password_hash, must_change_pw)
     VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [orgId, employeeId, username, passwordHash]
  );
  const userId = Number(user[0].id);

  await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, roleId]);

  return { employeeId, userId };
}
