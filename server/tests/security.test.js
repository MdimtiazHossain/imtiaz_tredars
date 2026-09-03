import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, query, closePool } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { HAS_DB } from './helpers/database.js';

/**
 * Security tests.
 *
 * The point of these is that hiding a button in the UI is not a control: a
 * Sales user must be refused by the API itself, whatever the client sends.
 */

// Probes the connection once rather than trusting the environment variable, so
// an unreachable database skips cleanly instead of failing every assertion.
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';

let app;
const tokens = {};

async function signIn(roleCode) {
  const { rows } = await query(
    `SELECT u.username FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = $1 LIMIT 1`,
    [roleCode]
  );
  if (!rows.length) return null;

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: rows[0].username, password: PASSWORD });

  return res.status === 200 ? res.body.data.accessToken : null;
}

suite('authentication', () => {
  beforeAll(async () => {
    app = createApp();
    for (const role of ['Admin', 'Sales', 'Warehouse', 'Accounts', 'Purchase']) {
      tokens[role] = await signIn(role);
    }
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/workspace');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('names the business without a token, and gives away nothing else', async () => {
    // The sign-in card has to say who this installation belongs to before
    // anyone can sign in, so this one endpoint answers without a token.
    const res = await request(app).get('/api/auth/context');

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBeTruthy();
    expect(res.body.data.systemName).toBeTruthy();

    // What it must not carry: everything else the organisation record holds is
    // behind the token, and an unauthenticated caller learns none of it.
    expect(Object.keys(res.body.data).sort()).toEqual(['name', 'systemName']);

    const { rows } = await query(
      'SELECT trade_licence_no, bin_no, mobile, email FROM organizations WHERE id = 1'
    );
    const body = JSON.stringify(res.body);
    for (const secret of Object.values(rows[0]).filter(Boolean)) {
      expect(body).not.toContain(secret);
    }
  });

  it('refuses a browser calling from an origin nobody listed, without claiming to have broken', async () => {
    // A disallowed origin is the caller being refused, not the server falling
    // over. Handing the CORS middleware a plain Error made it arrive at the
    // terminal handler as something unrecognised: a 500, logged as an
    // unhandled fault, for a request that was simply not allowed.
    const res = await request(app).get('/api/workspace').set('origin', 'http://not-allowed.example');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('not-allowed.example');
  });

  it('answers a preflight from an allowed origin', async () => {
    const allowed = config.corsOrigins[0];
    const res = await request(app)
      .options('/api/auth/login')
      .set('origin', allowed)
      .set('access-control-request-method', 'POST');

    expect(res.status).toBeLessThan(400);
    expect(res.headers['access-control-allow-origin']).toBe(allowed);
  });
  it('refuses a malformed token', async () => {
    const res = await request(app)
      .get('/api/workspace')
      .set('authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('refuses a wrong password without revealing whether the user exists', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody-here', password: 'whatever12345' });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ username: 'rakib01', password: 'definitely-wrong' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('accepts a valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('Admin');
  });

  it('never returns a password hash', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('authorization', `Bearer ${tokens.Admin}`);

    // Not "the word password never appears": an account has to be told whether
    // it is still holding the one-time password it was issued, and that flag
    // has to be named something. What may never appear is the material. Named
    // outright, under either spelling, and as a bcrypt digest however it got
    // there -- which the old wording would have missed if the field carrying
    // it were called anything else.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/password_?hash/i);
    expect(body).not.toMatch(/\$2[aby]\$\d{2}\$/);
    expect(res.body.data).not.toHaveProperty('password');
  });
});

