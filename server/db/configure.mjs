#!/usr/bin/env node
/**
 * Interactive database configuration.
 *
 * Prompts for the `business_suite` password with the terminal echo turned off,
 * writes it into both connection strings in `.env`, and verifies that it
 * actually connects before saving anything. The password is never passed as a
 * command-line argument, so it does not land in shell history.
 *
 *   node db/configure.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, '..', '.env');
const EXAMPLE_PATH = path.join(HERE, '..', '.env.example');

/** Read a line from stdin without echoing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          'This script needs an interactive terminal. Run it directly:\n' +
            '  cd server && node db/configure.mjs'
        )
      );
      return;
    }

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let value = '';
    const onData = (char) => {
      // Enter, or Ctrl-C / Ctrl-D to abort.
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
      // Backspace.
      if (char === '' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    process.stdin.on('data', onData);
  });
}

function buildEnv(password) {
  const encoded = encodeURIComponent(password);
  const source = fs.existsSync(ENV_PATH)
    ? fs.readFileSync(ENV_PATH, 'utf8')
    : fs.readFileSync(EXAMPLE_PATH, 'utf8');

  let next = source
    // Replace whatever password currently sits between the colon and the @.
    .replace(
      /^(DATABASE_URL=postgres:\/\/[^:]+:)[^@]*(@.*)$/m,
      (_m, head, tail) => `${head}${encoded}${tail}`
    )
    .replace(
      /^(TEST_DATABASE_URL=postgres:\/\/[^:]+:)[^@]*(@.*)$/m,
      (_m, head, tail) => `${head}${encoded}${tail}`
    );

  // Generate a signing secret if the file still has an empty one.
  if (/^JWT_SECRET=\s*$/m.test(next)) {
    next = next.replace(
      /^JWT_SECRET=\s*$/m,
      `JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}`
    );
  }

  return next;
}

async function verify(connectionString, label) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT current_database() AS db,
              current_user       AS usr,
              (SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'public')::int AS tables`
    );
    console.log(
      `  ${label}: connected to ${rows[0].db} as ${rows[0].usr} ` +
        `(${rows[0].tables} existing public tables)`
    );
    return true;
  } catch (err) {
    console.log(`  ${label}: FAILED — ${err.message}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const password = await promptHidden('Password for the business_suite role: ');

if (!password) {
  console.error('\nNo password entered. Nothing was written.');
  process.exit(1);
}

const candidate = buildEnv(password);

// Verify before writing, so a wrong password never overwrites a working file.
const urls = Object.fromEntries(
  candidate
    .split('\n')
    .filter((l) => /^(TEST_)?DATABASE_URL=/.test(l))
    .map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)])
);

console.log('\nVerifying...');
const mainOk = await verify(urls.DATABASE_URL, 'business_suite     ');
const testOk = await verify(urls.TEST_DATABASE_URL, 'business_suite_test');

if (!mainOk) {
  console.error(
    '\nThe password was not accepted, so .env was left unchanged.\n' +
      'Check the password you used in db/setup.sql and try again.'
  );
  process.exit(1);
}

fs.writeFileSync(ENV_PATH, candidate, 'utf8');
console.log(`\nWrote ${ENV_PATH}`);
if (!testOk) {
  console.log(
    'The test database did not connect. Integration tests will skip until it does.\n' +
      'Create it with:  CREATE DATABASE business_suite_test OWNER business_suite;'
  );
}
console.log('\nNext:  npm run db:migrate && npm run db:seed && npm test\n');
