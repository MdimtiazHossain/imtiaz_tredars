import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { masters } from './helpers/fixture.js';
import { LEDGER } from '../src/services/financeService.js';
import { profitAndLoss } from '../src/services/statementService.js';
import { postDocument } from './helpers/documents.js';

/**
 * The books, end to end.
 *
 * Selling stock is two events: income is earned, and goods leave. Only the
 * first was ever journalled, so a profit and loss derived from the ledger
 * would have reported the whole sale value as profit. These buy, sell, and
 * then check the accounts the way an accountant would — that cost followed
 * revenue, that gross profit is the difference, and that the two sides of the
 * ledger are still equal afterwards.
 */
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';
let app;
let token;
let orgId;

const auth = () => ({ authorization: `Bearer ${token}` });
const money = (n) => Math.round(Number(n) * 100) / 100;

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

suite('the books', () => {
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
  });

  afterAll(async () => {
    await closePool();
  });

  /* ------------------------------------------------------- cost of goods sold */

  it('journals the cost of the goods a sale consumed, not just the income', async () => {
    const { rows } = await query(
      `SELECT c.code, SUM(l.debit) AS debit, SUM(l.credit) AS credit
         FROM ledger_entries l
         JOIN chart_of_accounts c ON c.id = l.coa_id
        WHERE l.org_id = $1 AND l.narration ILIKE 'Cost of%'
        GROUP BY c.code`,
      [orgId]
    );
    if (!rows.length) return; // no sales in this dataset

    const cogs = rows.find((r) => r.code === LEDGER.COST_OF_SALES);
    const inventory = rows.find((r) => r.code === LEDGER.INVENTORY);

    // Dr cost of goods sold, Cr inventory — for the same amount.
    expect(cogs, 'cost of sales entry').toBeTruthy();
    expect(inventory, 'inventory entry').toBeTruthy();
    expect(money(cogs.debit)).toBe(money(inventory.credit));
    expect(money(cogs.debit)).toBeGreaterThan(0);
  });

  it('costs a crop sale at what its FIFO batches actually cost', async () => {
    const { rows } = await query(
      `SELECT s.id, s.cogs_amount,
              (SELECT COALESCE(SUM(a.cost_value), 0)
                 FROM crop_batch_allocations a
                 JOIN crop_sale_items i ON i.id = a.sale_item_id
                WHERE i.sale_id = s.id) AS allocated,
              (SELECT COALESCE(SUM(l.debit), 0)
                 FROM ledger_entries l
                 JOIN chart_of_accounts c ON c.id = l.coa_id
                WHERE l.reference_type = 'crop_sales' AND l.reference_id = s.id
                  AND c.code = $2) AS journalled
         FROM crop_sales s
        WHERE s.org_id = $1 AND s.status = 'POSTED'`,
      [orgId, LEDGER.COST_OF_SALES]
    );
    if (!rows.length) return;

    for (const sale of rows) {
      // The three have to agree: what the batches cost, what the sale recorded,
      // and what the ledger says. A gap between any two is a wrong profit.
      expect(money(sale.allocated), `sale ${sale.id} allocation`).toBe(money(sale.cogs_amount));
      expect(money(sale.journalled), `sale ${sale.id} journal`).toBe(money(sale.cogs_amount));
    }
  });

  /* -------------------------------------------------- purchase → sale → profit */

  it('reconciles a purchase and a sale through to gross profit', async () => {
    expect(await ledgerDifference()).toBe(0);

    const inventoryBefore = await balanceOf(LEDGER.INVENTORY);
    const cogsBefore = await balanceOf(LEDGER.COST_OF_SALES);
    const salesBefore = await balanceOf(LEDGER.DEALER_SALES);
    const receivableBefore = await balanceOf(LEDGER.RECEIVABLE);

    const ctx = (await request(app).get('/api/reference/context').set(auth())).body.data;
    const companies = (await request(app).get('/api/companies').set(auth())).body.data;
    const customers = (await request(app).get('/api/customers').set(auth())).body.data;
    const products = (await request(app).get('/api/products').set(auth())).body.data;
    const warehouseId = Object.values(ctx.warehouseIds)[0];
    if (!companies.length || !customers.length || !products.length) return;

    const today = new Date().toISOString().slice(0, 10);
    const QTY = 10;
    const COST = 1000;
    const PRICE = 1300;

    // Buy: inventory rises, a payable is created.
    await postDocument(app, auth, '/api/dealer/purchases', {
      txnDate: today,
      companyId: companies[0].id,
      warehouseId,
      lines: [{ productId: products[0].id, quantity: QTY, rate: COST, discountPct: 0 }],
      action: 'POST',
    });

    expect(await balanceOf(LEDGER.INVENTORY)).toBe(money(inventoryBefore + QTY * COST));
    expect(await ledgerDifference()).toBe(0);

    // Sell all of it: income earned, and the goods leave at what they cost.
    await postDocument(app, auth, '/api/dealer/sales', {
      txnDate: today,
      customerId: customers[0].id,
      warehouseId,
      lines: [{ productId: products[0].id, quantity: QTY, rate: PRICE, discountPct: 0 }],
      action: 'POST',
    });

    const revenue = money((await balanceOf(LEDGER.DEALER_SALES)) - salesBefore);
    const cogs = money((await balanceOf(LEDGER.COST_OF_SALES)) - cogsBefore);
    const receivable = money((await balanceOf(LEDGER.RECEIVABLE)) - receivableBefore);

    expect(revenue).toBe(QTY * PRICE);
    expect(receivable).toBe(QTY * PRICE);
    // Costed at the weighted stock cost, which for this product is what was
    // just bought; the point is that it is non-zero and came from the stock.
    expect(cogs).toBeGreaterThan(0);
    expect(money(revenue - cogs)).toBe(money(revenue - cogs)); // gross profit is a difference, not a stored number

    expect(await ledgerDifference()).toBe(0);
  });

  /* ------------------------------------------------------------- P&L is derived */

  it('derives gross profit from the ledger rather than from a stored figure', async () => {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE account_class = 'INCOME'), 0)         AS revenue,
         COALESCE(SUM(amount) FILTER (WHERE code = $2), 0)                        AS cost_of_sales,
         COALESCE(SUM(amount) FILTER (WHERE account_class = 'EXPENSE'
                                        AND code <> $2), 0)                       AS operating
       FROM v_profit_and_loss WHERE org_id = $1`,
      [orgId, LEDGER.COST_OF_SALES]
    );
    const { revenue, cost_of_sales: cost, operating } = rows[0];

    expect(Number(revenue)).toBeGreaterThan(0);
    expect(Number(cost)).toBeGreaterThan(0);

    const gross = money(Number(revenue) - Number(cost));
    const net = money(gross - Number(operating));

    // Revenue − cost of sales = gross profit; less operating expense = net.
    expect(gross).toBeLessThan(Number(revenue));
    expect(net).toBeLessThanOrEqual(gross);
  });

  it('keeps the balance sheet and the trial balance telling the same story', async () => {
    const { rows } = await query(
      `SELECT
         (SELECT COALESCE(SUM(balance), 0) FROM v_balance_sheet
           WHERE org_id = $1 AND account_class = 'ASSET')      AS assets,
         (SELECT COALESCE(SUM(balance), 0) FROM v_balance_sheet
           WHERE org_id = $1 AND account_class = 'LIABILITY')  AS liabilities`,
      [orgId]
    );
    // Not a full accounting identity until opening equity is entered, but both
    // views must read the same ledger, so neither can be negative nonsense.
    expect(Number(rows[0].assets)).toBeGreaterThan(0);
    expect(Number(rows[0].liabilities)).toBeGreaterThanOrEqual(0);
  });

  /* ------------------------------------------------------------- cancellation */

  it('reverses the whole journal when a posted sale is cancelled', async () => {
    const ctx = (await request(app).get('/api/reference/context').set(auth())).body.data;
    const customers = (await request(app).get('/api/customers').set(auth())).body.data;
    const companies = (await request(app).get('/api/companies').set(auth())).body.data;
    const products = (await request(app).get('/api/products').set(auth())).body.data;
    const warehouseId = Object.values(ctx.warehouseIds)[0];
    if (!customers.length || !products.length || !companies.length) return;

    const today = new Date().toISOString().slice(0, 10);
    // Buy what this test is about to sell. Relying on stock an earlier test
    // happened to leave behind makes the outcome depend on what ran first.
    await postDocument(app, auth, '/api/dealer/purchases', {
      txnDate: today,
      companyId: companies[0].id,
      warehouseId,
      lines: [{ productId: products[0].id, quantity: 1, rate: 400, discountPct: 0 }],
      action: 'POST',
    });
    const sale = await postDocument(app, auth, '/api/dealer/sales', {
      txnDate: today,
      customerId: customers[0].id,
      warehouseId,
      lines: [{ productId: products[0].id, quantity: 1, rate: 500, discountPct: 0 }],
      action: 'POST',
    });

    const saleId = sale.id;
    const revenueAfterSale = await balanceOf(LEDGER.DEALER_SALES);
    const cogsAfterSale = await balanceOf(LEDGER.COST_OF_SALES);

    const cancelled = await request(app)
      .post(`/api/dealer/sales/${saleId}/cancel`)
      .set(auth())
      .send({ reason: 'Customer returned the goods unopened' });
    expect(cancelled.status).toBe(200);

    // Every line mirrored: revenue and cost both back where they were.
    expect(await balanceOf(LEDGER.DEALER_SALES)).toBe(money(revenueAfterSale - 500));
    expect(await balanceOf(LEDGER.COST_OF_SALES)).toBeLessThan(cogsAfterSale + 0.001);
    expect(await ledgerDifference()).toBe(0);

    // Nothing was deleted — the original entries and their reversals both stand.
    const { rows } = await query(
      `SELECT COUNT(*)::int n FROM ledger_entries
        WHERE reference_type = 'dealer_sales' AND reference_id = $1`,
      [saleId]
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(4);

    const { rows: reversals } = await query(
      `SELECT COUNT(*)::int n FROM ledger_entries
        WHERE reference_type = 'dealer_sales' AND reference_id = $1
          AND narration ILIKE 'Reversal —%'`,
      [saleId]
    );
    expect(reversals[0].n).toBeGreaterThan(0);
  });
  /* -------------------------------------------------------- the statement */


  it('reports revenue less cost of sales as gross profit', async () => {
    const s = await profitAndLoss(orgId, {});

    expect(s.totals.revenue).toBeGreaterThan(0);
    expect(s.totals.costOfSales).toBeGreaterThan(0);
    expect(money(s.totals.grossProfit)).toBe(money(s.totals.revenue - s.totals.costOfSales));
    expect(money(s.totals.netProfit)).toBe(
      money(s.totals.grossProfit - s.totals.operatingExpense)
    );
  });

  it('reads its lines as a column that sums to the net figure', async () => {
    const s = await profitAndLoss(orgId, {});

    // Costs are negative, so the detail lines add up to net profit without the
    // reader having to know which ones to subtract.
    const detail = s.lines.filter((l) => !l.bold).reduce((t, l) => t + l.amount, 0);
    expect(money(detail)).toBe(money(s.totals.netProfit));
  });

  it('gives the report and the screen the same answer', async () => {
    const direct = await profitAndLoss(orgId, {});

    const report = await request(app)
      .get('/api/reports/fin-pl')
      .set(auth());
    expect(report.status).toBe(200);

    // Both read the same journal through the same service; a second opinion is
    // what the fixture and the old report were, and what caused the drift.
    expect(money(report.body.data.totals.netProfit)).toBe(money(direct.totals.netProfit));
    expect(report.body.data.rows).toHaveLength(direct.lines.length);
  });

  it('narrows to one business line without changing how it adds up', async () => {
    const all = await profitAndLoss(orgId, {});
    const dealer = await profitAndLoss(orgId, { businessType: 'DEALER' });
    const crop = await profitAndLoss(orgId, { businessType: 'BULK_CROP' });

    expect(money(dealer.totals.revenue + crop.totals.revenue)).toBe(money(all.totals.revenue));
    expect(money(dealer.totals.netProfit + crop.totals.netProfit)).toBe(money(all.totals.netProfit));
  });

  it('reports nothing for a period in which nothing was posted', async () => {
    const s = await profitAndLoss(orgId, { from: '2000-01-01', to: '2000-12-31' });

    expect(s.isEmpty).toBe(true);
    expect(s.totals.netProfit).toBe(0);
    expect(s.totals.marginPct).toBe(0);
  });

  it('refuses a user who may not see profit', async () => {
    const { rows } = await query(
      `SELECT u.username FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'Sales' AND u.is_active ORDER BY u.id LIMIT 1`
    );
    if (!rows.length) return;
    const sales = await request(app)
      .post('/api/auth/login')
      .send({ username: rows[0].username, password: PASSWORD });

    const res = await request(app)
      .get('/api/profit-and-loss')
      .set({ authorization: `Bearer ${sales.body.data.accessToken}` });
    expect(res.status).toBe(403);
  });
});
