#!/usr/bin/env node
/**
 * Start again with an empty business.
 *
 * Drops the schema, re-applies every migration and installs only what a
 * Business Suite database needs to be a working system: access control, one
 * organisation, its financial year, document numbering, the approval and
 * notification rules, and the units trade is measured in. No customers, no
 * suppliers, no products, no transactions -- the first record entered is a real
 * one.
 *
 * This destroys everything in the database it is pointed at. It refuses to run
 * unless `--force` is passed, and prints what it is about to delete first.
 *
 *   node db/fresh.mjs --force --name "Imtiaz Traders" --admin imtiaz
 *
 * The admin is created with a generated one-time password, printed once, and
 * flagged `must_change_pw`, so the person holding the account chooses the real
 * password on first sign-in and it is never written down anywhere.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { withTransaction, query, closePool } from '../src/lib/db.js';
import { guardDestructive, resolveTarget, maskUrl, OVERRIDE_FLAG } from './safety.mjs';
import { hashPassword } from '../src/services/authService.js';
import {
  installAccessControl,
  installBusinessTypes,
  installOrganization,
  installFiscalYear,
  installChartOfAccounts,
  installNumbering,
  installApprovalRules,
  installNotificationRules,
  installUnits,
  installAdmin,
  fiscalYearFor,
} from './foundation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(HERE, '..', '.env');

/**
 * Issue a new signing secret, so tokens from the old database stop working.
 *
 * Access tokens are stateless JWTs naming a user by id. Wiping the database and
 * creating a new administrator hands that administrator id 1 -- the id the
 * previous one had -- so a browser still holding yesterday's token goes on
 * being signed in, now as the new account. Rotating the secret is what makes
 * "start again" mean it.
 *
 * @returns {boolean} whether the secret was replaced
 */
function rotateSigningSecret() {
  if (!fs.existsSync(ENV_PATH)) return false;
  const source = fs.readFileSync(ENV_PATH, 'utf8');
  if (!/^JWT_SECRET=.*$/m.test(source)) return false;
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(ENV_PATH, source.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`), 'utf8');
  return true;
}

/** `--name "Imtiaz Traders"` -> {name: 'Imtiaz Traders'} */
function readArgs(argv) {
  const out = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') out.force = true;
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

/** A code like IMTIAZ, derived from the business name. */
function codeFrom(name) {
  const letters = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.slice(0, 10) || 'ORG';
}

/**
 * A one-time password: readable enough to be typed once from a screen, random
 * enough that guessing it is not worth trying.
 */
function oneTimePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('') + '!7';
}

/** What is about to be destroyed, so the confirmation means something. */
async function census() {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*) FROM organizations)                      AS organisations,
       (SELECT COUNT(*) FROM users)                              AS users,
       (SELECT COUNT(*) FROM customers) + (SELECT COUNT(*) FROM suppliers)
         + (SELECT COUNT(*) FROM companies)                      AS parties,
       (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM crops) AS items,
       (SELECT COUNT(*) FROM crop_purchases) + (SELECT COUNT(*) FROM crop_sales)
         + (SELECT COUNT(*) FROM dealer_purchases) + (SELECT COUNT(*) FROM dealer_sales)
         + (SELECT COUNT(*) FROM payments) + (SELECT COUNT(*) FROM expenses) AS documents,
       (SELECT COUNT(*) FROM stock_movements)                    AS movements,
       (SELECT COUNT(*) FROM audit_logs)                         AS audit_entries`
  );
  return rows[0];
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const name = args.name || 'Imtiaz Tredars';
  const username = (args.admin || 'admin').toLowerCase();
  const adminName = args['admin-name'] || 'Administrator';

  const target = resolveTarget();
  console.log(`Database: ${maskUrl(target.url)}`);
  console.log(`Classified as: ${target.kind.toUpperCase()}`);

  // Which database this is decides whether it may be destroyed at all. The
  // --force flag below only ever meant "I typed this deliberately"; it never
  // meant "against this database", which is the distinction that matters.
  guardDestructive({
    url: target.url,
    command: 'db:fresh',
    override: args[OVERRIDE_FLAG.slice(2)] !== undefined || process.argv.includes(OVERRIDE_FLAG),
  });

  let before;
  try {
    before = await census();
    console.log('\nAbout to permanently delete:');
    for (const [what, n] of Object.entries(before)) {
      console.log(`  ${String(n).padStart(6)}  ${what.split('_').join(' ')}`);
    }
  } catch {
    console.log('\nNo Business Suite schema found; this will create one.');
  }

  if (!args.force) {
    console.error(
      '\nRefusing to run without --force. Nothing has been changed.\n' +
        'Re-run with --force once the list above is what you meant to delete.'
    );
    process.exitCode = 1;
    return;
  }

  // The pool stays open across the reset. Its connections are idle by now and
  // hold no locks, so they do not block the schema drop -- and ending it here
  // would leave nothing to install through afterwards, since the pool in
  // `lib/db.js` is a singleton that cannot be reopened.
  //
  // The migration runner owns dropping and rebuilding the schema; running it as
  // a child keeps one implementation of that rather than a second copy here.
  console.log('\nResetting the schema…');
  const reset = spawnSync(process.execPath, [path.join(HERE, 'migrate.mjs'), 'reset'], {
    stdio: 'inherit',
  });
  if (reset.status !== 0) {
    console.error('The schema reset failed; nothing further was attempted.');
    process.exitCode = 1;
    return;
  }

  const rotated = rotateSigningSecret();
  const password = oneTimePassword();
  const passwordHash = await hashPassword(password);

  const summary = await withTransaction(async (client) => {
    const roleByCode = await installAccessControl(client);
    await installBusinessTypes(client);

    const orgId = await installOrganization(client, { code: codeFrom(name), name });
    const year = fiscalYearFor(new Date());
    await installFiscalYear(client, orgId, year);
    await installChartOfAccounts(client, orgId);
    await installNumbering(client, orgId);
    await installApprovalRules(client, orgId);
    await installNotificationRules(client, orgId);
    const units = await installUnits(client);

    await installAdmin(client, {
      orgId,
      roleId: roleByCode.get('Admin'),
      code: 'EMP-01',
      name: adminName,
      designation: 'Administrator',
      username,
      passwordHash,
    });

    return { orgId, year, units: units.size, roles: roleByCode.size };
  });

  console.log('\nInstalled:');
  console.log(`  organisation   ${name} (id ${summary.orgId})`);
  console.log(`  financial year ${summary.year.code}, ${summary.year.startsOn} to ${summary.year.endsOn}`);
  console.log(`  roles          ${summary.roles}, with their permissions`);
  console.log(`  units          ${summary.units}`);
  console.log('  numbering, approval limits and notification rules at their defaults');
  if (rotated) {
    console.log('  a new signing secret, so every session issued before now is dead');
  }
  console.log('\nNothing else. No customers, suppliers, companies, products, crops,');
  console.log('warehouses, stock, documents or audit history.');
  if (rotated) {
    console.log('\nRestart the API so it reads the new signing secret.');
  }

  console.log(`\n  Sign in as   ${username}`);
  console.log(`  One-time password   ${password}`);
  console.log('\nThe account is flagged to force a password change, so this key stops');
  console.log('working the moment it is used. Set the company name, licence and');
  console.log('address on the Settings screen afterwards.');

  await closePool();
}

main().catch(async (err) => {
  console.error('\nFailed:', err.message);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
