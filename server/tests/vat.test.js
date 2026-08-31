import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { LEDGER } from '../src/services/financeService.js';
import { postDocument } from './helpers/documents.js';

/**
 * VAT.
 *
 * Every other suite runs against an unregistered business, where the whole tax
 * model is inert and every document totals exactly what its goods are worth.
 * This one registers the business, which turns VAT on across every posting
 * path, and checks the three things that then have to be true at once: the
 * customer is charged the right amount, the business earns only the goods
 * value, and what is owed to the NBR sits in its own account rather than
 * hiding inside income or cost.
 *
 * Registration is put back at the end, because the suites share a database and
 * a business that is suddenly registered would change what every other one
 * posts.
 */
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';
let app;
let token;
let orgId;
let context;
let rates;

const auth = () => ({ authorization: `Bearer ${token}` });
const money = (n) => Math.round(Number(n) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

async function balanceOf(code) {
  const { rows } = await query(
    'SELECT COALESCE(balance, 0) AS balance FROM v_trial_balance WHERE org_id = $1 AND code = $2',
    [orgId, code]
  );
  return money(rows[0] ? rows[0].balance : 0);
}

async function ledgerDifference() {
  const { rows } = await query(
    'SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS diff FROM ledger_entries WHERE org_id = $1',
    [orgId]
  );
  return money(rows[0].diff);
}

/** Point a product at one rate, so a document charges what this test wants. */
async function chargeProductAt(productId, rateCode) {
  const rate = rates.find((r) => r.code === rateCode);
  await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [rate.id, productId]);
  return rate;
}

/** Set how the business quotes its prices for the duration of one test. */
const setPricing = (inclusive) =>
  query('UPDATE organizations SET prices_include_tax = $1 WHERE id = $2', [inclusive, orgId]);

const sell = ({ quantity, rate, paid = 0 }) =>
  postDocument(app, auth, '/api/dealer/sales', {
    txnDate: today(),
    customerId: context.customerId,
    warehouseId: context.warehouseId,
    paidAmount: paid,
    lines: [{ productId: context.productId, quantity, rate, discountPct: 0 }],
    action: 'POST',
  });

const buy = ({ quantity, rate }) =>
  postDocument(app, auth, '/api/dealer/purchases', {
    txnDate: today(),
    companyId: context.companyId,
    warehouseId: context.warehouseId,
    lines: [{ productId: context.productId, quantity, rate, discountPct: 0 }],
    action: 'POST',
  });

