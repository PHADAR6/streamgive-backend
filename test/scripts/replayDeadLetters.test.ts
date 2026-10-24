import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.NGO_REGISTRY_CONTRACT_ID = 'CTESTREPLAYCONTRACT';
  process.env.DONATION_VAULT_CONTRACT_ID = '';

  return {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
});

vi.mock('../../src/db.js', () => ({
  prisma: {
    indexerDeadLetter: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/indexer/dispatch.js', () => ({
  dispatchEvent: vi.fn(),
}));

import { nativeToScVal } from '@stellar/stellar-sdk';

import { replayDeadLetters } from '../../src/scripts/replayDeadLetters.js';

function encoded(value: string, type: 'symbol' | 'string'): string {
  return nativeToScVal(value, { type }).toXDR('base64');
}

const deadLetter = {
  id: 'dead-letter-1',
  eventId: '0000000520-0000000000',
  ledger: 520,
  contractId: 'CTESTREPLAYCONTRACT',
  error: 'old handler failure',
  topic: [encoded('register', 'symbol')],
  value: encoded('Replay NGO', 'string'),
  txHash: null,
  attempts: 1,
  resolvedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('replayDeadLetters', () => {
  beforeEach(() => {
    mocks.update.mockClear();
  });

  it('marks a row resolved after the dispatcher applies it', async () => {
    mocks.findMany.mockResolvedValue([deadLetter]);
    mocks.findUnique.mockResolvedValue({ attempts: 1 });
    mocks.update.mockResolvedValue({});
    const dispatcher = vi.fn().mockResolvedValue(undefined);

    const report = await replayDeadLetters({ dispatcher });

    expect(report).toEqual({ attempted: 1, resolved: 1, failed: 0 });
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: deadLetter.id },
      data: { resolvedAt: expect.any(Date), attempts: { increment: 1 } },
    });
  });

  it('keeps a row unresolved when replay throws', async () => {
    mocks.findMany.mockResolvedValue([{ ...deadLetter, topic: ['not-valid-xdr'] }]);
    mocks.findUnique.mockResolvedValue({ attempts: 1 });
    mocks.update.mockResolvedValue({});
    const dispatcher = vi.fn().mockResolvedValue(undefined);

    const report = await replayDeadLetters({ dispatcher });

    expect(report).toEqual({ attempted: 1, resolved: 0, failed: 1 });
    expect(dispatcher).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: deadLetter.id },
      data: {
        error: expect.not.stringMatching(/^old handler failure$/),
        attempts: { increment: 1 },
      },
    });
  });

  it('keeps a row unresolved when the handler records a new dead letter', async () => {
    mocks.findMany.mockResolvedValue([deadLetter]);
    mocks.findUnique.mockResolvedValue({ attempts: 2 });
    mocks.update.mockClear();
    const dispatcher = vi.fn().mockResolvedValue(undefined);

    const report = await replayDeadLetters({ dispatcher });

    expect(report).toEqual({ attempted: 1, resolved: 0, failed: 1 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
