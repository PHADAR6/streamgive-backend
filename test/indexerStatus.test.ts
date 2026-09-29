// src/__tests__/indexerStatus.test.ts
import request from 'supertest';
// Import your fastify app instance here

describe('GET /indexer/status (#59)', () => {
  it('returns configured: false when no contract IDs are set', async () => {
    const originalEnv = process.env.CONTRACT_IDS;
    delete process.env.CONTRACT_IDS;

    const response = await request(app).get('/indexer/status');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      configured: false,
      checkpointLedger: null,
      updatedAt: null,
      latestLedger: null,
      ledgerLag: null,
    });

    process.env.CONTRACT_IDS = originalEnv;
  });

  it('returns checkpoint, latest ledger, and lag when configured', async () => {
    process.env.CONTRACT_IDS = 'C_TESTCONTRACT123';

    // Mock RPC client response here if necessary

    const response = await request(app).get('/indexer/status');

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(response.body).toHaveProperty('checkpointLedger');
    expect(response.body).toHaveProperty('latestLedger');
    expect(response.body).toHaveProperty('ledgerLag');
  });
});