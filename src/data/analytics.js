import { C } from '../styles/tokens.js';

/**
 * Reporting figures for the dashboard, accounts and reports centre.
 *
 * These are the aggregates an analytics endpoint would serve. They are kept
 * out of the screen logic so a real backend can replace this module wholesale
 * without touching a view.
 */

/** Headline KPI tiles. `d` is the dealer figure, `c` the bulk crop figure. */
export const DASHBOARD_KPIS = [
      {k:"Today's Sales", d:412000, c:1035000, note:'9 invoices', up:'+8.4% vs yesterday', good:true},
      {k:'This Month Sales', d:9840000, c:24600000, note:'August 2026', up:'+12.1% vs July', good:true},
      {k:'This Month Purchase', d:7210000, c:21150000, note:'August 2026', up:'+6.8% vs July', good:true},
      {k:'Gross Profit', d:1486000, c:2385000, note:'margin 11.2%', up:'+1.4 pts', good:true},
      {k:'Outstanding Receivable', d:1580000, c:4270000, note:'42 open invoices', up:'৳12.4 L overdue', good:false},
      {k:'Outstanding Payable', d:2140000, c:1890000, note:'18 bills', up:'৳6.7 L due this week', good:false},
      {k:'Current Stock Value', d:5620000, c:18740000, note:'4 warehouses', up:'6 crop batches', good:true},
      {k:'Cash & Bank Balance', d:0, c:0, fix:4285000, note:'Cash, 2 banks, bKash', up:'+৳3.2 L today', good:true}
    ];

/** Monthly sales/purchase series, in lakh BDT, split by business line. */
export const MONTHLY_SERIES = [{l:'Feb', ds:7.2, dp:5.9, cs:14.1, cp:12.8}, {l:'Mar', ds:8.1, dp:6.4, cs:18.6, cp:16.2}, {l:'Apr', ds:6.9, dp:5.2, cs:21.4, cp:19.1},
      {l:'May', ds:7.6, dp:6.1, cs:16.2, cp:14.4}, {l:'Jun', ds:8.8, dp:7.0, cs:12.8, cp:11.2}, {l:'Jul', ds:8.8, dp:6.8, cs:22.1, cp:19.6},
      {l:'Aug', ds:9.8, dp:7.2, cs:24.6, cp:21.2}];

/** Best customers by sales value. */
export const TOP_CUSTOMERS = [{n:'Sonar Bangla Enterprise', v:6180000}, {n:'Messrs. Rahman Traders', v:4820000}, {n:'Nabin Krishi Bitan', v:3740000}, {n:'Bhai Bhai Agro Store', v:2960000}, {n:'Uttara Seed House', v:2410000}];

/** Best counterparty companies by traded value. */
export const TOP_COMPANIES = [{n:'PRAN Agro Business Ltd.', v:9840000}, {n:'City Group (Rice Unit)', v:7260000}, {n:'Akij Foods & Beverage', v:4180000}, {n:'Square Feeds Ltd.', v:3320000}, {n:'ACI Agrochemicals', v:2610000}];

/** Receivable aging buckets. */
export const AGING_BUCKETS = [{k:'0 – 30 days', v:1870000, c:C.crop}, {k:'31 – 60 days', v:1610000, c:C.warn}, {k:'61 – 90 days', v:1240000, c:'#C4720F'}, {k:'90+ days', v:1130000, c:C.dngr}];

/** Profit and loss lines for the current month. */
export const PROFIT_AND_LOSS = [{k:'Sales — Dealer business', v:9840000, ind:0}, {k:'Sales — Bulk crop business', v:24600000, ind:0}, {k:'Total revenue', v:34440000, bold:true},
      {k:'Cost of goods sold — Dealer', v:-8354000, ind:0}, {k:'Cost of goods sold — Bulk crop', v:-21215000, ind:0}, {k:'Gross profit', v:4871000, bold:true, good:true},
      {k:'Transport', v:-286000, ind:0}, {k:'Loading / unloading', v:-134000, ind:0}, {k:'Salary', v:-512000, ind:0}, {k:'Warehouse rent', v:-135000, ind:0},
      {k:'Commission', v:-162500, ind:0}, {k:'Office & utility', v:-88400, ind:0}, {k:'Total operating expense', v:-1317900, bold:true},
      {k:'Net profit — August 2026', v:3553100, bold:true, good:true, big:true}];

/** Report catalogue shown in the reports centre sidebar. */
export const REPORT_GROUPS = [
      {g:'Sales', items:[['sales-daily', 'Daily sales'], ['sales-monthly', 'Monthly sales'], ['sales-customer', 'Customer-wise sales'], ['sales-product', 'Product-wise sales'], ['sales-person', 'Salesperson-wise sales']]},
      {g:'Purchase', items:[['pur-supplier', 'Supplier-wise purchase'], ['pur-company', 'Company-wise purchase'], ['pur-batch', 'Batch-wise purchase']]},
      {g:'Inventory', items:[['inv-current', 'Current stock'], ['inv-valuation', 'Stock valuation'], ['inv-dead', 'Dead stock']]},
      {g:'Profit', items:[['crop-batch-profit', 'Batch-wise crop profit'], ['profit-product', 'Product-wise profit'], ['profit-customer', 'Customer-wise profit'], ['profit-monthly', 'Monthly profit']]},
      {g:'Finance', items:[['fin-aging', 'Customer outstanding & aging'], ['fin-cashbook', 'Cash book'], ['fin-pl', 'Profit & loss']]}
    ];
