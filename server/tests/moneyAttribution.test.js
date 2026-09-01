import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { LEDGER } from '../src/services/financeService.js';
import { masters } from './helpers/fixture.js';

/**
 * Whose money it is, and how much of it is still owed.
 *
 * Two faults with the same shape: the application knew the right total and
 * attributed it to the wrong place, so nothing was out of balance and nothing
 * failed -- the figures were simply about the wrong party, or about a moment
 * before the money arrived.
 *
 * A receipt with no invoice named against it credited Accounts receivable in
 * the general ledger and stopped there, so a customer's own ledger said 16,000
 * while the customers list, the ageing, the collect-from list and the dashboard
 * all said 26,000. And a crop purchase raised the whole landed cost against the
 * farmer, freight included, so paying them what they were owed left a balance
 * against their name that nobody intended and nothing would ever clear.
 *
 * The suite makes its own data, so it runs against a database holding only the
 * system foundation.
 */
const suite = HAS_DB ? describe : describe.skip;

// One pool serves both suites in this file, so it is closed once at the end
// rather than by whichever of them finishes first.
afterAll(async () => {
  await closePool();
});

let app;
let fx;

const money = (n) => Math.round(Number(n) * 100) / 100;
const auth = () => fx.auth;
const DAY = '2026-09-01';

/**
 * A name no earlier run has used.
 *
 * The shared masters are reused on purpose -- a fixture that made a new
 * warehouse every run would fill the database with them. But a party whose
 * balance is being asserted has to be this run's own, or a second run finds the
 * first run's invoices still against them and every total reads double.
 */
const stamp = String(Date.now()).slice(-8);
const unique = (what) => `ZZ-TEST ${what} ${stamp}`;
// A mobile number is unique per party, which is the app's rule and a good one.
const uniqueMobile = (prefix) => `${prefix}${stamp}`;

/** The net movement on one ledger account. */
async function balanceOf(code) {
  const { rows } = await query(
    'SELECT COALESCE(balance, 0) AS balance FROM v_trial_balance WHERE org_id = $1 AND code = $2',
    [fx.orgId, code]
  );
  return money(rows[0] ? rows[0].balance : 0);
}

const post = async (path, body) => {
  const res = await request(app).post(`/api${path}`).set(auth()).send(body);
  if (res.status >= 400) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};

