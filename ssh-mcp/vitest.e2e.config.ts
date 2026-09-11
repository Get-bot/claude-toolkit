import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    // `npm pack` + `npx` round-trips are much slower than the unit/integration legs.
    testTimeout: 120000,
    hookTimeout: 120000,
    // Packing and spawning the tarball is not safe to run concurrently.
    fileParallelism: false,
  },
});
