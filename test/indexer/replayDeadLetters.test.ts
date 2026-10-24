import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const contractId = 'CTESTREPLAYCONTRACT';

  // contracts.ts reads these at module load; vi.hoisted() runs before this
  // file's imports, so the replay script sees a watched contract id.
  process.env.NGO_REGISTRY_CONTRACT_ID = contractId;
  process.env.DONATION_VAULT_CONTRACT_ID = '';

  return { contractId };
});

import { prisma } from '../../src/db.js';
import { recordDeadLetter } from '../../src/indexer/deadLetter.js';
import { replayDeadLetters } from '../../src/scripts/replayDeadLetters.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, makeEvent, stringScVal, symbolScVal } from '../helpers/events.js';

describe('dead-letter replay', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('applies a previously failing event and marks it resolved', async () => {
    const ownerAddress = fakeAddress('R');
    const event = {
      ...makeEvent(
        [symbolScVal('register'), addressScVal(ownerAddress)],
        stringScVal('Replay NGO'),
        {
          id: '0000000520-0000000000',
          ledger: 520,
        },
      ),
      contractId: mocks.contractId,
    };

    // Model an event that failed under the old handler and was dead-lettered;
    // the fix has since shipped.
    await recordDeadLetter(event, new Error('handler bug before the fix'));
    expect(await prisma.ngo.findUnique({ where: { ownerAddress } })).toBeNull();

    const report = await replayDeadLetters();

    expect(report).toEqual({ attempted: 1, resolved: 1, failed: 0 });

    const ngo = await prisma.ngo.findUnique({ where: { ownerAddress } });
    expect(ngo?.name).toBe('Replay NGO');

    const deadLetter = await prisma.indexerDeadLetter.findUnique({
      where: { eventId: event.id },
    });
    expect(deadLetter?.resolvedAt).not.toBeNull();
    expect(deadLetter?.attempts).toBe(2);
  });

  it('leaves an event unresolved when replay still fails', async () => {
    const eventId = '0000000521-0000000000';
    await prisma.indexerDeadLetter.create({
      data: {
        eventId,
        ledger: 521,
        contractId: mocks.contractId,
        error: 'original failure',
        topic: ['not-valid-base64-xdr'],
        value: null,
        txHash: null,
        attempts: 1,
      },
    });

    const report = await replayDeadLetters();

    expect(report).toEqual({ attempted: 1, resolved: 0, failed: 1 });

    const deadLetter = await prisma.indexerDeadLetter.findUnique({ where: { eventId } });
    expect(deadLetter?.resolvedAt).toBeNull();
    expect(deadLetter?.attempts).toBe(2);
    expect(deadLetter?.error).not.toBe('original failure');
  });
});
