import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';

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

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';

let app;
let token;
let orgId;

const auth = () => ({ authorization: `Bearer ${token}` });
const stock = (qs = '') => request(app).get(`/api/inventory${qs}`).set(auth());

/** Something that names a stock line uniquely: one item, in one warehouse. */
const identify = (r) => `${r.kind}|${r.name}|${r.sub}|${r.warehouse}`;

suite('stock list', () => {
  beforeAll(async () => {
    app = createApp();
    const { rows } = await query(
      `SELECT u.username, u.org_id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'Admin' AND u.is_active ORDER BY u.id LIMIT 1`
    );
    if (!rows.length) throw new Error('Seed the test database first: npm run db:seed');
    // The endpoint reads the organisation off the token, so the count this
    // is checked against has to come from the same user rather than an id
    // written in here.
    orgId = Number(rows[0].org_id);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: rows[0].username, password: PASSWORD });
    token = res.body.data.accessToken;
  });

  afterAll(async () => {
    await closePool();
  });

  it('answers the request the screen actually makes', async () => {
    // Exactly what the client sends: a page, a size, and no opinion on order.
    const res = await stock('?page=1&pageSize=200');

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
    const res = await stock('?pageSize=200');

    expect(res.status).toBe(200);
    // A line per item per warehouse, which is what the stock table holds.
    expect(res.body.meta.total).toBe(rows[0].lines);
    expect(res.body.data.length).toBe(rows[0].lines);
  });

  it('puts the most valuable stock first when nothing was chosen', async () => {
    const res = await stock('?pageSize=200');
    const values = res.body.data.map((r) => r.value);

    expect(res.status).toBe(200);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it('sorts by every column it offers, both ways', async () => {
    // The bug was in assembling the clause, not in one column, so each key the
    // endpoint documents is asked for rather than a representative one.
    for (const sort of ['name', 'qty', 'value', 'age']) {
      for (const dir of ['asc', 'desc']) {
        const res = await stock(`?sort=${sort}&dir=${dir}&pageSize=200`);
        expect(res.status, `${sort} ${dir}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    }
  });

  it('honours an ascending sort by value, which the default reverses', async () => {
    const res = await stock('?sort=value&dir=asc&pageSize=200');
    const values = res.body.data.map((r) => r.value);

    expect(res.status).toBe(200);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('ignores a sort key it does not know rather than failing', async () => {
    const res = await stock('?sort=whatever&pageSize=200');
    expect(res.status).toBe(200);
  });

  it('separates the two kinds of stock', async () => {
    const [crop, dealer, all] = await Promise.all([
      stock('?kind=crop&pageSize=200'),
      stock('?kind=dealer&pageSize=200'),
      stock('?pageSize=200'),
    ]);

    expect(crop.body.data.every((r) => r.kind === 'crop')).toBe(true);
    expect(dealer.body.data.every((r) => r.kind === 'dealer')).toBe(true);
    expect(crop.body.meta.total + dealer.body.meta.total).toBe(all.body.meta.total);
  });

  it('totals the valuation over every line, not the page in view', async () => {
    const [page, everything] = await Promise.all([stock('?pageSize=1'), stock('?pageSize=200')]);
    const sum = everything.body.data.reduce((t, r) => t + r.value, 0);

    expect(page.body.data.length).toBe(1);
    expect(page.body.meta.totalValue).toBeCloseTo(sum, 2);
    expect(page.body.meta.totalValue).toBeCloseTo(everything.body.meta.totalValue, 2);
  });

  it('pages through the whole list without repeating or losing a line', async () => {
    // Rows tied on the sorted column need a fixed position between pages, or
    // paging shows one line twice and drops another -- which reads as stock the
    // business does not have beside stock it does.
    const everything = await stock('?pageSize=200');
    const total = everything.body.meta.total;
    if (total < 2) return;

    const seen = [];
    for (let page = 1; page <= total; page += 1) {
      const res = await stock(`?page=${page}&pageSize=1`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map(identify));
    }

    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual(everything.body.data.map(identify).sort());
  });
});
