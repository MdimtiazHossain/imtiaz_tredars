/**
 * Reference and configuration records: the team directory, the audit trail,
 * the permission matrix, the settings pages and the mobile screen specs.
 *
 * Separate from `analytics.js` because these are records a system-of-record
 * would own rather than figures a reporting endpoint would compute.
 */

/**
 * The team, as records rather than a positional table.
 *
 * The employees screen used to render these by index, which meant it could
 * only ever show this fixed list. As records they seed the in-memory store and
 * the screen renders whatever the repository returns -- the real table with a
 * backend, this fixture without one.
 *
 * Each carries an id, as every other master fixture does and as the API's own
 * rows do: the login on the employees screen is matched to the person by it,
 * and a record with no id cannot be matched to anything.
 */
export const EMPLOYEES = [
  { id: 1, code: 'EMP-01', name: 'Rakib Hasan', designation: 'Managing Director', department: 'Management', mobile: '01711-330099', role: 'Admin', joined: '2019-01-01' },
  { id: 2, code: 'EMP-02', name: 'Nasrin Akter', designation: 'Accounts Manager', department: 'Accounts', mobile: '01715-882204', role: 'Accounts', joined: '2020-03-12' },
  { id: 3, code: 'EMP-03', name: 'Sohel Rana', designation: 'Purchase Officer', department: 'Purchase', mobile: '01816-445521', role: 'Purchase', joined: '2021-07-05' },
  { id: 4, code: 'EMP-04', name: 'Shamim Reza', designation: 'Senior Sales Officer', department: 'Sales', mobile: '01912-006733', role: 'Sales', joined: '2021-09-18' },
  { id: 5, code: 'EMP-05', name: 'Jamal Uddin', designation: 'Warehouse In-charge', department: 'Warehouse', mobile: '01755-119043', role: 'Warehouse', joined: '2022-02-02' },
  { id: 6, code: 'EMP-06', name: 'Farhana Yeasmin', designation: 'Accounts Officer', department: 'Accounts', mobile: '01633-220871', role: 'Accounts', joined: '2022-06-20' },
  { id: 7, code: 'EMP-07', name: 'Mizanur Rahman', designation: 'Sales Officer', department: 'Sales', mobile: '01521-778812', role: 'Sales', joined: '2023-11-11' },
  { id: 8, code: 'EMP-08', name: 'Ashraful Islam', designation: 'Field Officer — Crop', department: 'Operations', mobile: '01844-663019', role: 'Purchase', joined: '2024-01-03' },
  { id: 9, code: 'EMP-09', name: 'Sumaiya Khatun', designation: 'Data Entry Operator', department: 'Operations', mobile: '01977-334528', role: 'Sales', joined: '2025-04-15' },
  { id: 10, code: 'EMP-10', name: 'Habibur Rahman', designation: 'Store Assistant', department: 'Warehouse', mobile: '01686-901254', role: 'Warehouse', joined: '2026-02-01' },
];

/**
 * Which role may do what.
 *
 * With a backend this comes from `role_permissions`, so the table states the
 * grants actually in force and editing a cell moves one. This is the same
 * thing without a server: the modules a permission groups under, the roles,
 * and the codes each role holds. The levels the matrix prints are derived from
 * those grants by `permissionMatrix()` rather than written out, so a
 * permission granted here reaches the table the way it would through the API.
 */