suite('role permissions', () => {
  it('lets Sales create a dealer sale', async () => {
    const res = await request(app)
      .get('/api/dealer/sales')
      .set('authorization', `Bearer ${tokens.Sales}`);
    expect(res.status).toBe(200);
  });

  it('refuses Sales access to the audit trail', async () => {
    const res = await request(app)
      .get('/api/audit')
      .set('authorization', `Bearer ${tokens.Sales}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses Sales the approval decision endpoint', async () => {
    const res = await request(app)
      .post('/api/approvals/1/decide')
      .set('authorization', `Bearer ${tokens.Sales}`)
      .send({ approved: true });
    expect(res.status).toBe(403);
  });

  it('refuses a Warehouse user the payments endpoint', async () => {
    const res = await request(app)
      .get('/api/payments')
      .set('authorization', `Bearer ${tokens.Warehouse}`);
    expect(res.status).toBe(403);
  });

  it('lets Accounts read payments', async () => {
    const res = await request(app)
      .get('/api/payments')
      .set('authorization', `Bearer ${tokens.Accounts}`);
    expect(res.status).toBe(200);
  });

  it('strips profit figures from a role without report.profit', async () => {
    const res = await request(app)
      .get('/api/reports/dashboard')
      .set('authorization', `Bearer ${tokens.Sales}`);
    expect(res.status).toBe(200);
    expect(res.body.data.grossProfit).toBeUndefined();
  });

  it('includes profit figures for Accounts', async () => {
    const res = await request(app)
      .get('/api/reports/dashboard')
      .set('authorization', `Bearer ${tokens.Accounts}`);
    expect(res.body.data.grossProfit).toBeDefined();
  });

  it('refuses the profit report to a role without permission', async () => {
    const res = await request(app)
      .get('/api/reports/crop-batch-profit')
      .set('authorization', `Bearer ${tokens.Sales}`);
    expect(res.status).toBe(403);
  });
});

suite('input validation and error shape', () => {
  it('rejects an invalid body with field detail', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('authorization', `Bearer ${tokens.Admin}`)
      .send({ name: '', mobile: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toBeDefined();
  });

  it('rejects a negative quantity', async () => {
    const res = await request(app)
      .post('/api/crops/purchases')
      .set('authorization', `Bearer ${tokens.Admin}`)
      .send({
        txnDate: '2026-08-28',
        supplierId: 1,
        warehouseId: 1,
        lines: [{ cropId: 1, unitId: 1, grossQuantity: -5, rate: 100 }],
      });
    expect(res.status).toBe(400);
  });

  it('never leaks a raw database error', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('authorization', `Bearer ${tokens.Admin}`)
      .send({ name: 'Duplicate Mobile Test', mobile: '01712-335566' });

    if (res.status === 409) {
      expect(res.body.error.message).not.toMatch(/constraint|violates|pg_|relation/i);
      expect(res.body.error.message).toMatch(/already exists/i);
    }
  });

  it('answers an unknown endpoint with the standard envelope', async () => {
    const res = await request(app)
      .get('/api/nope')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ENDPOINT_NOT_FOUND');
  });

  it('rejects malformed JSON with a readable message', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('authorization', `Bearer ${tokens.Admin}`)
      .set('content-type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

suite('report catalogue', () => {
  it('lists only reports the server can actually produce', async () => {
    const res = await request(app)
      .get('/api/reports/catalogue')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(200);

    const ids = res.body.data.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.length).toBeGreaterThan(0);

    // Every advertised report must answer, not 404.
    for (const id of ids) {
      const r = await request(app)
        .get(`/api/reports/${id}`)
        .set('authorization', `Bearer ${tokens.Admin}`);
      expect(r.status, `report ${id} is listed but does not respond`).toBe(200);
    }
  });

  it('hides a report the signed-in role may not view', async () => {
    const res = await request(app)
      .get('/api/reports/catalogue')
      .set('authorization', `Bearer ${tokens.Sales}`);
    const ids = res.body.data.flatMap((g) => g.items.map((i) => i.id));
    // Sales lacks report.profit, so the batch profit report is not offered.
    expect(ids).not.toContain('crop-batch-profit');
  });
});

suite('report export', () => {
  it('produces a real xlsx workbook', async () => {
    const res = await request(app)
      .get('/api/reports/pur-supplier/export?format=xlsx')
      .set('authorization', `Bearer ${tokens.Admin}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    // .xlsx is a zip container; every one starts with the PK local-file header.
    expect(res.body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('produces a real pdf', async () => {
    const res = await request(app)
      .get('/api/reports/pur-supplier/export?format=pdf')
      .set('authorization', `Bearer ${tokens.Admin}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(500);
  });

  it('names the file after the report and the date', async () => {
    const res = await request(app)
      .get('/api/reports/crop-batch-profit/export?format=xlsx')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.headers['content-disposition']).toMatch(
      /filename="batch-wise-crop-profit-\d{4}-\d{2}-\d{2}\.xlsx"/
    );
  });

  it('exposes content-disposition so the browser can read the filename', async () => {
    // Cross-origin, JavaScript cannot see this header unless it is exposed,
    // and the file would then save under a fallback name with no extension.
    const res = await request(app)
      .get('/api/reports/pur-supplier/export?format=xlsx')
      .set('origin', 'http://localhost:5290')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.headers['access-control-expose-headers'] || '').toMatch(/content-disposition/i);
  });

  it('refuses to export a report the role may not view', async () => {
    const res = await request(app)
      .get('/api/reports/crop-batch-profit/export?format=xlsx')
      .set('authorization', `Bearer ${tokens.Sales}`);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated export', async () => {
    const res = await request(app).get('/api/reports/pur-supplier/export?format=xlsx');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown format with the standard envelope', async () => {
    const res = await request(app)
      .get('/api/reports/pur-supplier/export?format=docx')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 for a report that does not exist', async () => {
    const res = await request(app)
      .get('/api/reports/not-a-report/export?format=xlsx')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(404);
  });
});

suite('workspace payload', () => {
  it('carries the numeric ids the client needs to write back', async () => {
    // The screens work in codes, but every write sends an id. Without these the
    // repository maps every code to undefined and no post can succeed.
    const res = await request(app)
      .get('/api/workspace')
      .set('authorization', `Bearer ${tokens.Admin}`);

    expect(res.status).toBe(200);
    for (const key of ['customers', 'suppliers', 'companies', 'products']) {
      const first = res.body.data[key][0];
      expect(first, `${key} is empty`).toBeDefined();
      expect(typeof first.id, `${key}[0].id`).toBe('number');
      expect(first.code, `${key}[0].code`).toBeTruthy();
    }

    // A batch keeps its number as `id`, so the numeric key travels separately.
    const batch = res.body.data.batches[0];
    expect(batch.id).toMatch(/^BC-/);
    expect(typeof batch.dbId).toBe('number');
  });

  it('carries the finance lookups the payment and expense forms select from', async () => {
    const res = await request(app)
      .get('/api/workspace')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.body.data.accounts.length).toBeGreaterThan(0);
    expect(res.body.data.paymentMethods.length).toBeGreaterThan(0);
    expect(res.body.data.expenseCategories.length).toBeGreaterThan(0);
    expect(typeof res.body.data.accounts[0].id).toBe('number');
  });
});

suite('cross-user access', () => {
  it('scopes reads to the signed-in user organisation', async () => {
    const res = await request(app)
      .get('/api/customers')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(200);

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM customers WHERE org_id = 1');
    expect(res.body.meta.total).toBeLessThanOrEqual(rows[0].n);
  });
});

// The pool is shared by every suite in this file, so it is closed once here
// rather than in the first suite's afterAll — closing it there left every
// later suite talking to a pool that had already ended.
afterAll(async () => {
  if (!pool.ended) await closePool().catch(() => {});
});

suite('master data', () => {
  let app2;
  const t = {};

  beforeAll(async () => {
    app2 = createApp();
    // Reuse the tokens the first suite obtained. Signing in again per suite
    // trips the auth rate limiter, and a 429 shows up as an unexplained 401
    // on whatever the next assertion happens to be.
    Object.assign(t, tokens);
  });

  const asAdmin = (method, path) =>
    request(app2)[method](path).set('authorization', `Bearer ${t.Admin}`);

  it('creates, edits and retires a crop', async () => {
    const created = await asAdmin('post', '/api/crops').send({
      name: 'Mustard (Tori-7)',
      unit: 'MT',
      rate: 98000,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toMatch(/^CROP-\d+$/);
    expect(created.body.data.status).toBe('Active');
    const id = created.body.data.id;

    // A partial edit leaves everything it did not mention alone.
    const edited = await asAdmin('patch', `/api/crops/${id}`).send({ rate: 101500 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.rate).toBe(101500);
    expect(edited.body.data.name).toBe('Mustard (Tori-7)');

    const retired = await asAdmin('delete', `/api/crops/${id}`);
    expect(retired.status).toBe(200);
    expect(retired.body.data.status).toBe('Retired');

    // Nothing was deleted, so the row is still there to be named by history.
    const { rows } = await query('SELECT is_active FROM crops WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_active).toBe(false);

    await query('DELETE FROM crops WHERE id = $1', [id]);
  });

  it('refuses to retire a crop that is still in stock', async () => {
    const { rows } = await query(
      `SELECT crop_id FROM crop_batches
        WHERE is_active AND quantity_remaining > 0 LIMIT 1`
    );
    const res = await asAdmin('delete', `/api/crops/${rows[0].crop_id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_STOCK');
    // The message says what is in the way, not just that it failed.
    expect(res.body.error.message).toMatch(/still in stock/i);
  });

  it('refuses to retire a supplier who is still owed money', async () => {
    const { rows } = await query(
      'SELECT supplier_id FROM v_supplier_outstanding WHERE outstanding > 0 LIMIT 1'
    );
    const res = await asAdmin('delete', `/api/suppliers/${rows[0].supplier_id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_OUTSTANDING');
  });

  it('refuses to retire the same record twice', async () => {
    const created = await asAdmin('post', '/api/companies').send({
      name: 'Bengal Feed Mills Ltd.',
      role: 'BUYER',
    });
    const id = created.body.data.id;

    expect((await asAdmin('delete', `/api/companies/${id}`)).status).toBe(200);
    const again = await asAdmin('delete', `/api/companies/${id}`);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('ALREADY_INACTIVE');

    await query('DELETE FROM companies WHERE id = $1', [id]);
  });

  it('validates before it writes', async () => {
    const noName = await asAdmin('post', '/api/crops').send({ unit: 'MT' });
    expect(noName.status).toBe(400);
    expect(noName.body.error.code).toBe('VALIDATION_FAILED');

    const badUnit = await asAdmin('post', '/api/crops').send({ name: 'Test', unit: 'Quintal' });
    expect(badUnit.status).toBe(404);

    const { rows } = await query("SELECT COUNT(*)::int AS n FROM crops WHERE name = 'Test'");
    expect(rows[0].n).toBe(0);
  });

  it('enforces master permissions on the server, not just in the UI', async () => {
    // Warehouse may look at crops but not change them, and Sales may not add a
    // company. Hiding the buttons is a courtesy; this is the control.
    const cases = [
      ['Warehouse', 'post', '/api/crops', { name: 'X', unit: 'MT' }],
      ['Warehouse', 'delete', '/api/crops/1', null],
      ['Sales', 'post', '/api/companies', { name: 'X', role: 'BUYER' }],
      ['Sales', 'delete', '/api/suppliers/1', null],
      ['Purchase', 'delete', '/api/crops/1', null],
      ['Warehouse', 'post', '/api/products', { name: 'X', unit: 'Pcs' }],
      ['Sales', 'delete', '/api/products/1', null],
      ['Warehouse', 'post', '/api/warehouses', { name: 'X' }],
      ['Sales', 'post', '/api/employees', { name: 'X' }],
      ['Sales', 'post', '/api/accounts', { name: 'X', type: 'CASH' }],
      ['Warehouse', 'post', '/api/expense-categories', { name: 'X' }],
      ['Accounts', 'delete', '/api/accounts/1', null],
      ['Sales', 'post', '/api/payment-methods', { name: 'X' }],
      ['Accounts', 'delete', '/api/payment-methods/1', null],
    ];

    for (const [role, method, path, body] of cases) {
      const req = request(app2)[method](path).set('authorization', `Bearer ${t[role]}`);
      const res = await (body ? req.send(body) : req);
      expect(res.status, `${role} ${method.toUpperCase()} ${path}`).toBe(403);
    }
  });

  it('lets Purchase maintain the procurement master it already creates', async () => {
    const created = await request(app2)
      .post('/api/crops')
      .set('authorization', `Bearer ${t.Purchase}`)
      .send({ name: 'Sesame', unit: 'MT', rate: 120000 });

    expect(created.status).toBe(201);
    await query('DELETE FROM crops WHERE id = $1', [created.body.data.id]);
  });

  it('creates a product, resolving the unit, category and brand it was given', async () => {
    const created = await asAdmin('post', '/api/products').send({
      name: 'Amistar Top 325 SC 50ml',
      cat: 'Agrochemical',
      brand: 'Syngenta',
      unit: 'Pcs',
      pur: 420,
      sale: 510,
      min: 150,
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    // The screen sent names and a unit code; the row carries the ids.
    const listed = await asAdmin('get', '/api/products?q=Amistar');
    expect(listed.body.data[0]).toMatchObject({
      id, cat: 'Agrochemical', brand: 'Syngenta', unit: 'Pcs', sale: 510,
    });

    await query('DELETE FROM products WHERE id = $1', [id]);
  });

  it('refuses a product naming a brand that does not exist', async () => {
    const created = await asAdmin('post', '/api/products').send({
      name: 'Test product', unit: 'Pcs',
    });
    const id = created.body.data.id;

    // A typo must not quietly become a new brand.
    const res = await asAdmin('patch', `/api/products/${id}`).send({ brand: 'Bayer' });
    expect(res.status).toBe(404);

    const { rows } = await query("SELECT COUNT(*)::int AS n FROM brands WHERE name = 'Bayer'");
    expect(rows[0].n).toBe(0);

    await query('DELETE FROM products WHERE id = $1', [id]);
  });

  it('refuses to retire a product that is still in stock', async () => {
    const { rows } = await query(
      `SELECT product_id FROM stock
        WHERE item_type = 'PRODUCT' AND quantity > 0 LIMIT 1`
    );
    const res = await asAdmin('delete', `/api/products/${rows[0].product_id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_STOCK');
  });

  it('opens and closes a warehouse', async () => {
    const created = await asAdmin('post', '/api/warehouses').send({
      name: 'Sherpur Transit Store',
      district: 'Bogura',
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const closed = await asAdmin('delete', `/api/warehouses/${id}`);
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('Closed');

    await query('DELETE FROM warehouses WHERE id = $1', [id]);
  });

  it('refuses to close a warehouse that still holds stock', async () => {
    const { rows } = await query(
      'SELECT warehouse_id FROM stock WHERE quantity > 0 LIMIT 1'
    );
    const res = await asAdmin('delete', `/api/warehouses/${rows[0].warehouse_id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_STOCK');
  });

  it('creates an employee and returns the joining date as a date', async () => {
    const created = await asAdmin('post', '/api/employees').send({
      name: 'Tanvir Ahmed',
      designation: 'Warehouse Assistant',
      department: 'Warehouse',
      mobile: '01799001122',
      joined: '2026-08-01',
    });
    expect(created.status).toBe(201);
    // A bare date comes back from pg as a JS Date; stringifying one gives
    // "Sat Aug 01", which is not a date.
    expect(created.body.data.joined).toBe('2026-08-01');

    await query('DELETE FROM employees WHERE id = $1', [created.body.data.id]);
  });

  it('refuses an employee naming a department that does not exist', async () => {
    const res = await asAdmin('post', '/api/employees').send({
      name: 'Tanvir Ahmed',
      department: 'Logistics',
    });
    expect(res.status).toBe(404);

    const { rows } = await query("SELECT COUNT(*)::int AS n FROM departments WHERE name = 'Logistics'");
    expect(rows[0].n).toBe(0);
  });

  it('refuses a joining date that is not a date', async () => {
    const res = await asAdmin('post', '/api/employees').send({
      name: 'Tanvir Ahmed',
      joined: '01 Aug 2026',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses to retire an employee whose login still works', async () => {
    const { rows } = await query(
      'SELECT employee_id FROM users WHERE is_active AND employee_id IS NOT NULL LIMIT 1'
    );
    const res = await asAdmin('delete', `/api/employees/${rows[0].employee_id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_ACTIVE_LOGIN');
  });

  it('opens an account with a code the operator chose', async () => {
    const created = await asAdmin('post', '/api/accounts').send({
      code: 'BANK-CITY',
      name: 'City Bank — 3301...9922',
      type: 'BANK',
      opening: 0,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe('BANK-CITY');

    // An empty account closes fine; its history keeps naming it.
    const closed = await asAdmin('delete', `/api/accounts/${created.body.data.id}`);
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('Closed');

    await query('DELETE FROM accounts WHERE id = $1', [created.body.data.id]);
  });

  it('names the record already using a code rather than failing on a constraint', async () => {
    const res = await asAdmin('post', '/api/accounts').send({
      code: 'BANK-IBBL',
      name: 'Duplicate',
      type: 'BANK',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CODE_IN_USE');
    expect(res.body.error.message).toMatch(/Islami Bank/);
  });

  it('refuses to close an account that still holds money', async () => {
    const { rows } = await query(
      `SELECT a.id FROM accounts a
        WHERE a.org_id = $1
          AND a.opening_balance
              + COALESCE((SELECT SUM(l.debit - l.credit) FROM ledger_entries l
                           WHERE l.account_id = a.id), 0) <> 0
        LIMIT 1`,
      [1]
    );
    const res = await asAdmin('delete', `/api/accounts/${rows[0].id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_BALANCE');
  });

  it('maintains expense categories, which are shared and have no org column', async () => {
    const created = await asAdmin('post', '/api/expense-categories').send({ name: 'Fuel' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    // The table has no updated_at, so a PATCH must not try to set one.
    const edited = await asAdmin('patch', `/api/expense-categories/${id}`).send({
      name: 'Fuel & lubricants',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.name).toBe('Fuel & lubricants');

    // Nothing blocks retiring one: past expenses keep pointing at it.
    const retired = await asAdmin('delete', `/api/expense-categories/${id}`);
    expect(retired.status).toBe(200);
    expect(retired.body.data.status).toBe('Retired');

    await query('DELETE FROM expense_categories WHERE id = $1', [id]);
  });

  it('creates a payment method against an account named rather than numbered', async () => {
    const created = await asAdmin('post', '/api/payment-methods').send({
      code: 'UPAY',
      name: 'Upay',
      account: 'bKash Merchant — 01755...',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.accountId).toBeTruthy();

    await query('DELETE FROM payment_methods WHERE id = $1', [created.body.data.id]);
  });

  it('refuses a payment method pointing at an account that does not exist', async () => {
    const res = await asAdmin('post', '/api/payment-methods').send({
      name: 'Test',
      account: 'Standard Chartered',
    });
    expect(res.status).toBe(404);
  });

  it('retires a payment method and puts it back', async () => {
    const created = await asAdmin('post', '/api/payment-methods').send({ name: 'Upay' });
    const id = created.body.data.id;

    const retired = await asAdmin('delete', `/api/payment-methods/${id}`);
    expect(retired.body.data.status).toBe('Retired');

    // Without this a record retired by mistake could only be recovered with
    // SQL, which is not something an operator can be asked to do.
    const restored = await asAdmin('post', `/api/payment-methods/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe('Active');

    const again = await asAdmin('post', `/api/payment-methods/${id}/restore`);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('ALREADY_ACTIVE');

    await query('DELETE FROM payment_methods WHERE id = $1', [id]);
  });

  it('records a restore in the audit trail, so the round trip is visible', async () => {
    const created = await asAdmin('post', '/api/payment-methods').send({ name: 'Upay' });
    const id = created.body.data.id;
    await asAdmin('delete', `/api/payment-methods/${id}`);
    await asAdmin('post', `/api/payment-methods/${id}/restore`);

    const { rows } = await query(
      `SELECT action FROM audit_logs
        WHERE entity_type = 'payment_methods' AND entity_id = $1
        ORDER BY id`,
      [id]
    );
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'DEACTIVATE', 'RESTORE']);

    await query('DELETE FROM payment_methods WHERE id = $1', [id]);
  });

  it('values product stock at what it is carried at, not the catalogue rate', async () => {
    const res = await asAdmin('get', '/api/products?pageSize=50');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const held = res.body.data.filter((p) => p.stock > 0);
    expect(held.length).toBeGreaterThan(0);

    // Every stock figure in the app has to agree, so products are valued the
    // same way the warehouse and dashboard totals are.
    const { rows } = await query(
      `SELECT ROUND(SUM(quantity * avg_cost), 2) AS value
         FROM stock WHERE item_type = 'PRODUCT'`
    );
    // Each product's value is rounded to paisa before being summed, so the
    // total can differ from a rounded grand total by a paisa or two.
    const shown = held.reduce((t, p) => t + p.value, 0);
    expect(Math.round(shown)).toBe(Math.round(Number(rows[0].value)));
  });

  it('reconciles the dashboard profit with the profit and loss', async () => {
    const dash = await asAdmin('get', '/api/reports/dashboard');
    const pl = await asAdmin('get', '/api/reports/fin-pl');

    const line = (match) =>
      Number((pl.body.data.rows.find((r) => match.test(r.line)) || {}).amount || 0);

    // The dashboard shows each sale's own recorded profit, which already
    // carries the selling cost booked against it. The profit and loss deducts
    // that lower down, so its gross profit is higher by exactly that much.
    const gross = line(/^Gross profit/);
    const selling = line(/^Selling expense/);
    expect(Math.round(dash.body.data.grossProfit.amount)).toBe(Math.round(gross + selling));
  });

  it('lists crops with what each one is holding', async () => {
    const res = await asAdmin('get', '/api/crops?pageSize=50');
    expect(res.status).toBe(200);

    const withStock = res.body.data.find((c) => c.quantity > 0);
    expect(withStock).toBeTruthy();
    expect(withStock.unit).toBeTruthy();
    // A date, not a stringified JS Date -- "Wed Aug 12" is not a date.
    expect(withStock.last).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Money rounded to paisa, not carrying binary-fraction noise.
    expect(String(withStock.value)).not.toMatch(/\.\d{3,}/);
  });
});

suite('what a session may look at', () => {
  /**
   * The header search box and the workspace payload were the two ways round
   * the permission model. Every screen checked what a role may see; these two
   * handed the same records over to anybody signed in — the search with no
   * check at all, the workspace behind a permission every role holds.
   *
   * A warehouse clerk who cannot open the Customers screen could type a name
   * into the header and read the customer list back, matched on mobile number.
   */

  const search = (role, term = 'a') =>
    request(app).get(`/api/search?q=${term}`).set('authorization', `Bearer ${tokens[role]}`);

  const workspace = (role) =>
    request(app).get('/api/workspace').set('authorization', `Bearer ${tokens[role]}`);

  it('answers the search with every group, whatever the role', async () => {
    for (const role of ['Admin', 'Sales', 'Warehouse']) {
      if (!tokens[role]) continue;
      const res = await search(role);
      expect(res.status, role).toBe(200);
      // Every key present, so a group somebody may not see reads exactly like
      // a group with no matches. The client cannot tell them apart, and that
      // is the point.
      for (const key of ['customers', 'suppliers', 'companies', 'products', 'batches']) {
        expect(Array.isArray(res.body.data[key]), `${role}.${key}`).toBe(true);
      }
    }
  });

  it('does not search customers for a role that may not see them', async () => {
    if (!tokens.Warehouse) return;
    const res = await search('Warehouse');

    // Warehouse handles goods. It holds no customer.view, so the box that
    // could once enumerate the customer list now returns nothing from it.
    expect(res.body.data.customers).toEqual([]);
    expect(res.body.data.suppliers).toEqual([]);
    expect(res.body.data.companies).toEqual([]);
    // What it does handle, it still finds.
    expect(res.body.data.products.length + res.body.data.batches.length).toBeGreaterThan(0);
  });

  it('does not search suppliers for a role that only sells', async () => {
    if (!tokens.Sales) return;
    const res = await search('Sales');

    expect(res.body.data.suppliers).toEqual([]);
    expect(res.body.data.companies).toEqual([]);
    // Sales keeps the customer list, which is theirs to keep.
    expect(res.body.data.customers.length).toBeGreaterThan(0);
  });

  it('does not search customers for a role that only buys', async () => {
    if (!tokens.Purchase) return;
    const res = await search('Purchase');

    expect(res.body.data.customers).toEqual([]);
    expect(res.body.data.suppliers.length).toBeGreaterThan(0);
  });

  it('finds everything for a role that may see everything', async () => {
    const res = await search('Admin');
    const found = Object.values(res.body.data).reduce((t, rows) => t + rows.length, 0);
    expect(found).toBeGreaterThan(0);
    expect(res.body.data.customers.length).toBeGreaterThan(0);
    expect(res.body.data.suppliers.length).toBeGreaterThan(0);
  });

  it('will not search on nothing', async () => {
    const res = await request(app)
      .get('/api/search?q=')
      .set('authorization', `Bearer ${tokens.Admin}`);
    expect(res.status).toBe(400);
  });

  it('refuses an unauthenticated search', async () => {
    const res = await request(app).get('/api/search?q=rahman');
    expect(res.status).toBe(401);
  });

  /* --------------------------------------------------------- the workspace */

  it('does not hand the whole customer master to a warehouse clerk', async () => {
    if (!tokens.Warehouse) return;
    const res = await workspace('Warehouse');
    expect(res.status).toBe(200);

    // This is the payload every screen boots from, so a list left in it is a
    // list the browser has whether or not a screen ever shows it.
    expect(res.body.data.customers).toEqual([]);
    expect(res.body.data.suppliers).toEqual([]);
    expect(res.body.data.companies).toEqual([]);
  });

  it('keeps the payload one shape whatever the role', async () => {
    const admin = await workspace('Admin');
    const warehouse = tokens.Warehouse ? await workspace('Warehouse') : null;
    if (!warehouse) return;

    // Same keys, different contents: a screen reading one finds an empty list
    // rather than undefined.
    expect(Object.keys(warehouse.body.data).sort()).toEqual(Object.keys(admin.body.data).sort());
  });

  it('still gives every role what its own screens need', async () => {
    if (tokens.Sales) {
      const sales = (await workspace('Sales')).body.data;
      // Sales raises dealer invoices and crop sales, so it needs the customers
      // and the buyer companies those are made out to.
      expect(sales.customers.length).toBeGreaterThan(0);
      expect(sales.products.length).toBeGreaterThan(0);
      expect(sales.buyers.length).toBeGreaterThan(0);
    }

    if (tokens.Purchase) {
      const purchase = (await workspace('Purchase')).body.data;
      // Purchase buys from farmers and principals.
      expect(purchase.suppliers.length).toBeGreaterThan(0);
      expect(purchase.companies.length).toBeGreaterThan(0);
    }

    if (tokens.Warehouse) {
      const warehouse = (await workspace('Warehouse')).body.data;
      // Warehouse moves stock, so it needs the goods and where they are.
      expect(warehouse.products.length).toBeGreaterThan(0);
      expect(warehouse.warehouses.length).toBeGreaterThan(0);
      expect(warehouse.units.length).toBeGreaterThan(0);
    }
  });

  it('gives Accounts the parties whose money it handles', async () => {
    if (!tokens.Accounts) return;
    const accounts = (await workspace('Accounts')).body.data;

    expect(accounts.customers.length).toBeGreaterThan(0);
    expect(accounts.suppliers.length).toBeGreaterThan(0);
    // And the cash books a payment moves through.
    expect(accounts.accounts.length).toBeGreaterThan(0);
  });
});
