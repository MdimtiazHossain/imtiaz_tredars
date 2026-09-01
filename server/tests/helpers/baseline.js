import 'dotenv/config';
import { beforeAll } from 'vitest';
import pg from 'pg';
import { classify } from '../../db/safety.mjs';
import { TAX_RATES } from '../../db/foundation.mjs';

/**
 * The state every suite is written against, asserted before each one starts.
 *
 * All of the suites share one database, and all but the VAT one assume an
 * unregistered business: their documents total exactly what their goods are
 * worth. The VAT suite registers the business for its own duration and puts it
 * back afterwards.
 *
 * That is correct and it is not sufficient. If the VAT file dies part way
 * through -- a worker exiting under it is rare but real -- its `afterAll`
 * never runs, the flag stays on, and every file that runs afterwards fails by
 * exactly 15% in tests that have nothing to do with tax. The suite that caused
 * it passes, which makes the failure genuinely hard to read: seven red tests
 * across three files, none of them about VAT.
 *
 * Doing this once before the whole run cannot help, because the damage happens
 * mid-run. Doing it before each file costs one statement and means no file can
 * inherit the wreckage of the one before it.
 *
 * That reasoning turns out to be more general than the flag it was written for.
 * The worker does not exit at random: it goes at the end of a file, which is
 * when teardown runs. So the blast radius of the flake is precisely the set of
 * `afterAll` hooks, and a suite that restores shared state on its way out is
 * exactly the thing it breaks -- invisibly, because the tests all passed and
 * the damage lands in whatever runs next. Restoring state is not a way to share
 * a database. Establishing it is.
 *
 * So the two other pieces of org-wide state the suites mutate are put back here
 * as well, from the same declarations the installer uses rather than from
 * numbers copied into this file:
 *
 *   tax rates       one test moves the standard rate to 10% and back to prove a
 *                   credit follows the invoice rather than today's rate. The
 *                   restore is a bare statement in the middle of the test, so
 *                   anything throwing before it leaves every later suite
 *                   charging 10%.
 *   product rates   several tests charge a product at a particular rate. The
 *                   seed assigns none -- a product with a rate on it is always
 *                   residue -- so they are cleared, and a file that needs one
 *                   sets it, which they all already do.
 */
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

beforeAll(async () => {
  if (!url) return;

  // The same refusal the suites make: this writes, so it must never be
  // pointed at a database anybody cares about.
  if (classify(url, { ...process.env, DATABASE_ENV: undefined }) !== 'test') return;

  const client = new pg.Client({ connectionString: url });
  // A client that cannot connect is not a failure here: the suites detect an
  // unreachable database for themselves and skip.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query(
      `UPDATE organizations
          SET is_vat_registered = false,
              sale_prices_include_tax = false,
              purchase_prices_include_tax = false
        WHERE is_vat_registered
           OR sale_prices_include_tax
           OR purchase_prices_include_tax`
    );

    // Only the rates the installer declares. A rate a test invented for itself
    // is its own business and is left alone.
    await client.query(
      `UPDATE tax_rates t SET rate = v.rate
         FROM (SELECT * FROM unnest($1::text[], $2::numeric[]) AS r(code, rate)) v
        WHERE t.code = v.code AND t.rate <> v.rate`,
      [TAX_RATES.map(([code]) => code), TAX_RATES.map((r) => r[4])]
    );

    await client.query('UPDATE products SET tax_rate_id = NULL WHERE tax_rate_id IS NOT NULL');
  } catch {
    // Nothing to do: the suite itself will skip or fail with a better message.
  } finally {
    await client.end().catch(() => {});
  }
});
