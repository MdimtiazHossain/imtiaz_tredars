#!/usr/bin/env node
/**
 * Take a copy of a database before anything irreversible happens to it.
 *
 * Written because a development database was destroyed and there was nothing
 * to restore from. A guard that refuses a reset is worth more when the answer
 * to "I really do mean it" is a backup rather than a shrug.
 *
 *   node db/backup.mjs                 back up the development database
 *   NODE_ENV=test node db/backup.mjs   back up the test database
 *   node db/backup.mjs --out path.sql  choose where it goes
 *
 * Restore with psql:
 *
 *   psql "$DATABASE_URL" -f db/backups/<file>.sql
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { resolveTarget, maskUrl, databaseName } from './safety.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(HERE, 'backups');

/** `2026-08-31_1641` — sortable, and readable in a directory listing. */
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

function outputPath(argv, name) {
  const flag = argv.indexOf('--out');
  if (flag > -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  return path.join(BACKUP_DIR, `${name}_${stamp()}.sql`);
}

/**
 * pg_dump, wherever PostgreSQL put it.
 *
 * On Windows the client tools are installed beside the server rather than on
 * PATH, so a backup that only tries `pg_dump` fails on the machine most likely
 * to be running this — which is the one moment a backup matters.
 */
function findPgDump() {
  const onPath = spawnSync('pg_dump', ['--version'], { stdio: 'ignore' });
  if (!onPath.error) return 'pg_dump';

  for (const root of ['C:/Program Files/PostgreSQL', 'C:/Program Files (x86)/PostgreSQL']) {
    if (!fs.existsSync(root)) continue;
    const versions = fs
      .readdirSync(root)
      .filter((entry) => /^\d+$/.test(entry))
      .sort((a, b) => Number(b) - Number(a));

    for (const version of versions) {
      const candidate = path.join(root, version, 'bin', 'pg_dump.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const target = resolveTarget();
if (!target.url) {
  console.error('No database configured. Set DATABASE_URL in server/.env.');
  process.exit(1);
}

const name = databaseName(target.url);
const file = outputPath(process.argv.slice(2), name);
fs.mkdirSync(path.dirname(file), { recursive: true });

console.log(`Database: ${maskUrl(target.url)}`);
console.log(`Classified as: ${target.kind.toUpperCase()}`);
console.log(`Writing: ${file}`);

const pgDump = findPgDump();
if (!pgDump) {
  console.error(
    [
      '',
      'pg_dump was not found.',
      'It ships with PostgreSQL; on Windows it is usually in',
      '  C:\\Program Files\\PostgreSQL\\<version>\\bin',
      'Add that directory to PATH, or copy the database another way before',
      'running anything destructive.',
    ].join('\n')
  );
  process.exit(1);
}

// pg_dump rather than a hand-rolled export: it is the tool that knows about
// sequences, constraint ordering and the extensions this schema installs.
const dump = spawnSync(pgDump, ['--no-owner', '--no-privileges', '--file', file, target.url], {
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (dump.status !== 0) {
  console.error(`\npg_dump exited with ${dump.status}. Nothing can be assumed to be backed up.`);
  process.exit(1);
}

const size = fs.statSync(file).size;
console.log(`\nBacked up ${name} — ${(size / 1024).toFixed(1)} kB`);
console.log(`Restore with:\n    psql "<connection string>" -f ${file}`);
