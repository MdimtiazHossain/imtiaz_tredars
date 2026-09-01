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
/** How this side of the trade quotes its rates, for the length of one test. */
const setPricing = (inclusive, side = 'SALE') =>
  query(
    `UPDATE organizations
        SET ${side === 'SALE' ? 'sale_prices_include_tax' : 'purchase_prices_include_tax'} = $1
      WHERE id = $2`,
    [inclusive, orgId]
  );

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
        WHERE r.code = 'Admin' AND u.is_active ORDER BY u.id LIMIT 1`
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
      `UPDATE organizations SET is_vat_registered = true,
              sale_prices_include_tax = false, purchase_prices_include_tax = false
        WHERE id = $1`,
      [orgId]
    );
  });

  afterAll(async () => {
    // First and unconditionally: every other suite in the run assumes an
    // unregistered business, and a registered one silently adds 15% to
    // everything they post.
    try {
      await query(
        `UPDATE organizations SET is_vat_registered = false,
                sale_prices_include_tax = false, purchase_prices_include_tax = false
          WHERE id = $1`,
        [orgId]
      );
      if (context?.productId) {
        await query('UPDATE products SET tax_rate_id = NULL WHERE id = $1', [context.productId]);
      }
    } finally {
      await closePool();
    }
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

  it('gives a credit only where a credit is actually given', async () => {
    const by = (code) => rates.find((r) => r.code === code);

    // The standard rate carries its input credit, and so does zero-rating --
    // that is the whole difference between zero-rating an export and exempting
    // a supply, and an exporter who lost it would be out of pocket.
    expect(by('VAT15').isReclaimable).toBe(true);
    expect(by('ZERO').isReclaimable).toBe(true);

    // The truncated rates do not. Charging less than 15% is the settlement,
    // and the credit is what is given up for it; claiming both is claiming
    // twice, and the return would ask the NBR for money it does not owe.
    for (const code of ['VAT10', 'VAT7.5', 'VAT5']) {
      expect(by(code).isReclaimable, code).toBe(false);
    }

    // An exempt supply never had any to give.
    expect(by('EXEMPT').isReclaimable).toBe(false);
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

  it('previews what posting would actually charge', async () => {
    await chargeProductAt(context.productId, 'VAT15');

    const preview = await request(app)
      .post('/api/dealer/sales/preview')
      .set(auth())
      .send({
        txnDate: today(),
        customerId: context.customerId,
        warehouseId: context.warehouseId,
        lines: [{ productId: context.productId, quantity: 10, rate: 1000, discountPct: 0 }],
      });
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200);

    await buy({ quantity: 10, rate: 800 });
    const posted = await sell({ quantity: 10, rate: 1000 });

    // A preview exists to say what a document will come to. One that leaves
    // the VAT off says a number nobody will ever be invoiced.
    expect(money(preview.body.data.net)).toBe(money(posted.totals.net));
    expect(money(preview.body.data.tax)).toBe(money(posted.totals.tax));
    expect(money(preview.body.data.total)).toBe(money(posted.totals.total));
  });

  it('previews a purchase the same way', async () => {
    await chargeProductAt(context.productId, 'VAT15');

    const preview = await request(app)
      .post('/api/dealer/purchases/preview')
      .set(auth())
      .send({
        txnDate: today(),
        companyId: context.companyId,
        warehouseId: context.warehouseId,
        lines: [{ productId: context.productId, quantity: 10, rate: 900, discountPct: 0 }],
      });
    const posted = await buy({ quantity: 10, rate: 900 });

    expect(money(preview.body.data.tax)).toBe(money(posted.totals.tax));
    expect(money(preview.body.data.total)).toBe(money(posted.totals.total));
  });

  it('does not hand the rate table back with a preview', async () => {
    const preview = await request(app)
      .post('/api/dealer/sales/preview')
      .set(auth())
      .send({
        txnDate: today(),
        customerId: context.customerId,
        warehouseId: context.warehouseId,
        lines: [{ productId: context.productId, quantity: 1, rate: 100, discountPct: 0 }],
      });
    // The tax context is loaded to work the figures out; it carries every rate
    // the organisation holds and has no business riding along in the answer.
    expect(preview.body.data).not.toHaveProperty('context');
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

  it('quotes each side of the trade the way that side is quoted', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    // Sells at a price the tax is already inside; buys at a price before it.
    await setPricing(true, 'SALE');
    await setPricing(false, 'PURCHASE');

    const sale = await request(app)
      .post('/api/dealer/sales/preview')
      .set(auth())
      .send({
        txnDate: today(),
        customerId: context.customerId,
        warehouseId: context.warehouseId,
        lines: [{ productId: context.productId, quantity: 1, rate: 1150, discountPct: 0 }],
      });
    const purchase = await request(app)
      .post('/api/dealer/purchases/preview')
      .set(auth())
      .send({
        txnDate: today(),
        companyId: context.companyId,
        warehouseId: context.warehouseId,
        lines: [{ productId: context.productId, quantity: 1, rate: 1000, discountPct: 0 }],
      });

    await setPricing(false, 'SALE');

    // The customer pays the 1,150 they were quoted; the principal is owed
    // their 1,000 plus the VAT their challanpatra adds.
    expect(money(sale.body.data.net)).toBe(1000);
    expect(money(sale.body.data.total)).toBe(1150);
    expect(money(purchase.body.data.net)).toBe(1000);
    expect(money(purchase.body.data.total)).toBe(1150);
  });

  it('one side does not move when the other is changed', async () => {
    await chargeProductAt(context.productId, 'VAT15');
    await setPricing(false, 'SALE');
    await setPricing(false, 'PURCHASE');

    const quote = (path, body) =>
      request(app)
        .post(path)
        .set(auth())
        .send({ txnDate: today(), warehouseId: context.warehouseId, ...body });

    const purchaseBefore = await quote('/api/dealer/purchases/preview', {
      companyId: context.companyId,
      lines: [{ productId: context.productId, quantity: 1, rate: 1000, discountPct: 0 }],
    });

    await setPricing(true, 'SALE');
    const purchaseAfter = await quote('/api/dealer/purchases/preview', {
      companyId: context.companyId,
      lines: [{ productId: context.productId, quantity: 1, rate: 1000, discountPct: 0 }],
    });
    await setPricing(false, 'SALE');

    // Under one flag this was unresolvable: setting it for sales read every
    // supplier invoice as cheaper than it was.
    expect(money(purchaseAfter.body.data.total)).toBe(money(purchaseBefore.body.data.total));
    expect(money(purchaseAfter.body.data.total)).toBe(1150);
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
    const { outputTax, inputTaxBeforeApportionment } = res.body.data.totals;

    // The return reads the documents and the trial balance reads the journal.
    // If those two disagree, one of them is not what was filed -- and the
    // claim is only ever for tax that actually reached the input account,
    // never for tax that went into the cost of the goods.
    expect(money(outputTax)).toBe(await balanceOf(LEDGER.OUTPUT_VAT));

    // Apportionment is the one thing that legitimately separates them, and
    // only until it is journalled: input tax is posted in full as it arrives,
    // because what share of it was earned is not knowable until the period's
    // sales are in. Whatever has been adjusted is out of the account.
    const { rows } = await query(
      'SELECT COALESCE(SUM(disallowed), 0) AS d FROM tax_apportionments WHERE org_id = $1',
      [orgId]
    );
    const journalled = money(num(rows[0].d));
    expect(money(inputTaxBeforeApportionment - journalled)).toBe(
      await balanceOf(LEDGER.INPUT_VAT)
    );
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
    // Before apportionment narrows it further: this test is about the rate's
    // own credit, and the two narrowings are separate questions.
    expect(money(ret.body.data.totals.inputTaxBeforeApportionment)).toBe(claimable);
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
        WHERE r.code = 'Warehouse' AND u.is_active ORDER BY u.id LIMIT 1`
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

    // Registration is org-wide and the suites share the database, so it goes
    // back on the way out whatever happens in between. A buy that runs out of
    // stock used to leave the flag as this test set it, and every suite that
    // ran afterwards was reading a different business from the one it meant.
    let before;
    let sale;
    try {
      await buy({ quantity: 10, rate: 1000 });
      before = await balanceOf(LEDGER.OUTPUT_VAT);
      sale = await sell({ quantity: 5, rate: 1000 });
    } finally {
      await query('UPDATE organizations SET is_vat_registered = true WHERE id = $1', [orgId]);
    }

    // The rates still exist; nothing charges at them. Every document reads
    // exactly as it did before VAT was modelled.
    expect(money(sale.totals.tax)).toBe(0);
    expect(money(sale.totals.total)).toBe(money(sale.totals.net));
    expect(await balanceOf(LEDGER.OUTPUT_VAT)).toBe(before);
  });

  /* ------------------------------------------------ input tax apportionment */

  describe('claiming input tax in the proportion it was earned', () => {
    /**
     * A credit is earned by making supplies inside the VAT chain. This
     * business makes both kinds -- dealer goods at the standard rate, crop
     * produce exempt -- so only part of what it pays on its inputs was ever
     * its to claim, whatever rate it paid at.
     *
     * The rate test and this one are separate narrowings and both apply: a
     * truncated-rate purchase never enters the pool at all, and what is left
     * is then apportioned by what the period actually supplied.
     */
    const apportion = (period) =>
      request(app).get('/api/tax/apportionment').query(period).set(auth());

    const vatReturn = (period) =>
      request(app).get('/api/reports/vat-return').query(period || {}).set(auth());

    it('measures the share on value, not on tax', async () => {
      const period = { from: today(), to: today() };
      const before = (await apportion(period)).body.data;

      // An exempt supply charges no tax at all. On a ratio built from tax it
      // would weigh nothing and the claim would come out whole, which is the
      // opposite of what an exempt supply should do to it.
      const exempt = rates.find((r) => r.code === 'EXEMPT');
      await chargeProductAt(context.productId, 'VAT15');
      await buy({ quantity: 200, rate: 100 });
      await sell({ quantity: 40, rate: 100 });

      await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [
        exempt.id,
        context.productId,
      ]);
      await sell({ quantity: 60, rate: 100 });

      const after = (await apportion(period)).body.data;
      // 4,000 of standard supply and 6,000 of exempt: the total grows by all
      // 10,000 and the creditable part by only the 4,000.
      expect(money(after.totalSupplies - before.totalSupplies)).toBe(10000);
      expect(money(after.creditableSupplies - before.creditableSupplies)).toBe(4000);
      expect(after.ratio).toBeLessThan(1);
    });

    it('claims that share of the input tax and disallows the rest', async () => {
      const worked = (await apportion({ from: today(), to: today() })).body.data;

      expect(money(worked.claimable + worked.disallowed)).toBe(money(worked.inputTax));
      for (const line of worked.lines) {
        expect(money(line.claimable), line.businessType).toBe(
          money(line.inputTax * line.ratio)
        );
        if (line.totalSupplies > 0) {
          expect(line.ratio, line.businessType).toBeCloseTo(
            line.creditableSupplies / line.totalSupplies,
            9
          );
        } else {
          // Nothing supplied is not the same as nothing creditable.
          expect(line.ratio, line.businessType).toBe(1);
        }
      }
      expect(worked.ratio).toBeCloseTo(worked.claimable / worked.inputTax, 9);
    });

    it('attributes each line input tax to that line own supplies', async () => {
      const period = { from: today(), to: today() };
      const worked = (await apportion(period)).body.data;

      // The crop side sells exempt produce and buys it from farmers, which is
      // exempt too, so it pays almost no input tax while being much the larger
      // part of turnover. The dealer side pays the input tax and sells at the
      // standard rate. One ratio across the whole business would disallow most
      // of a claim that was wholly and properly attributable to taxable
      // supply, so each line is measured against what it itself supplied.
      const { rows } = await query(
        `SELECT business_type,
                COALESCE(SUM(taxable_value), 0)    AS total,
                COALESCE(SUM(creditable_value), 0) AS creditable
           FROM v_output_tax
          WHERE org_id = $1 AND txn_date >= $2 AND txn_date <= $3
          GROUP BY business_type`,
        [orgId, period.from, period.to]
      );

      for (const row of rows) {
        const line = worked.lines.find((l) => l.businessType === row.business_type);
        if (!line) continue;
        expect(money(line.totalSupplies), row.business_type).toBe(money(num(row.total)));
        expect(money(line.creditableSupplies), row.business_type).toBe(
          money(num(row.creditable))
        );
      }

      // And the whole is the sum of the parts rather than a figure of its own.
      expect(money(worked.inputTax)).toBe(
        money(worked.lines.reduce((t, l) => t + l.inputTax, 0))
      );
      expect(money(worked.claimable)).toBe(
        money(worked.lines.reduce((t, l) => t + l.claimable, 0))
      );
    });

    it('shows what was withheld on the return, and why', async () => {
      const period = { from: today(), to: today() };
      const res = await vatReturn(period);
      const worked = (await apportion(period)).body.data;

      const withheld = res.body.data.rows.find((r) => r.line.startsWith('Less: not claimable'));
      expect(withheld, 'the return should say what it withheld').toBeTruthy();
      expect(money(withheld.tax)).toBe(money(worked.disallowed));
      // Named by the reason rather than left as a bare adjustment.
      expect(withheld.line).toContain('exempt');
      expect(res.body.data.totals.netPayable).toBe(
        money(res.body.data.totals.outputTax - worked.claimable)
      );
    });

    it('answers for every posted period when no dates are given', async () => {
      // The VAT return has no dates until somebody sets them, and the panel
      // that explains it must be able to mean the same thing by that. It
      // reports, but says the figures cannot be journalled: an adjustment
      // belongs to the period it adjusts.
      const res = await request(app).get('/api/tax/apportionment').set(auth());
      expect(res.status).toBe(200);

      const worked = res.body.data;
      expect(worked.from).toBeNull();
      expect(worked.to).toBeNull();
      expect(worked.journallable).toBe(false);
      expect(worked.posted).toBe(false);
      expect(worked.inputTax).toBeGreaterThan(0);
    });

    it('says a stated period could be journalled', async () => {
      const res = await request(app)
        .get('/api/tax/apportionment')
        .query({ from: today(), to: today() })
        .set(auth());

      expect(res.body.data.journallable).toBe(true);
    });

    it('still refuses to journal without a period', async () => {
      const res = await request(app).post('/api/tax/apportionment').set(auth()).send({});
      // Reading is open-ended; writing is not, and the schema is what says so.
      expect(res.status).toBe(400);
    });

    it('claims in full when every supply earned its credit', async () => {
      // A period the business had not started trading in. No supplies means no
      // ratio to be measured by, and withholding the whole claim on that basis
      // would be arbitrary rather than cautious.
      const worked = (await apportion({ from: '2019-01-01', to: '2019-01-31' })).body.data;
      expect(worked.totalSupplies).toBe(0);
      expect(worked.ratio).toBe(1);
      expect(worked.disallowed).toBe(0);
    });

    /* ------------------------------------------------- journalling the share */

    it('records the period and journals nothing when nothing was withheld', async () => {
      const period = { from: '2019-02-01', to: '2019-02-28' };
      const before = await balanceOf(LEDGER.IRRECOVERABLE_VAT);

      const res = await request(app).post('/api/tax/apportionment').set(auth()).send(period);
      // A quiet period still gets a record, because the record is what says the
      // period was dealt with rather than forgotten.
      if (res.status === 201) {
        expect(res.body.data.disallowed).toBe(0);
        expect(await balanceOf(LEDGER.IRRECOVERABLE_VAT)).toBe(before);
      } else {
        expect(res.body.error.code).toBe('ALREADY_APPORTIONED');
      }

      const { rows } = await query(
        'SELECT id FROM tax_apportionments WHERE org_id = $1 AND period_from = $2',
        [orgId, period.from]
      );
      expect(rows).toHaveLength(1);
    });

    it('adjusts a period once and refuses to do it twice', async () => {
      const period = { from: '2019-03-01', to: '2019-03-31' };
      await request(app).post('/api/tax/apportionment').set(auth()).send(period);

      const again = await request(app).post('/api/tax/apportionment').set(auth()).send(period);
      // Posting it twice would journal the same adjustment twice, and the
      // ledger cannot take an entry back.
      expect(again.status).toBe(422);
      expect(again.body.error.code).toBe('ALREADY_APPORTIONED');
    });

    /**
     * A period with something actually withheld, journalled for real.
     *
     * Every other journalling test here adjusts an empty period, where the
     * disallowed amount is nil and no entry is written at all. They pass
     * without the posting path ever running -- which is how a journal that
     * named a business type the enum does not have reached a browser before
     * it reached a test.
     */
    describe('journalling a period that actually withheld something', () => {
      /**
       * A day nobody has adjusted yet, claimed at run time.
       *
       * A period can be adjusted once, so a fixed one is only ever journalled
       * by the first run against a given database; every run after it reads
       * 422 and falls to asserting the first run's work. That is exactly how
       * strong this test looked while the posting path was broken -- it
       * passed against entries an earlier, working run had written.
       *
       * So it takes a day of its own, posts the documents that make the ratio
       * into that day, and journals it for real. Every run exercises the
       * path; none of them collide.
       */
      let period;
      let on;

      beforeAll(async () => {
        const { rows: used } = await query(
          'SELECT period_from FROM tax_apportionments WHERE org_id = $1',
          [orgId]
        );
        const taken = new Set(used.map((r) => String(r.period_from).slice(0, 10)));

        const pad = (n) => String(n).padStart(2, '0');
        const candidates = [];
        // Inside the fiscal year, so the document endpoints accept it, and
        // clear of the months the seed trades in. The seed deliberately buys
        // in one month and sells in the next, and another suite checks that a
        // purchase-only month still reaches the dashboard; a sale posted into
        // that month by this fixture would quietly delete the case it tests.
        for (const [year, month] of [[2026, 10], [2026, 11], [2026, 12], [2027, 1], [2027, 2]]) {
          for (let day = 1; day <= 28; day += 1) {
            candidates.push(`${year}-${pad(month)}-${pad(day)}`);
          }
        }
        on = candidates.find((d) => !taken.has(d));
        expect(
          on,
          'no unadjusted day left in the fiscal year -- reset the test database'
        ).toBeTruthy();
        period = { from: on, to: on };

        // A product of this fixture's own, bought and then sold entirely, so
        // every run ends holding none of it and the shared stock valuation is
        // exactly where it started. Using a seeded product left units behind
        // each time until an exact-equality assertion elsewhere drifted a taka.
        const standard = rates.find((r) => r.code === 'VAT15');
        const { rows: made } = await query(
          `INSERT INTO products (org_id, code, name, unit_id, purchase_rate, sale_rate, tax_rate_id)
           SELECT $1, 'TEST-APPORTION', 'Apportionment fixture', u.id, 100, 150, $2
             -- Units are global and have no org_id. Asking for one errored the
             -- whole file, which took its afterAll with it and left the
             -- organisation registered for every suite that ran after it: four
             -- failures across three files, none of them about tax.
             FROM units u WHERE u.code = 'Kg' LIMIT 1
           ON CONFLICT (org_id, code) DO UPDATE SET is_active = true, tax_rate_id = $2
           RETURNING id`,
          [orgId, standard.id]
        );
        const productId = Number(made[0].id);

        // Bought at the standard rate: input tax, and a credit to lose.
        await postDocument(app, auth, '/api/dealer/purchases', {
          txnDate: on,
          companyId: context.companyId,
          warehouseId: context.warehouseId,
          lines: [{ productId, quantity: 200, rate: 100, discountPct: 0 }],
          action: 'POST',
        });

        // Sold exempt, and all of it: the supply earns no credit, so the tax
        // above was not earned either.
        const exempt = rates.find((r) => r.code === 'EXEMPT');
        await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [exempt.id, productId]);
        await postDocument(app, auth, '/api/dealer/sales', {
          txnDate: on,
          customerId: context.customerId,
          warehouseId: context.warehouseId,
          paidAmount: 0,
          lines: [{ productId, quantity: 200, rate: 150, discountPct: 0 }],
          action: 'POST',
        });
      });

      it('takes the withheld tax out of the receivable and into cost', async () => {
        const worked = (
          await request(app).get('/api/tax/apportionment').query(period).set(auth())
        ).body.data;
        expect(worked.disallowed).toBeGreaterThan(0);

        const before = {
          irrecoverable: await balanceOf(LEDGER.IRRECOVERABLE_VAT),
          inputVat: await balanceOf(LEDGER.INPUT_VAT),
        };

        const res = await request(app).post('/api/tax/apportionment').set(auth()).send(period);
        // The period was claimed unadjusted, so this must actually journal.
        // Accepting 422 here is what hid a posting path that threw on every
        // run but the first.
        expect(res.status, JSON.stringify(res.body.error)).toBe(201);
        expect(res.body.data.disallowed).toBe(worked.disallowed);
        expect(await balanceOf(LEDGER.IRRECOVERABLE_VAT)).toBe(
          money(before.irrecoverable + worked.disallowed)
        );
        expect(await balanceOf(LEDGER.INPUT_VAT)).toBe(
          money(before.inputVat - worked.disallowed)
        );

        const { rows: recorded } = await query(
          `SELECT id, disallowed FROM tax_apportionments
            WHERE org_id = $1 AND period_from = $2 AND period_to = $3`,
          [orgId, period.from, period.to]
        );
        expect(recorded).toHaveLength(1);
        expect(num(recorded[0].disallowed)).toBeGreaterThan(0);

        // The entries exist, name a real business line, and balance. This is
        // the assertion the empty-period tests could never make.
        const { rows: entries } = await query(
          `SELECT business_type, SUM(debit) AS debit, SUM(credit) AS credit
             FROM ledger_entries
            WHERE org_id = $1 AND reference_type = 'tax_apportionments'
              AND reference_id = $2
            GROUP BY business_type`,
          [orgId, recorded[0].id]
        );
        expect(entries.length).toBeGreaterThan(0);
        for (const row of entries) {
          expect(['DEALER', 'BULK_CROP']).toContain(row.business_type);
        }
        const debit = entries.reduce((s, r) => s + num(r.debit), 0);
        const credit = entries.reduce((s, r) => s + num(r.credit), 0);
        expect(money(debit)).toBe(money(credit));
        expect(money(debit)).toBe(money(num(recorded[0].disallowed)));
        expect(await ledgerDifference()).toBe(0);
      });

      it('charges it to the line whose inputs it was', async () => {
        const { rows } = await query(
          `SELECT DISTINCT e.business_type
             FROM ledger_entries e
             JOIN tax_apportionments a ON a.id = e.reference_id
            WHERE e.org_id = $1 AND e.reference_type = 'tax_apportionments'
              AND a.period_from = $2`,
          [orgId, period.from]
        );

        // The tax was paid buying dealer stock, so the cost belongs to the
        // dealer line. Charging it against both would move profit from a line
        // that never incurred it.
        expect(rows.map((r) => r.business_type)).toEqual(['DEALER']);
      });
    });

    it('will not let a role without the permission journal it', async () => {
      const { rows } = await query(
        `SELECT u.username FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE r.code = 'Sales' AND u.is_active ORDER BY u.id LIMIT 1`
      );
      if (!rows.length) return;
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: rows[0].username, password: PASSWORD });
      const salesToken = login.body.data && login.body.data.accessToken;
      if (!salesToken) return;

      // Sales raises invoices; filing the return is the Accounts desk's job,
      // and this posts to the ledger.
      const res = await request(app)
        .post('/api/tax/apportionment')
        .set({ authorization: `Bearer ${salesToken}` })
        .send({ from: '2019-04-01', to: '2019-04-30' });
      expect(res.status).toBe(403);
    });

    it('takes the disallowed tax out of the receivable and into cost', async () => {
      const period = { from: '2019-05-01', to: '2019-05-31' };
      // Nothing was traded then, so this asserts the shape of the posting
      // rather than a figure that moves with the seed.
      const res = await request(app).post('/api/tax/apportionment').set(auth()).send(period);
      if (res.status !== 201) return;

      const { rows } = await query(
        `SELECT COUNT(*) AS n FROM ledger_entries
          WHERE org_id = $1 AND reference_type = 'tax_apportionments'
            AND reference_id = $2`,
        [orgId, res.body.data.id]
      );
      // No disallowed tax, no journal: an entry pair for nothing would be
      // noise in the ledger for every quiet month.
      expect(Number(rows[0].n)).toBe(0);
      expect(await ledgerDifference()).toBe(0);
    });
  });

  /* ------------------------------------- the sales side, at a truncated rate */

  describe('the sales register when a rate carries no credit', () => {
    /**
     * Reclaimability is a question about tax paid, not tax charged. A supply
     * at a truncated rate is charged at 10% instead of 15% and every taka of
     * it is owed to the NBR just the same -- the rate is lower, the liability
     * is not partial. So the sales side must ignore the flag entirely, and
     * narrowing what a purchase return gives back must not have narrowed what
     * a sale return credits.
     */
    const report = (id, filters = {}) =>
      request(app)
        .get(`/api/reports/${id}`)
        .query({ from: today(), to: today(), pageSize: 200, ...filters })
        .set(auth());

    const outputLine = async () =>
      (await report('vat-return')).body.data.rows
        .find((r) => r.line.startsWith('Output tax')).tax;

    let truncated;

    beforeAll(async () => {
      const { rows } = await query(
        `INSERT INTO tax_rates (org_id, code, name, kind, rate, is_reclaimable, is_default, is_active)
         VALUES ($1, 'TRUNC-SALE', 'Truncated on sales', 'REDUCED', 10.0, false, false, true)
         ON CONFLICT (org_id, code) DO UPDATE SET is_active = true, is_reclaimable = false
         RETURNING id`,
        [orgId]
      );
      truncated = Number(rows[0].id);
      await setPricing(false, 'SALE');
      await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [
        truncated,
        context.productId,
      ]);
      // The suites share a database and every run sells some of it, so this
      // one puts back more than it takes rather than depending on what an
      // earlier run happened to leave.
      await buy({ quantity: 400, rate: 80 });
    });

    afterAll(async () => {
      await query('UPDATE products SET tax_rate_id = NULL WHERE id = $1', [context.productId]);
      if (truncated) await query('UPDATE tax_rates SET is_active = false WHERE id = $1', [truncated]);
    });

    it('charges the truncated rate and owes every taka of it', async () => {
      const before = (await report('vat-sales-register')).body.data.totals;
      const outputBefore = await outputLine();

      await sell({ quantity: 100, rate: 100 });

      const register = (await report('vat-sales-register')).body.data;
      // 10,000 of goods at 10%. The rate is lower than the standard one; the
      // liability is not partial.
      expect(money(register.totals.taxableValue - before.taxableValue)).toBe(10000);
      expect(money(register.totals.tax - before.tax)).toBe(1000);

      // And the return owes the whole of it. Nothing here reads the credit
      // flag, because there is no credit to read on a supply made.
      expect(money((await outputLine()) - outputBefore)).toBe(1000);
    });

    it('has no reclaimable column to confuse it with', async () => {
      const register = (await report('vat-sales-register')).body.data;
      // A Mushak 6.2 lists what was charged. Reclaimability belongs to the
      // 6.1, and a column here would invite the two to be read as a pair.
      expect(register.columns.map((c) => c.key)).not.toContain('reclaimable');
      expect(register.totals.reclaimable).toBeUndefined();
    });

    it('credits the whole of it back when the sale is returned', async () => {
      const sale = await sell({ quantity: 50, rate: 100 });
      const returnable = (
        await request(app).get(`/api/returnable/dealer_sales/${sale.id}`).set(auth())
      ).body.data;
      const outputBefore = await outputLine();

      const res = await request(app)
        .post('/api/returns')
        .set(auth())
        .send({
          txnDate: today(),
          sourceType: 'dealer_sales',
          sourceId: sale.id,
          reason: 'Customer cancelled the order',
          lines: [{ sourceItemId: returnable.lines[0].sourceItemId, quantity: 50 }],
          action: 'POST',
        });
      expect(res.status, JSON.stringify(res.body.error)).toBe(201);

      // 5,000 at 10% was charged and is no longer owed, so the whole 500 comes
      // off. Narrowing what a purchase return claims must not touch this: the
      // business collected this tax and is handing it back.
      expect(money((await outputLine()) - outputBefore)).toBe(-500);
    });

    it('leaves the sales register and the output account agreeing', async () => {
      const totals = (await request(app).get('/api/reports/vat-return').set(auth())).body.data
        .totals;
      // The whole period, not just today: the register reads the documents and
      // the trial balance reads the journal, and a truncated rate must not be
      // the thing that makes them differ.
      expect(money(totals.outputTax)).toBe(await balanceOf(LEDGER.OUTPUT_VAT));
    });
  });

  /* --------------------------------------- the return, at a truncated rate */

  describe('the VAT return when a rate carries no credit', () => {
    /**
     * A truncated rate is charged and paid like any other, so it belongs on
     * the purchase register -- a Mushak 6.1 lists what was paid. It is not a
     * rebate, so it must not reach the return. The two reports read the same
     * view and have to disagree about this one column on purpose.
     */
    const report = (id, filters = {}) =>
      request(app)
        .get(`/api/reports/${id}`)
        .query({ from: today(), to: today(), ...filters })
        .set(auth());

    let truncated;

    beforeAll(async () => {
      const { rows } = await query(
        `INSERT INTO tax_rates (org_id, code, name, kind, rate, is_reclaimable, is_default, is_active)
         VALUES ($1, 'TRUNC-RPT', 'Truncated for the report', 'REDUCED', 10.0, false, false, true)
         ON CONFLICT (org_id, code) DO UPDATE SET is_active = true, is_reclaimable = false
         RETURNING id`,
        [orgId]
      );
      truncated = Number(rows[0].id);
    });

    afterAll(async () => {
      await query('UPDATE products SET tax_rate_id = NULL WHERE id = $1', [context.productId]);
      if (truncated) await query('UPDATE tax_rates SET is_active = false WHERE id = $1', [truncated]);
    });

    it('lists what was paid on the register and claims none of it', async () => {
      await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [
        truncated,
        context.productId,
      ]);

      const before = (await report('vat-purchase-register')).body.data.totals;
      const beforeReturn = (await report('vat-return')).body.data.rows;
      const inputBefore = beforeReturn.find((r) => r.line.startsWith('Input tax')).tax;

      await buy({ quantity: 100, rate: 100 });

      const register = (await report('vat-purchase-register')).body.data;
      const paid = money(register.totals.tax - before.tax);
      const claimed = money(register.totals.reclaimable - before.reclaimable);

      // 10,000 of goods at 10% was paid, and none of it may be claimed.
      expect(paid).toBe(1000);
      expect(claimed).toBe(0);

      // The return therefore does not move. What was paid went into the cost
      // of the goods; asking the NBR for it would be asking twice.
      const after = (await report('vat-return')).body.data.rows;
      expect(money(after.find((r) => r.line.startsWith('Input tax')).tax)).toBe(
        money(inputBefore)
      );
    });

    it('gives back no rebate on returning goods that never earned one', async () => {
      await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [
        truncated,
        context.productId,
      ]);

      const purchase = await buy({ quantity: 50, rate: 100 });
      const returnable = (
        await request(app).get(`/api/returnable/dealer_purchases/${purchase.id}`).set(auth())
      ).body.data;

      const inputBefore = (await report('vat-return')).body.data.rows
        .find((r) => r.line.startsWith('Input tax')).tax;

      const res = await request(app)
        .post('/api/returns')
        .set(auth())
        .send({
          txnDate: today(),
          sourceType: 'dealer_purchases',
          sourceId: purchase.id,
          reason: 'Short-dated stock sent back',
          lines: [{ sourceItemId: returnable.lines[0].sourceItemId, quantity: 50 }],
          action: 'POST',
        });
      expect(res.status, JSON.stringify(res.body.error)).toBe(201);

      // Sending the goods back gives back the tax that was claimed on them,
      // and nothing was. A return that credits the whole 500 would make the
      // period's input tax negative by tax the business never reclaimed.
      const inputAfter = (await report('vat-return')).body.data.rows
        .find((r) => r.line.startsWith('Input tax')).tax;
      expect(money(inputAfter)).toBe(money(inputBefore));
    });

    it('still gives back the whole rebate when the rate carried one', async () => {
      const standard = rates.find((r) => r.code === 'VAT15');
      await query('UPDATE products SET tax_rate_id = $1 WHERE id = $2', [
        standard.id,
        context.productId,
      ]);

      const purchase = await buy({ quantity: 50, rate: 100 });
      const returnable = (
        await request(app).get(`/api/returnable/dealer_purchases/${purchase.id}`).set(auth())
      ).body.data;

      const inputBefore = (await report('vat-return')).body.data.rows
        .find((r) => r.line.startsWith('Input tax')).tax;

      const res = await request(app)
        .post('/api/returns')
        .set(auth())
        .send({
          txnDate: today(),
          sourceType: 'dealer_purchases',
          sourceId: purchase.id,
          reason: 'Wrong pack size delivered',
          lines: [{ sourceItemId: returnable.lines[0].sourceItemId, quantity: 50 }],
          action: 'POST',
        });
      expect(res.status, JSON.stringify(res.body.error)).toBe(201);

      // 5,000 of goods at 15% was claimed, so sending all of it back gives the
      // whole 750 up again. Narrowing what a return credits must not narrow
      // this one.
      const inputAfter = (await report('vat-return')).body.data.rows
        .find((r) => r.line.startsWith('Input tax')).tax;
      expect(money(inputAfter - inputBefore)).toBe(750);
    });
  });

  /* ------------------------------------------- tax that cannot be claimed */

  describe('input tax the business cannot claim back', () => {
    /**
     * Every rate this system ships with is reclaimable, so this path has no
     * seeded example -- but a truncated-rate supply is common enough in
     * Bangladesh that the machinery has to be right before somebody ticks the
     * box in Settings.
     *
     * Where the tax cannot be claimed it is not a receivable from the NBR, it
     * is part of what the goods cost. It has to reach the batch and not only
     * the journal, because the batch is what a sale later charges its cost
     * against and what the inventory account is supposed to be the sum of.
     */
    let rateId;
    let cropId;
    let previousCropRate;
    let fixtures;

    beforeAll(async () => {
      // Upserted, and retired rather than deleted at the end: once a purchase
      // has been posted at this rate the documents refer to it, and a rate a
      // document was raised under is not something to remove.
      const { rows: rateRows } = await query(
        `INSERT INTO tax_rates (org_id, code, name, kind, rate, is_reclaimable, is_default, is_active)
         VALUES ($1, 'TRUNC-TEST', 'Truncated, no credit', 'REDUCED', 15.0, false, false, true)
         ON CONFLICT (org_id, code) DO UPDATE SET is_active = true, is_reclaimable = false
         RETURNING id`,
        [orgId]
      );
      rateId = Number(rateRows[0].id);

      const { rows: cropRows } = await query(
        'SELECT id, tax_rate_id, default_unit_id FROM crops WHERE org_id = $1 ORDER BY id LIMIT 1',
        [orgId]
      );
      cropId = Number(cropRows[0].id);
      previousCropRate = cropRows[0].tax_rate_id;
      await query('UPDATE crops SET tax_rate_id = $1 WHERE id = $2', [rateId, cropId]);

      const { rows: supplierRows } = await query(
        'SELECT id FROM suppliers WHERE org_id = $1 ORDER BY id LIMIT 1',
        [orgId]
      );
      fixtures = {
        supplierId: Number(supplierRows[0].id),
        unitId: Number(cropRows[0].default_unit_id),
      };
    });

    afterAll(async () => {
      // Guarded: if this describe's beforeAll failed there is nothing to put
      // back, and throwing here would skip the outer restore that switches
      // registration off for every other suite.
      if (cropId) {
        await query('UPDATE crops SET tax_rate_id = $1 WHERE id = $2', [previousCropRate, cropId]);
      }
      if (rateId) await query('UPDATE tax_rates SET is_active = false WHERE id = $1', [rateId]);
    });

    it('puts it on the batch rather than in a rebate that will never be paid', async () => {
      const before = {
        inventory: await balanceOf(LEDGER.INVENTORY),
        inputVat: await balanceOf(LEDGER.INPUT_VAT),
      };

      const purchase = await postDocument(app, auth, '/api/crops/purchases', {
        txnDate: today(),
        supplierId: fixtures.supplierId,
        warehouseId: context.warehouseId,
        lines: [
          { cropId, unitId: fixtures.unitId, grossQuantity: 10, moisturePct: 0, rate: 1000 },
        ],
        action: 'POST',
      });
      expect(purchase.status).toBe('POSTED');

      const purchaseId = purchase.id;
      const { rows: batches } = await query(
        `SELECT b.quantity_received, b.cost_per_unit
           FROM crop_batches b
           JOIN crop_purchase_items i ON i.id = b.purchase_item_id
          WHERE i.purchase_id = $1`,
        [purchaseId]
      );

      // 10,000 of crop carrying 1,500 it cannot claim back is 11,500 of stock.
      expect(batches).toHaveLength(1);
      expect(money(batches[0].cost_per_unit)).toBe(1150);

      // And the account agrees with the batch it is the sum of. Debiting the
      // inventory 11,500 while valuing the batch at 10,000 would leave 1,500
      // stranded there for good: never claimed from the NBR, never charged to
      // cost when the crop is sold.
      expect(money((await balanceOf(LEDGER.INVENTORY)) - before.inventory)).toBe(11500);
      expect(money((await balanceOf(LEDGER.INPUT_VAT)) - before.inputVat)).toBe(0);
      expect(await ledgerDifference()).toBe(0);
    });

    it('still claims back a rate that can be claimed back', async () => {
      const reclaimable = rates.find((r) => r.code === 'VAT15');
      await query('UPDATE crops SET tax_rate_id = $1 WHERE id = $2', [reclaimable.id, cropId]);
      const before = {
        inventory: await balanceOf(LEDGER.INVENTORY),
        inputVat: await balanceOf(LEDGER.INPUT_VAT),
      };

      const purchase = await postDocument(app, auth, '/api/crops/purchases', {
        txnDate: today(),
        supplierId: fixtures.supplierId,
        warehouseId: context.warehouseId,
        lines: [
          { cropId, unitId: fixtures.unitId, grossQuantity: 10, moisturePct: 0, rate: 1000 },
        ],
        action: 'POST',
      });
      expect(purchase.status).toBe('POSTED');

      const { rows: batches } = await query(
        `SELECT b.cost_per_unit FROM crop_batches b
           JOIN crop_purchase_items i ON i.id = b.purchase_item_id
          WHERE i.purchase_id = $1`,
        [purchase.id]
      );

      // The same purchase at a rate that can be claimed: the crop costs what
      // it cost, and the tax waits in its own account to be set against
      // output VAT.
      expect(money(batches[0].cost_per_unit)).toBe(1000);
      expect(money((await balanceOf(LEDGER.INVENTORY)) - before.inventory)).toBe(10000);
      expect(money((await balanceOf(LEDGER.INPUT_VAT)) - before.inputVat)).toBe(1500);

      await query('UPDATE crops SET tax_rate_id = $1 WHERE id = $2', [rateId, cropId]);
    });
  });
});

/** Numbers arrive from the database as strings, on purpose. */
const num = (n) => Number(n) || 0;
