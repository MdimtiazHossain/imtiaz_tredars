#!/usr/bin/env node
/**
 * Run the suite, and say truthfully what it covered.
 *
 * A worker process occasionally exits at the end of a file. Vitest raises
 * "Worker exited unexpectedly", exits non-zero, and prints a summary with that
 * file missing from it: "14 passed (15)", "329 passed (332)". It looks exactly
 * like a file was skipped.
 *
 * It was not. The JSON report from the same run lists all fifteen files with
 * their full assertion counts, totalling every test -- including the one the
 * summary dropped. The tests ran and passed; the worker died afterwards, and
 * the console summary is written from state that the exit had already
 * disturbed. Compared across a good run and a flaked one, the per-file counts
 * are identical.
 *
 * So the console cannot be read for coverage, and this reads the JSON instead.
 * It fails when a file genuinely produced nothing, reports whatever the JSON
 * says failed, and -- where the two disagree -- says which of the two is
 * describing the run.
 *
 * Nothing here makes a red run green: if vitest exits non-zero, so does this.
 * The point is that the operator can tell a flake from a regression without
 * having memorised that a complete run says 332.
 *
 *   node tools/run-tests.mjs              the whole suite, coverage checked
 *   node tools/run-tests.mjs returns      passed through to vitest as a filter
 *
 * A filtered run cannot be checked this way -- vitest, not this script, decides
 * what the filter matches -- so the check is skipped and says so.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TESTS = path.join(ROOT, 'tests');
const REPORT = path.join(ROOT, 'node_modules', '.vitest-run-report.json');

/** Every test file on disk, as absolute paths. */
function testFiles(dir = TESTS) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/** Same file, whatever separator and case the two sides happen to use. */
const key = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const args = process.argv.slice(2);
// Anything that is not a flag narrows the run to a subset vitest chooses.
const filtered = args.some((a) => !a.startsWith('-'));

fs.rmSync(REPORT, { force: true });

const vitest = spawnSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    ...args,
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
  ],
  { stdio: 'inherit', cwd: ROOT }
);
const vitestFailed = vitest.status !== 0;

if (filtered) {
  console.log('\n  Filtered run: coverage not checked.');
  process.exit(vitest.status ?? 1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
} catch {
  console.error(
    '\n  The run produced no JSON report, so what it covered cannot be established.' +
      '\n  Treating that as a failure.'
  );
  process.exit(1);
}

const results = report.testResults || [];
const reported = new Set(results.map((r) => key(r.name)));
const expected = testFiles();
const missing = expected.filter((f) => !reported.has(key(f)));
const ran = results.reduce((t, r) => t + (r.assertionResults || []).length, 0);
const failed = results.flatMap((r) =>
  (r.assertionResults || [])
    .filter((a) => a.status === 'failed')
    .map((a) => `${rel(r.name)} > ${a.fullName || a.title}`)
);

console.log('');

if (missing.length) {
  const plural = missing.length === 1 ? 'file' : 'files';
  console.error(`  ${missing.length} test ${plural} produced no result at all:\n`);
  for (const f of missing) console.error(`      ${rel(f)}`);
  console.error('\n  The suite did not run everything it was asked to.\n');
  process.exit(1);
}

if (failed.length) {
  console.error(`  ${failed.length} failing:\n`);
  for (const f of failed.slice(0, 20)) console.error(`      ${f}`);
  if (failed.length > 20) console.error(`      ... and ${failed.length - 20} more`);
  console.error('');
  process.exit(vitest.status ?? 1);
}

console.log(`  All ${expected.length} test files reported, ${ran} tests, none failing.`);

if (vitestFailed) {
  console.error(
    '\n  Vitest still exited non-zero, and its summary above is missing a file.' +
      '\n  That is the worker-exit flake: the worker died after the file finished,' +
      '\n  so the tests ran and passed but the summary was written from disturbed' +
      '\n  state. Coverage was complete. Failing anyway, because a process that' +
      '\n  dies unexpectedly is not a thing to pass over.\n'
  );
  process.exit(vitest.status ?? 1);
}
