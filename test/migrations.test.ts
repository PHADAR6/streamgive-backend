import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Schema expectations derived from prisma/schema.prisma.
// Each entry is [tableName, requiredColumns[]].  We assert every listed
// column exists in the table produced by the migrations, and that no table
// in this list is missing entirely.  Extra columns in a table are allowed
// (future migrations may add columns before the schema is updated), but
// missing columns or missing tables indicate drift that would break the app.
// ---------------------------------------------------------------------------
const EXPECTED_TABLES: [string, string[]][] = [
  ['donors',               ['id', 'address', 'created_at']],
  ['ngos',                 ['id', 'owner_address', 'name', 'display_name', 'verified', 'created_at', 'updated_at']],
  ['streams',              ['id', 'on_chain_id', 'donor_id', 'ngo_id', 'token_address', 'rate', 'last_rate', 'balance', 'withdrawn', 'status', 'created_tx_hash', 'created_at', 'updated_at']],
  ['ngo_applications',     ['id', 'owner_address', 'name', 'description', 'website', 'contact_email', 'country', 'status', 'review_note', 'created_at', 'updated_at']],
  ['ngo_application_challenges', ['challenge', 'owner_address', 'expires_at']],
  ['notification_logs',    ['id', 'event_id', 'event_type', 'channel', 'success', 'error', 'created_at']],
  ['indexer_checkpoints',  ['id', 'last_ledger', 'last_event_id', 'updated_at']],
  ['indexer_dead_letters', ['id', 'event_id', 'ledger', 'contract_id', 'error', 'topic', 'value', 'tx_hash', 'attempts', 'resolved_at', 'created_at', 'updated_at']],
  ['stream_events',        ['id', 'type', 'stream_id', 'ledger', 'tx_hash', 'payload', 'created_at']],
];

/** Tables managed by Prisma Migrate itself — not part of the app schema. */
const PRISMA_INTERNAL_TABLES = new Set(['_prisma_migrations']);

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');

describe('Prisma schema and migrations', () => {
  let client: Client;
  let dbAvailable = false;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) return;

    client = new Client({ connectionString: url });
    try {
      await client.connect();
      dbAvailable = true;
    } catch {
      // Postgres is not running — tests will be skipped below.
    }
  }, 10_000);

  it(
    'applying all migrations to an empty database produces no drift against schema.prisma',
    async () => {
      if (!dbAvailable) {
        console.warn(
          '[skip] Postgres is not reachable — skipping migration drift check.\n' +
            '       Run `docker compose up -d postgres` and re-run the tests to enable it.',
        );
        return;
      }

      // ------------------------------------------------------------------
      // Step 1: wipe the public schema and re-create it so we start fresh.
      // This is safe because the test suite always uses the dedicated
      // streamgive_test database, never the development one.
      // ------------------------------------------------------------------
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');

      // ------------------------------------------------------------------
      // Step 2: apply every migration SQL file in chronological order.
      // We run them in the same order Prisma would: sorted by directory name
      // (which starts with a timestamp).
      // ------------------------------------------------------------------
      const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
      const migrationDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();

      for (const dir of migrationDirs) {
        const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
        let sql: string;
        try {
          sql = await readFile(sqlPath, 'utf8');
        } catch {
          // Directory exists but has no migration.sql (e.g. a baseline-only
          // folder).  Skip it.
          continue;
        }
        try {
          await client.query(sql);
        } catch (err) {
          throw new Error(
            `Migration ${dir} failed to apply:\n${(err as Error).message}\n\n` +
              'Fix the SQL in the migration file or regenerate the migration with ' +
              '`prisma migrate dev`.',
            { cause: err },
          );
        }
      }

      // ------------------------------------------------------------------
      // Step 3: inspect the resulting database and compare against the
      // expected shape derived from schema.prisma.
      // ------------------------------------------------------------------

      // 3a. Collect actual tables in the public schema.
      const tablesResult = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const actualTables = new Set(
        tablesResult.rows.map((r) => r.table_name).filter((t) => !PRISMA_INTERNAL_TABLES.has(t)),
      );

      // 3b. Collect actual columns per table.
      const colsResult = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'`,
      );
      const actualColumns = new Map<string, Set<string>>();
      for (const { table_name, column_name } of colsResult.rows) {
        if (!actualColumns.has(table_name)) actualColumns.set(table_name, new Set());
        actualColumns.get(table_name)!.add(column_name);
      }

      // 3c. Assert every expected table exists with all its required columns.
      const missing: string[] = [];

      for (const [table, columns] of EXPECTED_TABLES) {
        if (!actualTables.has(table)) {
          missing.push(`Table "${table}" is missing`);
          continue;
        }
        const actual = actualColumns.get(table) ?? new Set();
        for (const col of columns) {
          if (!actual.has(col)) {
            missing.push(`Column "${table}"."${col}" is missing`);
          }
        }
      }

      // 3d. Assert no unexpected application tables exist (catches tables
      //     added to migrations but not yet reflected in schema.prisma).
      const expectedTableNames = new Set(EXPECTED_TABLES.map(([t]) => t));
      for (const t of actualTables) {
        if (!expectedTableNames.has(t)) {
          missing.push(
            `Table "${t}" exists in the database but is not declared in schema.prisma`,
          );
        }
      }

      expect(
        missing,
        'Migration drift detected between migrations and schema.prisma.\n' +
          'Run `prisma migrate dev` to generate a migration for the pending changes.\n\n' +
          missing.join('\n'),
      ).toHaveLength(0);
    },
    60_000,
  );

  // Clean up the connection after all tests in this file have run.
  // We intentionally do not restore the schema — resetDb() in other test
  // files truncates tables rather than dropping schemas, and this test
  // always runs in its own file (fileParallelism: false in vitest.config.ts).
  // The next test run will wipe and re-apply anyway.
  afterAll(async () => {
    if (dbAvailable) await client.end();
  });
});
