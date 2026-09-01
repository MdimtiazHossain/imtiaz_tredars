import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import {
  classify,
  databaseName,
  checkDestructive,
  resolveTarget,
  maskUrl,
  OVERRIDE_FLAG,
} from '../db/safety.mjs';

/**
 * Which database a destructive command is allowed to touch.
 *
 * A development database was destroyed by a command meant for the test one,
 * and the tooling had no way to tell them apart: every script read the same
 * variable, and `--force` meant "I typed this deliberately" rather than "yes,
 * against this database". These are the rules that replaced that.
 */

const DEV = 'postgres://u:p@127.0.0.1:5432/business_suite';
const TEST = 'postgres://u:p@127.0.0.1:5432/business_suite_test';
const PROD = 'postgres://u:p@db.example.com:5432/meghna_live';

describe('classifying a database', () => {
  it('reads an explicit declaration before anything else', () => {
    expect(classify(PROD, { DATABASE_ENV: 'development' })).toBe('development');
    expect(classify(TEST, { DATABASE_ENV: 'production' })).toBe('production');
  });

  it('recognises a test database by name', () => {
    for (const url of [TEST, 'postgres://h/app_test', 'postgres://h/test_app', 'postgres://h/x-test']) {
      expect(classify(url, {}), url).toBe('test');
    }
  });

  it('recognises a development database by name', () => {
    for (const url of ['postgres://h/app_dev', 'postgres://h/dev_app', 'postgres://h/app_local']) {
      expect(classify(url, {}), url).toBe('development');
    }
  });

  it('treats an unrecognised name as production', () => {
    // Erring this way costs a flag; erring the other way costs the books.
    expect(classify(PROD, {})).toBe('production');
    expect(classify(DEV, {})).toBe('production');
  });

  it('reads the database name out of a connection string', () => {
    expect(databaseName(TEST)).toBe('business_suite_test');
    expect(databaseName('postgres://h:5432/db?sslmode=require')).toBe('db');
    expect(databaseName('')).toBe('');
  });

  it('never prints a password', () => {
    expect(maskUrl('postgres://user:hunter2@host/db')).toBe('postgres://user:***@host/db');
    expect(maskUrl('postgres://user:hunter2@host/db')).not.toContain('hunter2');
  });
});

describe('permission to destroy', () => {
  const dev = { DATABASE_ENV: 'development' };

  it('allows a reset of the test database', () => {
    expect(checkDestructive({ url: TEST, command: 'db:reset' }, {}).allowed).toBe(true);
  });

  it('refuses a reset of development without the explicit override', () => {
    const verdict = checkDestructive({ url: DEV, command: 'db:fresh' }, dev);
    expect(verdict.allowed).toBe(false);
    expect(verdict.kind).toBe('development');
    // The message has to teach the way out, not just say no.
    expect(verdict.reason).toContain('NODE_ENV=test');
    expect(verdict.reason).toContain(OVERRIDE_FLAG);
  });

  it('allows development only when the override is given deliberately', () => {
    expect(checkDestructive({ url: DEV, command: 'db:fresh', override: true }, dev).allowed).toBe(
      true
    );
  });

  it('refuses production whatever flags are passed', () => {
    for (const override of [false, true]) {
      const verdict = checkDestructive(
        { url: PROD, command: 'db:fresh', override },
        { DATABASE_ENV: 'production' }
      );
      expect(verdict.allowed, `override=${override}`).toBe(false);
      expect(verdict.reason).toContain('PRODUCTION');
    }
  });

  it('offers no override for production, so there is nothing to reach for', () => {
    const verdict = checkDestructive(
      { url: PROD, command: 'db:reset', override: true },
      { DATABASE_ENV: 'production' }
    );
    expect(verdict.reason).not.toContain(OVERRIDE_FLAG);
  });
});

describe('which database a command resolves', () => {
  const env = {
    DATABASE_URL: DEV,
    TEST_DATABASE_URL: TEST,
    DATABASE_ENV: 'development',
  };

  it('uses the development database by default', () => {
    const target = resolveTarget({ ...env, NODE_ENV: 'development' });
    expect(target.url).toBe(DEV);
    expect(target.kind).toBe('development');
  });

  it('uses the test database under NODE_ENV=test, whatever DATABASE_ENV says', () => {
    const target = resolveTarget({ ...env, NODE_ENV: 'test' });
    expect(target.url).toBe(TEST);
    expect(target.kind).toBe('test');
  });

  it('lets that resolved classification through to the guard', () => {
    // The guard re-deriving the kind for itself is what stopped db:fresh from
    // ever resetting the test database: it read DATABASE_ENV=development out of
    // the shipped .env, called "business_suite_test" the development database,
    // and advised NODE_ENV=test -- which was already set.
    const target = resolveTarget({ ...env, NODE_ENV: 'test' });
    const verdict = checkDestructive(
      { url: target.url, kind: target.kind, command: 'db:fresh' },
      { ...env, NODE_ENV: 'test' }
    );
    expect(verdict.allowed).toBe(true);
  });

  it('will not call the development database a test one when there is no test one', () => {
    // Falling back to DATABASE_URL is a convenience for a machine with one
    // database. Declaring that fallback 'test' would hand a destructive command
    // the development database under the test database's name.
    const target = resolveTarget({
      DATABASE_URL: DEV,
      DATABASE_ENV: 'development',
      NODE_ENV: 'test',
    });
    expect(target.url).toBe(DEV);
    expect(target.kind).toBe('development');
    expect(checkDestructive({ ...target, command: 'db:fresh' }).allowed).toBe(false);
  });

  it('protects an unnamed fallback database as production, not test', () => {
    const target = resolveTarget({ DATABASE_URL: PROD, NODE_ENV: 'test' });
    expect(target.kind).toBe('production');
  });
});

describe('the suite itself', () => {
  it('is connected to a test database, not a real one', () => {
    // The check that would have caught the original fault: this suite posts
    // and cancels real documents, and had been doing so against development.
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    expect(classify(url, { ...process.env, DATABASE_ENV: undefined })).toBe('test');
  });

  it('runs with NODE_ENV=test so the application config agrees', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});
