import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'src/admin/**',
      'src/applications/**',
      'src/donors/donors.service.ts',
      'src/health/health.controller.ts',
      'src/impacts/impact.service.ts',
      'src/main.ts',
      'src/notifications/notifications.service.ts',
      'src/streams/streams.service.ts',
      'test/shutdown.integration.spec.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
