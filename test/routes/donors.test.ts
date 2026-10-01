import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import { fakeAddress, resetDb } from '../helpers/db.js';

describe('GET /donors', () => {
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

    const response = await app.inject({ method: 'GET', url: '/donors' });

    expect(response.statusCode).toBe(200);
    expect(response.json().donors).toEqual([
      expect.objectContaining({ id: first.id, totalCommitted: '1000', totalWithdrawn: '400' }),
      expect.objectContaining({ id: second.id, totalCommitted: '300', totalWithdrawn: '300' }),
      expect.objectContaining({ id: third.id, totalCommitted: '0', totalWithdrawn: '0' }),
    ]);

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
      url: '/donors?sort=withdrawn&order=desc&limit=2',
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().donors.map((donor: { id: string }) => donor.id)).toEqual([
      donors[2].id,
      donors[1].id,
    ]);
    expect(firstPage.json().nextCursor).toBe(donors[1].id);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/donors?sort=withdrawn&order=desc&limit=2&cursor=${firstPage.json().nextCursor}`,
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().donors.map((donor: { id: string }) => donor.id)).toEqual([
      donors[0].id,
    ]);
    expect(secondPage.json().nextCursor).toBeNull();

    await app.close();
  });
});
