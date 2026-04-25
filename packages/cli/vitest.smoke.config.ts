import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/smoke/**/*.test.ts'],
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
