import { C } from '../styles/tokens.js';
import { money } from '../domain/format.js';

/**
 * Reference and configuration records: the team directory, the audit trail,
 * the permission matrix, the settings pages and the mobile screen specs.
 *
 * Separate from `analytics.js` because these are records a system-of-record
 * would own rather than figures a reporting endpoint would compute.
 */

/** Team directory: id, name, designation, department, mobile, role, joined. */
export const EMPLOYEES = [
      ['EMP-01', 'Rakib Hasan', 'Managing Director', 'Management', '01711-330099', 'Admin', '01 Jan 2019'],
      ['EMP-02', 'Nasrin Akter', 'Accounts Manager', 'Accounts', '01715-882204', 'Accounts', '12 Mar 2020'],
      ['EMP-03', 'Sohel Rana', 'Purchase Officer', 'Purchase', '01816-445521', 'Purchase', '05 Jul 2021'],
      ['EMP-04', 'Shamim Reza', 'Senior Sales Officer', 'Sales', '01912-006733', 'Sales', '18 Sep 2021'],
      ['EMP-05', 'Jamal Uddin', 'Warehouse In-charge', 'Warehouse', '01755-119043', 'Warehouse', '02 Feb 2022'],
      ['EMP-06', 'Farhana Yeasmin', 'Accounts Officer', 'Accounts', '01633-220871', 'Accounts', '20 Jun 2022'],
      ['EMP-07', 'Mizanur Rahman', 'Sales Officer', 'Sales', '01521-778812', 'Sales', '11 Nov 2023'],
      ['EMP-08', 'Ashraful Islam', 'Field Officer — Crop', 'Operations', '01844-663019', 'Purchase', '03 Jan 2024'],
      ['EMP-09', 'Sumaiya Khatun', 'Data Entry Operator', 'Operations', '01977-334528', 'Sales', '15 Apr 2025'],
      ['EMP-10', 'Habibur Rahman', 'Store Assistant', 'Warehouse', '01686-901254', 'Warehouse', '01 Feb 2026']
    ];

/** Which role may do what, per module. */
export const PERMISSION_MATRIX = {cols:['Module', 'Admin', 'Management', 'Sales', 'Purchase', 'Accounts', 'Warehouse'],
        rows:[['Dashboard', 'Full', 'Full', 'Own', 'Own', 'Full', 'Stock only'], ['Crop purchase', 'Full', 'View', '—', 'Create', 'View', 'Receive'],
          ['Crop sales', 'Full', 'View', 'Create', '—', 'View', 'Issue'], ['Dealer purchase', 'Full', 'View', '—', 'Create', 'View', 'Receive'],
          ['Dealer sales', 'Full', 'View', 'Create', '—', 'View', 'Issue'], ['Inventory', 'Full', 'View', 'View', 'View', 'View', 'Full'],
          ['Customers', 'Full', 'View', 'Full', '—', 'View', '—'], ['Suppliers', 'Full', 'View', '—', 'Full', 'View', '—'],
          ['Payments', 'Full', 'View', 'Collect', '—', 'Full', '—'], ['Profit figures', 'Full', 'Full', 'Hidden', 'Hidden', 'Full', 'Hidden'],
          ['Approvals', 'Full', 'Approve', '—', '—', 'Request', '—'], ['Settings', 'Full', 'View', '—', '—', '—', '—']].map(r => ({cells:r.map((c, i) => ({
          t:c, w:i === 0 ? '600' : '400', color:c === 'Full' ? C.crop : c === '—' || c === 'Hidden' ? '#B6B0A6' : '#3D3A36', align:i === 0 ? 'left' : 'center'}))}))};

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

/** Financial years, most recent first. */
export const FINANCIAL_YEARS = [{k:'FY 2026-27', d:'01 Jul 2026 – 30 Jun 2027', tag:'Current', tagBg:C.cropBg, tagFg:C.crop, bg:'#FBFAF8'},
        {k:'FY 2025-26', d:'01 Jul 2025 – 30 Jun 2026', tag:'Closed', tagBg:'#F0EEE9', tagFg:'#3D3A36', bg:'#fff'},
        {k:'FY 2024-25', d:'01 Jul 2024 – 30 Jun 2025', tag:'Closed', tagBg:'#F0EEE9', tagFg:'#3D3A36', bg:'#fff'}];

/** Document numbering patterns. */
export const NUMBERING = [{k:'Crop purchase', v:'PC-YYMM-###'}, {k:'Crop sale', v:'SC-YYMM-###'}, {k:'Dealer purchase', v:'DP-YYMM-###'}, {k:'Dealer sale', v:'DS-YYMM-###'},
        {k:'Batch / lot', v:'BC-YYMM-###'}, {k:'Receipt', v:'RC-YYMM-###'}, {k:'Payment voucher', v:'PY-YYMM-###'}, {k:'Expense', v:'EXP-YYMM-###'}];

/** Units and their conversion to the base unit. */
export const UNIT_CONVERSIONS = [{k:'Metric Tonne (MT)', v:'base unit for crops'}, {k:'Maund', v:'1 MT = 26.7922 maund'}, {k:'Kilogram', v:'1 MT = 1,000 kg'},
        {k:'Bag (50 kg)', v:'1 MT = 20 bags'}, {k:'Piece', v:'base unit for dealer products'}];

/** Payment methods and whether each is in use. */
export const PAYMENT_METHODS = [{k:'Cash', d:'Office cash — Bogura', on:true}, {k:'Bank transfer', d:'Islami Bank, DBBL', on:true}, {k:'Cheque', d:'with clearing date tracking', on:true},
        {k:'bKash', d:'merchant 01755-119043', on:true}, {k:'Nagad', d:'merchant 01755-119043', on:true}, {k:'Rocket', d:'not in use', on:false}];

/** Notification rules and when each fires. */
export const NOTIFICATION_RULES = [{k:'Customer payment overdue', d:'daily 9:00 am for invoices past due date'}, {k:'Supplier payment due', d:'2 days before due date'},
        {k:'Low stock', d:'when quantity falls below minimum stock'}, {k:'Dead stock', d:'crop batch older than 60 days'},
        {k:'Large transaction', d:'any single transaction above ' + money(2000000)}, {k:'Expense threshold', d:'expense above ' + money(50000)}];

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
