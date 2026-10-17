import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    pool: 'forks',
    // Hang caps only: tests wait on observable conditions (tests/helpers.ts WAIT_MS), never on fixed sleeps.
    testTimeout: 90000,
    hookTimeout: 90000,
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
