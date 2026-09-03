import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query, closePool } from '../src/lib/db.js';
import { HAS_DB } from './helpers/database.js';
import { hashPassword } from '../src/services/authService.js';
import { masters } from './helpers/fixture.js';

/**
 * A one-time password stops working once it is used.
 *
 * Every account this system creates carries `must_change_pw`, and `db:fresh`
 * tells the operator that the key it just printed "stops working the moment it
 * is used". Nothing read the flag, so it did not: a password read off a
 * terminal, pasted into a chat or dictated over a phone stayed a working
 * credential for the life of the account.
 *
 * The refusal has to be the API's rather than the client's, because the
 * credential is the thing that leaked -- so these drive the API directly, the
 * way a script holding that password would.
 */
const suite = HAS_DB ? describe : describe.skip;

/**
 * Give the Admin role back at the end.
 *
 * A refusal only proves the password gate if the account would otherwise be
 * allowed the route, so the account here holds Admin for the length of this
 * file. Left holding it afterwards, it is anything but inert. The shared
 * fixture adopts the oldest account holding Admin as the administrator every
 * other suite signs in as, and rewrites its password -- while this file is
 * still rewriting it too. Worse, `roles` demotes an administrator expecting to
 * be refused because nobody would be left to administer; a second Admin makes
 * that demotion succeed, and it lands on the seeded administrator, who never
 * gets the role back.
 *
 * That is not hypothetical. Runs of an earlier version of this file left six
 * administrators behind and cost `rakib01` his role, after which every run
 * failed: 85 tests across four files with nothing to do with passwords.
 *
 * The row itself stays. It is named in audit entries the database keeps
 * append-only, and rightly refuses to let go of; one dormant account is a far
 * smaller thing than an argument with that guard. Being roleless and disabled,
 * nothing adopts it and nothing counts it.
 */
async function releaseFixtureAdmin() {
  if (!userId) return;
  await query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  await query('UPDATE users SET is_active = false WHERE id = $1', [userId]);
}

afterAll(async () => {
  if (HAS_DB) await releaseFixtureAdmin();
  await closePool();
});

const stamp = String(Date.now()).slice(-8);
const ONE_TIME = `OneTime!${stamp}`;
const CHOSEN = `Chosen!Passphrase${stamp}`;

/** One account, reused: see `releaseFixtureAdmin` for why it is never deleted. */
const EMPLOYEE_CODE = 'ZZ-PW-GATE';
const username = 'zz_password_gate';

let app;
let fx;
let userId;
/** One gated sign-in, shared by the cases that only need to be turned away. */
let gated;

/**
 * Put the account back into the state db:fresh leaves it in.
 *
 * Only the stored password and the flag; the access token issued earlier is a
 * signed JWT and stays valid, which is why one sign-in can serve several cases.
 */
async function issueOneTimePassword() {
  await query('UPDATE users SET password_hash = $1, must_change_pw = true WHERE id = $2', [
    await hashPassword(ONE_TIME),
    userId,
  ]);
}

/**
 * Sign in.
 *
 * Used sparingly on purpose. Sign-in is rate limited to ten attempts a window
 * and the limiter is built once for the process, so a file that signs in for
 * every assertion starts collecting 429s partway through and reads as a broken
 * gate. Cases that only need a gated token share `gated` instead; the two below
 * that are genuinely about signing in do their own.
 */
const signIn = (password) =>
  request(app).post('/api/auth/login').send({ username, password });

const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** Change the password using a token that is currently gated. */
const changeTo = (token, newPassword) =>
  request(app)
    .post('/api/auth/change-password')
    .set(bearer(token))
    .send({ currentPassword: ONE_TIME, newPassword });

