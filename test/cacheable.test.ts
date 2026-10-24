import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { sendPublicCacheable } from '../src/routes/cacheable.js';

/** The validator the helper is expected to produce for a given body. */
function expectedEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

describe('public conditional responses', () => {
  it('returns an ETag and answers a matching If-None-Match with 304', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { value: 'current' }),
    );

    const firstResponse = await app.inject({ method: 'GET', url: '/public' });
    const etag = firstResponse.headers.etag;
    expect(etag).toBeDefined();
    expect(etag).toBe(expectedEtag(JSON.stringify({ value: 'current' })));
    expect(firstResponse.headers['cache-control']).toContain('public');

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': `W/${etag}` },
    });

    expect(cachedResponse.statusCode).toBe(304);
    expect(cachedResponse.body).toBe('');
    expect(cachedResponse.headers.etag).toBe(etag);

    await app.close();
  });

  it('returns 304 for If-None-Match: * (matches any representation)', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { value: 'data' }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': '*' },
    });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');

    await app.close();
  });

  it('returns 304 when If-None-Match contains a weak ETag validator', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { value: 'content' }),
    );

    const firstResponse = await app.inject({ method: 'GET', url: '/public' });
    const etag = firstResponse.headers.etag;

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': `W/${etag}` },
    });

    expect(cachedResponse.statusCode).toBe(304);

    await app.close();
  });

  it('returns 304 when If-None-Match is a comma-separated list containing the right ETag', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { version: 3 }),
    );

    const firstResponse = await app.inject({ method: 'GET', url: '/public' });
    const etag = firstResponse.headers.etag;

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': `"old-etag-1", ${etag}, "old-etag-2"` },
    });

    expect(cachedResponse.statusCode).toBe(304);

    await app.close();
  });

  it('returns 200 with full body when If-None-Match does not match', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { status: 'fresh' }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': '"non-matching-etag"' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'fresh' });

    await app.close();
  });

  it('handles comma-separated list with weak validators', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { data: 'test' }),
    );

    const firstResponse = await app.inject({ method: 'GET', url: '/public' });
    const etag = firstResponse.headers.etag;

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': `W/"other", W/${etag}, W/"another"` },
    });

    expect(cachedResponse.statusCode).toBe(304);

    await app.close();
  });

  it('handles If-None-Match with spaces around commas', async () => {
    const app = Fastify();
    app.get('/public', async (request, reply) =>
      sendPublicCacheable(request, reply, { value: 'spaced' }),
    );

    const firstResponse = await app.inject({ method: 'GET', url: '/public' });
    const etag = firstResponse.headers.etag;

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'if-none-match': ` "old" , ${etag} , "other" ` },
    });

    expect(cachedResponse.statusCode).toBe(304);

    await app.close();
  });
});