const get = async (path) => {
  const res = await request(app).get(`/api${path}`).set(auth());
  if (res.status >= 400) throw new Error(`GET ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};

/** Clear the approval queue, which anything over the limit lands in. */
async function releaseApprovals() {
  const queue = await get('/approvals');
  const rows = Array.isArray(queue) ? queue : queue.rows;
  for (const a of rows.filter((r) => r.status === 'PENDING' || !r.status)) {
    await post(`/approvals/${a.id}/decide`, { approved: true, comment: 'test' });
  }
}

suite('what a payment on account does to the figures', () => {
  let customerId;
  let before;

  beforeAll(async () => {
    app = createApp();
    fx = await masters(app);

    // This run's own customer, so what they owe is only what this run sold
    // them.
    const customer = await post('/customers', {
      name: unique('Payer'),
      type: 'Dealer',
      mobile: uniqueMobile('017'),
      limit: 10000000,
      days: 30,
    });
    customerId = customer.id;

    // What the business as a whole was owed before any of this, so the
    // dashboard can be checked by how much it moved on a database that already
    // holds other people's invoices.
    const dash = await get('/reports/dashboard');
    before = {
      dashboardReceivable: money(dash.receivable.amount),
      ledgerReceivable: await balanceOf(LEDGER.RECEIVABLE),
    };

    await post('/dealer/purchases', {
      txnDate: DAY,
      companyId: fx.principal.id,
      warehouseId: fx.warehouse.id,
      lines: [{ productId: fx.product.id, quantity: 100, rate: 1000 }],
      action: 'POST',
    });
    await post('/dealer/sales', {
      txnDate: DAY,
      customerId,
      warehouseId: fx.warehouse.id,
      lines: [{ productId: fx.product.id, quantity: 20, rate: 1300 }],
      action: 'POST',
    });
    await releaseApprovals();

    // The receipt the payment screen produces when no invoice line is filled
    // in: money in hand, not yet matched to anything.
    await post('/payments', {
      txnDate: DAY,
      direction: 'RECEIPT',
      businessType: 'DEALER',
      partyType: 'CUSTOMER',
      partyId: customerId,
      accountId: fx.account.id,
      paymentMethodId: fx.method.id,
      amount: 10000,
    });
  });

  it('leaves the money on account rather than against an invoice', async () => {
    const payments = await get('/payments?pageSize=20');
    const rows = Array.isArray(payments) ? payments : payments.rows;
    const receipt = rows.find((p) => money(p.amount) === 10000);
    expect(money(receipt.unallocated)).toBe(10000);

    // The invoice itself is untouched, which is the point: nobody said it was
    // this invoice the money was for.
    const { rows: raw } = await query(
      `SELECT COALESCE(SUM(balance), 0) AS due FROM receivables
        WHERE party_type = 'CUSTOMER' AND party_id = $1`,
      [customerId]
    );
    expect(money(raw[0].due)).toBe(26000);
  });

  it('nets it off everywhere the business reads what it is owed', async () => {
    const statement = await get(`/parties/CUSTOMER/${customerId}/statement`);
    const workspace = await get('/workspace');
    const customer = workspace.customers.find((c) => c.id === customerId);
    const openItems = await get(`/receivables?partyType=CUSTOMER&partyId=${customerId}`);

    const readings = {
      'party ledger': money(statement.closing),
      'customers list': money(customer.out),
      'open items': money(openItems.reduce((t, r) => t + Number(r.balance), 0)),
    };

    for (const [where, value] of Object.entries(readings)) {
      expect(value, `${where} says the customer owes`).toBe(16000);
    }
    expect(new Set(Object.values(readings)).size, 'every surface agrees').toBe(1);
  });

  it('moves the dashboard and the general ledger by the same amount', async () => {
    // Org-wide figures, so what is asserted is the change this run caused: a
    // 26,000 invoice less a 10,000 receipt. They used to move by different
    // amounts, which is what made the dashboard disagree with the books.
    const dashboard = await get('/reports/dashboard');
    expect(money(dashboard.receivable.amount) - before.dashboardReceivable).toBe(16000);
    expect((await balanceOf(LEDGER.RECEIVABLE)) - before.ledgerReceivable).toBe(16000);
  });

  it('keeps All equal to Dealer plus Bulk Crop', async () => {
    // The credit has to be filtered by business line the same way the invoices
    // are. Taking the whole of it off every slice made the two lines come to
    // less than the total they are a breakdown of.
    const [all, dealer, crop] = await Promise.all([
      get('/reports/dashboard?businessType=ALL'),
      get('/reports/dashboard?businessType=DEALER'),
      get('/reports/dashboard?businessType=BULK_CROP'),
    ]);

    for (const figure of ['receivable', 'payable', 'sales', 'purchases']) {
      expect(
        money(dealer[figure].amount + crop[figure].amount),
        `${figure}: the two business lines should come to the total`
      ).toBe(money(all[figure].amount));
    }
  });

  it('counts it as money collected', async () => {
    const workspace = await get('/workspace');
    const customer = workspace.customers.find((c) => c.id === customerId);
    expect(money(customer.coll)).toBe(10000);
  });

  it('ages the debt that is genuinely still outstanding', async () => {
    const dashboard = await get('/reports/dashboard');
    const aged = Object.values(dashboard.aging).reduce((t, v) => t + Number(v), 0);
    // The buckets are a breakdown of the receivable, so they cannot come to
    // more than it.
    expect(money(aged)).toBe(money(dashboard.receivable.amount));
  });

  it('stops chasing an invoice the money already covers', async () => {
    // A second receipt takes the balance past what is open.
    await post('/payments', {
      txnDate: DAY,
      direction: 'RECEIPT',
      businessType: 'DEALER',
      partyType: 'CUSTOMER',
      partyId: customerId,
      accountId: fx.account.id,
      amount: 16000,
    });

    const openItems = await get(`/receivables?partyType=CUSTOMER&partyId=${customerId}`);
    expect(openItems).toEqual([]);

    const workspace = await get('/workspace');
    const customer = workspace.customers.find((c) => c.id === customerId);
    expect(money(customer.out)).toBe(0);
    // Back where the books started, this run's trading fully settled.
    expect(await balanceOf(LEDGER.RECEIVABLE)).toBe(before.ledgerReceivable);
  });
});

suite('who is owed for a crop purchase', () => {
  let supplierId;
  let purchaseId;

  beforeAll(async () => {
    app = createApp();
    fx = await masters(app);

    // This run's own farmer, so their payable is only this run's purchase.
    const supplier = await post('/suppliers', {
      name: unique('Farmer'),
      type: 'Farmer',
      mobile: uniqueMobile('018'),
    });
    supplierId = supplier.id;

    const created = await post('/crops/purchases', {
      txnDate: DAY,
      supplierId,
      warehouseId: fx.warehouse.id,
      transportCost: 50000,
      otherCost: 20000,
      lines: [{ cropId: fx.crop.id, unitId: fx.unitMTId, grossQuantity: 100, rate: 30000 }],
      action: 'POST',
    });
    purchaseId = created.id;
    await releaseApprovals();
  });

  /** This purchase's own entries. A seeded database has hundreds of others. */
  async function entriesFor(reference) {
    const { rows } = await query(
      `SELECT a.code, COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr
         FROM ledger_entries l
         JOIN chart_of_accounts a ON a.id = l.coa_id
        WHERE l.reference_type = 'crop_purchases' AND l.reference_id = $1 AND l.org_id = $2
        GROUP BY a.code`,
      [reference, fx.orgId]
    );
    return Object.fromEntries(rows.map((r) => [r.code, { dr: money(r.dr), cr: money(r.cr) }]));
  }

  it('values the batch at landed cost, freight included', async () => {
    const { rows } = await query(
      `SELECT b.quantity_received, b.cost_per_unit
         FROM crop_batches b
         JOIN crop_purchase_items i ON i.id = b.purchase_item_id
        WHERE i.purchase_id = $1`,
      [purchaseId]
    );
    expect(money(rows[0].cost_per_unit)).toBe(30700);
    expect(money(rows[0].quantity_received * rows[0].cost_per_unit)).toBe(3070000);
  });

  it('owes the farmer for the crop, not for the lorry', async () => {
    const { rows } = await query(
      `SELECT COALESCE(SUM(balance), 0) AS due FROM payables
        WHERE party_type = 'SUPPLIER' AND party_id = $1`,
      [supplierId]
    );
    expect(money(rows[0].due)).toBe(3000000);

    const statement = await get(`/parties/SUPPLIER/${supplierId}/statement`);
    expect(money(statement.closing)).toBe(-3000000);
  });

  it('accrues the carriage separately, against no party at all', async () => {
    const by = await entriesFor(purchaseId);
    expect(by[LEDGER.PROCUREMENT_ACCRUAL].cr).toBe(70000);

    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM ledger_entries l
         JOIN chart_of_accounts a ON a.id = l.coa_id
        WHERE a.code = $1 AND l.org_id = $2 AND l.party_id IS NOT NULL`,
      [LEDGER.PROCUREMENT_ACCRUAL, fx.orgId]
    );
    expect(rows[0].n, 'the accrual belongs to nobody yet').toBe(0);
  });

  it('still balances, and still owes the same amount in total', async () => {
    const { rows } = await query(
      'SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS diff FROM ledger_entries WHERE org_id = $1',
      [fx.orgId]
    );
    expect(money(rows[0].diff), 'the ledger as a whole').toBe(0);

    // Splitting the credit changed who is owed, not what the crop cost or what
    // the business owes for it.
    const by = await entriesFor(purchaseId);
    expect(by[LEDGER.INVENTORY].dr).toBe(3070000);
    expect(by[LEDGER.PAYABLE].cr).toBe(3000000);
    expect(by[LEDGER.PROCUREMENT_ACCRUAL].cr).toBe(70000);
    expect(by[LEDGER.PAYABLE].cr + by[LEDGER.PROCUREMENT_ACCRUAL].cr).toBe(
      by[LEDGER.INVENTORY].dr
    );
  });
});