export const PERMISSION_MODULES = [
  { key: 'dashboard', label: 'Dashboard', permissions: [['dashboard.view', 'View']] },
  { key: 'crop_purchase', label: 'Crop purchase', permissions: [['crop.purchase.view', 'View'], ['crop.purchase.create', 'Create'], ['crop.purchase.post', 'Post'], ['crop.purchase.cancel', 'Cancel']] },
  { key: 'crop_sale', label: 'Crop sales', permissions: [['crop.sale.view', 'View'], ['crop.sale.create', 'Create'], ['crop.sale.post', 'Post'], ['crop.sale.cancel', 'Cancel']] },
  { key: 'dealer_purchase', label: 'Dealer purchase', permissions: [['dealer.purchase.view', 'View'], ['dealer.purchase.create', 'Create'], ['dealer.purchase.post', 'Post'], ['dealer.purchase.cancel', 'Cancel']] },
  { key: 'dealer_sale', label: 'Dealer sales', permissions: [['dealer.sale.view', 'View'], ['dealer.sale.create', 'Create'], ['dealer.sale.post', 'Post'], ['dealer.sale.cancel', 'Cancel']] },
  { key: 'inventory', label: 'Inventory', permissions: [['inventory.view', 'View'], ['inventory.transfer', 'Transfer'], ['inventory.adjust', 'Adjust']] },
  { key: 'customer', label: 'Customers', permissions: [['customer.view', 'View'], ['customer.create', 'Create'], ['customer.edit', 'Edit'], ['customer.delete', 'Retire']] },
  { key: 'supplier', label: 'Suppliers', permissions: [['supplier.view', 'View'], ['supplier.create', 'Create'], ['supplier.edit', 'Edit'], ['supplier.delete', 'Retire']] },
  { key: 'company', label: 'Companies', permissions: [['company.view', 'View'], ['company.create', 'Create'], ['company.edit', 'Edit'], ['company.delete', 'Retire']] },
  { key: 'crop', label: 'Crops', permissions: [['crop.view', 'View'], ['crop.create', 'Create'], ['crop.edit', 'Edit'], ['crop.delete', 'Retire']] },
  { key: 'product', label: 'Products', permissions: [['product.view', 'View'], ['product.create', 'Create'], ['product.edit', 'Edit'], ['product.delete', 'Retire']] },
  { key: 'warehouse', label: 'Warehouses', permissions: [['warehouse.create', 'Create'], ['warehouse.edit', 'Edit'], ['warehouse.delete', 'Close']] },
  { key: 'employee', label: 'Employees', permissions: [['employee.view', 'View'], ['employee.create', 'Create'], ['employee.edit', 'Edit'], ['employee.delete', 'Retire']] },
  { key: 'payment', label: 'Payments', permissions: [['payment.view', 'View'], ['payment.create', 'Collect']] },
  { key: 'payment_method', label: 'Payment methods', permissions: [['payment.method.create', 'Create'], ['payment.method.edit', 'Edit'], ['payment.method.delete', 'Retire']] },
  { key: 'expense', label: 'Expenses', permissions: [['expense.view', 'View'], ['expense.create', 'Record']] },
  { key: 'expense_category', label: 'Expense categories', permissions: [['expense.category.create', 'Create'], ['expense.category.edit', 'Edit'], ['expense.category.delete', 'Retire']] },
  { key: 'account', label: 'Cash and bank accounts', permissions: [['account.create', 'Create'], ['account.edit', 'Edit'], ['account.delete', 'Close']] },
  { key: 'unit', label: 'Units of measure', permissions: [['unit.create', 'Create'], ['unit.edit', 'Edit'], ['unit.delete', 'Retire']] },
  { key: 'report', label: 'Reports', permissions: [['report.view', 'View']] },
  // Not seeing profit is a deliberate state with a name, not an absence.
  { key: 'profit', label: 'Profit figures', permissions: [['report.profit', 'Full']], empty: 'Hidden' },
  { key: 'approval', label: 'Approvals', permissions: [['approval.view', 'Request'], ['approval.decide', 'Approve']] },
  { key: 'settings', label: 'Settings', permissions: [['settings.view', 'View'], ['settings.edit', 'Full']] },
  { key: 'access', label: 'Roles and logins', permissions: [['user.manage', 'Logins'], ['role.edit', 'Roles']] },
  { key: 'audit', label: 'Audit trail', permissions: [['audit.view', 'View']] },
];

/** Every permission code the modules above account for. */
export const ALL_PERMISSIONS = PERMISSION_MODULES.flatMap((m) =>
  m.permissions.map(([code]) => code)
);

