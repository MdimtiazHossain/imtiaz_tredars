/**
 * Which database a command is about to act on, and whether it may.
 *
 * This exists because a development database was destroyed by a command that
 * was aimed at the test one. Nothing in the tooling had an opinion about the
 * difference: every script read `DATABASE_URL`, the destructive ones took a
 * `--force` that meant "yes I typed this on purpose" rather than "yes, against
 * *this* database", and the test suite resolved its connection through the same
 * config as the application — so it had been writing to development all along.
 *
 * The rule this enforces:
 *
 *   TEST         reset, seed and migrate freely — it exists to be thrown away
 *   DEVELOPMENT  migrate and seed; a reset needs a second, explicit flag
 *   PRODUCTION   never reset, whatever flags are passed
 *
 * Classification is explicit where the operator has said (`DATABASE_ENV`) and
 * inferred from the database name otherwise, erring towards the more protected
 * answer: something unrecognised is treated as production, because the cost of
 * wrongly protecting a scratch database is a flag and the cost of wrongly
 * exposing a real one is somebody's books.
 */

/** The name at the end of a connection string, without query parameters. */
export function databaseName(url) {
  const match = String(url || '').match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : '';
}

/**
 * @param {string} url
 * @param {object} [env] process.env, injectable for testing
 * @returns {'test'|'development'|'production'}
 */
export function classify(url, env = process.env) {
  const declared = String(env.DATABASE_ENV || '').toLowerCase();
  if (declared === 'test' || declared === 'development' || declared === 'production') {
    return declared;
  }

  const name = databaseName(url).toLowerCase();
  if (/(^|[_-])test($|[_-])|_test$/.test(name)) return 'test';
  if (/(^|[_-])(dev|development|local)($|[_-])|_dev$/.test(name)) return 'development';

  // A database whose name says nothing is assumed to be the real one.
  return 'production';
}

/** The connection a command should act on, given how it was invoked. */
export function resolveTarget(env = process.env) {
  const useTest = env.NODE_ENV === 'test';
  const url = useTest ? env.TEST_DATABASE_URL || env.DATABASE_URL : env.DATABASE_URL;
  return { url, kind: classify(url, useTest ? { ...env, DATABASE_ENV: 'test' } : env) };
}

/** A connection string with its password removed, for printing. */
export const maskUrl = (url) => String(url || '').replace(/:[^:@/]*@/, ':***@');

/** The flag that allows a destructive command against development. */
export const OVERRIDE_FLAG = '--allow-destroying-development';

/**
 * Decide whether a destructive command may proceed.
 *
 * @param {object} o
 * @param {string} o.url        connection the command would act on
 * @param {string} o.command    what the operator ran, for the message
 * @param {boolean} [o.override] the explicit development override was passed
 * @returns {{allowed: boolean, kind: string, reason?: string}}
 */
export function checkDestructive({ url, command, override = false, kind }, env = process.env) {
  kind = kind || classify(url, env);
  const name = databaseName(url);

  if (kind === 'test') return { allowed: true, kind };

  if (kind === 'production') {
    return {
      allowed: false,
      kind,
      reason:
        `Refusing to run ${command} against "${name}", which is classified as a ` +
        'PRODUCTION database.\n' +
        'There is no flag for this. If the classification is wrong, set ' +
        'DATABASE_ENV=development in server/.env.',
    };
  }

  if (!override) {
    return {
      allowed: false,
      kind,
      reason:
        `Refusing to run ${command} against "${name}", the DEVELOPMENT database.\n` +
        'This destroys every record in it, and there is no undo.\n\n' +
        'If you meant the test database:\n' +
        `    NODE_ENV=test npm run ${command}\n\n` +
        'If you really do mean development, back it up first and then pass:\n' +
        `    ${OVERRIDE_FLAG}`,
    };
  }

  return { allowed: true, kind };
}

/**
 * Refuse loudly, or return the target.
 *
 * Used by the command-line scripts, which should stop rather than throw a
 * stack trace at somebody who is about to lose data.
 */
export function guardDestructive(options) {
  const verdict = checkDestructive(options);
  if (!verdict.allowed) {
    console.error(`\n${verdict.reason}\n`);
    process.exit(1);
  }
  return verdict;
}
