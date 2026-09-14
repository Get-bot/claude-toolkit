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
    // The tests share one spawned server, so once a wait for it has burned its 60 s budget the
    // remaining waits will too. Stop at the first failure rather than paying that budget again
    // per test (a broken package-smoke leg costs one timeout, not three).
    bail: 1,
  },
});
