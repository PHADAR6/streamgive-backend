import { describe, it, expect, vi, beforeEach } from 'vitest';

const { simulateTransaction, scValToNative } = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  scValToNative: vi.fn(),
}));

vi.mock('../src/stellar/rpc.js', () => ({
  rpcServer: {
    simulateTransaction(args: unknown) {
      return simulateTransaction(args);
    },
  },
  getLatestLedgerSequence: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  prisma: {
    ngo: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../src/indexer/contracts.js', () => ({
  NGO_REGISTRY_CONTRACT_ID: 'test-contract',
}));

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Contract: class {
      constructor(public contractId: string) {}
      call() {
        return { type: 'invokeHostFunction' };
      }
    },
    Account: class {},
    Keypair: { random: () => ({ publicKey: () => 'source-address' }) },
    nativeToScVal: vi.fn((value: unknown) => value),
    TransactionBuilder: class {
      addOperation() {
        return this;
      }
      setTimeout() {
        return this;
      }
      build() {
        return {};
      }
    },
    scValToNative,
  };
});

import { reconcileVerification } from '../src/scripts/reconcileVerification.js';
import { prisma } from '../src/db.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileVerification', () => {
  it('reports a mismatch without fixing', async () => {
    (prisma.ngo.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 'ngo-1', ownerAddress: 'GAOADRESS', verified: false },
    ]);
    simulateTransaction.mockResolvedValue({
      result: { retval: { type: 'scvInvoke' } },
    });
    scValToNative.mockReturnValue(true);

    const report = await reconcileVerification();

    expect(report.checked).toBe(1);
    expect(report.fixed).toBe(0);
    expect(report.mismatches).toEqual([
      {
        ngoId: 'ngo-1',
        ownerAddress: 'GAOADRESS',
        dbVerified: false,
        onChainVerified: true,
      },
    ]);
    expect(prisma.ngo.update).not.toHaveBeenCalled();
  });

  it('fixes mismatches when fix is true', async () => {
    (prisma.ngo.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 'ngo-2', ownerAddress: 'GAOADRESS2', verified: true },
    ]);
    simulateTransaction.mockResolvedValue({
      result: { retval: { type: 'scvInvoke' } },
    });
    scValToNative.mockReturnValue(false);
    (prisma.ngo.update as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({});

    const report = await reconcileVerification({ fix: true });

    expect(report.fixed).toBe(1);
    expect(prisma.ngo.update).toHaveBeenCalledWith({
      where: { id: 'ngo-2' },
      data: { verified: false },
    });
  });

  it('limits concurrent RPC calls', async () => {
    (prisma.ngo.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `ngo-${index}`,
        ownerAddress: `G${index}`,
        verified: true,
      })),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    simulateTransaction.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { result: { retval: true } };
    });

    await reconcileVerification();

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it('skips ngos that are not registered on-chain', async () => {
    (prisma.ngo.findMany as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      { id: 'ngo-3', ownerAddress: 'GAOADDRESS3', verified: false },
    ]);
    simulateTransaction.mockResolvedValue({ error: 'NotRegistered' });

    const report = await reconcileVerification();

    expect(report.checked).toBe(1);
    expect(report.mismatches).toEqual([]);
  });
});
