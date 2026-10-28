import { Client } from 'pg';

import { getDatabaseUrl } from '../db.js';

const INDEXER_LOCK_NAMESPACE = 1_398_032_214;
const INDEXER_LOCK_ID = 1;

export interface IndexerLock {
  isHeld(): boolean;
  release(): Promise<void>;
}

/** Acquires a session-level Postgres lock on a dedicated connection. */
export async function tryAcquireIndexerLock(): Promise<IndexerLock | undefined> {
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [INDEXER_LOCK_NAMESPACE, INDEXER_LOCK_ID],
    );

    if (!result.rows[0]?.locked) {
      await client.end();
      return undefined;
    }

    let held = true;
    let released = false;
    client.on('error', (error) => {
      held = false;
      console.error('indexer advisory lock connection failed', error);
    });

    return {
      isHeld: () => held,
      release: async () => {
        if (released) return;
        released = true;
        try {
          if (held) {
            await client.query('SELECT pg_advisory_unlock($1, $2)', [
              INDEXER_LOCK_NAMESPACE,
              INDEXER_LOCK_ID,
            ]);
          }
        } finally {
          held = false;
          await client.end();
        }
      },
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}
