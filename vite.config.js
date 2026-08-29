import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
  },
});
