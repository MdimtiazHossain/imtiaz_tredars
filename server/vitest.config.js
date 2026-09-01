import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Without this the suite inherits NODE_ENV from .env -- which says
    // development -- and every integration test posts its documents into the
    // development database. That is how it behaved, and it is why a wipe was
    // survivable enough to go unnoticed.
    env: { NODE_ENV: 'test' },
    include: ['tests/**/*.test.js'],
    // Every suite but the VAT one assumes an unregistered business, and the
    // VAT one turns registration on for its own duration. Before each file
    // rather than once before the run, because a file that dies part way
    // through leaves the flag on for the files after it in the same run.
    setupFiles: ['tests/helpers/baseline.js'],
    // Integration tests share one database; running files in parallel would
    // make them race each other rather than test real concurrency.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
