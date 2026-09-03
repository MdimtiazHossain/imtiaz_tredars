import 'dotenv/config';
import { beforeAll } from 'vitest';
import pg from 'pg';
import { classify } from '../../db/safety.mjs';

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

    // The suites are written against an installation in ordinary use, where
    // the people holding these accounts replaced the passwords they were
    // issued with long ago. The seed flags every account it creates
    // `must_change_pw` -- rightly, it hands out one-time passwords -- and the
    // API now refuses a flagged account everything but its own password. Left
    // set, every suite that signs in with the seed password would be testing
    // that gate instead of whatever it is actually about. The file that is
    // about the gate sets the flag on an account of its own, per case.
    await client.query(`UPDATE users SET must_change_pw = false WHERE must_change_pw`);
  } catch {
    // Nothing to do: the suite itself will skip or fail with a better message.
  } finally {
    await client.end().catch(() => {});
  }
});
