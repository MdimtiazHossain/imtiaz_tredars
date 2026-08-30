#!/usr/bin/env node
/**
 * Static cross-check of application SQL against the schema.
 *
 * Catches, without needing a database:
 *   1. INSERT column lists naming a column the table does not have
 *   2. INSERT/UPDATE statements whose $n placeholders do not match the number
 *      of values passed
 *   3. References to a table that no migration creates
 *
 * These are the mistakes that otherwise only surface on the first real run.
 *
 *   node tools/check-sql.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* ------------------------------------------------------------------ schema */

function readSchema() {
  const dir = path.join(ROOT, 'db', 'migrations');
  const sql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');

  const tables = new Map();

  // CREATE TABLE name ( ... ) — balance parentheses to find the body.
  const re = /CREATE TABLE (\w+)\s*\(/g;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    const body = sql.slice(re.lastIndex, i - 1);

    const columns = new Set();
    let nesting = 0;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      // Only top-level lines declare columns; skip table constraints.
      if (nesting === 0 && /^[a-z_][a-z0-9_]*\s+/i.test(line)) {
        const first = line.split(/\s+/)[0].toLowerCase();
        if (!['check', 'unique', 'primary', 'foreign', 'constraint'].includes(first)) {
          columns.add(first);
        }
      }
      for (const ch of line) {
        if (ch === '(') nesting++;
        else if (ch === ')') nesting--;
      }
    }
    tables.set(name, columns);
  }

  // Views are readable but have no writable column list we check.
  const views = new Set(
    [...sql.matchAll(/CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW (\w+)/gi)].map((v) =>
      v[1].toLowerCase()
    )
  );

  // A later migration may add a column rather than recreate the table, so
  // apply ALTER TABLE ... ADD COLUMN too. Without this, every additive
  // migration makes the checker report the new column as non-existent.
  const alterRe = /ALTER TABLE (?:ONLY\s+)?(\w+)[\s\S]*?ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)/gi;
  let a;
  while ((a = alterRe.exec(sql))) {
    const table = tables.get(a[1].toLowerCase());
    if (table) table.add(a[2].toLowerCase());
  }

  return { tables, views };
}

/* ------------------------------------------------------- application files */

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(js|mjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'db', 'seed'));
  return out;
}

const { tables, views } = readSchema();
const problems = [];

for (const file of sourceFiles()) {
  const rel = path.relative(ROOT, file);
  // Strip comments first: prose like "FROM the ledger" is not a SQL clause.
  const code = fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // ---- 1. INSERT column lists -------------------------------------------
  const insertRe = /INSERT INTO\s+(\w+)\s*\n?\s*\(([^)]*)\)/gi;
  let m;
  while ((m = insertRe.exec(code))) {
    const table = m[1];
    if (!tables.has(table)) {
      if (!views.has(table) && !table.startsWith('${')) {
        problems.push(`${rel}: INSERT INTO unknown table "${table}"`);
      }
      continue;
    }
    const known = tables.get(table);
    const columns = m[2]
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    for (const col of columns) {
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
      if (!known.has(col)) {
        problems.push(`${rel}: table "${table}" has no column "${col}"`);
      }
    }
  }

  // ---- 2. placeholder count vs values array -----------------------------
  // Matches: client.query(`... $n ...`, [ ... ]) on the common shapes.
  const callRe = /\.query\(\s*`([^`]*)`\s*,\s*\[([\s\S]*?)\]\s*\)/g;
  while ((m = callRe.exec(code))) {
    const sql = m[1];
    const argsBlock = m[2];

    const placeholders = new Set([...sql.matchAll(/\$(\d+)/g)].map((p) => Number(p[1])));
    if (!placeholders.size) continue;
    const highest = Math.max(...placeholders);

    // Count top-level commas in the values array.
    const trimmedArgs = argsBlock.trim().replace(/,\s*$/, '');
    let depth = 0;
    let count = trimmedArgs ? 1 : 0;
    let inStr = null;
    for (let i = 0; i < trimmedArgs.length; i++) {
      const ch = trimmedArgs[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
      else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) count++;
    }

    // A placeholder may legitimately repeat (e.g. $10 twice), so compare the
    // highest index rather than the count of occurrences.
    if (count !== highest) {
      const preview = sql.trim().split('\n')[0].slice(0, 60);
      problems.push(
        `${rel}: query uses $1..$${highest} but passes ${count} value(s) — "${preview}..."`
      );
    }
  }

  // ---- 3. FROM/JOIN/UPDATE against unknown relations ---------------------
  // Scan only the template literals that actually hold a query. Error messages
  // are template literals too, and prose like "sold from the destination"
  // would otherwise be read as a FROM clause on a table named "the".
  const scannable = [...code.matchAll(/`(?:[^`\\]|\\.)*`/g)]
    .map((lit) => lit[0].slice(1, -1))
    .filter((lit) => /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(lit))
    .join('\n;\n');
  const relRe = /\b(?:FROM|JOIN|UPDATE)\s+([a-z_][a-z0-9_]*)\b/gi;
  while ((m = relRe.exec(scannable))) {
    const name = m[1].toLowerCase();
    if (['select', 'set', 'where', 'values', 'only', 'lateral'].includes(name)) continue;
    if (tables.has(name) || views.has(name)) continue;
    if (name === 'schema_migrations' || name === 'information_schema') continue;
    problems.push(`${rel}: references unknown relation "${name}"`);
  }
}

console.log(`Schema: ${tables.size} tables, ${views.size} views\n`);

if (!problems.length) {
  console.log('No mismatches found between application SQL and the schema.');
} else {
  const unique = [...new Set(problems)];
  console.log(`${unique.length} problem(s):\n`);
  for (const p of unique) console.log('  ' + p);
  process.exitCode = 1;
}
