import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Integration tests share one Postgres test DB and reset it between
    // tests — running files in parallel would race on that shared state.
    fileParallelism: false,
  },
});
