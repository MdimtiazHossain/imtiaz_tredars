#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Applies every `db/migrations/*.sql` file that has not run yet, in filename
 * order, each inside its own transaction. Applied files are recorded with a
 * checksum so an edited migration is caught rather than silently skipped.
 *
 *   node db/migrate.mjs up      apply pending migrations
 *   node db/migrate.mjs status  show what is applied and what is pending
 *   node db/migrate.mjs reset   drop the schema and re-apply everything
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

const DATABASE_URL =
  process.env.NODE_ENV === 'test'
    ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    : process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\n' +
      'Copy server/.env.example to server/.env and set your connection string.'
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

function readMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: sha(sql) };
    });
}

async function ensureMigrationsTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applied() {
  const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function up() {
  await ensureMigrationsTable();
  const done = await applied();
  const all = readMigrations();
  let count = 0;

  for (const m of all) {
    const previous = done.get(m.filename);
    if (previous) {
      if (previous !== m.checksum) {
        throw new Error(
          `Migration ${m.filename} changed after being applied ` +
            `(${previous} -> ${m.checksum}). Add a new migration instead of editing it.`
        );
      }
      continue;
    }

    process.stdout.write(`  applying ${m.filename} ... `);
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [m.filename, m.checksum]
      );
      await client.query('COMMIT');
      console.log('ok');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw new Error(`${m.filename}: ${err.message}`, { cause: err });
    }
  }

  console.log(count ? `\n${count} migration(s) applied.` : '\nAlready up to date.');
}

async function status() {
  await ensureMigrationsTable();
  const done = await applied();
  for (const m of readMigrations()) {
    const state = done.has(m.filename)
      ? done.get(m.filename) === m.checksum
        ? 'applied'
        : 'CHANGED SINCE APPLIED'
      : 'pending';
    console.log(`  ${m.filename.padEnd(28)} ${state}`);
  }
}

async function reset() {
  console.log('  dropping schema public ...');
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  await up();
}

const command = process.argv[2] || 'up';

try {
  await client.connect();
  if (command === 'up') await up();
  else if (command === 'status') await status();
  else if (command === 'reset') await reset();
  else {
    console.error(`Unknown command: ${command}. Use up | status | reset.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nMigration error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
