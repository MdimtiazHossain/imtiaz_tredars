import { createApp } from './app.js';
import { config } from './lib/config.js';
import { closePool, healthcheck } from './lib/db.js';

/**
 * Server bootstrap. Refuses to start if the database is unreachable, so a
 * misconfigured deployment fails immediately rather than at the first request.
 */
const app = createApp();

try {
  await healthcheck();
} catch (err) {
  console.error('Cannot reach the database:', err.message);
  console.error('Check DATABASE_URL in server/.env');
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`Business Suite API listening on http://localhost:${config.port} (${config.env})`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
