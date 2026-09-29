import { afterEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';

describe('GET /health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when database is reachable', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('responds with a non-200 status when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).not.toBe(200);

    await app.close();
  });
});
