import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { signAdminRequest } from './helpers/adminAuth.js';
import { resetDb } from './helpers/db.js';
import { SEED_APPLICATIONS, SEED_DONORS, SEED_NGOS, seed } from '../prisma/seed.js';

describe('prisma/seed.ts', () => {
  const adminKeypair = Keypair.random();
  const originalAdminAddress = process.env.ADMIN_ADDRESS;

  beforeEach(async () => {
    process.env.ADMIN_ADDRESS = adminKeypair.publicKey();
    await resetDb();
  });

  afterEach(async () => {
    if (originalAdminAddress !== undefined) {
      process.env.ADMIN_ADDRESS = originalAdminAddress;
    } else {
      delete process.env.ADMIN_ADDRESS;
    }
    await resetDb();
  });

  it('runs against the test database and produces valid data accepted by the API', async () => {
    await seed(prisma);

    // Verify NGOs seeded with valid StrKey addresses
    const ngos = await prisma.ngo.findMany();
    expect(ngos).toHaveLength(SEED_NGOS.length);
    for (const ngo of ngos) {
      expect(ngo.ownerAddress).toMatch(/^G[A-Z2-7]{55}$/);
      expect(StrKey.isValidEd25519PublicKey(ngo.ownerAddress)).toBe(true);
    }

    // Verify Donors seeded with valid StrKey addresses
    const donors = await prisma.donor.findMany();
    expect(donors).toHaveLength(SEED_DONORS.length);
    for (const donor of donors) {
      expect(donor.address).toMatch(/^G[A-Z2-7]{55}$/);
      expect(StrKey.isValidEd25519PublicKey(donor.address)).toBe(true);
    }

    // Verify Streams seeded
    const streams = await prisma.stream.findMany();
    expect(streams).toHaveLength(4);

    // Verify Applications seeded with RFC 4122 UUIDs
    const applications = await prisma.ngoApplication.findMany();
    expect(applications).toHaveLength(SEED_APPLICATIONS.length);

    // Assert the API accepts seeded applications and does not 400
    const app = buildServer();
    for (const seededApp of SEED_APPLICATIONS) {
      const url = `/v1/ngo-applications/${seededApp.id}`;
      const headers = signAdminRequest(adminKeypair, 'GET', url);
      const response = await app.inject({
        method: 'GET',
        url,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(seededApp.id);
      expect(body.ownerAddress).toBe(seededApp.ownerAddress);
    }

    // Also assert that GET /v1/ngos/lookup accepts the seeded addresses without 400
    for (const seededNgo of SEED_NGOS) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/ngos/lookup?address=${seededNgo.ownerAddress}`,
      });
      expect(response.statusCode).not.toBe(400);
    }

    await app.close();
  });
});