/**
 * The codes a role holds, given how far it reaches into each module.
 *
 * A number is how far down that module's ladder the role goes -- 1 is view, 2
 * is create, and so on -- and `*` is the lot. Written this way because it is
 * what the grants mean: a role that may post a sale may also see one.
 */
const grants = (reach) =>
  PERMISSION_MODULES.flatMap((module) => {
    const depth = reach[module.key];
    if (!depth) return [];
    const codes = module.permissions.map(([code]) => code);
    return depth === '*' ? codes : codes.slice(0, depth);
  });

/** The six roles the business is set up around, and what each one holds. */
export const ROLES = [
  {
    id: 1, code: 'Admin', name: 'Admin', system: true,
    description: 'Everything, including roles, logins and settings',
    granted: ALL_PERMISSIONS,
  },
  {
    id: 2, code: 'Management', name: 'Management', system: true,
    description: 'Sees the whole business and decides approvals',
    granted: grants({ dashboard: '*', crop_purchase: 1, crop_sale: 1, dealer_purchase: 1, dealer_sale: 1, inventory: 1, customer: 1, supplier: 1, company: 1, crop: 1, product: 1, warehouse: 2, employee: 3, payment: 1, expense: 1, report: '*', profit: '*', approval: '*', settings: 1, audit: '*' }),
  },
  {
    id: 3, code: 'Sales', name: 'Sales', system: true,
    description: 'Raises sales, collects payment, keeps the customer list',
    granted: grants({ dashboard: '*', crop_sale: 3, dealer_sale: 3, inventory: 1, customer: 3, crop: 1, product: 1, payment: '*', report: 1 }),
  },
  {
    id: 4, code: 'Purchase', name: 'Purchase', system: true,
    description: 'Raises purchases and keeps the procurement master',
    granted: grants({ dashboard: '*', crop_purchase: 2, dealer_purchase: 2, inventory: 1, supplier: 3, company: 3, crop: 3, product: 3, report: 1 }),
  },
  {
    id: 5, code: 'Accounts', name: 'Accounts', system: true,
    description: 'Money in, money out, and the books behind it',
    granted: grants({ dashboard: '*', crop_purchase: 1, crop_sale: 1, dealer_purchase: 1, dealer_sale: 1, inventory: 1, customer: 1, supplier: 1, company: 1, crop: 1, product: 1, payment: '*', expense: '*', report: '*', profit: '*', approval: 1, audit: '*' }),
  },
  {
    id: 6, code: 'Warehouse', name: 'Warehouse', system: true,
    description: 'Stock in the godowns, and the movements between them',
    granted: grants({ dashboard: '*', crop_purchase: 1, crop_sale: 1, dealer_purchase: 1, dealer_sale: 1, inventory: '*', crop: 1, product: 1 }),
  },
];

/**
 * Turn roles and their grants into the matrix the screen draws.
 *
 * The same derivation the server makes: all of a module reads 'Full', none of
 * it reads the module's empty label, and anything between reads the strongest
 * level actually held. `users` counts the team members holding the role, so
 * the roles list can say who would be affected by a change to it.
 */
export function permissionMatrix(roles, team = EMPLOYEES) {
  const holders = (code) => team.filter((e) => e.role === code && e.status !== 'Retired').length;
  return {
    roles: roles.map((r) => r.code),
    roleList: roles.map((r) => ({
      ...r,
      users: holders(r.code),
      activeUsers: holders(r.code),
    })),
    modules: PERMISSION_MODULES.map((module) => ({
      key: module.key,
      label: module.label,
      empty: module.empty || '\u2014',
      permissions: module.permissions.map(([code, label]) => ({ code, label, description: '' })),
      levels: Object.fromEntries(
        roles.map((role) => {
          const owned = module.permissions.filter(([code]) => role.granted.includes(code));
          if (!owned.length) return [role.code, module.empty || '\u2014'];
          if (owned.length === module.permissions.length) return [role.code, 'Full'];
          return [role.code, owned[owned.length - 1][1]];
        })
      ),
    })),
  };
}

