import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { masters } from './helpers/fixture.js';

/**
 * Reading the stock the business is holding.
 *
 * The Inventory screen asks for no particular sort, and that was the one
 * request the endpoint could not answer: it appended a direction to an ORDER BY
 * that already carried one, built `ORDER BY stock_value ASC DESC`, and got a
 * syntax error back from Postgres every time. The screen read the resulting 500
 * the only way it could and drew "Stock could not be loaded" over a warehouse
 * that was full.
 *
 * So the plain unsorted request is tested first, and then every sort the
 * endpoint offers, in both directions -- because the mistake was in building
 * the clause rather than in any one column, and it would come back the same way
 * for any of them.
 */
const suite = HAS_DB ? describe : describe.skip;

let app;
let fixture;
let orgId;

const auth = () => fixture.auth;
const stock = (qs = '') => request(app).get(`/api/inventory${qs}`).set(auth());

/** The largest page the endpoint will give out, from its own schema. */
const PAGE_CAP = 200;

/**
 * Every line, by following the pages.
 *
 * A single request returns a page and says how many lines there are in total.
 * Treating that page as the whole list is the mistake the screen itself once
 * made, and it holds for exactly as long as the business has less stock than
 * fits on one page.
 */
async function everyStockLine(pageSize = 60) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const res = await request(app)
      .get(`/api/inventory?page=${page}&pageSize=${pageSize}`)
      .set(auth());
    if (res.status !== 200) throw new Error(`page ${page} -> ${res.status}`);
    rows.push(...res.body.data);
    if (rows.length >= res.body.meta.total || !res.body.data.length) return rows;
  }
}

/** Something that names a stock line uniquely: one item, in one warehouse. */
const identify = (r) => `${r.kind}|${r.name}|${r.sub}|${r.warehouse}`;

suite('stock list', () => {
  beforeAll(async () => {
    app = createApp();
    // Its own account and its own masters, so this runs against a database
    // holding only the system foundation as readily as against a seeded one.
    fixture = await masters(app);
    orgId = fixture.orgId;

    // A line of stock to read back, bought the way a clerk would buy it.
    await request(app)
      .post('/api/dealer/purchases')
      .set(auth())
      .send({
        txnDate: new Date().toISOString().slice(0, 10),
        companyId: fixture.principal.id,
        warehouseId: fixture.warehouse.id,
        lines: [{ productId: fixture.product.id, quantity: 25, rate: 1000 }],
        action: 'POST',
      });
  });

  afterAll(async () => {
    await closePool();
  });

  it('answers the request the screen actually makes', async () => {
    // Exactly what the client sends: a page, a size, and no opinion on order.
    const res = await stock(`?page=1&pageSize=${PAGE_CAP}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('reports the stock the database is holding', async () => {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS lines
         FROM stock s
        WHERE s.org_id = $1 AND s.quantity > 0`,
      [orgId]
    );
    const res = await stock(`?pageSize=${PAGE_CAP}`);

    expect(res.status).toBe(200);
    // A line per item per warehouse, which is what the stock table holds. The
    // count is the whole of it; one page is at most a page of it, and asserting
    // otherwise made this pass only while the database held fewer lines than a
    // page. It accumulates about seventeen batches a run, so the test would
    // pass for a week and then start failing on unchanged code, naming a file
    // that had nothing to do with whatever was last touched.
    expect(res.body.meta.total).toBe(rows[0].lines);
    expect(res.body.data.length).toBe(Math.min(rows[0].lines, PAGE_CAP));
  });

  it('puts the most valuable stock first when nothing was chosen', async () => {
    const res = await stock(`?pageSize=${PAGE_CAP}`);
    const values = res.body.data.map((r) => r.value);

    expect(res.status).toBe(200);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it('sorts by every column it offers, both ways', async () => {
    // The bug was in assembling the clause, not in one column, so each key the
    // endpoint documents is asked for rather than a representative one.
    for (const sort of ['name', 'qty', 'value', 'age']) {
      for (const dir of ['asc', 'desc']) {
        const res = await stock(`?sort=${sort}&dir=${dir}&pageSize=${PAGE_CAP}`);
        expect(res.status, `${sort} ${dir}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    }
  });

  it('honours an ascending sort by value, which the default reverses', async () => {
    const res = await stock(`?sort=value&dir=asc&pageSize=${PAGE_CAP}`);
    const values = res.body.data.map((r) => r.value);

    expect(res.status).toBe(200);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('ignores a sort key it does not know rather than failing', async () => {
    const res = await stock(`?sort=whatever&pageSize=${PAGE_CAP}`);
    expect(res.status).toBe(200);
  });

  it('separates the two kinds of stock', async () => {
    const [crop, dealer, all] = await Promise.all([
      stock(`?kind=crop&pageSize=${PAGE_CAP}`),
      stock(`?kind=dealer&pageSize=${PAGE_CAP}`),
      stock(`?pageSize=${PAGE_CAP}`),
    ]);

    expect(crop.body.data.every((r) => r.kind === 'crop')).toBe(true);
    expect(dealer.body.data.every((r) => r.kind === 'dealer')).toBe(true);
    expect(crop.body.meta.total + dealer.body.meta.total).toBe(all.body.meta.total);
  });

  it('totals the valuation over every line, not the page in view', async () => {
    // The whole list, followed page by page, against what a single line's page
    // claims the valuation is. Summing one page and calling it the total was
    // the same mistake this test exists to catch the endpoint making.
    const everything = await everyStockLine();
    const sum = everything.reduce((t, r) => t + r.value, 0);
    const page = await stock('?pageSize=1');

    expect(page.body.data.length).toBe(1);
    expect(page.body.meta.total).toBe(everything.length);
    expect(page.body.meta.totalValue).toBeCloseTo(sum, 2);
  });

  it('pages through the whole list without repeating or losing a line', async () => {
    // Rows tied on the sorted column need a fixed position between pages, or
    // paging shows one line twice and drops another -- which reads as stock the
    // business does not have beside stock it does.
    //
    // Two page sizes that divide the list differently, so a tie sitting on a
    // boundary for one of them does not sit on a boundary for the other. A
    // page of one row was the strictest version of this and also the slowest:
    // one request per line, on a list that grows every run.
    const sevens = await everyStockLine(7);
    const elevens = await everyStockLine(11);
    if (sevens.length < 2) return;

    const seen = sevens.map(identify);
    expect(new Set(seen).size, 'a line appeared on two pages').toBe(seen.length);
    expect([...seen].sort()).toEqual(elevens.map(identify).sort());

    const { body } = await stock('?pageSize=1');
    expect(seen.length).toBe(body.meta.total);
  });
});
