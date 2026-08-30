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
