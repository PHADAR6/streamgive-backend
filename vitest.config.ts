import { configDefaults, defineConfig } from 'vitest/config';

const unitTests = [
  'test/cacheable.test.ts',
  'test/compression.test.ts',
  'test/cors.test.ts',
  'test/metrics.test.ts',
  'test/requestId.test.ts',
  'test/security-headers.test.ts',
  'test/shutdown.test.ts',
  'test/routes/serializeStream.test.ts',
  'test/scripts/replayDeadLetters.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: unitTests,
          environment: 'node',
          testTimeout: 10000,
          hookTimeout: 10000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...unitTests],
          environment: 'node',
          setupFiles: ['./test/setup.ts'],
          testTimeout: 20000,
          hookTimeout: 20000,
          fileParallelism: false,
        },
      },
    ],
  },
});
