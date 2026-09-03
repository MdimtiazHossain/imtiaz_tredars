import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { masters } from './helpers/fixture.js';
import { postDocument } from './helpers/documents.js';

/**
 * A party's account.
 *
 * This is what gets sent when a customer disputes a balance, so the one thing
 * it cannot do is disagree with itself: the opening balance plus everything
 * that happened has to be the closing balance, and the closing balance has to
 * be what the rest of the system says the party owes. Everything below is a
 * version of that question.
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

const statementFor = (partyType, id, params = '') =>
  request(app).get(`/api/parties/${partyType}/${id}/statement${params}`).set(auth());

/** What the journal says this party's balance is, independently. */
async function journalBalance(partyType, partyId) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
       FROM v_party_ledger
      WHERE org_id = $1 AND party_type = $2 AND party_id = $3`,
    [orgId, partyType, partyId]
  );
  return money(rows[0].balance);
}

suite('party statement', () => {
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
    const suppliers = (await request(app).get('/api/suppliers').set(auth())).body.data;
    const products = (await request(app).get('/api/products').set(auth())).body.data;
    context = {
      warehouseId: Object.values(ctx.warehouseIds)[0],
      companyId: companies[0] && companies[0].id,
      customerId: customers[0] && customers[0].id,
      supplierId: suppliers[0] && suppliers[0].id,
      productId: products[0] && products[0].id,
    };
  });

  afterAll(async () => {
    await closePool();
  });

  /* ------------------------------------------------------------ the account */

  it('adds up: opening plus what happened is the closing balance', async () => {
    const res = await statementFor('CUSTOMER', context.customerId);
    expect(res.status, JSON.stringify(res.body.error)).toBe(200);

    const s = res.body.data;
    // The one thing a statement must do. A reader adds the column down and
    // has to arrive at the figure at the bottom.
    expect(money(s.opening + s.totals.debit - s.totals.credit)).toBe(money(s.closing));
  });

  it('agrees with the journal it was read from', async () => {
    const res = await statementFor('CUSTOMER', context.customerId);
    expect(money(res.body.data.closing)).toBe(await journalBalance('CUSTOMER', context.customerId));
  });

  it('carries the running balance down the lines', async () => {
    const res = await statementFor('CUSTOMER', context.customerId);
    const s = res.body.data;
    if (!s.lines.length) return;

    let running = s.opening;
    for (const line of s.lines) {
      running = money(running + line.debit - line.credit);
      expect(money(line.balance), `after ${line.documentNo}`).toBe(running);
    }
    expect(money(s.lines[s.lines.length - 1].balance)).toBe(money(s.closing));
  });

  it('names the document every line came from', async () => {
    const res = await statementFor('CUSTOMER', context.customerId);
    for (const line of res.body.data.lines) {
      // A statement whose lines say only "Dealer sale" cannot settle a
      // dispute; the number is what the party recognises.
      expect(line.documentNo, line.particulars).toBeTruthy();
      expect(line.documentLabel).toBeTruthy();
      expect(line.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  /* -------------------------------------------------------------- direction */

  it('says a customer owes us and a supplier is owed', async () => {
    const customer = (await statementFor('CUSTOMER', context.customerId)).body.data;
    const supplier = (await statementFor('SUPPLIER', context.supplierId)).body.data;

    expect(customer.totals.direction).toBe('RECEIVABLE');
    expect(customer.totals.outstanding).toBeGreaterThan(0);

    // A farmer's balance is negative because we owe them, which is a
    // direction rather than a shortfall.
    expect(supplier.closing).toBeLessThan(0);
    expect(supplier.totals.direction).toBe('PAYABLE');
    expect(supplier.totals.outstanding).toBe(Math.abs(supplier.closing));
  });

  it('nets a company that both supplies and buys', async () => {
    const res = await statementFor('COMPANY', context.companyId);
    expect(res.status).toBe(200);

    const s = res.body.data;
    // One party with two relationships has one balance, and the documents on
    // it come from both sides.
    expect(['RECEIVABLE', 'PAYABLE', 'SETTLED']).toContain(s.totals.direction);
    expect(money(s.opening + s.totals.debit - s.totals.credit)).toBe(money(s.closing));
  });

  /* ---------------------------------------------------------------- periods */

  it('folds everything before the period into the opening balance', async () => {
    const whole = (await statementFor('CUSTOMER', context.customerId)).body.data;
    const from = today();
    const part = (await statementFor('CUSTOMER', context.customerId, `?from=${from}`)).body.data;

    // A statement for one day still starts where the day before left off, and
    // still closes where the whole account closes.
    expect(money(part.closing)).toBe(money(whole.closing));
    expect(part.lines.length).toBeLessThanOrEqual(whole.lines.length);
    expect(money(part.opening + part.totals.debit - part.totals.credit)).toBe(money(part.closing));
  });

  it('opens at nothing when the statement covers everything', async () => {
    const s = (await statementFor('CUSTOMER', context.customerId)).body.data;
    // Nothing happened before "the beginning", so counting the whole account
    // as an opening balance would report it twice.
    expect(s.opening).toBe(0);
  });

  it('reports a period with nothing in it as a period with nothing in it', async () => {
    const s = (await statementFor('CUSTOMER', context.customerId, '?from=2000-01-01&to=2000-12-31'))
      .body.data;

    expect(s.lines).toHaveLength(0);
    expect(s.opening).toBe(0);
    expect(s.closing).toBe(0);
    expect(s.totals.direction).toBe('SETTLED');
  });

  /* ------------------------------------------------------- what it includes */

  it('picks up a new invoice the moment it is posted', async () => {
    const before = (await statementFor('CUSTOMER', context.customerId)).body.data;

    await postDocument(app, auth, '/api/dealer/purchases', {
      txnDate: today(),
      companyId: context.companyId,
      warehouseId: context.warehouseId,
      lines: [{ productId: context.productId, quantity: 5, rate: 900, discountPct: 0 }],
      action: 'POST',
    });
    const sale = await postDocument(app, auth, '/api/dealer/sales', {
      txnDate: today(),
      customerId: context.customerId,
      warehouseId: context.warehouseId,
      lines: [{ productId: context.productId, quantity: 5, rate: 1200, discountPct: 0 }],
      action: 'POST',
    });

    const after = (await statementFor('CUSTOMER', context.customerId)).body.data;
    expect(money(after.closing - before.closing)).toBe(6000);
    expect(after.lines.some((l) => l.documentNo === sale.txnNo)).toBe(true);
    expect(after.documents.some((d) => d.no === sale.txnNo)).toBe(true);
  });

  it('takes a receipt off the balance and names what it settled', async () => {
    const accounts = (await request(app).get('/api/accounts').set(auth())).body.data;
    const before = (await statementFor('CUSTOMER', context.customerId)).body.data;
    const open = (
      await request(app)
        .get(`/api/receivables?partyType=CUSTOMER&partyId=${context.customerId}&pageSize=5`)
        .set(auth())
    ).body.data;

    // Settle exactly what the oldest open invoice still carries. Paying more
    // than an invoice owes is refused, and rightly -- the point here is the
    // statement, not the allocation rule.
    const amount = open.length ? Math.min(500, money(open[0].balance)) : 500;
    const res = await request(app)
      .post('/api/payments')
      .set(auth())
      .send({
        txnDate: today(),
        direction: 'RECEIPT',
        businessType: 'DEALER',
        partyType: 'CUSTOMER',
        partyId: context.customerId,
        accountId: accounts[0].id,
        amount,
        allocations: open.length
          ? [{ invoiceType: open[0].invoiceType, invoiceId: open[0].invoiceId, amount }]
          : [],
      });
    expect(res.status, JSON.stringify(res.body.error)).toBe(201);

    const after = (await statementFor('CUSTOMER', context.customerId)).body.data;
    expect(money(after.closing - before.closing)).toBe(-amount);

    const receipt = after.payments.find((p) => p.no === res.body.data.txnNo);
    expect(receipt, 'the receipt on the statement').toBeTruthy();
    // Either the invoice it settled, or an honest "on account" — a blank
    // column is what stops the receipts and the balance reconciling.
    expect(receipt.against).toBeTruthy();
  });

  it('shows a credit note as money the party no longer owes', async () => {
    const before = (await statementFor('CUSTOMER', context.customerId)).body.data;

    const note = await request(app)
      .post('/api/credit-notes')
      .set(auth())
      .send({
        noteDate: today(),
        noteType: 'CREDIT',
        businessType: 'DEALER',
        partyType: 'CUSTOMER',
        partyId: context.customerId,
        reason: 'Allowance agreed after invoicing',
        amount: 250,
      });
    expect(note.status, JSON.stringify(note.body.error)).toBe(201);

    const after = (await statementFor('CUSTOMER', context.customerId)).body.data;
    expect(money(after.closing - before.closing)).toBe(-250);
    expect(after.lines.some((l) => l.documentNo === note.body.data.noteNo)).toBe(true);
  });

  /* --------------------------------------------------------------- the rest */

  it('ages what is still outstanding', async () => {
    const s = (await statementFor('CUSTOMER', context.customerId)).body.data;
    const { current, b30, b60, b90, b90plus, total } = s.aging;

    expect(money(current + b30 + b60 + b90 + b90plus)).toBe(money(total));
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it('carries the party themselves, for the paper it goes on', async () => {
    const s = (await statementFor('CUSTOMER', context.customerId)).body.data;

    expect(s.party.code).toBeTruthy();
    expect(s.party.name).toBeTruthy();
    expect(s.party.partyType).toBe('CUSTOMER');
    // A statement is printed and posted; it needs an address and a BIN column
    // even when they happen to be empty.
    expect(s.party).toHaveProperty('address');
    expect(s.party).toHaveProperty('binNo');
  });

  it('refuses a party this organisation does not have', async () => {
    const res = await statementFor('CUSTOMER', 999_999);
    expect(res.status).toBe(404);
  });

  it('refuses a kind of party that does not exist', async () => {
    const res = await request(app).get('/api/parties/BANKER/1/statement').set(auth());
    expect(res.status).toBe(400);
  });

  it('refuses a user who may not see the party at all', async () => {
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

    // Warehouse handles goods, not balances.
    const res = await request(app)
      .get(`/api/parties/CUSTOMER/${context.customerId}/statement`)
      .set({ authorization: `Bearer ${login.body.data.accessToken}` });
    expect(res.status).toBe(403);
  });
});
