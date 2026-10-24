import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();

function createDeadLetterFixture(
  index: number,
  overrides: Partial<Parameters<typeof prisma.indexerDeadLetter.create>[0]['data']> = {},
) {
  const ledger = 100 + index;
  const eventId = `${String(ledger).padStart(10, '0')}-0000000001`;
  return {
    eventId,
    ledger,
    contractId: 'CCPWQBI7FV2CZ7EECOVZ5XHOHK5S7CS6XTBDWPWHBEOKPTIASNGOBQFH',
    error: `Failure reason #${index}`,
    topic: ['AAAA...'],
    value: 'BBBB...',
    txHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    attempts: 1,
    resolvedAt: null,
    createdAt: new Date(1700000000000 + index * 1000),
    ...overrides,
  };
}

describe('GET /v1/admin/dead-letters', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  describe('Authentication & Security', () => {
    it('rejects an unsigned request with 401 unauthorized', async () => {
      const app = buildServer();

      const response = await app.inject({ method: 'GET', url: '/v1/admin/dead-letters' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });

      await app.close();
    });

    it('returns 503 when admin address is not configured in environment', async () => {
      const app = buildServer();
      const currentAdmin = process.env.ADMIN_ADDRESS;
      delete process.env.ADMIN_ADDRESS;

      try {
        const response = await app.inject({ method: 'GET', url: '/v1/admin/dead-letters' });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ error: 'admin_auth_not_configured' });
      } finally {
        if (currentAdmin !== undefined) {
          process.env.ADMIN_ADDRESS = currentAdmin;
        }
        await app.close();
      }
    });

    it('rejects requests signed by an unauthorized Stellar keypair', async () => {
      const app = buildServer();
      const unauthorizedKeypair = Keypair.random();

      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(unauthorizedKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });

      await app.close();
    });

    it('rejects a signature with a stale timestamp (> 5 minutes)', async () => {
      const app = buildServer();
      const staleTimestamp = (Date.now() - 10 * 60 * 1000).toString();

      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(adminKeypair, 'GET', url, staleTimestamp);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'stale_signature' });

      await app.close();
    });

    it('rejects timestamps provided in seconds instead of milliseconds', async () => {
      const app = buildServer();
      const secondsTimestamp = Math.floor(Date.now() / 1000).toString();

      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(adminKeypair, 'GET', url, secondsTimestamp);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'timestamp_unit_mismatch' });

      await app.close();
    });

    it('rejects replayed signatures within the freshness window', async () => {
      const app = buildServer();
      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(adminKeypair, 'GET', url);

      const firstResponse = await app.inject({ method: 'GET', url, headers });
      expect(firstResponse.statusCode).toBe(200);

      const replayResponse = await app.inject({ method: 'GET', url, headers });
      expect(replayResponse.statusCode).toBe(401);
      expect(replayResponse.json()).toEqual({ error: 'replayed_signature' });

      await app.close();
    });

    it('allows a validly signed admin request when no records exist', async () => {
      const app = buildServer();
      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(adminKeypair, 'GET', url);

      const response = await app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        deadLetters: [],
        total: 0,
        hasMore: false,
        nextCursor: null,
      });

      await app.close();
    });
  });

  describe('Filtering by resolved status', () => {
    it('returns both resolved and unresolved dead letters when resolved is omitted', async () => {
      const app = buildServer();

      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(1, { resolvedAt: null }),
      });
      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(2, { resolvedAt: new Date() }),
      });
      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(3, { resolvedAt: null }),
      });

      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(3);
      expect(body.deadLetters).toHaveLength(3);
      expect(body.deadLetters.map((d: { ledger: number }) => d.ledger)).toEqual([103, 102, 101]);

      await app.close();
    });

    it('returns only unresolved dead letters when resolved=false', async () => {
      const app = buildServer();

      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(1, { resolvedAt: null }),
      });
      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(2, { resolvedAt: new Date() }),
      });
      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(3, { resolvedAt: null }),
      });

      const url = '/v1/admin/dead-letters?resolved=false';
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(2);
      expect(body.deadLetters).toHaveLength(2);
      expect(
        body.deadLetters.every((d: { resolvedAt: string | null }) => d.resolvedAt === null),
      ).toBe(true);
      expect(body.deadLetters.map((d: { ledger: number }) => d.ledger)).toEqual([103, 101]);

      await app.close();
    });

    it('returns only resolved dead letters when resolved=true', async () => {
      const app = buildServer();

      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(1, { resolvedAt: null }),
      });
      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(2, { resolvedAt: new Date('2026-10-21T04:00:00Z') }),
      });
      await prisma.indexerDeadLetter.create({
        data: createDeadLetterFixture(3, { resolvedAt: null }),
      });

      const url = '/v1/admin/dead-letters?resolved=true';
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.deadLetters).toHaveLength(1);
      expect(body.deadLetters[0].ledger).toBe(102);
      expect(body.deadLetters[0].resolvedAt).toBe('2026-10-21T04:00:00.000Z');

      await app.close();
    });

    it('returns 400 invalid_request when resolved query parameter is invalid', async () => {
      const app = buildServer();

      const url = '/v1/admin/dead-letters?resolved=invalid_boolean';
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });

      await app.close();
    });
  });

  describe('Pagination & Cursor Controls', () => {
    it('paginates correctly using limit and cursor without duplicate records', async () => {
      const app = buildServer();

      // Seed 5 dead letters (index 1 to 5)
      for (let i = 1; i <= 5; i++) {
        await prisma.indexerDeadLetter.create({
          data: createDeadLetterFixture(i),
        });
      }

      // Page 1: limit 2 -> newest first (ledger 105, 104)
      const page1Url = '/v1/admin/dead-letters?limit=2';
      const page1Headers = signAdminRequest(adminKeypair, 'GET', page1Url);
      const page1Response = await app.inject({
        method: 'GET',
        url: page1Url,
        headers: page1Headers,
      });

      expect(page1Response.statusCode).toBe(200);
      const page1Body = page1Response.json();
      expect(page1Body.total).toBe(5);
      expect(page1Body.deadLetters).toHaveLength(2);
      expect(page1Body.hasMore).toBe(true);
      expect(page1Body.nextCursor).not.toBeNull();
      const page1Ids = page1Body.deadLetters.map((d: { id: string }) => d.id);
      expect(page1Body.deadLetters.map((d: { ledger: number }) => d.ledger)).toEqual([105, 104]);

      // Page 2: limit 2, cursor from page 1 -> (ledger 103, 102)
      const page2Url = `/v1/admin/dead-letters?limit=2&cursor=${page1Body.nextCursor}`;
      const page2Headers = signAdminRequest(adminKeypair, 'GET', page2Url);
      const page2Response = await app.inject({
        method: 'GET',
        url: page2Url,
        headers: page2Headers,
      });

      expect(page2Response.statusCode).toBe(200);
      const page2Body = page2Response.json();
      expect(page2Body.total).toBe(5);
      expect(page2Body.deadLetters).toHaveLength(2);
      expect(page2Body.hasMore).toBe(true);
      expect(page2Body.nextCursor).not.toBeNull();
      const page2Ids = page2Body.deadLetters.map((d: { id: string }) => d.id);
      expect(page2Body.deadLetters.map((d: { ledger: number }) => d.ledger)).toEqual([103, 102]);

      // Assert no overlap between page 1 and page 2
      expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);

      // Page 3: limit 2, cursor from page 2 -> (ledger 101)
      const page3Url = `/v1/admin/dead-letters?limit=2&cursor=${page2Body.nextCursor}`;
      const page3Headers = signAdminRequest(adminKeypair, 'GET', page3Url);
      const page3Response = await app.inject({
        method: 'GET',
        url: page3Url,
        headers: page3Headers,
      });

      expect(page3Response.statusCode).toBe(200);
      const page3Body = page3Response.json();
      expect(page3Body.total).toBe(5);
      expect(page3Body.deadLetters).toHaveLength(1);
      expect(page3Body.hasMore).toBe(false);
      expect(page3Body.nextCursor).toBeNull();
      expect(page3Body.deadLetters[0].ledger).toBe(101);

      await app.close();
    });

    it('rejects invalid limit values (0, negative, >100, non-numeric)', async () => {
      const app = buildServer();

      for (const invalidLimit of ['0', '-5', '101', 'abc']) {
        const url = `/v1/admin/dead-letters?limit=${invalidLimit}`;
        const headers = signAdminRequest(adminKeypair, 'GET', url);
        const response = await app.inject({ method: 'GET', url, headers });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'invalid_request' });
      }

      await app.close();
    });

    it('rejects a non-UUID cursor with 400 invalid_request', async () => {
      const app = buildServer();

      const url = '/v1/admin/dead-letters?cursor=not-a-valid-uuid';
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_request' });

      await app.close();
    });

    it('returns an empty list when a valid UUID cursor does not exist in the database', async () => {
      const app = buildServer();
      const nonExistentUuid = '00000000-0000-4000-8000-000000000000';
      await prisma.indexerDeadLetter.create({ data: createDeadLetterFixture(1) });

      const url = `/v1/admin/dead-letters?cursor=${nonExistentUuid}`;
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        deadLetters: [],
        total: 1,
        hasMore: false,
        nextCursor: null,
      });

      await app.close();
    });

    it('correctly returns all full record attributes of a dead letter', async () => {
      const app = buildServer();

      const created = await prisma.indexerDeadLetter.create({
        data: {
          eventId: '0000000500-0000000002',
          ledger: 500,
          contractId: 'CDLKBGX3VTFZZBVBNQYHF47PQO6I7UTBYVVQE3BPJDONF6G4U33Z7VLH',
          error: 'TypeError: scValToNative unexpected type',
          topic: ['AAAAEgAAAAFjcmVhdGVkAAAAAA==', 'AAAAEAAAAAEAAAAAAAAAUg=='],
          value: 'AAAAEAAAAAUAAAAPAAAAB0RFUE9TSVQAAA==',
          txHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          attempts: 2,
          resolvedAt: null,
        },
      });

      const url = '/v1/admin/dead-letters';
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({ method: 'GET', url, headers });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.deadLetters).toHaveLength(1);
      const record = body.deadLetters[0];

      expect(record.id).toBe(created.id);
      expect(record.eventId).toBe('0000000500-0000000002');
      expect(record.ledger).toBe(500);
      expect(record.contractId).toBe('CDLKBGX3VTFZZBVBNQYHF47PQO6I7UTBYVVQE3BPJDONF6G4U33Z7VLH');
      expect(record.error).toBe('TypeError: scValToNative unexpected type');
      expect(record.topic).toHaveLength(2);
      expect(record.value).toBe('AAAAEAAAAAUAAAAPAAAAB0RFUE9TSVQAAA==');
      expect(record.txHash).toBe(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      );
      expect(record.attempts).toBe(2);
      expect(record.resolvedAt).toBeNull();
      expect(record.createdAt).toBeDefined();
      expect(record.updatedAt).toBeDefined();

      await app.close();
    });
  });
});
