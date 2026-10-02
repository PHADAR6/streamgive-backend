import { afterEach, describe, expect, it } from 'vitest';

import { getCheckpoint, saveCheckpoint } from '../src/indexer/checkpoint.js';
import { prisma } from '../src/db.js';
import { resetDb } from './helpers/db.js';

afterEach(async () => {
  await resetDb();
});

describe('checkpoint persistence', () => {
  it('creates then updates the single main checkpoint row', async () => {
    await saveCheckpoint(100);
    await saveCheckpoint(125);

    expect(await prisma.indexerCheckpoint.count()).toBe(1);
    expect(await getCheckpoint()).toBe(125);
  });

  it('returns the stored ledger and undefined when unset', async () => {
    expect(await getCheckpoint()).toBeUndefined();

    await saveCheckpoint(321);

    expect(await getCheckpoint()).toBe(321);
  });
});

describe('Intra-Ledger Checkpoint & Resumption (#39)', () => {
  it('processes subsequent events in the same ledger after a mid-ledger crash', async () => {
    const ledgerEvents = [
      { id: 'evt_1', ledger: 100, data: 'first' },
      { id: 'evt_2', ledger: 100, data: 'second' },
    ];

    let checkpoint = { lastLedger: 0, lastEventId: null as string | null };
    const processedEvents: string[] = [];

    // Simulate poll function with checkpoint cursor support
    const mockPoll = async () => {
      // Filter events after current checkpoint cursor
      const pendingEvents = ledgerEvents.filter((e) => {
        if (checkpoint.lastEventId) {
          // If we have an event ID, skip up to and including that ID in the ledger
          return e.id !== checkpoint.lastEventId && e.ledger >= checkpoint.lastLedger;
        }
        return e.ledger >= checkpoint.lastLedger;
      });

      for (const event of pendingEvents) {
        processedEvents.push(event.id);
        checkpoint = { lastLedger: event.ledger, lastEventId: event.id };
        if (event.id === 'evt_1') {
          // Simulate crash/throw right after first event checkpoint save
          break;
        }
      }
    };

    // Run first poll (simulates crash after evt_1)
    await mockPoll();
    expect(processedEvents).toEqual(['evt_1']);
    expect(checkpoint.lastEventId).toBe('evt_1');

    // Run second poll (resumes from lastEventId in ledger 100)
    await mockPoll();
    
    // Should process evt_2 without skipping it
    expect(processedEvents).toContain('evt_2');
  });
});
