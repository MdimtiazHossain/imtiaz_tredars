import request from 'supertest';
import { query, withTransaction } from '../../src/lib/db.js';
import { hashPassword } from '../../src/services/authService.js';

/**
 * Data a test makes for itself.
 *
 * The suites were written against `npm run db:seed` -- the demonstration
 * business -- and look their fixtures up by the codes that seed happens to
 * allocate: crop CROP-04, product P-1005, the first customer, the first
 * warehouse. Against a database that holds only the system foundation, which
 * is what a real installation starts as, 102 of them fail: there is no
 * CROP-04, and the account they sign in as has a password only the seed knows.
 *
 * Everything here is built through the API, so a fixture exercises the same
 * validation and posting a clerk would. The one exception is the sign-in
 * account, which cannot be created through an API that requires one to already
 * exist; that is written directly, and it is system data rather than anybody's
 * trading history.
 *
 * Names are prefixed so a fixture can never be mistaken for a real record, and
 * so running against a seeded database collides with nothing.
 */

const PREFIX = 'ZZ-TEST';

/**
 * The one password the whole suite uses.
 *
 * Deliberately the same as the seed's, and not a password of this fixture's
 * own. Several suites sign in as "the first user holding the Admin role"
 * without caring which that is, and this account holds it too -- so a fixture
 * with its own password made those suites fail with a 401 whenever the file
 * that creates it happened to run first. Vitest's file order is not fixed, so
 * that surfaced as a suite passing one run and failing the next.
 */
const PASSWORD = process.env.SEED_PASSWORD || 'ChangeMe!2026';

/**
 * An administrator this suite knows the password of.
 *
 * It adopts the administrator that is already there rather than adding one.
 * Two suites count them: one refuses a change that would leave nobody able to
 * administer roles, and an extra Admin makes that condition impossible to
 * reach. So on a seeded database this finds the seed's own administrator, whose
 * password is already the one below, and changes nothing at all; on a database
 * installed by db:fresh it finds that administrator and replaces the one-time
 * password nobody recorded. Only a database with no administrator gets a new
 * one, which no installed database is.
 */
export async function fixtureAdmin() {
  const { rows: org } = await query('SELECT id FROM organizations ORDER BY id LIMIT 1');
  if (!org.length) throw new Error('No organisation: run `NODE_ENV=test npm run db:fresh -- --force`');
  const orgId = Number(org[0].id);

  const { rows: role } = await query("SELECT id FROM roles WHERE code = 'Admin' LIMIT 1");
  if (!role.length) throw new Error('No Admin role: the database has no foundation installed');

  const { rows: already } = await query(
    `SELECT u.id, u.username FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
      WHERE ur.role_id = $1 ORDER BY u.id LIMIT 1`,
    [Number(role[0].id)]
  );
  if (already.length) {
    // must_change_pw is cleared too: db:fresh sets it, and a fixture cannot
    // answer a password-change prompt.
    await query(
      'UPDATE users SET password_hash = $1, is_active = true, must_change_pw = false WHERE id = $2',
      [await hashPassword(PASSWORD), Number(already[0].id)]
    );
    return { username: already[0].username, password: PASSWORD, userId: Number(already[0].id) };
  }

  const username = 'zz_test_admin';
  const passwordHash = await hashPassword(PASSWORD);

  const userId = await withTransaction(async (client) => {
    const { rows: employee } = await client.query(
      `INSERT INTO employees (org_id, code, name, designation, joined_on)
       VALUES ($1, $2, 'Fixture Administrator', 'Automated test', CURRENT_DATE)
       RETURNING id`,
      [orgId, `${PREFIX}-EMP`]
    );
    const { rows: user } = await client.query(
      `INSERT INTO users (org_id, employee_id, username, password_hash, must_change_pw)
       VALUES ($1, $2, $3, $4, false) RETURNING id`,
      [orgId, Number(employee[0].id), username, passwordHash]
    );
    await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
      Number(user[0].id),
      Number(role[0].id),
    ]);
    return Number(user[0].id);
  });

  return { username, password: PASSWORD, userId };
}

/** Sign in as the fixture administrator and return a bearer header. */
export async function fixtureToken(app) {
  const admin = await fixtureAdmin();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: admin.username, password: admin.password });
  if (res.status !== 200) {
    throw new Error(`Fixture sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { authorization: `Bearer ${res.body.data.accessToken}` };
}

/** POST through the API, failing with the server's own message. */
async function create(app, auth, path, body) {
  const res = await request(app).post(`/api${path}`).set(auth).send(body);
  if (res.status >= 400) {
    throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

/** Find a record this fixture made earlier, so a suite can run twice. */
async function existing(app, auth, path, name) {
  const res = await request(app).get(`/api${path}`).set(auth);
  const rows = Array.isArray(res.body?.data) ? res.body.data : res.body?.data?.rows || [];
  return rows.find((r) => r.name === name) || null;
}

const named = (what) => `${PREFIX} ${what}`;

/**
 * The masters a document needs, made through the API if they are not there.
 *
 * @param {import('express').Express} app
 * @returns the ids a test posts against
 */
export async function masters(app) {
  const auth = await fixtureToken(app);

  const reuse = async (path, name, body) =>
    (await existing(app, auth, path, name)) || (await create(app, auth, path, body));

  const warehouse = await reuse('/warehouses', named('Warehouse'), {
    name: named('Warehouse'),
    district: 'Test District',
  });

  const customer = await reuse('/customers', named('Customer'), {
    name: named('Customer'),
    type: 'Dealer',
    mobile: '01700-000001',
    limit: 10000000,
    days: 30,
  });

  const supplier = await reuse('/suppliers', named('Supplier'), {
    name: named('Supplier'),
    type: 'Farmer',
    mobile: '01700-000002',
  });

  const principal = await reuse('/companies', named('Principal'), {
    name: named('Principal'),
    role: 'PRINCIPAL',
    mobile: '01700-000003',
    limit: 10000000,
    days: 30,
  });

  const buyer = await reuse('/companies', named('Buyer'), {
    name: named('Buyer'),
    role: 'BUYER',
    mobile: '01700-000004',
    days: 14,
  });

  const category = await reuse('/product-categories', named('Category'), { name: named('Category') });
  const brand = await reuse('/brands', named('Brand'), { name: named('Brand') });

  const product = await reuse('/products', named('Product'), {
    name: named('Product'),
    cat: named('Category'),
    brand: named('Brand'),
    unit: 'Pcs',
    pur: 1000,
    sale: 1300,
    min: 40,
  });

  const crop = await reuse('/crops', named('Crop'), {
    name: named('Crop'),
    unit: 'MT',
    rate: 30000,
  });

  const account = await reuse('/accounts', named('Cash'), {
    code: 'ZZTESTCASH',
    name: named('Cash'),
    type: 'CASH',
    opening: 0,
  });

  const method = await reuse('/payment-methods', named('Method'), {
    code: 'ZZ_TEST_CASH',
    name: named('Method'),
  });

  const expenseCategory = await reuse('/expense-categories', named('Expense'), {
    code: 'ZZ_TEST_EXPENSE',
    name: named('Expense'),
  });

  const { rows: units } = await query("SELECT id FROM units WHERE code = 'MT'");
  const { rows: org } = await query('SELECT id FROM organizations ORDER BY id LIMIT 1');

  return {
    auth,
    orgId: Number(org[0].id),
    unitMTId: Number(units[0].id),
    warehouse,
    customer,
    supplier,
    principal,
    buyer,
    category,
    brand,
    product,
    crop,
    account,
    method,
    expenseCategory,
  };
}
