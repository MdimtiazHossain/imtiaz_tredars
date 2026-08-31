import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';

/**
 * Roles, permissions and logins.
 *
 * The point of these is not that the endpoints answer 200. It is that a grant
 * moved on this screen is the grant the API enforces on the next request, that
 * the roles the system is set up around cannot be dismantled, and that no
 * sequence of otherwise-reasonable changes can leave the business with nobody
 * able to change them back.
 */
const suite = HAS_DB ? describe : describe.skip;

const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';

let app;
const tokens = {};

async function usernameFor(roleCode) {
  const { rows } = await query(
    `SELECT u.username FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = $1 AND u.is_active LIMIT 1`,
    [roleCode]
  );
  return rows[0]?.username || null;
}

async function signIn(username) {
  const res = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
  return res.status === 200 ? res.body.data.accessToken : null;
}

const as = (role) => ({ authorization: `Bearer ${tokens[role]}` });

const roleNamed = (body, code) => body.data.roleList.find((r) => r.code === code);
const moduleNamed = (body, label) => body.data.modules.find((m) => m.label === label);

suite('roles and permissions', () => {
  beforeAll(async () => {
    app = createApp();
    for (const role of ['Admin', 'Accounts', 'Sales']) {
      const username = await usernameFor(role);
      tokens[role] = username ? await signIn(username) : null;
    }
  });

  afterAll(async () => {
    // Leave the database as the suite found it: the roles this created are
    // gone, and the grants it moved are put back. The pool stays open -- the
    // login suite below shares it, and closing it here would take that with it.
    await query("DELETE FROM roles WHERE is_system = false AND code LIKE 'Test%'");
  });

  /* --------------------------------------------------------- who may look */

  it('shows the matrix to anyone who may read the settings', async () => {
    const res = await request(app).get('/api/roles').set(as('Admin'));

    expect(res.status).toBe(200);
    expect(res.body.data.roles).toContain('Admin');
    // Every permission the database defines is reachable from some module, or
    // it would be a code no screen could ever grant.
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM permissions');
    const inModules = new Set(
      res.body.data.modules.flatMap((m) => m.permissions.map((p) => p.code))
    );
    expect(inModules.size).toBe(rows[0].n);
  });

  it('refuses the matrix to a role that cannot read the settings', async () => {
    const res = await request(app).get('/api/roles').set(as('Sales'));
    expect(res.status).toBe(403);
  });

  it('refuses every write to a role without role.edit', async () => {
    const res = await request(app)
      .post('/api/roles')
      .set(as('Accounts'))
      .send({ code: 'TestNope', name: 'Should not exist' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('does not allow this action');
  });

  /* -------------------------------------------------- a grant that bites */

  it('a permission granted here is one the API then allows', async () => {
    // Sales cannot record an expense to begin with.
    const before = await request(app)
      .get('/api/expenses')
      .set(as('Sales'));
    expect(before.status).toBe(403);

    const sales = roleNamed((await request(app).get('/api/roles').set(as('Admin'))).body, 'Sales');
    const granted = await request(app)
      .put(`/api/roles/${sales.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['expense.view', 'expense.create'], permissions: ['expense.view'] });
    expect(granted.status).toBe(200);
    expect(moduleNamed(granted.body, 'Expenses').levels.Sales).toBe('View');

    // The same token, unchanged: permissions are read from the database on
    // every request rather than carried in the token, so this takes effect
    // without signing in again.
    const after = await request(app).get('/api/expenses').set(as('Sales'));
    expect(after.status).toBe(200);

    // And revoking it closes the door again.
    const revoked = await request(app)
      .put(`/api/roles/${sales.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['expense.view', 'expense.create'], permissions: [] });
    expect(revoked.status).toBe(200);
    expect((await request(app).get('/api/expenses').set(as('Sales'))).status).toBe(403);
  });

  it('leaves permissions outside the scope alone', async () => {
    const body = (await request(app).get('/api/roles').set(as('Admin'))).body;
    const warehouse = roleNamed(body, 'Warehouse');
    const held = warehouse.granted.length;

    // Deciding one module says nothing about any other.
    const res = await request(app)
      .put(`/api/roles/${warehouse.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['audit.view'], permissions: ['audit.view'] });

    expect(res.status).toBe(200);
    expect(roleNamed(res.body, 'Warehouse').granted.length).toBe(held + 1);

    await request(app)
      .put(`/api/roles/${warehouse.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['audit.view'], permissions: [] });
  });

  it('refuses to grant a permission the caller did not put in scope', async () => {
    const sales = roleNamed((await request(app).get('/api/roles').set(as('Admin'))).body, 'Sales');
    const res = await request(app)
      .put(`/api/roles/${sales.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['expense.view'], permissions: ['settings.edit'] });

    expect(res.status).toBe(400);
  });

  /* ------------------------------------------------------- roles of its own */

  it('creates, describes and deletes a role', async () => {
    const created = await request(app)
      .post('/api/roles')
      .set(as('Admin'))
      .send({ code: 'TestAuditor', name: 'Test auditor', description: 'Reads, changes nothing' });

    expect(created.status).toBe(201);
    expect(created.body.data.role.system).toBe(false);
    expect(created.body.data.role.granted).toEqual([]);

    const id = created.body.data.id;
    const renamed = await request(app)
      .patch(`/api/roles/${id}`)
      .set(as('Admin'))
      .send({ name: 'Test auditor (external)' });
    expect(roleNamed(renamed.body, 'TestAuditor').name).toBe('Test auditor (external)');

    const removed = await request(app).delete(`/api/roles/${id}`).set(as('Admin'));
    expect(removed.status).toBe(200);
    expect(roleNamed(removed.body, 'TestAuditor')).toBeUndefined();
  });

  it('refuses to delete a role the system is set up around', async () => {
    const admin = roleNamed((await request(app).get('/api/roles').set(as('Admin'))).body, 'Admin');
    const res = await request(app).delete(`/api/roles/${admin.id}`).set(as('Admin'));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ROLE_IS_SYSTEM');
  });

  it('refuses to delete a role somebody still holds', async () => {
    const created = await request(app)
      .post('/api/roles')
      .set(as('Admin'))
      .send({ code: 'TestHeld', name: 'Test held' });

    const accountsUser = await query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id WHERE r.code = 'Accounts' AND u.is_active LIMIT 1`
    );
    const userId = Number(accountsUser.rows[0].id);

    await request(app)
      .patch(`/api/users/${userId}`)
      .set(as('Admin'))
      .send({ roles: ['Accounts', 'TestHeld'] });

    const res = await request(app).delete(`/api/roles/${created.body.data.id}`).set(as('Admin'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROLE_IN_USE');

    // Put the user back, then the role goes.
    await request(app).patch(`/api/users/${userId}`).set(as('Admin')).send({ roles: ['Accounts'] });
    expect((await request(app).delete(`/api/roles/${created.body.data.id}`).set(as('Admin'))).status)
      .toBe(200);
  });

  /* --------------------------------------------------------- the guardrail */

  it('refuses a change that would leave nobody able to change roles back', async () => {
    const admin = roleNamed((await request(app).get('/api/roles').set(as('Admin'))).body, 'Admin');

    const res = await request(app)
      .put(`/api/roles/${admin.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['user.manage', 'role.edit'], permissions: ['user.manage'] });

    // Revoking it from your own only role is caught before the write, with a
    // message about your own access rather than about the system's.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WOULD_REVOKE_OWN_ACCESS');

    // Moving the only administrator to another role reaches the deeper guard.
    const { rows } = await query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id WHERE r.code = 'Admin' AND u.is_active LIMIT 1`
    );
    const moved = await request(app)
      .patch(`/api/users/${Number(rows[0].id)}`)
      .set(as('Admin'))
      .send({ roles: ['Sales'] });

    expect(moved.status).toBe(422);
    expect(moved.body.error.code).toBe('WOULD_LOCK_EVERYONE_OUT');
  });

  it('records every change to a role in the audit trail', async () => {
    const created = await request(app)
      .post('/api/roles')
      .set(as('Admin'))
      .send({ code: 'TestAudited', name: 'Test audited' });

    await request(app)
      .put(`/api/roles/${created.body.data.id}/permissions`)
      .set(as('Admin'))
      .send({ scope: ['audit.view'], permissions: ['audit.view'] });

    const { rows } = await query(
      `SELECT action, summary, new_value FROM audit_logs
        WHERE entity_type = 'roles' AND entity_id = $1 ORDER BY id`,
      [created.body.data.id]
    );

    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(rows[1].summary).toContain('audit.view');

    await request(app).delete(`/api/roles/${created.body.data.id}`).set(as('Admin'));
  });
});

suite('user accounts', () => {
  // One employee and one login, made on the first run of this suite and
  // reused after it. A user is never deleted -- the audit trail names them,
  // and the trail is append-only by design -- so the suite puts the account
  // back the way it needs it rather than pretending it can start clean.
  const TEST_USERNAME = 'test.newlogin';
  const TEST_PASSWORD = 'a-long-enough-one';
  let employeeId;
  let testUserId;
  let created = false;

  beforeAll(async () => {
    app = createApp();
    for (const role of ['Admin', 'Accounts']) {
      const username = await usernameFor(role);
      tokens[role] = username ? await signIn(username) : null;
    }

    const { rows: employee } = await query(
      `INSERT INTO employees (org_id, code, name, designation)
       VALUES (1, 'EMP-TEST', 'Test Person', 'Tester')
       ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    employeeId = Number(employee.rows === undefined ? employee[0].id : employee[0].id);

    const { rows: existing } = await query('SELECT id FROM users WHERE username = $1', [
      TEST_USERNAME,
    ]);

    if (!existing.length) {
      const res = await request(app)
        .post('/api/users')
        .set(as('Admin'))
        .send({
          employeeId,
          username: TEST_USERNAME,
          password: TEST_PASSWORD,
          roles: ['Warehouse'],
        });
      expect(res.status).toBe(201);
      created = true;
      const { rows } = await query('SELECT id FROM users WHERE username = $1', [TEST_USERNAME]);
      testUserId = Number(rows[0].id);
    } else {
      testUserId = Number(existing[0].id);
      // A previous run switched it off on its way past; switch it back on and
      // give it a password it can sign in with again.
      await request(app).patch(`/api/users/${testUserId}`).set(as('Admin')).send({
        active: true,
        roles: ['Warehouse'],
      });
      await request(app)
        .post(`/api/users/${testUserId}/password`)
        .set(as('Admin'))
        .send({ password: TEST_PASSWORD });
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('is closed to anyone without user.manage', async () => {
    expect((await request(app).get('/api/users').set(as('Accounts'))).status).toBe(403);
  });

  it('lists the logins with the roles they hold', async () => {
    const res = await request(app).get('/api/users').set(as('Admin'));

    expect(res.status).toBe(200);
    const admin = res.body.data.find((u) => u.roles.includes('Admin'));
    expect(admin.username).toBeTruthy();
    expect(admin.active).toBe(true);
    // A password never leaves the server, in any shape.
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
  });

  it('gives an employee a login, flagged to be changed at first sign-in', async () => {
    const res = await request(app).get('/api/users').set(as('Admin'));
    const account = res.body.data.find((u) => u.username === TEST_USERNAME);

    expect(account.roles).toEqual(['Warehouse']);
    expect(account.employeeCode).toBe('EMP-TEST');
    // Set by an administrator, so it is temporary by construction.
    expect(account.mustChangePassword).toBe(true);
    if (created) expect(account.active).toBe(true);
  });

  it('refuses a second login for an employee who already has one', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(as('Admin'))
      .send({
        employeeId,
        username: 'test.second',
        password: TEST_PASSWORD,
        roles: ['Warehouse'],
      });

    expect(res.status).toBe(409);
  });

  it('refuses a password too short to be worth setting', async () => {
    const res = await request(app)
      .post(`/api/users/${testUserId}/password`)
      .set(as('Admin'))
      .send({ password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('10 characters');
  });

  it('changes the roles a login holds', async () => {
    const changed = await request(app)
      .patch(`/api/users/${testUserId}`)
      .set(as('Admin'))
      .send({ roles: ['Warehouse', 'Sales'] });

    expect(changed.status).toBe(200);
    expect(changed.body.data.find((u) => u.id === testUserId).roles).toEqual(['Sales', 'Warehouse']);

    const back = await request(app)
      .patch(`/api/users/${testUserId}`)
      .set(as('Admin'))
      .send({ roles: ['Warehouse'] });
    expect(back.body.data.find((u) => u.id === testUserId).roles).toEqual(['Warehouse']);
  });

  it('will not let an administrator disable their own login', async () => {
    const { rows } = await query(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id WHERE r.code = 'Admin' AND u.is_active LIMIT 1`
    );

    const res = await request(app)
      .patch(`/api/users/${Number(rows[0].id)}`)
      .set(as('Admin'))
      .send({ active: false });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('disabling a login ends the session it was signed in with', async () => {
    const signedIn = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(signedIn.status).toBe(200);

    const disabled = await request(app)
      .patch(`/api/users/${testUserId}`)
      .set(as('Admin'))
      .send({ active: false });
    expect(disabled.status).toBe(200);

    const refused = await request(app)
      .get('/api/workspace')
      .set({ authorization: `Bearer ${signedIn.body.data.accessToken}` });
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toContain('deactivated');

    const { rows: sessions } = await query(
      'SELECT COUNT(*)::int AS live FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [testUserId]
    );
    expect(sessions[0].live).toBe(0);

    // And back on, so the account is where the next run expects it.
    await request(app).patch(`/api/users/${testUserId}`).set(as('Admin')).send({ active: true });
  });

  it('a password reset signs the account out everywhere', async () => {
    const signedIn = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(signedIn.status).toBe(200);

    const reset = await request(app)
      .post(`/api/users/${testUserId}/password`)
      .set(as('Admin'))
      .send({ password: TEST_PASSWORD });
    expect(reset.status).toBe(200);

    const { rows } = await query(
      'SELECT COUNT(*)::int AS live FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [testUserId]
    );
    expect(rows[0].live).toBe(0);

    const { rows: logged } = await query(
      `SELECT action FROM audit_logs
        WHERE entity_type = 'users' AND entity_id = $1 AND action = 'RESET_PASSWORD'`,
      [testUserId]
    );
    expect(logged.length).toBeGreaterThan(0);
  });
});
