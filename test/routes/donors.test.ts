import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

describe('GET /v1/donors', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('ranks donors by total committed by default', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO', verified: true },
    });
    const first = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const second = await prisma.donor.create({ data: { address: fakeAddress('B') } });
    const third = await prisma.donor.create({ data: { address: fakeAddress('C') } });

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 1n,
          donorId: first.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '600',
          withdrawn: '400',
          status: 'ACTIVE',
        },
        {
          onChainId: 2n,
          donorId: second.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('T'),
          rate: '0',
          balance: '0',
          withdrawn: '300',
          status: 'CANCELLED',
        },
      ],
    });

    const response = await app.inject({ method: 'GET', url: '/v1/donors' });

    expect(response.statusCode).toBe(200);
    expect(response.json().donors).toEqual([
      expect.objectContaining({ id: first.id, totalCommitted: '1000', totalWithdrawn: '400' }),
      expect.objectContaining({ id: second.id, totalCommitted: '300', totalWithdrawn: '300' }),
      expect.objectContaining({ id: third.id, totalCommitted: '0', totalWithdrawn: '0' }),
    ]);

    await app.close();
  });

  it('returns an ETag and 304 for a matching If-None-Match header', async () => {
    const app = buildServer();

    const first = await app.inject({ method: 'GET', url: '/v1/donors' });
    const etag = first.headers.etag;
    expect(etag).toBeDefined();
    expect(first.headers['cache-control']).toContain('max-age=30');

    const cached = await app.inject({
      method: 'GET',
      url: '/v1/donors',
      headers: { 'if-none-match': String(etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    expect(cached.headers.etag).toBe(etag);

    await app.close();
  });

  it('uses a different ETag when a query string changes the representation', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO', verified: true },
    });
    const [highBalance, highWithdrawn] = await Promise.all([
      prisma.donor.create({ data: { address: fakeAddress('A') } }),
      prisma.donor.create({ data: { address: fakeAddress('B') } }),
    ]);

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 1n,
          donorId: highBalance.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '900',
          withdrawn: '100',
        },
        {
          onChainId: 2n,
          donorId: highWithdrawn.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '100',
          withdrawn: '900',
        },
      ],
    });

    const committed = await app.inject({ method: 'GET', url: '/v1/donors?sort=committed' });
    const withdrawn = await app.inject({ method: 'GET', url: '/v1/donors?sort=withdrawn' });

    expect(committed.statusCode).toBe(200);
    expect(withdrawn.statusCode).toBe(200);
    expect(committed.body).not.toBe(withdrawn.body);
    expect(committed.headers.etag).not.toBe(withdrawn.headers.etag);

    await app.close();
  });

  it('sorts by withdrawn amount and paginates the ranked result', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO', verified: true },
    });
    const donors = await Promise.all(
      ['A', 'B', 'C'].map((letter) =>
        prisma.donor.create({ data: { address: fakeAddress(letter) } }),
      ),
    );

    await prisma.stream.createMany({
      data: donors.map((donor, index) => ({
        onChainId: BigInt(index + 1),
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '1',
        balance: '1000',
        withdrawn: String((index + 1) * 100),
      })),
    });

    const firstPage = await app.inject({
      method: 'GET',
      url: '/v1/donors?sort=withdrawn&order=desc&limit=2',
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().donors.map((donor: { id: string }) => donor.id)).toEqual([
      donors[2].id,
      donors[1].id,
    ]);
    expect(firstPage.json().nextCursor).toBe(donors[1].id);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/donors?sort=withdrawn&order=desc&limit=2&cursor=${firstPage.json().nextCursor}`,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().donors.map((donor: { id: string }) => donor.id)).toEqual([
      donors[0].id,
    ]);
    expect(secondPage.json().nextCursor).toBeNull();

    await app.close();
  });
});

describe('GET /v1/donors/:address', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('summarises committed, withdrawn, active streams and distinct NGOs', async () => {
    const app = buildServer();
    const [ngoA, ngoB] = await Promise.all([
      prisma.ngo.create({
        data: { ownerAddress: fakeAddress('N'), name: 'NGO A', verified: true },
      }),
      prisma.ngo.create({
        data: { ownerAddress: fakeAddress('M'), name: 'NGO B', verified: true },
      }),
    ]);
    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });
    const other = await prisma.donor.create({ data: { address: fakeAddress('B') } });

    await prisma.stream.createMany({
      data: [
        // ACTIVE with ngoA: committed = balance + withdrawn = 600 + 400 = 1000
        {
          onChainId: 1n,
          donorId: donor.id,
          ngoId: ngoA.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '600',
          withdrawn: '400',
          status: 'ACTIVE',
        },
        // CANCELLED with ngoB: remaining balance no longer committed.
        {
          onChainId: 2n,
          donorId: donor.id,
          ngoId: ngoB.id,
          tokenAddress: fakeAddress('T'),
          rate: '0',
          balance: '500',
          withdrawn: '300',
          status: 'CANCELLED',
        },
        // ACTIVE with ngoB: committed = 200 + 50 = 250
        {
          onChainId: 3n,
          donorId: donor.id,
          ngoId: ngoB.id,
          tokenAddress: fakeAddress('U'),
          rate: '1',
          balance: '200',
          withdrawn: '50',
          status: 'ACTIVE',
        },
        // Another donor's stream must not leak into this summary.
        {
          onChainId: 4n,
          donorId: other.id,
          ngoId: ngoA.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '9999',
          withdrawn: '9999',
          status: 'ACTIVE',
        },
      ],
    });

    const response = await app.inject({ method: 'GET', url: `/v1/donors/${donor.address}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        id: donor.id,
        address: donor.address,
        totalCommitted: '1550',
        committedByToken: [
          { tokenAddress: fakeAddress('T'), amount: '1300' },
          { tokenAddress: fakeAddress('U'), amount: '250' },
        ],
        totalWithdrawn: '750',
        activeStreamCount: 2,
        distinctNgoCount: 2,
      }),
    );

    await app.close();
  });

  it('returns zeros for a donor without streams', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('Z') } });

    const response = await app.inject({ method: 'GET', url: `/v1/donors/${donor.address}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        totalCommitted: '0',
        totalWithdrawn: '0',
        activeStreamCount: 0,
        distinctNgoCount: 0,
      }),
    );

    await app.close();
  });

  it('returns an ETag and 304 for a matching If-None-Match header', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('Z') } });
    const url = `/v1/donors/${donor.address}`;

    const first = await app.inject({ method: 'GET', url });
    const etag = first.headers.etag;
    expect(etag).toBeDefined();
    expect(first.headers['cache-control']).toContain('max-age=30');

    const cached = await app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': String(etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    expect(cached.headers.etag).toBe(etag);

    await app.close();
  });

  it('returns 404 for an unknown donor address', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: `/v1/donors/${fakeAddress('Q')}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    await app.close();
  });

  it('returns 400 for a malformed address', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/v1/donors/not-an-address' });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /v1/donors/:address/streams.csv', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('exports an empty history with headers when donor has no streams', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('A') } });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/donors/${donor.address}/streams.csv`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="donor-${donor.address}-streams.csv"`,
    );

    const body = response.body.trim();
    expect(body).toBe(
      'id,onChainId,ngoId,ngoName,ngoAddress,tokenAddress,rate,lastRate,balance,withdrawn,status,createdTxHash,createdAt,updatedAt',
    );

    await app.close();
  });

  it('escapes formula injection characters and special CSV characters', async () => {
    const app = buildServer();
    const donor = await prisma.donor.create({ data: { address: fakeAddress('B') } });
    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('N'),
        name: '=SUM(A1:A10)',
        displayName: '@Malicious NGO, "Quoted"',
        verified: true,
      },
    });

    await prisma.stream.create({
      data: {
        onChainId: 100n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('T'),
        rate: '+10',
        lastRate: '-5',
        balance: '500',
        withdrawn: '100',
        status: 'ACTIVE',
        createdTxHash: '=cmd|calc',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/donors/${donor.address}/streams.csv`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');

    const lines = response.body.trim().split(/\r\n|\n/);
    expect(lines).toHaveLength(2);

    const row = lines[1];
    // Formula characters prefix check:
    // displayName started with '@' and contained quotes/commas -> should be escaped and quoted
    expect(row).toContain('"\'@Malicious NGO, ""Quoted"""');
    // rate started with '+' -> '+10'
    expect(row).toContain("'+10");
    // lastRate started with '-' -> '-5'
    expect(row).toContain("'-5");
    // createdTxHash started with '=' -> '=cmd|calc'
    expect(row).toContain("'=cmd|calc");

    await app.close();
  });

  it('returns 404 for an unknown donor address', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/donors/${fakeAddress('Q')}/streams.csv`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    await app.close();
  });

  it('returns 400 for a malformed address', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/donors/not-an-address/streams.csv',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
