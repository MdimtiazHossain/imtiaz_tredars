import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, withTransaction, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { LEDGER, ledgerAccount, writeLedger } from '../src/services/financeService.js';

/**
 * The chart of accounts.
 *
 * `ledger_entries` was already a balanced double-entry journal with nowhere to
 * classify an entry to, so the books could produce a cash book and not a trial
 * balance. These assert the classification actually holds: that every posting
 * path names an account, that it names the right one, and that the two sides
 * of the whole ledger are equal — the one property that makes a trial balance
 * worth printing at all.
 */
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';
let app;
let token;
let orgId;

const auth = () => ({ authorization: `Bearer ${token}` });

suite('chart of accounts', () => {
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
  });

  afterAll(async () => {
    await closePool();
  });

  /* --------------------------------------------------------------- the chart */

  it('installs a chart covering all five statement classes', async () => {
    const { rows } = await query(
      `SELECT account_class, COUNT(*)::int n FROM chart_of_accounts
        WHERE org_id = $1 GROUP BY account_class`,
      [orgId]
    );
    const classes = Object.fromEntries(rows.map((r) => [r.account_class, r.n]));
    for (const k of ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']) {
      expect(classes[k], k).toBeGreaterThan(0);
    }
  });

  it('hangs every account under a heading of its own class', async () => {
    const { rows } = await query(
      `SELECT c.code, c.account_class, p.account_class AS parent_class
         FROM chart_of_accounts c
         JOIN chart_of_accounts p ON p.id = c.parent_id
        WHERE c.org_id = $1`,
      [orgId]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.parent_class, r.code).toBe(r.account_class);
  });

  it('marks the accounts the posting paths depend on as system accounts', async () => {
    const codes = Object.values(LEDGER);
    const { rows } = await query(
      `SELECT code FROM chart_of_accounts
        WHERE org_id = $1 AND is_system AND code = ANY($2::text[])`,
      [orgId, codes]
    );
    expect(rows.map((r) => r.code).sort()).toEqual([...codes].sort());
  });

  /* ----------------------------------------------------- every entry classified */

  it('leaves no journal entry without an account', async () => {
    const { rows } = await query('SELECT COUNT(*)::int n FROM ledger_entries WHERE coa_id IS NULL');
    expect(rows[0].n).toBe(0);
  });

  it('refuses a journal entry posted to a heading rather than an account', async () => {
    const { rows } = await query(
      'SELECT id FROM chart_of_accounts WHERE org_id = $1 AND is_group LIMIT 1',
      [orgId]
    );

    await expect(
      withTransaction((client) =>
        writeLedger(client, {
          orgId,
          coaId: Number(rows[0].id),
          entryDate: '2026-08-01',
          narration: 'posting to a heading',
          debit: 100,
          credit: 0,
          referenceType: 'test',
          referenceId: 1,
          userId: 1,
        })
      )
    ).rejects.toThrow(/LEDGER_ACCOUNT_IS_A_GROUP/);
  });

  it('refuses to resolve an account that is not in the chart', async () => {
    await expect(withTransaction((client) => ledgerAccount(client, orgId, '9999'))).rejects.toThrow(
      /missing from the chart/
    );
  });

  /* ------------------------------------------------------------ trial balance */

  it('balances: total debits equal total credits', async () => {
    const { rows } = await query(
      'SELECT SUM(total_debit) AS d, SUM(total_credit) AS c FROM v_trial_balance WHERE org_id = $1',
      [orgId]
    );
    expect(Number(rows[0].d)).toBe(Number(rows[0].c));
  });

  it('signs each balance by the nature of its account', async () => {
    const { rows } = await query(
      `SELECT account_class, total_debit, total_credit, balance
         FROM v_trial_balance
        WHERE org_id = $1 AND (total_debit > 0 OR total_credit > 0)`,
      [orgId]
    );
    for (const r of rows) {
      const debitNatured = ['ASSET', 'EXPENSE'].includes(r.account_class);
      const expected = debitNatured
        ? Number(r.total_debit) - Number(r.total_credit)
        : Number(r.total_credit) - Number(r.total_debit);
      expect(Number(r.balance), r.account_class).toBe(expected);
    }
  });

  /* --------------------------------------- postings land where they belong */

  it('files a dealer sale as a receivable against sales income', async () => {
    const { rows } = await query(
      `SELECT c.code, l.debit, l.credit
         FROM ledger_entries l
         JOIN chart_of_accounts c ON c.id = l.coa_id
        WHERE l.reference_type = 'dealer_sales'
        ORDER BY l.id LIMIT 2`
    );
    if (!rows.length) return;
    expect(rows.find((r) => Number(r.debit) > 0).code).toBe(LEDGER.RECEIVABLE);
    expect(rows.find((r) => Number(r.credit) > 0).code).toBe(LEDGER.DEALER_SALES);
  });

  it('files a crop purchase as inventory against a payable', async () => {
    const { rows } = await query(
      `SELECT c.code, l.debit, l.credit
         FROM ledger_entries l
         JOIN chart_of_accounts c ON c.id = l.coa_id
        WHERE l.reference_type = 'crop_purchases'
        ORDER BY l.id LIMIT 2`
    );
    if (!rows.length) return;
    expect(rows.find((r) => Number(r.debit) > 0).code).toBe(LEDGER.INVENTORY);
    expect(rows.find((r) => Number(r.credit) > 0).code).toBe(LEDGER.PAYABLE);
  });

  it('keeps the books balanced after another document is posted', async () => {
    const difference = async () => {
      const { rows } = await query(
        `SELECT SUM(total_debit) - SUM(total_credit) AS diff
           FROM v_trial_balance WHERE org_id = $1`,
        [orgId]
      );
      return Number(rows[0].diff);
    };

    expect(await difference()).toBe(0);

    const ctx = (await request(app).get('/api/reference/context').set(auth())).body.data;
    const customers = (await request(app).get('/api/customers').set(auth())).body.data;
    const products = (await request(app).get('/api/products').set(auth())).body.data;
    if (!customers.length || !products.length) return;

    const res = await request(app)
      .post('/api/dealer/sales')
      .set(auth())
      .send({
        txnDate: new Date().toISOString().slice(0, 10),
        customerId: customers[0].id,
        warehouseId: Object.values(ctx.warehouseIds)[0],
        lines: [{ productId: products[0].id, quantity: 1, rate: 10, discountPct: 0 }],
        action: 'POST',
      });

    // Whether it posted or was refused for stock, the books must still balance.
    expect([201, 422]).toContain(res.status);
    expect(await difference()).toBe(0);
  });
});