suite('vat', () => {
  beforeAll(async () => {
    app = createApp();
    const { rows } = await query(
      `SELECT u.username FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'Admin' LIMIT 1`
    );
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: rows[0].username, password: PASSWORD });
    token = res.body.data && res.body.data.accessToken;
    orgId = Number((await query('SELECT id FROM organizations LIMIT 1')).rows[0].id);

    const ctx = (await request(app).get('/api/reference/context').set(auth())).body.data;
    const companies = (await request(app).get('/api/companies').set(auth())).body.data;
    const customers = (await request(app).get('/api/customers').set(auth())).body.data;
    const products = (await request(app).get('/api/products').set(auth())).body.data;
    context = {
      warehouseId: Object.values(ctx.warehouseIds)[0],
      companyId: companies[0] && companies[0].id,
      customerId: customers[0] && customers[0].id,
      productId: products[0] && products[0].id,
    };

    rates = (await request(app).get('/api/tax-rates').set(auth())).body.data;
    await query(
      'UPDATE organizations SET is_vat_registered = true, prices_include_tax = false WHERE id = $1',
      [orgId]
    );
  });

  afterAll(async () => {
    await query(
      `UPDATE organizations SET is_vat_registered = false, prices_include_tax = false WHERE id = $1`,
      [orgId]
    );
    if (context?.productId) {
      await query('UPDATE products SET tax_rate_id = NULL WHERE id = $1', [context.productId]);
    }
    await closePool();
  });

  /* --------------------------------------------------------------- the rates */

  it('ships the rates the NBR actually uses', async () => {
    const codes = rates.map((r) => r.code);
    expect(codes).toContain('VAT15');
    expect(codes).toContain('ZERO');
    expect(codes).toContain('EXEMPT');

    const standard = rates.find((r) => r.code === 'VAT15');
    expect(standard.rate).toBe(15);
    expect(standard.kind).toBe('STANDARD');
  });

  it('has exactly one default, and moving it releases the last', async () => {
    const before = rates.filter((r) => r.isDefault);
    expect(before).toHaveLength(1);

    const other = rates.find((r) => r.code === 'VAT5');
    const res = await request(app)
      .patch(`/api/tax-rates/${other.id}`)
      .set(auth())
      .send({ isDefault: true });
    expect(res.status).toBe(200);

    const after = (await request(app).get('/api/tax-rates').set(auth())).body.data;
    expect(after.filter((r) => r.isDefault).map((r) => r.code)).toEqual(['VAT5']);

    // Put it back; every test below assumes the standard rate is the default.
    await request(app)
      .patch(`/api/tax-rates/${before[0].id}`)
      .set(auth())
      .send({ isDefault: true });
  });

  it('will not let an exempt supply claim its input tax back', async () => {
    const exempt = rates.find((r) => r.code === 'EXEMPT');
    expect(exempt.rate).toBe(0);
    expect(exempt.isReclaimable).toBe(false);

    // Even asked directly, because the NBR will not repay it.
    const res = await request(app)
      .patch(`/api/tax-rates/${exempt.id}`)
      .set(auth())
      .send({ isReclaimable: true });
    const reread = (await request(app).get('/api/tax-rates').set(auth())).body.data;
    expect(res.status).toBeLessThan(500);
    expect(reread.find((r) => r.code === 'EXEMPT').isReclaimable).toBe(false);
  });

  /* ------------------------------------------------------------------ sales */

  it('charges the rate the product attracts and owes it to the NBR', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await buy({ quantity: 20, rate: 1000 });

    const before = {
      receivable: await balanceOf(LEDGER.RECEIVABLE),
      sales: await balanceOf(LEDGER.DEALER_SALES),
      outputVat: await balanceOf(LEDGER.OUTPUT_VAT),
    };

    const sale = await sell({ quantity: 10, rate: 1300 });
    expect(money(sale.totals.net)).toBe(13000);
    expect(money(sale.totals.tax)).toBe(1950);
    expect(money(sale.totals.total)).toBe(14950);

    // The customer owes the invoice; the business earned only the goods; the
    // difference is the NBR's.
    expect(money((await balanceOf(LEDGER.RECEIVABLE)) - before.receivable)).toBe(14950);
    expect(money((await balanceOf(LEDGER.DEALER_SALES)) - before.sales)).toBe(13000);
    expect(money((await balanceOf(LEDGER.OUTPUT_VAT)) - before.outputVat)).toBe(1950);
    expect(await ledgerDifference()).toBe(0);
  });

  it('raises the receivable for the invoice, not for the goods', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await buy({ quantity: 10, rate: 1000 });
    const sale = await sell({ quantity: 5, rate: 1000 });

    const { rows } = await query(
      `SELECT invoice_amount, balance FROM receivables
        WHERE invoice_type = 'dealer_sales' AND invoice_id = $1`,
      [sale.id]
    );
    expect(money(rows[0].invoice_amount)).toBe(5750);
    expect(money(rows[0].balance)).toBe(5750);
  });

  it('does not count tax as profit', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await buy({ quantity: 10, rate: 1000 });
    const sale = await sell({ quantity: 10, rate: 1500 });

    const { rows } = await query(
      'SELECT net_amount, tax_amount, total_amount, cost_amount, profit_amount FROM dealer_sales WHERE id = $1',
      [sale.id]
    );
    const r = rows[0];
    // Profit is revenue less cost. The VAT was never the business's to earn,
    // so it appears in the total and nowhere else.
    expect(money(r.profit_amount)).toBe(money(num(r.net_amount) - num(r.cost_amount)));
    expect(money(r.total_amount)).toBe(money(num(r.net_amount) + num(r.tax_amount)));
  });

  it('charges nothing on an exempt supply', async () => {
    await chargeProductAt(context.productId, 'EXEMPT');
    await buy({ quantity: 10, rate: 1000 });

    const before = await balanceOf(LEDGER.OUTPUT_VAT);
    const sale = await sell({ quantity: 4, rate: 1200 });

    expect(money(sale.totals.tax)).toBe(0);
    expect(money(sale.totals.total)).toBe(4800);
    expect(await balanceOf(LEDGER.OUTPUT_VAT)).toBe(before);
  });

  /* ------------------------------------------------------- inclusive pricing */

  it('takes the tax out of a price that already contains it', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await setPricing(true);
    await buy({ quantity: 10, rate: 800 });

    // 1,150 a unit with 15% inside it is 1,000 of goods and 150 of tax.
    const sale = await sell({ quantity: 10, rate: 1150 });
    await setPricing(false);

    expect(money(sale.totals.net)).toBe(10000);
    expect(money(sale.totals.tax)).toBe(1500);
    // The customer pays what they were quoted, to the paisa.
    expect(money(sale.totals.total)).toBe(11500);
  });

  it('never leaves the two halves failing to add back to the price', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await setPricing(true);
    await buy({ quantity: 30, rate: 500 });

    // A price that does not divide cleanly by 1.15, on purpose.
    const sale = await sell({ quantity: 7, rate: 999 });
    await setPricing(false);

    expect(money(sale.totals.net + sale.totals.tax)).toBe(money(sale.totals.total));
    expect(money(sale.totals.total)).toBe(6993);
  });

  /* -------------------------------------------------------------- purchases */

  it('claims input tax back rather than carrying it as cost', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    const before = {
      inventory: await balanceOf(LEDGER.INVENTORY),
      inputVat: await balanceOf(LEDGER.INPUT_VAT),
      payable: await balanceOf(LEDGER.PAYABLE),
    };

    const purchase = await buy({ quantity: 10, rate: 1000 });
    expect(money(purchase.totals.tax)).toBe(1500);

    // Stock is worth the goods; the tax is a receivable from the NBR; the
    // principal is owed both.
    expect(money((await balanceOf(LEDGER.INVENTORY)) - before.inventory)).toBe(10000);
    expect(money((await balanceOf(LEDGER.INPUT_VAT)) - before.inputVat)).toBe(1500);
    expect(money((await balanceOf(LEDGER.PAYABLE)) - before.payable)).toBe(11500);
    expect(await ledgerDifference()).toBe(0);
  });

  it('puts tax it cannot reclaim into the cost of the goods', async () => {
    // A rate that charges but cannot be claimed: the tax belongs in the stock,
    // not in a rebate the NBR will never pay.
    const { rows } = await query(
      `INSERT INTO tax_rates (org_id, code, name, kind, rate, is_reclaimable)
       VALUES ($1, 'VATNC', 'VAT 15% not reclaimable', 'STANDARD', 15, false)
       ON CONFLICT (org_id, code) DO UPDATE SET is_reclaimable = false
       RETURNING id`,
      [orgId]
    );
    await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [
      Number(rows[0].id),
      context.productId,
    ]);

    const before = {
      inventory: await balanceOf(LEDGER.INVENTORY),
      inputVat: await balanceOf(LEDGER.INPUT_VAT),
    };
    await buy({ quantity: 10, rate: 1000 });

    expect(money((await balanceOf(LEDGER.INVENTORY)) - before.inventory)).toBe(11500);
    expect(await balanceOf(LEDGER.INPUT_VAT)).toBe(before.inputVat);
    expect(await ledgerDifference()).toBe(0);
  });

  /* ---------------------------------------------------------------- returns */

  it('gives the tax back with the goods', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await buy({ quantity: 10, rate: 1000 });
    const sale = await sell({ quantity: 10, rate: 1300 });

    const source = await request(app)
      .get(`/api/returnable/dealer_sales/${sale.id}`)
      .set(auth());
    const line = source.body.data.lines[0];

    const before = {
      outputVat: await balanceOf(LEDGER.OUTPUT_VAT),
      receivable: await balanceOf(LEDGER.RECEIVABLE),
    };

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sale.id,
        reason: 'Four bags returned unopened',
        lines: [{ sourceItemId: line.sourceItemId, quantity: 4 }],
        action: 'POST',
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    // A customer who paid VAT on goods they sent back gets the VAT back too,
    // and the business no longer owes it to the NBR.
    expect(money(res.body.data.tax)).toBe(780);
    expect(money(res.body.data.note.amount)).toBe(5980);
    expect(money((await balanceOf(LEDGER.OUTPUT_VAT)) - before.outputVat)).toBe(-780);
    expect(money((await balanceOf(LEDGER.RECEIVABLE)) - before.receivable)).toBe(-5980);
    expect(await ledgerDifference()).toBe(0);
  });

  it('credits at the rate the invoice charged, not at today s rate', async () => {
    const standard = await chargeProductAt(context.productId, 'VAT15');
    await buy({ quantity: 10, rate: 1000 });
    const sale = await sell({ quantity: 10, rate: 1000 });

    // The budget moves the standard rate after the invoice went out.
    await request(app).patch(`/api/tax-rates/${standard.id}`).set(auth()).send({ rate: 10 });

    const source = await request(app)
      .get(`/api/returnable/dealer_sales/${sale.id}`)
      .set(auth());
    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sale.id,
        reason: 'Returned after the rate changed',
        lines: [{ sourceItemId: source.body.data.lines[0].sourceItemId, quantity: 10 }],
        action: 'POST',
      });
    await request(app).patch(`/api/tax-rates/${standard.id}`).set(auth()).send({ rate: 15 });

    expect(res.status, JSON.stringify(res.body.error)).toBe(201);
    // 15% is what was charged, so 15% is what comes back. Crediting 10% would
    // leave the business owing the NBR tax it had already refunded.
    expect(money(res.body.data.tax)).toBe(1500);
  });

  it('leaves an invoice raised at the old rate saying what it said', async () => {
    const standard = rates.find((r) => r.code === 'VAT15');
    await chargeProductAt(context.productId, 'VAT15');
    await buy({ quantity: 10, rate: 1000 });
    const sale = await sell({ quantity: 5, rate: 1000 });

    await request(app).patch(`/api/tax-rates/${standard.id}`).set(auth()).send({ rate: 7.5 });
    const { rows } = await query(
      'SELECT tax_rate, tax_amount FROM dealer_sale_items WHERE sale_id = $1',
      [sale.id]
    );
    await request(app).patch(`/api/tax-rates/${standard.id}`).set(auth()).send({ rate: 15 });

    // The line keeps the percentage it charged. Reading the rate from the
    // master instead would restate every filed return.
    expect(money(rows[0].tax_rate)).toBe(15);
    expect(money(rows[0].tax_amount)).toBe(750);
  });

  /* ------------------------------------------------------------- the return */

  it('reports what is owed to the NBR as output less input', async () => {
    const res = await request(app).get('/api/reports/vat-return').set(auth());
    expect(res.status).toBe(200);

    const { outputTax, inputTax, netPayable } = res.body.data.totals;
    expect(outputTax).toBeGreaterThan(0);
    expect(inputTax).toBeGreaterThan(0);
    expect(money(netPayable)).toBe(money(outputTax - inputTax));
  });

  it('agrees with the accounts it was posted to', async () => {
    const res = await request(app).get('/api/reports/vat-return').set(auth());
    const { outputTax, inputTax } = res.body.data.totals;

    // The return reads the documents and the trial balance reads the journal.
    // If those two disagree, one of them is not what was filed -- and the
    // claim is only ever for tax that actually reached the input account,
    // never for tax that went into the cost of the goods.
    expect(money(outputTax)).toBe(await balanceOf(LEDGER.OUTPUT_VAT));
    expect(money(inputTax)).toBe(await balanceOf(LEDGER.INPUT_VAT));
  });

  it('does not claim back tax that was never reclaimable', async () => {
    const register = await request(app)
      .get('/api/reports/vat-purchase-register?pageSize=200')
      .set(auth());
    const paid = money(register.body.data.totals.tax);
    const claimable = money(register.body.data.totals.reclaimable);

    // A non-reclaimable purchase was posted above, so these must differ.
    expect(paid).toBeGreaterThan(claimable);

    const ret = await request(app).get('/api/reports/vat-return').set(auth());
    expect(money(ret.body.data.totals.inputTax)).toBe(claimable);
  });

  it('lists every supply made, with the buyer and their BIN', async () => {
    // The whole period in one page: the totals cover every row, and comparing
    // them against a single page of fifty would be comparing two things.
    const res = await request(app)
      .get('/api/reports/vat-sales-register?pageSize=200')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    const row = res.body.data.rows[0];
    expect(row.no).toBeTruthy();
    expect(row.party).toBeTruthy();
    // An unregistered buyer is ordinary in this trade and the register says so
    // rather than leaving the column blank.
    expect(row.bin).toBeTruthy();
    // The totals cover the period, not the page. Comparing them to whatever
    // fifty rows came back would be comparing two different questions, so the
    // register is checked against the view it reads.
    const { rows } = await query(
      'SELECT COALESCE(SUM(tax_amount), 0) AS tax FROM v_output_tax WHERE org_id = $1',
      [orgId]
    );
    expect(money(res.body.data.totals.tax)).toBe(money(rows[0].tax));
  });

  it('lists every input taken', async () => {
    const res = await request(app)
      .get('/api/reports/vat-purchase-register?pageSize=200')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    const { rows } = await query(
      `SELECT COALESCE(SUM(tax_amount), 0) AS tax,
              COALESCE(SUM(reclaimable_tax), 0) AS reclaimable
         FROM v_input_tax WHERE org_id = $1`,
      [orgId]
    );
    expect(money(res.body.data.totals.tax)).toBe(money(rows[0].tax));
    expect(money(res.body.data.totals.reclaimable)).toBe(money(rows[0].reclaimable));
  });

  it('refuses the VAT return to someone who may not see tax', async () => {
    const { rows } = await query(
      `SELECT u.username FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'Warehouse' LIMIT 1`
    );
    if (!rows.length) return;
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: rows[0].username, password: PASSWORD });
    if (login.status !== 200) return;

    const res = await request(app)
      .get('/api/reports/vat-return')
      .set({ authorization: `Bearer ${login.body.data.accessToken}` });
    expect(res.status).toBe(403);
  });

  /* ------------------------------------------------------- not registered */

  it('charges nothing at all while the business is unregistered', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await query('UPDATE organizations SET is_vat_registered = false WHERE id = $1', [orgId]);
    await buy({ quantity: 10, rate: 1000 });

    const before = await balanceOf(LEDGER.OUTPUT_VAT);
    const sale = await sell({ quantity: 5, rate: 1000 });
    await query('UPDATE organizations SET is_vat_registered = true WHERE id = $1', [orgId]);

    // The rates still exist; nothing charges at them. Every document reads
    // exactly as it did before VAT was modelled.
    expect(money(sale.totals.tax)).toBe(0);
    expect(money(sale.totals.total)).toBe(money(sale.totals.net));
    expect(await balanceOf(LEDGER.OUTPUT_VAT)).toBe(before);
  });
});

/** Numbers arrive from the database as strings, on purpose. */
const num = (n) => Number(n) || 0;
