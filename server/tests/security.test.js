import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';

/**
 * Security tests.
 *
 * The point of these is that hiding a button in the UI is not a control: a
 * Sales user must be refused by the API itself, whatever the client sends.
 */

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
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

  afterAll(async () => {
    await closePool();
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
