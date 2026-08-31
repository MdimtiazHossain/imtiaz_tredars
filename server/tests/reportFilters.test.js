import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { describeEntityFilters } from '../src/routes/reportHelpers.js';

/**
 * Narrowing a report.
 *
 * The Reports Centre drew a row of filters -- warehouse, customer, supplier,
 * crop -- that all read "All" and could not be changed, because nothing behind
 * them did anything. A filter that cannot filter is worse than no filter: it
 * tells the reader the report has been narrowed when it has not.
 *
 * Two things have to hold. A report must only offer a filter it actually
 * applies, and applying one must change the answer.
 */
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';
let app;
let token;
let context;
let catalogue;

const auth = () => ({ authorization: `Bearer ${token}` });
const money = (n) => Math.round(Number(n) * 100) / 100;

const run = (id, params = '') =>
  request(app).get(`/api/reports/${id}?pageSize=200${params}`).set(auth());

suite('report filters', () => {
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

    const ctx = (await request(app).get('/api/reference/context').set(auth())).body.data;
    const customers = (await request(app).get('/api/customers').set(auth())).body.data;
    const suppliers = (await request(app).get('/api/suppliers').set(auth())).body.data;
    const products = (await request(app).get('/api/products').set(auth())).body.data;
    const crops = (await request(app).get('/api/crops').set(auth())).body.data;
    context = {
      warehouseId: Object.values(ctx.warehouseIds)[0],
      customerId: customers[0] && customers[0].id,
      supplierId: suppliers[0] && suppliers[0].id,
      productId: products[0] && products[0].id,
      cropId: crops[0] && crops[0].id,
    };

    catalogue = (await request(app).get('/api/reports/catalogue').set(auth())).body.data.flatMap(
      (g) => g.items
    );
  });

  afterAll(async () => {
    await closePool();
  });

  /* ------------------------------------------------------------- the offer */

  it('says which filters each report can be narrowed by', async () => {
    const narrowable = catalogue.filter((r) => r.filters.length);
    expect(narrowable.length).toBeGreaterThan(0);

    for (const report of catalogue) {
      // Every report answers the question, even if the answer is none.
      expect(Array.isArray(report.filters), report.id).toBe(true);
      for (const filter of report.filters) {
        expect(filter.key, report.id).toBeTruthy();
        // A picker needs a label to show and a list to draw from; without
        // either the client cannot render it.
        expect(filter.label, `${report.id}.${filter.key}`).toBeTruthy();
        expect(filter.source, `${report.id}.${filter.key}`).toBeTruthy();
      }
    }
  });

  it('offers no filter it would ignore', async () => {
    const byCustomer = catalogue.find((r) => r.id === 'sales-customer');
    expect(byCustomer.filters.map((f) => f.key)).toEqual([
      'customerId',
      'warehouseId',
      'employeeId',
    ]);

    // A statement of the whole business has nothing to narrow by, and says so
    // by offering nothing rather than offering pickers that do nothing.
    const pl = catalogue.find((r) => r.id === 'fin-pl');
    expect(pl.filters).toEqual([]);
  });

  /* ------------------------------------------------------------ the effect */

  it('narrows a sales report to one customer', async () => {
    const all = await run('sales-customer');
    const one = await run('sales-customer', `&customerId=${context.customerId}`);
    expect(one.status).toBe(200);

    expect(all.body.data.rows.length).toBeGreaterThan(1);
    expect(one.body.data.rows).toHaveLength(1);
    // And the total is the narrowed total, not the whole business's.
    expect(money(one.body.data.totals.sales)).toBeLessThan(money(all.body.data.totals.sales));
  });

  it('narrows stock to one warehouse', async () => {
    const all = await run('inv-current');
    const one = await run('inv-current', `&warehouseId=${context.warehouseId}`);

    expect(one.body.data.rows.length).toBeLessThanOrEqual(all.body.data.rows.length);
    const warehouses = new Set(one.body.data.rows.map((r) => r.warehouse));
    expect(warehouses.size).toBeLessThanOrEqual(1);
  });

  it('narrowing stock to a crop leaves the products out', async () => {
    const res = await run('inv-current', `&cropId=${context.cropId}`);
    expect(res.status).toBe(200);

    // Asking for one crop is asking not to see products at all; leaving the
    // other half of the union wide open would answer a different question.
    expect(res.body.data.rows.every((r) => r.kind === 'Bulk Crop')).toBe(true);
  });

  it('narrowing stock to a product leaves the crops out', async () => {
    const res = await run('inv-current', `&productId=${context.productId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((r) => r.kind === 'Dealer')).toBe(true);
  });

  it('narrows a purchase report to one supplier', async () => {
    const all = await run('pur-supplier');
    const one = await run('pur-supplier', `&supplierId=${context.supplierId}`);

    expect(one.status).toBe(200);
    expect(one.body.data.rows.length).toBeLessThanOrEqual(all.body.data.rows.length);
    if (one.body.data.rows.length) expect(one.body.data.rows).toHaveLength(1);
  });

  it('narrows the aging report to one party', async () => {
    const all = await run('fin-aging');
    const one = await run('fin-aging', `&customerId=${context.customerId}`);

    expect(one.status).toBe(200);
    expect(one.body.data.rows.length).toBeLessThanOrEqual(all.body.data.rows.length);
  });

  it('combines a date range with an entity', async () => {
    const res = await run(
      'sales-customer',
      `&customerId=${context.customerId}&from=2000-01-01&to=2000-12-31`
    );
    expect(res.status).toBe(200);
    // Both applied: this customer, and a period they traded nothing in.
    expect(res.body.data.rows).toHaveLength(0);
  });

  it('leaves a report alone when nothing was chosen', async () => {
    const plain = await run('sales-customer');
    const empty = await run('sales-customer', '&customerId=');

    expect(empty.status).toBe(200);
    expect(empty.body.data.rows).toHaveLength(plain.body.data.rows.length);
  });

  it('refuses a filter that is not a number', async () => {
    const res = await run('sales-customer', '&customerId=; DROP TABLE customers');
    // Parsed and rejected, never spliced: the value is bound, and the column
    // it binds to comes from the report rather than from the request.
    expect(res.status).toBe(400);

    const { rows } = await query("SELECT to_regclass('customers') AS still_here");
    expect(rows[0].still_here).toBe('customers');
  });

  /* ------------------------------------------------------------ the export */

  it('names on the file what the report was narrowed to', async () => {
    const customers = (await request(app).get('/api/customers').set(auth())).body.data;
    const customer = customers.find((c) => c.id === context.customerId);

    const said = await describeEntityFilters(
      query,
      Number((await query('SELECT id FROM organizations LIMIT 1')).rows[0].id),
      { customerId: context.customerId },
      { customerId: 's.customer_id', warehouseId: 's.warehouse_id' }
    );

    // A filed report has to say what it covers; a header reading "Business
    // type: All" over one customer's figures misrepresents itself.
    expect(said).toEqual([`Customer: ${customer.name}`]);
  });

  it('names a filter whose record has since been removed', async () => {
    const said = await describeEntityFilters(
      query,
      1,
      { warehouseId: 999999 },
      { warehouseId: 'w.id' }
    );
    // It still narrowed the report, so it is reported rather than dropped.
    expect(said).toEqual(['Warehouse: #999999']);
  });

  it('says nothing about a report nothing was chosen for', async () => {
    const said = await describeEntityFilters(query, 1, {}, { customerId: 's.customer_id' });
    expect(said).toEqual([]);
  });

  it('still downloads the narrowed report', async () => {
    const res = await request(app)
      .get(`/api/reports/sales-customer/export?format=xlsx&customerId=${context.customerId}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('.xlsx');
  });
});
