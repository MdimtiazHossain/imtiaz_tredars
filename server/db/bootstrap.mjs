#!/usr/bin/env node
/**
 * One-step database bootstrap.
 *
 * Use this when the `business_suite` password is unknown or was never recorded.
 * You supply the `postgres` superuser password once; this then:
 *
 *   1. creates the `business_suite` role if it does not exist
 *   2. sets a freshly generated strong password on it
 *   3. creates `business_suite` and `business_suite_test` if they do not exist
 *   4. grants the role ownership of each database's public schema
 *   5. writes both connection strings into `.env` and generates JWT_SECRET
 *   6. verifies that the new credentials actually connect
 *
 * The generated password is written only to `.env`, which is gitignored. It is
 * never printed, never passed as a command-line argument, and never needs to be
 * typed. Connecting as the superuser uses the `pg` driver directly rather than
 * psql, so it does not depend on the command-line tools being runnable.
 *
 *   node db/bootstrap.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, '..', '.env');
const EXAMPLE_PATH = path.join(HERE, '..', '.env.example');

const HOST = process.env.PGHOST || '127.0.0.1';
const PORT = Number(process.env.PGPORT || 5432);
const SUPERUSER = process.env.PGSUPERUSER || 'postgres';

const APP_ROLE = 'business_suite';
const APP_DB = 'business_suite';
const TEST_DB = 'business_suite_test';

/** Read a line from stdin without echoing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    // Without a terminal there is no echo to turn off, so read the password
    // from piped stdin rather than failing. This is what lets the script run
    // from a wrapper or a non-interactive shell.
    if (!process.stdin.isTTY) {
      let piped = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        piped += chunk;
      });
      process.stdin.on('end', () => resolve(piped.split('\n')[0].replace(/\r$/, '')));
      process.stdin.on('error', reject);
      process.stdin.resume();
      return;
    }

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (char === '' || char === '') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(1);
      }
      if (char === '' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    process.stdin.on('data', onData);
  });
}

function connect(database, user, password) {
  return new pg.Client({
    host: HOST,
    port: PORT,
    database,
    user,
    password,
    connectionTimeoutMillis: 8000,
  });
}

/** Quote a literal for use in a DDL statement that cannot take parameters. */
const lit = (value) => "'" + String(value).replaceAll("'", "''") + "'";

async function main() {
  console.log(`\nBootstrapping ${APP_DB} on ${HOST}:${PORT} as ${SUPERUSER}.\n`);

  // PGSUPERPASS supplies the password without a prompt, for callers that have
  // no terminal. Prefer the prompt when there is one: an environment variable
  // is readable by every process this user owns for as long as it is set.
  const superPassword =
    process.env.PGSUPERPASS ||
    (await promptHidden(`Password for the "${SUPERUSER}" superuser: `));
  if (!superPassword) {
    console.error('\nNo password entered. Nothing was changed.');
    process.exit(1);
  }

  // A URL-safe password, so it never needs percent-encoding in a DSN.
  const appPassword = crypto.randomBytes(24).toString('base64url');

  const admin = connect('postgres', SUPERUSER, superPassword);
  try {
    await admin.connect();
  } catch (err) {
    console.error(`\nCould not connect as ${SUPERUSER}: ${err.message}`);
    console.error(
      '\nIf you do not know this password either, reset it from an elevated\n' +
        'prompt on the machine that runs PostgreSQL, or reinstall PostgreSQL.\n' +
        'Nothing in this project has been changed.'
    );
    process.exit(1);
  }

  console.log('  connected as superuser');

  try {
    // 1 + 2. Role: create if missing, then set a known password either way.
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (role.rowCount === 0) {
      await admin.query(`CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${lit(appPassword)}`);
      console.log(`  created role ${APP_ROLE}`);
    } else {
      await admin.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${lit(appPassword)}`);
      console.log(`  reset password on existing role ${APP_ROLE}`);
    }

    // 3. Databases. CREATE DATABASE cannot run inside a transaction block, and
    //    the driver does not wrap single statements, so this is fine as-is.
    for (const db of [APP_DB, TEST_DB]) {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE ${db} OWNER ${APP_ROLE}`);
        console.log(`  created database ${db}`);
      } else {
        await admin.query(`ALTER DATABASE ${db} OWNER TO ${APP_ROLE}`);
        console.log(`  database ${db} already existed (ownership confirmed)`);
      }
    }
  } finally {
    await admin.end().catch(() => {});
  }

  // 4. The app owns its own schema, so migrations can create and drop objects.
  for (const db of [APP_DB, TEST_DB]) {
    const client = connect(db, SUPERUSER, superPassword);
    await client.connect();
    try {
      await client.query(`GRANT ALL ON SCHEMA public TO ${APP_ROLE}`);
      await client.query(`ALTER SCHEMA public OWNER TO ${APP_ROLE}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
  console.log('  granted schema ownership');

  // 5. Write .env.
  const encoded = encodeURIComponent(appPassword);
  const source = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8')
    : fs.readFileSync(EXAMPLE_PATH, 'utf8');

  let next = source
    .replace(
      /^DATABASE_URL=.*$/m,
      `DATABASE_URL=postgres://${APP_ROLE}:${encoded}@${HOST}:${PORT}/${APP_DB}`
    )
    .replace(
      /^TEST_DATABASE_URL=.*$/m,
      `TEST_DATABASE_URL=postgres://${APP_ROLE}:${encoded}@${HOST}:${PORT}/${TEST_DB}`
    );

  if (/^JWT_SECRET=\s*$/m.test(next)) {
    next = next.replace(
      /^JWT_SECRET=\s*$/m,
      `JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`
    );
  }

  fs.writeFileSync(ENV_PATH, next, 'utf8');
  console.log(`  wrote ${path.relative(process.cwd(), ENV_PATH)}`);

  // 6. Verify with the credentials just written.
  console.log('\nVerifying...');
  let allOk = true;
  for (const [db, label] of [[APP_DB, 'business_suite     '], [TEST_DB, 'business_suite_test']]) {
    const client = connect(db, APP_ROLE, appPassword);
    try {
      await client.connect();
      const { rows } = await client.query(
        `SELECT (SELECT COUNT(*) FROM information_schema.tables
                  WHERE table_schema = 'public')::int AS tables`
      );
      console.log(`  ${label}: connected (${rows[0].tables} public tables)`);
    } catch (err) {
      console.log(`  ${label}: FAILED — ${err.message}`);
      allOk = false;
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (!allOk) {
    console.error('\nVerification failed. Check pg_hba.conf allows local connections.');
    process.exit(1);
  }

  console.log('\nDone. The generated password is in .env only — you never need to type it.');
  console.log('\nNext:  npm run db:setup && npm test\n');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
