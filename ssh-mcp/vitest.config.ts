import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/e2e is deliberately excluded: it packs and spawns the built package
    // and runs from the `test:e2e` script with vitest.e2e.config.ts.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
