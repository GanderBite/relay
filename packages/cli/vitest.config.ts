import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/smoke/**'],
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      // json-summary writes coverage/coverage-summary.json for CI gating.
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      // Honest threshold reflecting current coverage — ratchet up as coverage grows.
      thresholds: { lines: 40, functions: 35, branches: 30 },
    },
  },
});
