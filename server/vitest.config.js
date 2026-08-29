import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Integration tests share one database; running files in parallel would
    // make them race each other rather than test real concurrency.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