/** Field-entry and approval screens for the phone. */
export const PHONE_SCREENS = [
        {title:'Crop Purchase', tag:'Field entry', net:'4G ▪ 82%', cta:'Save and send for approval',
          note:'Field officer at the weighbridge. Three numbers to type, everything else is picked from a list; cost per unit updates as they type.',
          blocks:[{k:'Supplier', v:'Abdul Karim Mondol', size:'15px', font:'inherit', color:'#1A1817', d:'Mohadevpur, Naogaon · payable ৳5,20,000'},
            {k:'Crop and grade', v:'Maize · A (Premium)', size:'15px', font:'inherit', color:'#1A1817', d:''},
            {k:'Net quantity after 1.5% deduction', v:'98.50 MT', size:'20px', font:"'Roboto Mono',monospace", color:'#1A1817', d:'Gross 100 MT'},
            {k:'Rate per MT', v:'৳30,000', size:'20px', font:"'Roboto Mono',monospace", color:'#1A1817', d:'Last purchase ৳30,500'},
            {k:'Actual cost per MT', v:'৳30,761', size:'24px', font:"'Roboto Mono',monospace", color:'#1F4D2E', d:'Total landed cost ৳30,30,000'}]},
        {title:'Collection', tag:'Sales officer', net:'4G ▪ 76%', cta:'Receive ৳2,00,000',
          note:'Collection against a specific invoice, on the spot. Allocation and the new outstanding are shown before the receipt is issued.',
          blocks:[{k:'Customer', v:'Nabin Krishi Bitan', size:'15px', font:'inherit', color:'#1A1817', d:'Mohadevpur, Naogaon'},
            {k:'Outstanding', v:'৳8,50,000', size:'22px', font:"'Roboto Mono',monospace", color:'#B3261E', d:'৳1,00,000 past 90 days'},
            {k:'Against invoice', v:'DS-2608-188', size:'15px', font:"'Roboto Mono',monospace", color:'#1A1817', d:'৳4,45,000 · due 29 Aug'},
            {k:'Receiving in', v:'bKash', size:'15px', font:'inherit', color:'#1A1817', d:'01911-450288'},
            {k:'Outstanding after receipt', v:'৳6,50,000', size:'20px', font:"'Roboto Mono',monospace", color:'#1A1817', d:''}]},
        {title:'Approvals', tag:'Owner', net:'WiFi ▪ 91%', cta:'Approve ৳30,20,000',
          note:'What the owner sees on the phone: the reason a request is blocked, the money at stake and two buttons.',
          blocks:[{k:'Request', v:'Crop purchase PC-2608-014', size:'15px', font:'inherit', color:'#1A1817', d:'Raised by Sohel Rana · 10:12 am'},
            {k:'Amount', v:'৳30,20,000', size:'24px', font:"'Roboto Mono',monospace", color:'#1A1817', d:'Above the ৳5,00,000 limit'},
            {k:'Cost per MT after all expense', v:'৳30,761', size:'19px', font:"'Roboto Mono',monospace", color:'#1F4D2E', d:'Market rate today ৳31,200'},
            {k:'Supplier exposure', v:'৳5,20,000 payable', size:'15px', font:'inherit', color:'#1A1817', d:'Advance requested ৳15,00,000'}]}];

/**
 * The Settings screen's working set, without a backend.
 *
 * Field for field this is what `GET /settings` returns, so the screen reads one
 * shape whichever repository it is holding, and the panels are the same panels
 * either way. The demo can edit them; nothing outlives the page, which is what
 * "no backend" means.
 */
