/**
 * Reference and configuration records: the team directory, the audit trail,
 * the permission matrix, the settings pages and the mobile screen specs.
 *
 * Separate from `analytics.js` because these are records a system-of-record
 * would own rather than figures a reporting endpoint would compute.
 */

/** Team directory: id, name, designation, department, mobile, role, joined. */
/**
 * The team, as records rather than a positional table.
 *
 * The employees screen used to render these by index, which meant it could
 * only ever show this fixed list. As records they seed the in-memory store and
 * the screen renders whatever the repository returns -- the real table with a
 * backend, this fixture without one.
 */
export const EMPLOYEES = [
  { code: 'EMP-01', name: 'Rakib Hasan', designation: 'Managing Director', department: 'Management', mobile: '01711-330099', role: 'Admin', joined: '2019-01-01' },
  { code: 'EMP-02', name: 'Nasrin Akter', designation: 'Accounts Manager', department: 'Accounts', mobile: '01715-882204', role: 'Accounts', joined: '2020-03-12' },
  { code: 'EMP-03', name: 'Sohel Rana', designation: 'Purchase Officer', department: 'Purchase', mobile: '01816-445521', role: 'Purchase', joined: '2021-07-05' },
  { code: 'EMP-04', name: 'Shamim Reza', designation: 'Senior Sales Officer', department: 'Sales', mobile: '01912-006733', role: 'Sales', joined: '2021-09-18' },
  { code: 'EMP-05', name: 'Jamal Uddin', designation: 'Warehouse In-charge', department: 'Warehouse', mobile: '01755-119043', role: 'Warehouse', joined: '2022-02-02' },
  { code: 'EMP-06', name: 'Farhana Yeasmin', designation: 'Accounts Officer', department: 'Accounts', mobile: '01633-220871', role: 'Accounts', joined: '2022-06-20' },
  { code: 'EMP-07', name: 'Mizanur Rahman', designation: 'Sales Officer', department: 'Sales', mobile: '01521-778812', role: 'Sales', joined: '2023-11-11' },
  { code: 'EMP-08', name: 'Ashraful Islam', designation: 'Field Officer — Crop', department: 'Operations', mobile: '01844-663019', role: 'Purchase', joined: '2024-01-03' },
  { code: 'EMP-09', name: 'Sumaiya Khatun', designation: 'Data Entry Operator', department: 'Operations', mobile: '01977-334528', role: 'Sales', joined: '2025-04-15' },
  { code: 'EMP-10', name: 'Habibur Rahman', designation: 'Store Assistant', department: 'Warehouse', mobile: '01686-901254', role: 'Warehouse', joined: '2026-02-01' },
];

/**
 * Which role may do what, per module.
 *
 * With a backend this is computed from `role_permissions`, so the table states
 * the grants that are actually in force. This is the same shape for the
 * no-backend demo: roles, and the level each one holds per module.
 */
export const PERMISSION_MATRIX = {
  roles: ['Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse'],
  modules: [
    ['Dashboard', 'Full', 'Full', 'Full', 'Full', 'Full', 'Full'],
    ['Crop purchase', 'Full', 'View', '—', 'Create', 'View', 'View'],
    ['Crop sales', 'Full', 'View', 'Post', '—', 'View', 'View'],
    ['Dealer purchase', 'Full', 'View', '—', 'Create', 'View', 'View'],
    ['Dealer sales', 'Full', 'View', 'Post', '—', 'View', 'View'],
    ['Inventory', 'Full', 'View', 'View', 'View', 'View', 'Full'],
    ['Customers', 'Full', 'View', 'Edit', '—', 'View', '—'],
    ['Suppliers', 'Full', 'View', '—', 'Create', 'View', '—'],
    ['Products', 'Full', 'View', 'View', 'View', 'View', 'View'],
    ['Payments', 'Full', 'View', 'Collect', '—', 'Collect', '—'],
    ['Expenses', 'Full', 'View', '—', '—', 'Record', '—'],
    ['Profit figures', 'Full', 'Full', 'Hidden', 'Hidden', 'Full', 'Hidden'],
    ['Approvals', 'Full', 'Full', '—', '—', 'Request', '—'],
    ['Settings', 'Full', 'View', '—', '—', '—', '—'],
    ['Audit trail', 'Full', 'View', '—', '—', 'View', '—'],
  ].map(([label, ...levels]) => ({
    label,
    levels: Object.fromEntries(
      ['Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse'].map((role, i) => [
        role,
        levels[i],
      ])
    ),
  })),
};

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
  permissions: PERMISSION_MATRIX,
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
