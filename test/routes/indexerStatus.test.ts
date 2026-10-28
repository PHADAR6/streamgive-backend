import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveCheckpoint } from '../../src/indexer/checkpoint.js';
import { buildServer } from '../../src/server.js';
import * as rpc from '../../src/stellar/rpc.js';
import { resetDb } from '../helpers/db.js';

describe('GET /v1/indexer/status (#59, #256)', () => {
  const originalWatched = process.env.WATCHED_CONTRACT_IDS;
  const originalRegistry = process.env.NGO_REGISTRY_CONTRACT_ID;
  const originalVault = process.env.DONATION_VAULT_CONTRACT_ID;
  const originalLegacy = process.env.CONTRACT_IDS;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  afterEach(() => {
    if (originalWatched !== undefined) {
      process.env.WATCHED_CONTRACT_IDS = originalWatched;
    } else {
      delete process.env.WATCHED_CONTRACT_IDS;
    }

    if (originalRegistry !== undefined) {
      process.env.NGO_REGISTRY_CONTRACT_ID = originalRegistry;
    } else {
      delete process.env.NGO_REGISTRY_CONTRACT_ID;
    }

    if (originalVault !== undefined) {
      process.env.DONATION_VAULT_CONTRACT_ID = originalVault;
    } else {
      delete process.env.DONATION_VAULT_CONTRACT_ID;
    }

    if (originalLegacy !== undefined) {
      process.env.CONTRACT_IDS = originalLegacy;
    } else {
      delete process.env.CONTRACT_IDS;
    }
  });

  it('returns configured: false when no contract IDs are set', async () => {
    delete process.env.WATCHED_CONTRACT_IDS;
    delete process.env.NGO_REGISTRY_CONTRACT_ID;
    delete process.env.DONATION_VAULT_CONTRACT_ID;
    delete process.env.CONTRACT_IDS;

    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/indexer/status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: false,
      checkpointLedger: null,
      updatedAt: null,
      latestLedger: null,
      ledgerLag: null,
    });

    await app.close();
  });

  it('returns real checkpoint, latest ledger, and lag when configured', async () => {
    process.env.WATCHED_CONTRACT_IDS = 'C_TESTCONTRACT123';
    
    // Seed a specific checkpoint ledger in the database
    await saveCheckpoint(123450);

    // Mock the RPC to return a known latest ledger
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValue(123455);

    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/indexer/status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    
    // Assert exact values to ensure the endpoint reads real data, not stubs.
    // This test would fail if the implementation returned hardcoded placeholders.
    expect(body.configured).toBe(true);
    expect(body.checkpointLedger).toBe(123450);
    expect(body.latestLedger).toBe(123455);
    expect(body.ledgerLag).toBe(5);
    expect(body.updatedAt).not.toBeNull();
    expect(new Date(body.updatedAt).getTime()).not.toBeNaN();

    await app.close();
  });

  it('recognizes legacy CONTRACT_IDS alias', async () => {
    delete process.env.WATCHED_CONTRACT_IDS;
    delete process.env.NGO_REGISTRY_CONTRACT_ID;
    delete process.env.DONATION_VAULT_CONTRACT_ID;
    process.env.CONTRACT_IDS = 'C_LEGACYCONTRACT123';

    await saveCheckpoint(123450);
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValue(123455);

    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/indexer/status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.configured).toBe(true);
    expect(body.checkpointLedger).toBe(123450);
    expect(body.latestLedger).toBe(123455);
    expect(body.ledgerLag).toBe(5);

    await app.close();
  });
});
