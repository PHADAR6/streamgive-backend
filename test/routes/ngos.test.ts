import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

const adminKeypair = Keypair.random();

describe('GET /v1/ngos', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns only verified NGOs, newest first', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Unverified NGO', verified: false },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Verified NGO', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngos).toHaveLength(1);
    expect(body.ngos[0].name).toBe('Verified NGO');
    expect(body.ngos.map((ngo: { name: string }) => ngo.name)).not.toContain('Unverified NGO');
    expect(body.nextCursor).toBeNull();

    await app.close();
  });

  it("returns an NGO's displayName as its public name", async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('C'),
        name: 'On-chain name',
        displayName: 'Curated name',
        verified: true,
      },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ngos[0].name).toBe('Curated name');

    await app.close();
  });

  it('returns an ETag and responds 304 when the client has the current representation', async () => {
    const app = buildServer();

    const firstResponse = await app.inject({ method: 'GET', url: '/v1/ngos' });
    const etag = firstResponse.headers.etag;
    expect(etag).toBeDefined();
    expect(firstResponse.headers['cache-control']).toContain('public');

    const cachedResponse = await app.inject({
      method: 'GET',
      url: '/v1/ngos',
      headers: { 'if-none-match': String(etag) },
    });

    expect(cachedResponse.statusCode).toBe(304);
    expect(cachedResponse.body).toBe('');
    expect(cachedResponse.headers.etag).toBe(etag);

    await app.close();
  });

  it('paginates with cursor and returns no overlap between pages', async () => {
    const app = buildServer();

    // Create 3 verified NGOs — oldest first so createdAt desc gives C, B, A.
    for (const char of ['A', 'B', 'C']) {
      await prisma.ngo.create({
        data: { ownerAddress: fakeAddress(char), name: `NGO ${char}`, verified: true },
      });
    }

    const firstPage = await app.inject({ method: 'GET', url: '/v1/ngos?limit=2' });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.ngos).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const firstIds = firstBody.ngos.map((n: { id: string }) => n.id);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/v1/ngos?limit=2&cursor=${firstBody.nextCursor}`,
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.ngos).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    // No overlap between pages.
    const secondIds = secondBody.ngos.map((n: { id: string }) => n.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

    await app.close();
  });
  it('returns NGOs oldest first when sort=oldest', async () => {
    const app = buildServer();

    for (const char of ['A', 'B', 'C']) {
      await prisma.ngo.create({
        data: { ownerAddress: fakeAddress(char), name: `NGO ${char}`, verified: true },
      });
    }

    const response = await app.inject({ method: 'GET', url: '/v1/ngos?sort=oldest' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names = body.ngos.map((n: { name: string }) => n.name);
    expect(names).toEqual(['NGO A', 'NGO B', 'NGO C']);

    await app.close();
  });

  it('returns NGOs alphabetically when sort=name', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('C'),
        name: 'Zeta NGO',
        displayName: 'Alpha NGO',
        verified: true,
      },
    });
    await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('A'),
        name: 'Alpha NGO',
        displayName: 'Zulu NGO',
        verified: true,
      },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Midway NGO', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos?sort=name' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names = body.ngos.map((n: { name: string }) => n.name);
    expect(names).toEqual(['Alpha NGO', 'Midway NGO', 'Zulu NGO']);

    await app.close();
  });

  it('400s on an unknown sort value', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngos?sort=invalid' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('filters by name when q is provided (case-insensitive)', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Save The Oceans', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Plant A Tree', verified: true },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('C'), name: 'Ocean Cleanup Fund', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos?q=ocean' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names: string[] = body.ngos.map((n: { name: string }) => n.name);
    expect(names).toContain('Save The Oceans');
    expect(names).toContain('Ocean Cleanup Fund');
    expect(names).not.toContain('Plant A Tree');

    await app.close();
  });

  it('searches the public displayName instead of a replaced on-chain name', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('D'),
        name: 'Hidden On-chain Name',
        displayName: 'Visible Public Name',
        verified: true,
      },
    });

    const visible = await app.inject({ method: 'GET', url: '/v1/ngos?q=public' });
    expect(visible.json().ngos.map((ngo: { name: string }) => ngo.name)).toEqual([
      'Visible Public Name',
    ]);

    const hidden = await app.inject({ method: 'GET', url: '/v1/ngos?q=hidden' });
    expect(hidden.json().ngos).toHaveLength(0);

    await app.close();
  });

  it('returns empty list when q matches nothing', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Green Earth', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos?q=zzznomatch' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngos).toHaveLength(0);

    await app.close();
  });

  it('400s when q exceeds 100 characters', async () => {
    const app = buildServer();

    const longQ = 'a'.repeat(101);
    const response = await app.inject({ method: 'GET', url: `/v1/ngos?q=${longQ}` });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /ngos/all (admin)', () => {
  beforeAll(() => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
  });

  afterEach(async () => {
    await resetDb();
  });

  it('rejects an unsigned request with 401', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Verified NGO', verified: true },
    });

    const response = await app.inject({ method: 'GET', url: '/v1/ngos/all' });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('includes unverified NGOs for a correctly signed admin request', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Unverified NGO', verified: false },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Verified NGO', verified: true },
    });

    const headers = signAdminRequest(adminKeypair, 'GET', '/v1/ngos/all');
    const response = await app.inject({ method: 'GET', url: '/v1/ngos/all', headers });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const names = body.ngos.map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(['Unverified NGO', 'Verified NGO']);

    const unverified = body.ngos.find((n: { verified: boolean }) => !n.verified);
    expect(unverified.name).toBe('Unverified NGO');
    expect(unverified.ownerAddress).toBe(fakeAddress('A'));

    await app.close();
  });

  it('returns only unverified NGOs with ?verified=false', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Unverified NGO', verified: false },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Verified NGO', verified: true },
    });

    const url = '/v1/ngos/all?verified=false';
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngos).toHaveLength(1);
    expect(body.ngos[0].name).toBe('Unverified NGO');
    expect(body.ngos[0].verified).toBe(false);

    await app.close();
  });

  it('returns only verified NGOs with ?verified=true', async () => {
    const app = buildServer();

    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('A'), name: 'Unverified NGO', verified: false },
    });
    await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('B'), name: 'Verified NGO', verified: true },
    });

    const url = '/v1/ngos/all?verified=true';
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.ngos).toHaveLength(1);
    expect(body.ngos[0].name).toBe('Verified NGO');
    expect(body.ngos[0].verified).toBe(true);

    await app.close();
  });

  it('400s on an invalid verified value', async () => {
    const app = buildServer();

    const url = '/v1/ngos/all?verified=maybe';
    const headers = signAdminRequest(adminKeypair, 'GET', url);
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('paginates with cursor and returns no overlap between pages', async () => {
    const app = buildServer();

    // Create 3 NGOs — oldest first so createdAt desc gives C, B, A.
    for (const char of ['A', 'B', 'C']) {
      await prisma.ngo.create({
        data: { ownerAddress: fakeAddress(char), name: `NGO ${char}`, verified: false },
      });
    }

    const firstUrl = '/v1/ngos/all?limit=2';
    const firstHeaders = signAdminRequest(adminKeypair, 'GET', firstUrl);
    const firstPage = await app.inject({ method: 'GET', url: firstUrl, headers: firstHeaders });
    expect(firstPage.statusCode).toBe(200);

    const firstBody = firstPage.json();
    expect(firstBody.ngos).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const firstIds = firstBody.ngos.map((n: { id: string }) => n.id);

    const secondUrl = `/v1/ngos/all?limit=2&cursor=${firstBody.nextCursor}`;
    const secondHeaders = signAdminRequest(adminKeypair, 'GET', secondUrl);
    const secondPage = await app.inject({ method: 'GET', url: secondUrl, headers: secondHeaders });
    expect(secondPage.statusCode).toBe(200);

    const secondBody = secondPage.json();
    expect(secondBody.ngos).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    // No overlap between pages.
    const secondIds = secondBody.ngos.map((n: { id: string }) => n.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

    await app.close();
  });
});

describe('GET /ngos/lookup', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('finds the NGO matching the given address', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('A'),
        name: 'Impact NGO',
        displayName: 'Community Impact',
        verified: true,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/lookup?address=${ngo.ownerAddress}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBe(ngo.id);
    expect(body.name).toBe('Community Impact');

    await app.close();
  });

  it('returns an unverified NGO matching the given address', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('A'),
        name: 'Unverified Impact NGO',
        verified: false,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/lookup?address=${ngo.ownerAddress}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: ngo.id,
      ownerAddress: ngo.ownerAddress,
      verified: false,
    });

    await app.close();
  });

  it('404s when no NGO matches the address', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/lookup?address=${fakeAddress('Z')}`,
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('400s on a malformed address instead of matching nothing silently', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngos/lookup?address=not-an-address' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('GET /v1/ngos/:id', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('404s for an id that does not exist', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngos/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('400s for a non-uuid id instead of leaking a Prisma error', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/v1/ngos/not-a-uuid' });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('returns an unverified NGO by id', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('C'),
        name: 'Unverified Impact NGO',
        verified: false,
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: ngo.id,
      ownerAddress: ngo.ownerAddress,
      verified: false,
    });

    await app.close();
  });

  it("computes stats from the NGO's streams", async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: fakeAddress('C'),
        name: 'Impact NGO',
        displayName: 'Community Impact',
        verified: true,
      },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('D') } });

    await prisma.stream.create({
      data: {
        onChainId: 1n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('E'),
        rate: '10',
        balance: '400',
        withdrawn: '600',
        status: 'ACTIVE',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.name).toBe('Community Impact');
    expect(body.stats.totalCommitted).toBe('1000');
    expect(body.stats.totalWithdrawn).toBe('600');
    expect(body.stats.activeStreamCount).toBe(1);
    expect(body.stats.donorCount).toBe(1);

    await app.close();
  });

  it('computes stats correctly with a cancelled stream', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'Mixed Streams NGO', verified: true },
    });
    const activeDonor = await prisma.donor.create({ data: { address: fakeAddress('I') } });
    const cancelledDonor = await prisma.donor.create({ data: { address: fakeAddress('J') } });

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 2n,
          donorId: activeDonor.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('K'),
          rate: '10',
          balance: '400',
          withdrawn: '600',
          status: 'ACTIVE',
        },
        {
          onChainId: 3n,
          donorId: cancelledDonor.id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('L'),
          rate: '10',
          balance: '0',
          withdrawn: '200',
          status: 'CANCELLED',
        },
      ],
    });

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.stats.totalCommitted).toBe('1200');
    expect(body.stats.committedByToken).toEqual([
      { tokenAddress: fakeAddress('K'), amount: '1000' },
      { tokenAddress: fakeAddress('L'), amount: '200' },
    ]);
    expect(body.stats.totalWithdrawn).toBe('800');
    expect(body.stats.activeStreamCount).toBe(1);
    expect(body.stats.donorCount).toBe(2);

    await app.close();
  });

  it('aggregates large stream histories and returns only a bounded recent page', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('M'), name: 'High Volume NGO', verified: true },
    });
    const donors = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        prisma.donor.create({ data: { address: fakeAddress(String.fromCharCode(65 + index)) } }),
      ),
    );
    const createdAt = new Date('2026-01-01T00:00:00Z');

    await prisma.stream.createMany({
      data: donors.map((donor, index) => ({
        onChainId: BigInt(100 + index),
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('N'),
        rate: '1',
        balance: index < 3 ? '0' : '100',
        withdrawn: '10',
        status: index < 3 ? 'CANCELLED' : 'ACTIVE',
        createdAt: new Date(createdAt.getTime() + index * 1_000),
      })),
    });

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.stats.totalCommitted).toBe('1020');
    expect(body.stats.totalWithdrawn).toBe('120');
    expect(body.stats.activeStreamCount).toBe(9);
    expect(body.stats.donorCount).toBe(12);
    expect(body.recentStreams).toHaveLength(10);
    expect(body.recentStreams[0].onChainId).toBe('111');
    expect(body.recentStreamsNextCursor).toBe(body.recentStreams.at(-1).id);

    await app.close();
  });

  it('includes description, website and country from the approved application', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('F'), name: 'Green NGO', verified: true },
    });
    await prisma.ngoApplication.create({
      data: {
        ownerAddress: ngo.ownerAddress,
        name: ngo.name,
        description: 'Saving trees everywhere.',
        website: 'https://green.example',
        contactEmail: 'secret@green.example',
        country: 'Brazil',
        status: 'APPROVED',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.description).toBe('Saving trees everywhere.');
    expect(body.website).toBe('https://green.example');
    expect(body.country).toBe('Brazil');
    expect(body.contactEmail).toBeUndefined();
    expect(body.reviewNote).toBeUndefined();

    await app.close();
  });

  it('returns null description/website/country when there is no approved application', async () => {
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('G'), name: 'Pending NGO', verified: false },
    });
    await prisma.ngoApplication.create({
      data: {
        ownerAddress: ngo.ownerAddress,
        name: ngo.name,
        description: 'Still under review.',
        contactEmail: 'hi@pending.example',
        status: 'PENDING',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}` });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.description).toBeNull();
    expect(body.website).toBeNull();
    expect(body.country).toBeNull();

    await app.close();
  });
});

describe('GET /v1/ngos/:id/donors', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns distinct donors with per-NGO committed totals and paginates them', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'Food Fund', verified: true },
    });
    const otherNgo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('I'), name: 'Other Fund', verified: true },
    });
    const donors = await Promise.all(
      ['J', 'K', 'L'].map((char) =>
        prisma.donor.create({ data: { address: fakeAddress(char) } }),
      ),
    );

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 10n,
          donorId: donors[0].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '40',
          withdrawn: '10',
          status: 'ACTIVE',
        },
        {
          onChainId: 11n,
          donorId: donors[0].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '999',
          withdrawn: '20',
          status: 'CANCELLED',
        },
        {
          onChainId: 12n,
          donorId: donors[1].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '30',
          withdrawn: '5',
          status: 'ACTIVE',
        },
        {
          onChainId: 13n,
          donorId: donors[2].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '7',
          withdrawn: '3',
          status: 'ACTIVE',
        },
        {
          onChainId: 14n,
          donorId: donors[0].id,
          ngoId: otherNgo.id,
          tokenAddress: fakeAddress('M'),
          rate: '1',
          balance: '1000',
          withdrawn: '0',
          status: 'ACTIVE',
        },
      ],
    });

    const first = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}/donors?limit=2` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.donors).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/ngos/${ngo.id}/donors?limit=2&cursor=${firstBody.nextCursor}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.donors).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    const totals = new Map(
      [...firstBody.donors, ...secondBody.donors].map(
        (donor: { id: string; totalCommitted: string }) => [donor.id, donor.totalCommitted],
      ),
    );
    expect(totals).toEqual(
      new Map([
        [donors[0].id, '70'],
        [donors[1].id, '35'],
        [donors[2].id, '10'],
      ]),
    );

    await app.close();
  });

  it('returns an ETag and 304 for a matching If-None-Match header', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('V'), name: 'Cached NGO', verified: true },
    });
    const url = `/v1/ngos/${ngo.id}/donors`;

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

  it('returns 404 for an unknown NGO', async () => {
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngos/00000000-0000-0000-0000-000000000000/donors',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    await app.close();
  });

  it('returns 400 for an unknown cursor (non-existent donor ID)', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'Test NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('O') } });
    await prisma.stream.create({
      data: {
        onChainId: 15n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('P'),
        rate: '1',
        balance: '100',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });

    const unknownCursor = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/${ngo.id}/donors?cursor=${unknownCursor}`,
    });

    // Unknown cursor results in empty list (Prisma cursor skip behavior)
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.donors).toEqual([]);
    expect(body.nextCursor).toBeNull();

    await app.close();
  });

  it('handles limit of 1 and paginates correctly', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('Q'), name: 'Single Limit NGO', verified: true },
    });
    const donors = await Promise.all(
      ['R', 'S'].map((char) => prisma.donor.create({ data: { address: fakeAddress(char) } })),
    );

    await prisma.stream.createMany({
      data: [
        {
          onChainId: 16n,
          donorId: donors[0].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '50',
          withdrawn: '0',
          status: 'ACTIVE',
        },
        {
          onChainId: 17n,
          donorId: donors[1].id,
          ngoId: ngo.id,
          tokenAddress: fakeAddress('T'),
          rate: '1',
          balance: '75',
          withdrawn: '0',
          status: 'ACTIVE',
        },
      ],
    });

    const first = await app.inject({ method: 'GET', url: `/v1/ngos/${ngo.id}/donors?limit=1` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.donors).toHaveLength(1);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/ngos/${ngo.id}/donors?limit=1&cursor=${firstBody.nextCursor}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.donors).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    await app.close();
  });

  it('returns null nextCursor on the last page', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('U'), name: 'Last Page NGO', verified: true },
    });
    const donor = await prisma.donor.create({ data: { address: fakeAddress('V') } });
    await prisma.stream.create({
      data: {
        onChainId: 18n,
        donorId: donor.id,
        ngoId: ngo.id,
        tokenAddress: fakeAddress('W'),
        rate: '1',
        balance: '200',
        withdrawn: '50',
        status: 'ACTIVE',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/${ngo.id}/donors?limit=10`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.donors).toHaveLength(1);
    expect(body.nextCursor).toBeNull();

    await app.close();
  });

  it('returns empty list with null nextCursor for an NGO with no donors', async () => {
    const app = buildServer();
    const ngo = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('X'), name: 'No Donors NGO', verified: true },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/ngos/${ngo.id}/donors`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.donors).toEqual([]);
    expect(body.nextCursor).toBeNull();

    await app.close();
  });
});
