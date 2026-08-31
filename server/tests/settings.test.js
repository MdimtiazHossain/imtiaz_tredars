import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';

/**
 * Settings.
 *
 * These cover the two things that make configuration worth having in a
 * database: that it is what the rest of the system reads, and that changing it
 * is answerable for. So the assertions are less about the endpoints returning
 * 200 than about a changed prefix reaching the next document number, a closed
 * year refusing a posting, and every change landing in the audit trail.
 */
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

const as = (role) => ({ authorization: `Bearer ${tokens[role]}` });

suite('settings', () => {
  beforeAll(async () => {
    app = createApp();
    for (const role of ['Admin', 'Sales']) tokens[role] = await signIn(role);
  });

  afterAll(async () => {
    await closePool();
  });

  /* ------------------------------------------------------------ who may read */

  it('lets an administrator read the whole screen in one call', async () => {
    const res = await request(app).get('/api/settings').set(as('Admin'));

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.organization.name).toBeTruthy();
    expect(data.fiscalYears.length).toBeGreaterThan(0);
    expect(data.numbering.length).toBeGreaterThan(0);
    expect(data.units.length).toBeGreaterThan(0);
    expect(data.approvalRules.length).toBeGreaterThan(0);
    expect(data.notificationRules.length).toBeGreaterThan(0);
    expect(data.permissions.roles).toContain('Admin');
  });

  it('lets management look at the configuration without changing it', async () => {
    // The seed gives every employee a login except a Management one, so the
    // grant is checked where it is decided rather than through a sign-in that
    // may have nobody to make it.
    const { rows } = await query(
      `SELECT p.code FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE r.code = 'Management' AND p.code LIKE 'settings.%'`
    );
    const held = rows.map((r) => r.code);
    expect(held).toContain('settings.view');
    expect(held).not.toContain('settings.edit');
  });

  it('refuses a sales user outright', async () => {
    const res = await request(app).get('/api/settings').set(as('Sales'));
    expect(res.status).toBe(403);
  });

  /* ------------------------------------------------- the matrix is the grants */

  it('builds the permission matrix from the grants actually held', async () => {
    const res = await request(app).get('/api/settings').set(as('Admin'));
    const modules = res.body.data.permissions.modules;

    const settings = modules.find((m) => m.label === 'Settings');
    // Admin holds settings.view and settings.edit; Sales holds neither.
    expect(settings.levels.Admin).toBe('Full');
    expect(settings.levels.Sales).toBe('—');
    // Not seeing profit is a state with a name rather than a blank.
    expect(modules.find((m) => m.label === 'Profit figures').levels.Sales).toBe('Hidden');
  });

  /* ------------------------------------------------------- company profile */

  it('saves the company profile and records what changed', async () => {
    const before = (await request(app).get('/api/settings').set(as('Admin'))).body.data.organization;

    const res = await request(app)
      .patch('/api/settings/organization')
      .set(as('Admin'))
      .send({ headOffice: 'Station Road, Bogura' });
    expect(res.status).toBe(200);
    expect(res.body.data.headOffice).toBe('Station Road, Bogura');

    const { rows } = await query(
      `SELECT new_value FROM audit_logs
        WHERE entity_type = 'organizations' ORDER BY id DESC LIMIT 1`
    );
    expect(rows[0].new_value.head_office).toBe('Station Road, Bogura');

    await request(app)
      .patch('/api/settings/organization')
      .set(as('Admin'))
      .send({ headOffice: before.headOffice });
  });

  it('refuses a currency that is not a three-letter code', async () => {
    const res = await request(app)
      .patch('/api/settings/organization')
      .set(as('Admin'))
      .send({ currency: 'TAKA' });
    expect(res.status).toBe(400);
  });

  /* ----------------------------------------------------- document numbering */

  it('numbers the next document with the configured prefix', async () => {
    const before = (await request(app).get('/api/settings').set(as('Admin'))).body.data.numbering.find(
      (n) => n.docType === 'expense'
    );

    await request(app)
      .patch('/api/settings/numbering/expense')
      .set(as('Admin'))
      .send({ prefix: 'VCH', padding: 4 });

    const { rows: org } = await query('SELECT id FROM organizations LIMIT 1');
    const { rows } = await query('SELECT next_document_no($1,$2,$3,$4,$5) AS no', [
      org[0].id,
      'settings_test',
      'VCH',
      '9901',
      4,
    ]);
    expect(rows[0].no).toBe('VCH-9901-0001');

    const after = (await request(app).get('/api/settings').set(as('Admin'))).body.data.numbering.find(
      (n) => n.docType === 'expense'
    );
    expect(after.pattern).toBe('VCH-YYMM-####');

    await request(app)
      .patch('/api/settings/numbering/expense')
      .set(as('Admin'))
      .send({ prefix: before.prefix, padding: before.padding });
    await query("DELETE FROM document_sequences WHERE doc_type = 'settings_test'");
  });

  it('refuses a prefix already used by another document type', async () => {
    const res = await request(app)
      .patch('/api/settings/numbering/expense')
      .set(as('Admin'))
      .send({ prefix: 'PC', padding: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PREFIX_IN_USE');
  });

  /* --------------------------------------------------------- approval rules */

  it('moves an approval limit and reports it back through the workspace', async () => {
    const rules = (await request(app).get('/api/settings').set(as('Admin'))).body.data.approvalRules;
    const purchase = rules.find((r) => r.entityType === 'crop_purchases');

    await request(app)
      .patch(`/api/settings/approval-rules/${purchase.id}`)
      .set(as('Admin'))
      .send({ threshold: 750000 });

    const workspace = await request(app).get('/api/workspace').set(as('Admin'));
    // The lowest purchase limit in force -- the dealer rule is still 5 lakh.
    expect(workspace.body.data.approvalLimit).toBe(500000);

    await request(app)
      .patch(`/api/settings/approval-rules/${purchase.id}`)
      .set(as('Admin'))
      .send({ threshold: purchase.threshold });
  });

  it('refuses a limit on a rule that always requires approval', async () => {
    const rules = (await request(app).get('/api/settings').set(as('Admin'))).body.data.approvalRules;
    const always = rules.find((r) => r.condition === 'ALWAYS');

    const res = await request(app)
      .patch(`/api/settings/approval-rules/${always.id}`)
      .set(as('Admin'))
      .send({ threshold: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RULE_HAS_NO_THRESHOLD');
  });

  /* ----------------------------------------------------- notification rules */

  it('switches a notification rule off and back on', async () => {
    const rules = (await request(app).get('/api/settings').set(as('Admin'))).body.data
      .notificationRules;
    const overdue = rules.find((r) => r.code === 'CUSTOMER_OVERDUE');

    const off = await request(app)
      .patch(`/api/settings/notification-rules/${overdue.id}`)
      .set(as('Admin'))
      .send({ active: false });
    expect(off.body.data.active).toBe(false);

    const on = await request(app)
      .patch(`/api/settings/notification-rules/${overdue.id}`)
      .set(as('Admin'))
      .send({ active: true });
    expect(on.body.data.active).toBe(true);
  });

  it('refuses a threshold on a rule that fires on a condition', async () => {
    const rules = (await request(app).get('/api/settings').set(as('Admin'))).body.data
      .notificationRules;
    const lowStock = rules.find((r) => r.code === 'LOW_STOCK');

    const res = await request(app)
      .patch(`/api/settings/notification-rules/${lowStock.id}`)
      .set(as('Admin'))
      .send({ threshold: 5 });
    expect(res.status).toBe(422);
  });

  /* ------------------------------------------------------------ fiscal years */

  it('will not close the year the business is trading in', async () => {
    const years = (await request(app).get('/api/settings').set(as('Admin'))).body.data.fiscalYears;
    const current = years.find((y) => y.current);

    const res = await request(app)
      .patch(`/api/settings/fiscal-years/${current.id}`)
      .set(as('Admin'))
      .send({ closed: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('YEAR_IS_CURRENT');
  });

  it('refuses a financial year overlapping one that exists', async () => {
    const years = (await request(app).get('/api/settings').set(as('Admin'))).body.data.fiscalYears;
    const current = years.find((y) => y.current);

    const res = await request(app)
      .post('/api/settings/fiscal-years')
      .set(as('Admin'))
      .send({ code: 'FY overlap', startsOn: current.startsOn, endsOn: current.endsOn });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FISCAL_YEAR_OVERLAPS');
  });

  it('locks transactions dated into a closed year', async () => {
    const settings = (await request(app).get('/api/settings').set(as('Admin'))).body.data;
    const closed = settings.fiscalYears.find((y) => y.closed);
    const context = (await request(app).get('/api/reference/context').set(as('Admin'))).body.data;

    const res = await request(app)
      .post('/api/crops/purchases')
      .set(as('Admin'))
      .send({
        // A day inside the closed year.
        txnDate: closed.startsOn,
        supplierId: 1,
        warehouseId: Object.values(context.warehouseIds)[0],
        lines: [
          {
            cropId: Object.values(context.cropIds)[0],
            gradeId: Object.values(context.gradeIds)[0],
            unitId: context.unitIds.MT,
            grossQuantity: 1,
            moisturePct: 0,
            rate: 100,
          },
        ],
        action: 'POST',
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FISCAL_YEAR_CLOSED');
    // The message names the year and the date, so the clerk knows what to fix.
    expect(res.body.error.message).toContain(closed.code);
  });

  /* ------------------------------------------------------------------ units */

  it('derives a unit conversion from the factor rather than restating it', async () => {
    const units = (await request(app).get('/api/settings').set(as('Admin'))).body.data.units;
    const kg = units.find((u) => u.code === 'Kg');

    expect(kg.base).toBe('MT');
    expect(kg.conversion).toBe('1 MT = 1,000 Kg');
    expect(units.find((u) => u.code === 'MT').conversion).toBe('base unit');
  });

  it('refuses to retire a unit that crops or products are measured in', async () => {
    const units = (await request(app).get('/api/settings').set(as('Admin'))).body.data.units;
    const mt = units.find((u) => u.code === 'MT');

    const res = await request(app).delete(`/api/units/${mt.id}`).set(as('Admin'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNIT_IN_USE');
  });

  it('adds and retires a unit nothing is using', async () => {
    // A previous run that failed part-way could have left it behind, and the
    // code is unique.
    await query("DELETE FROM units WHERE code = 'Quintal'");

    const created = await request(app)
      .post('/api/units')
      .set(as('Admin'))
      .send({ code: 'Quintal', name: 'Quintal', factor: 0.1, base: 'MT' });
    expect(created.status).toBe(201);

    const listed = (await request(app).get('/api/settings').set(as('Admin'))).body.data.units.find(
      (u) => u.code === 'Quintal'
    );
    expect(listed.conversion).toBe('1 MT = 10 Quintal');

    const retired = await request(app).delete(`/api/units/${created.body.data.id}`).set(as('Admin'));
    expect(retired.status).toBe(200);

    // The audit rows stay: that table refuses a delete, which is the point of
    // it. Only the unit itself is cleared, so the suite can run again.
    await query('DELETE FROM units WHERE id = $1', [created.body.data.id]);
  });
});
