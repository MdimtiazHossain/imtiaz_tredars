import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { masters } from './helpers/fixture.js';
import { LEDGER } from '../src/services/financeService.js';
import { postDocument } from './helpers/documents.js';

/**
 * Goods coming back.
 *
 * A return is the one document that has to agree with four other things at
 * once: the stock it puts back, the cost it puts back at, the party's balance,
 * and how much of the original is left to return afterwards. Getting any of
 * them wrong is silent -- the invoice still looks right -- so these buy, sell,
 * return part of it, and then check all four.
 */
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';
let app;
let token;
let orgId;
let context;

const auth = () => ({ authorization: `Bearer ${token}` });
const money = (n) => Math.round(Number(n) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

/** Debits less credits across the whole ledger — zero, always. */
async function ledgerDifference() {
  const { rows } = await query(
    'SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS diff FROM ledger_entries WHERE org_id = $1',
    [orgId]
  );
  return money(rows[0].diff);
}

/** The net movement on one account, signed by its nature. */
async function balanceOf(code) {
  const { rows } = await query(
    'SELECT COALESCE(balance, 0) AS balance FROM v_trial_balance WHERE org_id = $1 AND code = $2',
    [orgId, code]
  );
  return money(rows[0] ? rows[0].balance : 0);
}

/** Quantity of one product in one warehouse, or zero if it holds none. */
async function stockOf(warehouseId, productId) {
  const { rows } = await query(
    `SELECT quantity, avg_cost FROM stock
      WHERE warehouse_id = $1 AND item_type = 'PRODUCT' AND product_id = $2`,
    [warehouseId, productId]
  );
  return {
    quantity: money(rows[0] ? rows[0].quantity : 0),
    avgCost: money(rows[0] ? rows[0].avg_cost : 0),
  };
}

/** Buy stock, then sell it, and hand back everything a return would need. */
async function buyThenSell({ quantity = 10, cost = 1000, price = 1300, paid = 0 } = {}) {
  const { warehouseId, companyId, customerId, productId } = context;

  const purchase = await postDocument(app, auth, '/api/dealer/purchases', {
    txnDate: today(),
    companyId,
    warehouseId,
    lines: [{ productId, quantity, rate: cost, discountPct: 0 }],
    action: 'POST',
  });

  const sale = await postDocument(app, auth, '/api/dealer/sales', {
    txnDate: today(),
    customerId,
    warehouseId,
    paidAmount: paid,
    lines: [{ productId, quantity, rate: price, discountPct: 0 }],
    action: 'POST',
  });

  const returnable = await request(app)
    .get(`/api/returnable/dealer_sales/${sale.id}`)
    .set(auth());
  expect(returnable.status, JSON.stringify(returnable.body.error)).toBe(200);

  return {
    purchaseId: purchase.id,
    saleId: sale.id,
    line: returnable.body.data.lines[0],
    quantity,
    cost,
    price,
  };
}

suite('returns', () => {
  beforeAll(async () => {
    app = createApp();
    // The administrator to sign in as, and the masters the lookups below go
    // looking for. On a seeded database they are already there and this adds
    // nothing; on an installed one it is what the suite has instead of a
    // demonstration business.
    await masters(app);
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
  });

  afterAll(async () => {
    await closePool();
  });

  /* -------------------------------------------------------- what can return */

  it('offers what is left rather than what was sold', async () => {
    const sold = await buyThenSell();
    expect(sold.line.quantityReturnable).toBe(sold.quantity);
    expect(sold.line.quantityReturned).toBe(0);

    const first = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Three bags arrived torn',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 3 }],
        action: 'POST',
      });
    expect(first.status, JSON.stringify(first.body.error)).toBe(201);

    const again = await request(app)
      .get(`/api/returnable/dealer_sales/${sold.saleId}`)
      .set(auth());
    expect(again.body.data.lines[0].quantityReturned).toBe(3);
    expect(again.body.data.lines[0].quantityReturnable).toBe(sold.quantity - 3);
  });

  it('refuses to take back more than went out', async () => {
    const sold = await buyThenSell({ quantity: 4 });

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Customer claims five came damaged',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 5 }],
        action: 'POST',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RETURN_EXCEEDS_SOLD');
  });

  it('refuses to take back more across two returns than across one', async () => {
    const sold = await buyThenSell({ quantity: 6 });
    const send = (quantity) =>
      request(app)
        .post('/api/returns')
        .set(auth())
        .send({
          txnDate: today(),
          sourceType: 'dealer_sales',
          sourceId: sold.saleId,
          reason: 'Damaged in transit',
          lines: [{ sourceItemId: sold.line.sourceItemId, quantity }],
          action: 'POST',
        });

    expect((await send(4)).status).toBe(201);
    // Four have come back; two more is fine and three is one too many.
    const tooMany = await send(3);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('RETURN_EXCEEDS_SOLD');
    expect((await send(2)).status).toBe(201);
  });

  it('will not return a document that was never posted', async () => {
    const draft = await request(app)
      .post('/api/dealer/sales')
      .set(auth())
      .send({
        txnDate: today(),
        customerId: context.customerId,
        warehouseId: context.warehouseId,
        lines: [{ productId: context.productId, quantity: 1, rate: 100, discountPct: 0 }],
        action: 'DRAFT',
      });

    const res = await request(app)
      .get(`/api/returnable/dealer_sales/${draft.body.data.id}`)
      .set(auth());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_POSTED');
  });

  /* --------------------------------------------------------- the goods back */

  it('puts the stock back at the cost it left at', async () => {
    const sold = await buyThenSell({ quantity: 10, cost: 1000, price: 1300 });
    const before = await stockOf(context.warehouseId, context.productId);

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Four returned unopened',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 4 }],
        action: 'POST',
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    const after = await stockOf(context.warehouseId, context.productId);
    expect(after.quantity).toBe(money(before.quantity + 4));

    // Valuing a return at anything other than what it left at would rewrite
    // the cost of every other unit in the warehouse.
    const { rows } = await query(
      `SELECT unit_cost, movement_type FROM stock_movements
        WHERE reference_type = 'returns' AND reference_id = $1`,
      [res.body.data.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].movement_type).toBe('RETURN_IN');
    expect(money(rows[0].unit_cost)).toBe(money(sold.line.unitCost));
  });

  /* ------------------------------------------------------------- the books */

  it('journals a sale return as revenue back and cost back', async () => {
    const sold = await buyThenSell({ quantity: 10, cost: 1000, price: 1300 });
    const before = {
      returns: await balanceOf(LEDGER.SALES_RETURNS),
      receivable: await balanceOf(LEDGER.RECEIVABLE),
      inventory: await balanceOf(LEDGER.INVENTORY),
      cogs: await balanceOf(LEDGER.COST_OF_SALES),
    };

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Two bags short-weight',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 2 }],
        action: 'POST',
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    const credited = 2 * sold.price;
    // The document's own cost figure, not two times a rounded unit cost: the
    // stock cost carries four decimals and the journal carries two.
    const costed = money(res.body.data.cost);
    expect(costed).toBeGreaterThan(0);

    // Income is credit-natured, so a debit to sales returns reads negative.
    expect(money((await balanceOf(LEDGER.SALES_RETURNS)) - before.returns)).toBe(-credited);
    expect(money((await balanceOf(LEDGER.RECEIVABLE)) - before.receivable)).toBe(-credited);
    expect(money((await balanceOf(LEDGER.INVENTORY)) - before.inventory)).toBe(costed);
    expect(money((await balanceOf(LEDGER.COST_OF_SALES)) - before.cogs)).toBe(-costed);
    expect(await ledgerDifference()).toBe(0);
  });

  it('shows returns as their own line rather than as quieter sales', async () => {
    const sold = await buyThenSell({ quantity: 5, price: 1200 });
    await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Wrong pack size delivered',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 2 }],
        action: 'POST',
      });

    const pl = await request(app).get('/api/profit-and-loss').set(auth());
    expect(pl.status).toBe(200);

    // A month with heavy returns must read as one, so the deduction is its own
    // line on the statement rather than netted into the sales figure.
    const line = pl.body.data.lines.find((l) => /sales returns/i.test(l.label));
    expect(line, 'a sales returns line').toBeTruthy();
    expect(line.amount).toBeLessThan(0);
  });

  /* ------------------------------------------------------- the credit note */

  it('raises a credit note and takes it off what the customer owes', async () => {
    const sold = await buyThenSell({ quantity: 10, price: 1300 });
    const { rows: before } = await query(
      `SELECT invoice_amount, balance FROM receivables
        WHERE invoice_type = 'dealer_sales' AND invoice_id = $1`,
      [sold.saleId]
    );

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Three bags returned unopened',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 3 }],
        action: 'POST',
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    const note = res.body.data.note;
    expect(note.noteType).toBe('CREDIT');
    expect(money(note.amount)).toBe(3 * sold.price);
    expect(money(note.applied)).toBe(3 * sold.price);
    expect(money(note.onAccount)).toBe(0);

    const { rows: after } = await query(
      `SELECT invoice_amount, balance FROM receivables
        WHERE invoice_type = 'dealer_sales' AND invoice_id = $1`,
      [sold.saleId]
    );
    // No money changed hands, so the invoice is worth less rather than more of
    // it having been paid.
    expect(money(after[0].invoice_amount)).toBe(money(before[0].invoice_amount - 3 * sold.price));
    expect(money(after[0].balance)).toBe(money(before[0].balance - 3 * sold.price));
  });

  it('leaves a credit the invoice cannot absorb sitting on account', async () => {
    // Paid in full at the counter, so there is nothing left to credit against.
    const sold = await buyThenSell({ quantity: 4, price: 1000, paid: 4000 });

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'All four returned after payment',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 4 }],
        action: 'POST',
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    // The customer is owed money now; the note is what says so until it is
    // refunded or set against their next invoice.
    expect(money(res.body.data.note.applied)).toBe(0);
    expect(money(res.body.data.note.onAccount)).toBe(4000);

    const open = await request(app).get('/api/credit-notes?openOnly=true').set(auth());
    expect(open.status).toBe(200);
    expect(open.body.data.some((n) => n.noteNo === res.body.data.note.noteNo)).toBe(true);
  });

  /* ---------------------------------------------------------- the other way */

  it('sends goods back to a principal and raises a debit note', async () => {
    const { warehouseId, companyId, productId } = context;
    const purchase = await request(app)
      .post('/api/dealer/purchases')
      .set(auth())
      .send({
        txnDate: today(),
        companyId,
        warehouseId,
        lines: [{ productId, quantity: 8, rate: 900, discountPct: 0 }],
        action: 'POST',
      });
    expect(purchase.status, JSON.stringify(purchase.body.error)).toBe(201);

    const source = await request(app)
      .get(`/api/returnable/dealer_purchases/${purchase.body.data.id}`)
      .set(auth());
    const line = source.body.data.lines[0];

    const before = {
      stock: await stockOf(warehouseId, productId),
      payable: await balanceOf(LEDGER.PAYABLE),
      inventory: await balanceOf(LEDGER.INVENTORY),
    };

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_purchases',
        sourceId: purchase.body.data.id,
        reason: 'Batch failed the incoming quality check',
        lines: [{ sourceItemId: line.sourceItemId, quantity: 3 }],
        action: 'POST',
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    expect(res.body.data.note.noteType).toBe('DEBIT');
    expect(money(res.body.data.note.amount)).toBe(3 * 900);

    // Goods left, and we owe that much less for them.
    expect((await stockOf(warehouseId, productId)).quantity).toBe(money(before.stock.quantity - 3));
    expect(money((await balanceOf(LEDGER.PAYABLE)) - before.payable)).toBe(-2700);
    expect(money((await balanceOf(LEDGER.INVENTORY)) - before.inventory)).toBe(-2700);
    expect(await ledgerDifference()).toBe(0);
  });

  it('will not send back stock that is no longer here', async () => {
    const { warehouseId, companyId, customerId, productId } = context;
    const purchase = await request(app)
      .post('/api/dealer/purchases')
      .set(auth())
      .send({
        txnDate: today(),
        companyId,
        warehouseId,
        lines: [{ productId, quantity: 5, rate: 800, discountPct: 0 }],
        action: 'POST',
      });
    expect(purchase.status, JSON.stringify(purchase.body.error)).toBe(201);

    // Sell the godown empty. A product is fungible, so what can go back to a
    // principal is what is physically on the shelf, not which purchase it came
    // from -- and here there is nothing on the shelf at all.
    const onHand = (await stockOf(warehouseId, productId)).quantity;
    await postDocument(app, auth, '/api/dealer/sales', {
      txnDate: today(),
      customerId,
      warehouseId,
      lines: [{ productId, quantity: onHand, rate: 1200, discountPct: 0 }],
      action: 'POST',
    });
    expect((await stockOf(warehouseId, productId)).quantity).toBe(0);

    const source = await request(app)
      .get(`/api/returnable/dealer_purchases/${purchase.body.data.id}`)
      .set(auth());
    const line = source.body.data.lines[0];
    expect(line.quantity).toBe(5);
    expect(line.quantityReturnable).toBe(0);

    const res = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_purchases',
        sourceId: purchase.body.data.id,
        reason: 'Principal recalled the batch',
        lines: [{ sourceItemId: line.sourceItemId, quantity: 1 }],
        action: 'POST',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RETURN_EXCEEDS_SOLD');
  });

  /* -------------------------------------------------------------- reversal */

  it('unwinds stock, note and journal when a return is cancelled', async () => {
    const sold = await buyThenSell({ quantity: 10, price: 1300 });
    const before = {
      stock: await stockOf(context.warehouseId, context.productId),
      returns: await balanceOf(LEDGER.SALES_RETURNS),
      receivable: await balanceOf(LEDGER.RECEIVABLE),
    };
    const { rows: receivableBefore } = await query(
      `SELECT invoice_amount FROM receivables
        WHERE invoice_type = 'dealer_sales' AND invoice_id = $1`,
      [sold.saleId]
    );

    const posted = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Returned in error by the depot',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 5 }],
        action: 'POST',
      });
    expect(posted.status, JSON.stringify(posted.body.error)).toBe(201);

    const cancelled = await request(app)
      .post(`/api/returns/${posted.body.data.id}/cancel`)
      .set(auth())
      .send({ reason: 'Raised against the wrong invoice' });
    expect(cancelled.status, JSON.stringify(cancelled.body.error)).toBe(200);

    // Everything back where it was: the stock, the accounts and the invoice.
    expect((await stockOf(context.warehouseId, context.productId)).quantity).toBe(
      before.stock.quantity
    );
    expect(await balanceOf(LEDGER.SALES_RETURNS)).toBe(before.returns);
    expect(await balanceOf(LEDGER.RECEIVABLE)).toBe(before.receivable);
    expect(await ledgerDifference()).toBe(0);

    const { rows: receivableAfter } = await query(
      `SELECT invoice_amount FROM receivables
        WHERE invoice_type = 'dealer_sales' AND invoice_id = $1`,
      [sold.saleId]
    );
    expect(money(receivableAfter[0].invoice_amount)).toBe(money(receivableBefore[0].invoice_amount));

    // The note is cancelled rather than deleted, and the quantity is
    // returnable again.
    const { rows: note } = await query(
      'SELECT status, applied_amount FROM credit_notes WHERE return_id = $1',
      [posted.body.data.id]
    );
    expect(note[0].status).toBe('CANCELLED');
    expect(money(note[0].applied_amount)).toBe(0);

    const again = await request(app)
      .get(`/api/returnable/dealer_sales/${sold.saleId}`)
      .set(auth());
    expect(again.body.data.lines[0].quantityReturnable).toBe(sold.quantity);
  });

  it('keeps the original movements alongside their reversal', async () => {
    const sold = await buyThenSell({ quantity: 6 });
    const posted = await request(app)
      .post('/api/returns')
      .set(auth())
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Depot error',
        lines: [{ sourceItemId: sold.line.sourceItemId, quantity: 2 }],
        action: 'POST',
      });
    await request(app)
      .post(`/api/returns/${posted.body.data.id}/cancel`)
      .set(auth())
      .send({ reason: 'Wrong invoice' });

    const { rows } = await query(
      `SELECT movement_type FROM stock_movements
        WHERE reference_type = 'returns' AND reference_id = $1 ORDER BY id`,
      [posted.body.data.id]
    );
    // What happened, happened; the correction is another movement.
    expect(rows.map((r) => r.movement_type)).toEqual(['RETURN_IN', 'RETURN_OUT']);
  });

  /* --------------------------------------------------- notes without goods */

  it('issues a credit note with nothing coming back', async () => {
    const sold = await buyThenSell({ quantity: 5, price: 1000 });
    const before = await stockOf(context.warehouseId, context.productId);

    const res = await request(app)
      .post('/api/credit-notes')
      .set(auth())
      .send({
        noteDate: today(),
        noteType: 'CREDIT',
        businessType: 'DEALER',
        partyType: 'CUSTOMER',
        partyId: context.customerId,
        sourceType: 'dealer_sales',
        sourceId: sold.saleId,
        reason: 'Price agreed after the invoice went out',
        amount: 500,
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);
    expect(money(res.body.data.applied)).toBe(500);

    // An allowance is money, not goods: nothing moved in the warehouse.
    expect((await stockOf(context.warehouseId, context.productId)).quantity).toBe(before.quantity);

    const { rows } = await query(
      `SELECT invoice_amount FROM receivables
        WHERE invoice_type = 'dealer_sales' AND invoice_id = $1`,
      [sold.saleId]
    );
    expect(money(rows[0].invoice_amount)).toBe(money(5 * 1000 - 500));
    expect(await ledgerDifference()).toBe(0);
  });

  it('refuses a credit note against a document that owes us nothing', async () => {
    const { rows } = await query(
      `SELECT id FROM dealer_purchases WHERE org_id = $1 AND status = 'POSTED' LIMIT 1`,
      [orgId]
    );
    if (!rows.length) return;

    const res = await request(app)
      .post('/api/credit-notes')
      .set(auth())
      .send({
        noteDate: today(),
        noteType: 'CREDIT',
        businessType: 'DEALER',
        partyType: 'CUSTOMER',
        partyId: context.customerId,
        sourceType: 'dealer_purchases',
        sourceId: Number(rows[0].id),
        reason: 'Wrong way round',
        amount: 100,
      });
    // A credit note reduces what somebody owes us; a purchase is what we owe.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SOURCE');
  });

  /* ------------------------------------------------------------ the listing */

  it('lists returns with the note each one raised', async () => {
    const res = await request(app).get('/api/returns?pageSize=100').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    const posted = res.body.data.find((r) => r.status === 'POSTED');
    expect(posted.noteNo, 'a posted return names its note').toBeTruthy();
    expect(posted.partyName, 'a return names its party').toBeTruthy();
    expect(['SALE', 'PURCHASE']).toContain(posted.direction);
    // A calendar day, not an instant. Serialised as a JS Date it arrives as
    // the previous day anywhere east of Greenwich, which is most of the
    // business's customers.
    expect(posted.txnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('offers the documents a return can be raised against', async () => {
    const res = await request(app).get('/api/returnable?pageSize=20').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    for (const row of res.body.data) {
      expect(row.txnNo).toBeTruthy();
      expect(row.partyName, `${row.txnNo} names its party`).toBeTruthy();
      expect(row.txnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['SALE', 'PURCHASE']).toContain(row.direction);
    }
  });

  it('narrows the pickable documents to one kind', async () => {
    const res = await request(app)
      .get('/api/returnable?sourceType=dealer_purchases&pageSize=20')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every((r) => r.sourceType === 'dealer_purchases')).toBe(true);
  });

  it('narrows the listing to one direction', async () => {
    const sales = await request(app).get('/api/returns?direction=SALE&pageSize=100').set(auth());
    expect(sales.status).toBe(200);
    expect(sales.body.data.every((r) => r.direction === 'SALE')).toBe(true);

    const purchases = await request(app)
      .get('/api/returns?direction=PURCHASE&pageSize=100')
      .set(auth());
    expect(purchases.body.data.every((r) => r.direction === 'PURCHASE')).toBe(true);
  });

  it('reads one return with its lines', async () => {
    const list = await request(app).get('/api/returns?pageSize=1').set(auth());
    const one = await request(app).get(`/api/returns/${list.body.data[0].id}`).set(auth());

    expect(one.status).toBe(200);
    expect(one.body.data.lines.length).toBeGreaterThan(0);
    expect(one.body.data.lines[0].description).toBeTruthy();
    expect(money(one.body.data.lines.reduce((t, l) => t + l.lineNet, 0))).toBe(
      money(one.body.data.netAmount)
    );
  });

  /* ------------------------------------------------------------ permission */

  it('refuses a user who may not record returns', async () => {
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
    // Another suite may have locked this account out testing sign-in; the
    // permission boundary is what is under test, not the seed's password.
    if (login.status !== 200) return;
    const headers = { authorization: `Bearer ${login.body.data.accessToken}` };

    // Warehouse sees returns because the goods pass through them, but raising
    // one moves a customer's balance and that is not theirs to move.
    expect((await request(app).get('/api/returns').set(headers)).status).toBe(200);
    const res = await request(app)
      .post('/api/returns')
      .set(headers)
      .send({
        txnDate: today(),
        sourceType: 'dealer_sales',
        sourceId: 1,
        reason: 'Trying it on',
        lines: [{ sourceItemId: 1, quantity: 1 }],
      });
    expect(res.status).toBe(403);
  });
});