export const SETTINGS = {
  organization: {
    id: 1,
    code: 'MEGHNA',
    name: 'Meghna Agro Enterprise',
    systemName: 'Business Suite',
    tradeLicenceNo: 'BOG-TL-2019-04471',
    binNo: '003912847-0201',
    headOffice: 'Sherpur Road, Bogura Sadar, Bogura',
    mobile: '01711-330099',
    email: 'accounts@meghnaagro.com.bd',
    currency: 'BDT',
    defaultDistrict: 'Bogura',
    valuation: 'FIFO',
  },
  fiscalYears: [
    { id: 1, code: 'FY 2026-27', startsOn: '2026-07-01', endsOn: '2027-06-30', span: '01 Jul 2026 – 30 Jun 2027', current: true, closed: false, status: 'Current' },
    { id: 2, code: 'FY 2025-26', startsOn: '2025-07-01', endsOn: '2026-06-30', span: '01 Jul 2025 – 30 Jun 2026', current: false, closed: true, status: 'Closed' },
    { id: 3, code: 'FY 2024-25', startsOn: '2024-07-01', endsOn: '2025-06-30', span: '01 Jul 2024 – 30 Jun 2025', current: false, closed: true, status: 'Closed' },
  ],
  numbering: [
    { docType: 'crop_purchase', label: 'Crop purchase', prefix: 'PC', padding: 3, pattern: 'PC-YYMM-###', issued: 13 },
    { docType: 'crop_sale', label: 'Crop sale', prefix: 'SC', padding: 3, pattern: 'SC-YYMM-###', issued: 50 },
    { docType: 'dealer_purchase', label: 'Dealer purchase', prefix: 'DP', padding: 3, pattern: 'DP-YYMM-###', issued: 41 },
    { docType: 'dealer_sale', label: 'Dealer sale', prefix: 'DS', padding: 3, pattern: 'DS-YYMM-###', issued: 221 },
    { docType: 'crop_batch', label: 'Batch / lot', prefix: 'BC', padding: 3, pattern: 'BC-YYMM-###', issued: 14 },
    { docType: 'receipt', label: 'Receipt', prefix: 'RC', padding: 3, pattern: 'RC-YYMM-###', issued: 309 },
    { docType: 'payment', label: 'Payment voucher', prefix: 'PY', padding: 3, pattern: 'PY-YYMM-###', issued: 88 },
    { docType: 'expense', label: 'Expense', prefix: 'EXP', padding: 3, pattern: 'EXP-YYMM-###', issued: 118 },
  ],
  units: [
    { id: 1, code: 'MT', name: 'Metric Tonne', factor: 1, base: '', active: true, status: 'Active', conversion: 'base unit' },
    { id: 2, code: 'Maund', name: 'Maund', factor: 0.037324, base: 'MT', active: true, status: 'Active', conversion: '1 MT = 26.7924 Maund' },
    { id: 3, code: 'Kg', name: 'Kilogram', factor: 0.001, base: 'MT', active: true, status: 'Active', conversion: '1 MT = 1,000 Kg' },
    { id: 4, code: 'Bag', name: 'Bag (50 kg)', factor: 0.05, base: 'MT', active: true, status: 'Active', conversion: '1 MT = 20 Bag' },
    { id: 5, code: 'Pcs', name: 'Piece', factor: 1, base: '', active: true, status: 'Active', conversion: 'base unit' },
  ],
  approvalRules: [
    { id: 1, code: 'CROP_PUR_LIMIT', entityType: 'crop_purchases', entityLabel: 'Crop purchase', businessType: 'BULK_CROP', condition: 'AMOUNT_ABOVE', threshold: 500000, active: true },
    { id: 2, code: 'DEALER_PUR_LIMIT', entityType: 'dealer_purchases', entityLabel: 'Dealer purchase', businessType: 'DEALER', condition: 'AMOUNT_ABOVE', threshold: 500000, active: true },
    { id: 3, code: 'CROP_SALE_LIMIT', entityType: 'crop_sales', entityLabel: 'Crop sale', businessType: 'BULK_CROP', condition: 'AMOUNT_ABOVE', threshold: 2000000, active: true },
    { id: 4, code: 'DISCOUNT_CEILING', entityType: 'dealer_sales', entityLabel: 'Dealer sale', businessType: 'DEALER', condition: 'DISCOUNT_PCT_ABOVE', threshold: 5, active: true },
    { id: 5, code: 'STOCK_ADJ', entityType: 'stock_adjustments', entityLabel: 'Stock adjustment', businessType: null, condition: 'ALWAYS', threshold: null, active: true },
    { id: 6, code: 'EXPENSE_LIMIT', entityType: 'expenses', entityLabel: 'Expense', businessType: null, condition: 'AMOUNT_ABOVE', threshold: 50000, active: true },
  ],
  notificationRules: [
    { id: 1, code: 'CUSTOMER_OVERDUE', name: 'Customer payment overdue', description: 'daily 9:00 am for invoices past due date', threshold: null, unit: 'amount', active: true },
    { id: 2, code: 'SUPPLIER_DUE', name: 'Supplier payment due', description: 'fires {value} days before the due date', threshold: 2, unit: 'days', active: true },
    { id: 3, code: 'LOW_STOCK', name: 'Low stock', description: 'when quantity falls below minimum stock', threshold: null, unit: 'amount', active: true },
    { id: 4, code: 'DEAD_STOCK', name: 'Dead stock', description: 'a crop batch still held after {value} days', threshold: 60, unit: 'days', active: true },
    { id: 5, code: 'LARGE_TRANSACTION', name: 'Large transaction', description: 'any single transaction above {value}', threshold: 2000000, unit: 'amount', active: true },
    { id: 6, code: 'EXPENSE_THRESHOLD', name: 'Expense threshold', description: 'an expense above {value}', threshold: 50000, unit: 'amount', active: true },
  ],
  categories: [
    { id: 1, code: 'AGROCHEMICAL', name: 'Agrochemical', products: 3, active: true, status: 'Active' },
    { id: 2, code: 'FERTILIZER', name: 'Fertilizer', products: 2, active: true, status: 'Active' },
    { id: 3, code: 'SEEDS', name: 'Seeds', products: 1, active: true, status: 'Active' },
    { id: 4, code: 'FEED', name: 'Feed', products: 0, active: true, status: 'Active' },
  ],
  brands: [
    { id: 1, code: 'SYNGENTA', name: 'Syngenta', products: 2, active: true, status: 'Active' },
    { id: 2, code: 'ACI', name: 'ACI', products: 2, active: true, status: 'Active' },
    { id: 3, code: 'SQUARE', name: 'Square', products: 1, active: true, status: 'Active' },
    { id: 4, code: 'ISPAHANI', name: 'Ispahani', products: 1, active: true, status: 'Active' },
  ],
  permissions: permissionMatrix(ROLES),
};

