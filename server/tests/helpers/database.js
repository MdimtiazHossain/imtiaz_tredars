import 'dotenv/config';
import pg from 'pg';
import { classify, databaseName } from '../../db/safety.mjs';

/**
 * Whether a usable database is actually reachable.
 *
 * Gating on the presence of an environment variable is not enough: a
 * connection string that points at a database which is down, or whose password
 * is wrong, would let the suite start and then fail every assertion for a
 * reason that has nothing to do with the code. Probing once here means the
 * integration and security suites either run for real or skip cleanly.
 */

const CONNECTION_STRING = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/**
 * The suite writes real documents, so it must never be pointed at a database
 * anybody cares about. Falling back to DATABASE_URL is a convenience for a
 * machine with only one database configured; it is not licence to run against
 * a development or production one, and this is the check that says so.
 */
if (CONNECTION_STRING) {
  const kind = classify(CONNECTION_STRING, { ...process.env, DATABASE_ENV: undefined });
  if (kind !== 'test') {
    throw new Error(
      `Refusing to run the test suite against "${databaseName(CONNECTION_STRING)}", ` +
        `which is classified as ${kind}.
` +
        'These tests create, post and cancel real documents. Set TEST_DATABASE_URL ' +
        'in server/.env to a database whose name marks it as a test one.'
    );
  }
}

async function probe() {
  if (!CONNECTION_STRING) {
    return { ok: false, reason: 'TEST_DATABASE_URL is not set' };
  }

  const client = new pg.Client({
    connectionString: CONNECTION_STRING,
    connectionTimeoutMillis: 4000,
  });

  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT (SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'public')::int AS tables`
    );
    await client.end();

    if (rows[0].tables === 0) {
      return { ok: false, reason: 'database is empty — run: npm run db:setup' };
    }
    return { ok: true, reason: null };
  } catch (err) {
    await client.end().catch(() => {});
    return { ok: false, reason: err.message };
  }
}

const result = await probe();

export const HAS_DB = result.ok;
export const SKIP_REASON = result.reason;

if (!HAS_DB) {
  console.log(
    `\n  Integration and security tests skipped: ${SKIP_REASON}` +
      '\n  Configure server/.env, then: npm run db:setup\n'
  );
}
