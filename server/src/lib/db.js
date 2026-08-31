import pg from 'pg';
import { config } from './config.js';

/**
 * PostgreSQL access.
 *
 * Everything that writes goes through `withTransaction`, so a failed step
 * rolls the whole document back rather than leaving stock moved but no
 * receivable raised.
 */

// Return numeric/bigint as strings rather than lossy JS numbers, then convert
// deliberately at the edge. Money must never round-trip through a float.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

// A `date` is a calendar day, not an instant. Parsed into a JS Date it becomes
// local midnight, which `JSON.stringify` then writes as the previous day
// anywhere east of Greenwich -- so an invoice dated the 31st reached the
// browser as the 30th. Several services carry their own defence against this;
// keeping the column a string means none of them has to.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'business-suite-api',
});

pool.on('error', (err) => {
  // A broken idle client must not take the process down.
  console.error('[db] idle client error:', err.message);
});

/** Run a query on the pool. */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run `fn` inside a single transaction, passing it a dedicated client.
 * Commits on success, rolls back on any throw, and always releases.
 *
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @param {{isolation?: 'READ COMMITTED'|'REPEATABLE READ'|'SERIALIZABLE'}} [opts]
 * @returns {Promise<T>}
 */
export async function withTransaction(fn, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query(
      opts.isolation ? `BEGIN ISOLATION LEVEL ${opts.isolation}` : 'BEGIN'
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Numeric column -> JS number, for arithmetic and JSON responses. */
export const num = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Bigint id column -> JS number. Safe for ids below 2^53. */
export const id = (v) => (v === null || v === undefined ? null : Number(v));

export async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

export async function closePool() {
  await pool.end();
}