suite('an account still holding its one-time password', () => {
  beforeAll(async () => {
    app = createApp();
    fx = await masters(app);

    // Its own account, so forcing a password change here cannot lock another
    // suite out of the shared administrator. One account rather than one per
    // run: the audit trail is append-only, so an account that has signed in
    // can never be deleted, and a fresh name each time would leave a row
    // behind on every run for as long as the database lives.
    const existing = await query('SELECT id FROM employees WHERE code = $1', [EMPLOYEE_CODE]);
    const employeeId = existing.rows.length
      ? Number(existing.rows[0].id)
      : Number(
          (
            await query(
              `INSERT INTO employees (org_id, code, name, designation, joined_on)
               VALUES ($1, $2, 'Password Fixture', 'Automated test', CURRENT_DATE) RETURNING id`,
              [fx.orgId, EMPLOYEE_CODE]
            )
          ).rows[0].id
        );

    const held = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (held.rows.length) {
      userId = Number(held.rows[0].id);
      // Back to the state the last run found it in, whatever it left it in.
      await query(
        'UPDATE users SET password_hash = $1, must_change_pw = true, is_active = true WHERE id = $2',
        [await hashPassword(ONE_TIME), userId]
      );
    } else {
      const created = await query(
        `INSERT INTO users (org_id, employee_id, username, password_hash, must_change_pw)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [fx.orgId, employeeId, username, await hashPassword(ONE_TIME)]
      );
      userId = Number(created.rows[0].id);
    }

    const role = await query("SELECT id FROM roles WHERE code = 'Admin' LIMIT 1");
    await query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, Number(role.rows[0].id)]
    );

    gated = await signIn(ONE_TIME);
  });

  it('can sign in, and is told why that is not enough', async () => {
    expect(gated.status).toBe(200);
    expect(gated.body.data.user.mustChangePassword).toBe(true);
  });

  it('is refused every route but its own account', async () => {
    for (const path of [
      '/api/workspace',
      '/api/customers',
      '/api/inventory',
      '/api/reports/dashboard',
      '/api/settings',
      '/api/users',
    ]) {
      const res = await request(app).get(path).set(bearer(gated.body.data.accessToken));
      expect(res.status, path).toBe(403);
      // Its own code, so a client can tell this from a permission refusal and
      // ask for the password rather than reporting the wrong problem.
      expect(res.body.error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('may still see who it is, so the change can be asked for', async () => {
    const me = await request(app).get('/api/auth/me').set(bearer(gated.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.mustChangePassword).toBe(true);
  });

  it('is refused writes as well as reads', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set(bearer(gated.body.data.accessToken))
      .send({ name: `ZZ-TEST Should Not Exist ${stamp}`, mobile: `019${stamp}` });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM customers WHERE name = $1', [
      `ZZ-TEST Should Not Exist ${stamp}`,
    ]);
    expect(rows[0].n, 'nothing was created').toBe(0);
  });

  it('is let through the moment the password is replaced', async () => {
    const token = gated.body.data.accessToken;
    expect((await request(app).get('/api/workspace').set(bearer(token))).status).toBe(403);

    expect((await changeTo(token, CHOSEN)).status).toBe(200);

    // The flag is read per request rather than carried in the token, so the
    // same token works immediately.
    expect((await request(app).get('/api/workspace').set(bearer(token))).status).toBe(200);
  });

  it('stops working as a credential once it has been used', async () => {
    await issueOneTimePassword();
    await changeTo(gated.body.data.accessToken, CHOSEN);

    // The promise db:fresh prints, now kept.
    const reuse = await signIn(ONE_TIME);
    expect(reuse.status).toBe(401);

    const fresh = await signIn(CHOSEN);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.user.mustChangePassword).toBe(false);
  });

  it('signs the account out everywhere, which is what the screen now says', async () => {
    await issueOneTimePassword();
    // Two sessions, because the claim is about the other ones as well as this
    // one. This is the only case that needs a second sign-in of its own.
    const first = (await signIn(ONE_TIME)).body.data;
    const second = (await signIn(ONE_TIME)).body.data;

    await changeTo(first.accessToken, CHOSEN);

    // Both refresh tokens are revoked, this session's included.
    for (const session of [first, second]) {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(res.status).toBe(401);
    }
  });

  it('leaves an account that has chosen its own password alone', async () => {
    // The gate must not stand in front of everybody: the fixture's own
    // administrator has a password it chose and is unaffected.
    const res = await request(app).get('/api/workspace').set(fx.auth);
    expect(res.status).toBe(200);
  });
});
