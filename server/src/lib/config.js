import 'dotenv/config';

/**
 * Runtime configuration.
 *
 * Every secret comes from the environment. Nothing here is ever sent to the
 * browser: the frontend only learns the API base URL, which it gets from its
 * own Vite config.
 */

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Copy server/.env.example to server/.env and fill it in.'
    );
  }
  return value;
}

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest,

  port: Number(process.env.PORT || 5310),

  // Never defaulted: an app that silently points at the wrong database is worse
  // than one that refuses to start.
  databaseUrl: isTest
    ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    : required('DATABASE_URL'),
  dbPoolMax: Number(process.env.DB_POOL_MAX || 10),

  jwtSecret: required('JWT_SECRET', isTest ? 'test-only-secret-value-not-for-production' : undefined),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '30m',
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7),

  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || (isTest ? 4 : 12)),

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5290')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX || 10),
  },

  // Default organisation for a single-tenant deployment.
  orgId: Number(process.env.ORG_ID || 1),
};