/** Payment methods and whether each is in use, without a backend. */
export const PAYMENT_METHODS = [
  { id: 1, code: 'CASH', name: 'Cash', account: 'Office cash — Bogura', active: true, status: 'Active' },
  { id: 2, code: 'BANK', name: 'Bank transfer', account: 'Islami Bank — 20501...4417', active: true, status: 'Active' },
  { id: 3, code: 'CHEQUE', name: 'Cheque', account: 'DBBL — 1471...8802', active: true, status: 'Active' },
  { id: 4, code: 'BKASH', name: 'bKash', account: 'bKash Merchant — 01755...', active: true, status: 'Active' },
  { id: 5, code: 'NAGAD', name: 'Nagad', account: '', active: true, status: 'Active' },
  { id: 6, code: 'ROCKET', name: 'Rocket', account: '', active: false, status: 'Retired' },
];

/**
 * Cash and bank accounts shown on the Accounts screen without a backend.
 *
 * Named rather than written inline so the table, its footer and the KPI above
 * it all count the same list. With the API wired the balances come from the
 * server's account rows instead.
 */
export const CASH_ACCOUNTS = [
  { name: 'Office cash — Bogura', type: 'Cash', last: '28 Aug 2026', balance: 385000 },
  { name: 'Islami Bank — 20501...4417', type: 'Bank', last: '28 Aug 2026', balance: 2140000 },
  { name: 'DBBL — 1471...8802', type: 'Bank', last: '27 Aug 2026', balance: 1520000 },
  { name: 'bKash Merchant — 01755...', type: 'MFS', last: '28 Aug 2026', balance: 240000 },
];

