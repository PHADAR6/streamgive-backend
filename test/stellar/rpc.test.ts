import { beforeEach, describe, expect, it, vi } from 'vitest';

const { simulateTransaction } = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk/rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk/rpc')>();
  return {
    ...actual,
    Server: class {
      simulateTransaction(transaction: unknown) {
        return simulateTransaction(transaction);
      }
    },
  };
});

import { nativeToScVal, Transaction } from '@stellar/stellar-sdk';
import { callContract } from '../../src/stellar/rpc.js';
import { fakeContractAddress } from '../helpers/db.js';

beforeEach(() => {
  simulateTransaction.mockReset();
});

describe('callContract', () => {
  it('simulates a read-only call and decodes its return value', async () => {
    simulateTransaction.mockResolvedValue({
      result: { retval: nativeToScVal('result') },
    });

    const result = await callContract<string>(fakeContractAddress('A'), 'read');

    expect(result).toBe('result');
    expect(simulateTransaction).toHaveBeenCalledOnce();
    expect(simulateTransaction.mock.calls[0][0]).toBeInstanceOf(Transaction);
  });
});
