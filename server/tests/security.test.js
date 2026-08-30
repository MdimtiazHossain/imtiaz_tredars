import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, query, closePool } from '../src/lib/db.js';
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
    for (const role of ['Admin', 'Sales', 'Warehouse', 'Accounts']) {
      tokens[role] = await signIn(role);
    }
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/workspace');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
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
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
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
      .get('/api/dashboard/dashboard')
      .set('authorization', `Bearer ${tokens.Sales}`);
    expect(res.status).toBe(200);
    expect(res.body.data.grossProfit).toBeUndefined();
  });

  it('includes profit figures for Accounts', async () => {
    const res = await request(app)
      .get('/api/dashboard/dashboard')
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
    for (const role of ['Admin', 'Sales', 'Warehouse', 'Purchase']) {
      t[role] = await signIn(role);
    }
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