/**
 * Expense vouchers shown when there is no backend.
 *
 * With the API wired these come from `GET /expenses`; this is the fixture the
 * demo runs on, kept here rather than inline in a screen so the table and its
 * total are built from one list.
 */
export const EXPENSE_VOUCHERS = [
  { no: 'EXP-2608-118', date: '2026-08-27', category: 'Transport', note: 'Dinajpur to Bogura, 3 trucks', businessType: 'BULK_CROP', amount: 96000 },
  { no: 'EXP-2608-112', date: '2026-08-26', category: 'Loading / Unloading', note: 'Naogaon godown labour', businessType: 'BULK_CROP', amount: 34000 },
  { no: 'EXP-2608-108', date: '2026-08-25', category: 'Salary', note: 'August advance — 4 staff', businessType: null, amount: 128000 },
  { no: 'EXP-2608-101', date: '2026-08-23', category: 'Warehouse', note: 'Rangpur store rent', businessType: null, amount: 45000 },
  { no: 'EXP-2608-094', date: '2026-08-21', category: 'Fuel', note: 'Delivery van, dealer route', businessType: 'DEALER', amount: 18600 },
  { no: 'EXP-2608-088', date: '2026-08-19', category: 'Commission', note: 'Aratdar commission, paddy lot', businessType: 'BULK_CROP', amount: 62500 },
];

/**
 * Audit entries shown when there is no backend.
 *
 * With the API wired these come from `GET /audit`, where every write records
 * one inside the transaction that made the change. The shape is the same, so
 * the screen builds its table the same way either way.
 */
export const AUDIT_LOG = [
  { when: '28 Aug, 10:12 am', user: 'Sohel Rana', action: 'CREATE', entity: 'crop_purchases', entityId: 14, summary: 'Crop purchase PC-2608-014 created', oldValue: null, newValue: { net_amount: 3020000 } },
  { when: '28 Aug, 9:58 am', user: 'Sohel Rana', action: 'UPDATE', entity: 'crop_purchases', entityId: 14, summary: 'Crop purchase PC-2608-014 updated', oldValue: { transport_cost: 42000 }, newValue: { transport_cost: 50000 } },
  { when: '28 Aug, 9:40 am', user: 'Shamim Reza', action: 'UPDATE', entity: 'dealer_sales', entityId: 221, summary: 'Dealer sale DS-2608-221 updated', oldValue: { rate: 295 }, newValue: { rate: 286 } },
  { when: '27 Aug, 6:05 pm', user: 'Jamal Uddin', action: 'ADJUST', entity: 'crop_batches', entityId: 14, summary: 'Batch BC-2607-014 adjusted', oldValue: { quantity_remaining: 92 }, newValue: { quantity_remaining: 88 } },
  { when: '27 Aug, 3:22 pm', user: 'Nasrin Akter', action: 'CREATE', entity: 'payments', entityId: 309, summary: 'Receipt RC-2608-309 recorded', oldValue: null, newValue: { amount: 400000 } },
  { when: '26 Aug, 12:15 pm', user: 'Rakib Hasan', action: 'APPROVE', entity: 'crop_sales', entityId: 51, summary: 'Crop sale SC-2608-051 approved', oldValue: { status: 'PENDING_APPROVAL' }, newValue: { status: 'APPROVED' } },
  { when: '26 Aug, 11:50 am', user: 'Shamim Reza', action: 'POST', entity: 'crop_sales', entityId: 51, summary: 'Crop sale SC-2608-051 sent for approval', oldValue: { status: 'DRAFT' }, newValue: { status: 'PENDING_APPROVAL' } },
  { when: '25 Aug, 5:02 pm', user: 'Rakib Hasan', action: 'REJECT', entity: 'dealer_sales', entityId: 198, summary: 'Dealer sale DS-2608-198 rejected', oldValue: { discount_pct: 8 }, newValue: { status: 'REJECTED' } },
];
