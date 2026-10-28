import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

describe('request body limit', () => {
  const originalLimit = process.env.BODY_LIMIT_BYTES;

  afterEach(() => {
    if (originalLimit === undefined) delete process.env.BODY_LIMIT_BYTES;
    else process.env.BODY_LIMIT_BYTES = originalLimit;
  });

  it('rejects oversized bodies using the standard 413 error response', async () => {
    process.env.BODY_LIMIT_BYTES = '64';
    const app = buildServer();
    app.post('/test-body-limit', async (request) => request.body);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/test-body-limit',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ value: 'x'.repeat(100) }),
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: 'payload_too_large' });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid body-limit configuration', () => {
    process.env.BODY_LIMIT_BYTES = 'not-a-number';
    expect(() => buildServer()).toThrow('BODY_LIMIT_BYTES must be a positive integer.');
  });
});
