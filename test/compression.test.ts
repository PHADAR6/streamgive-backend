import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { buildServer } from '../src/server.js';

async function build() {
  const app = buildServer();
  await app.after();
  app.get('/big', async () => ({
    items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `ngo-${i}` })),
  }));
  app.get('/small', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('response compression', () => {
  it('compresses large JSON when client accepts gzip', async () => {
    const app = await build();
    const res = await app.inject({
      url: '/big',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
    const body = JSON.parse(gunzipSync(res.rawPayload).toString());
    expect(body.items).toHaveLength(500);
    await app.close();
  });

  it('does not compress when client sends no accept-encoding', async () => {
    const app = await build();
    const res = await app.inject({ url: '/big' });
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });

  it('skips responses under the threshold', async () => {
    const app = await build();
    const res = await app.inject({
      url: '/small',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });
});
