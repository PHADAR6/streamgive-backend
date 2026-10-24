import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import * as rpc from '../../src/stellar/rpc.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 when the database is reachable', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok' });

    await app.close();
  });

  it('serves Swagger UI and an OpenAPI document in development', async () => {
    const app = buildServer();
    const ui = await app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().openapi).toMatch(/^3\./);
    expect(spec.json().paths['/v1/streams']).toBeDefined();
    expect(spec.json().paths['/v1/ngos']).toBeDefined();
    await app.close();
  });

  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'error' });

    await app.close();
  });

  it('responds with 503 when the database check times out', async () => {
    // Simulate a query that never resolves
    vi.spyOn(prisma, '$queryRaw').mockReturnValueOnce(new Promise(() => {}) as never);

    const previousTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
    process.env.HEALTH_CHECK_TIMEOUT_MS = '50'; // very short timeout for the test

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'error' });

    await app.close();

    if (previousTimeout === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    else process.env.HEALTH_CHECK_TIMEOUT_MS = previousTimeout;
  });

  it('does not include the RPC check so an RPC outage cannot trigger a liveness restart', async () => {
    // Even with RPC broken, /health must return 200 — it is a liveness probe.
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockRejectedValueOnce(new Error('RPC unreachable'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok' });

    await app.close();
  });

  it('applies the global rate limit to repeated health checks', async () => {
    const previousMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '1';
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValue(1);
    const app = buildServer();

    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
    if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previousMax;
  });
});

describe('GET /health/ready', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when DB and RPC are reachable and lag is within threshold', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(
      10050,
    );
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(
      10000,
    );

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      lag: 50,
      latestLedger: 10050,
      checkpointLedger: 10000,
    });

    await app.close();
  });

  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when the database check times out', async () => {
    vi.spyOn(prisma, '$queryRaw').mockReturnValueOnce(new Promise(() => {}) as never);

    const previousTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
    process.env.HEALTH_CHECK_TIMEOUT_MS = '50';

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();

    if (previousTimeout === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    else process.env.HEALTH_CHECK_TIMEOUT_MS = previousTimeout;
  });

  it('responds with 503 when the RPC check times out', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockReturnValueOnce(
      new Promise(() => {}) as never,
    );
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const previousTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
    process.env.HEALTH_CHECK_TIMEOUT_MS = '50';

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();

    if (previousTimeout === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    else process.env.HEALTH_CHECK_TIMEOUT_MS = previousTimeout;
  });

  it('responds with 503 when RPC is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockRejectedValue(new Error('RPC connection failed'));
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when indexer has no checkpoint', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10050);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(undefined);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_not_started' });

    await app.close();
  });

  it('responds with 503 when indexer lag is above threshold', async () => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10150);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_lagging', lag: 150, threshold: 100 });

    await app.close();
  });

  it('treats a non-numeric INDEXER_LAG_THRESHOLD as 0', async () => {
    const original = process.env.INDEXER_LAG_THRESHOLD;
    process.env.INDEXER_LAG_THRESHOLD = 'abc';

    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10001);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('error');
    expect(body.reason).toBe('indexer_lagging');
    expect(body.lag).toBe(1);
    expect(body.threshold).toBe(0);

    await app.close();

    if (original === undefined) delete process.env.INDEXER_LAG_THRESHOLD;
    else process.env.INDEXER_LAG_THRESHOLD = original;
  });
});
