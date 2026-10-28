import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const DEFAULT_DATABASE_URL = 'postgresql://streamgive:streamgive@localhost:5432/streamgive';
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
});

export const prisma = new PrismaClient({ adapter });

const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

export const SEED_NGOS = [
  {
    ownerAddress: 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR',
    name: 'Clean Water Initiative',
    verified: true,
  },
  {
    ownerAddress: 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U',
    name: 'Education For All',
    verified: true,
  },
  {
    ownerAddress: 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG',
    name: 'Rainforest Trust',
    verified: false,
  },
];

export const SEED_APPLICATIONS = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    ownerAddress: 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR',
    name: 'Clean Water Initiative',
    description:
      'We bring clean drinking water to rural communities across Sub-Saharan Africa through bore-hole drilling and maintenance.',
    website: 'https://cleanwaterinitiative.example',
    contactEmail: 'contact@cleanwater.example',
    country: 'Kenya',
    status: 'APPROVED' as const,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    ownerAddress: 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U',
    name: 'Education For All',
    description:
      'Funding school construction, teacher training, and scholarship programmes for children in under-served regions.',
    website: 'https://educationforall.example',
    contactEmail: 'apply@efa.example',
    country: 'Nigeria',
    status: 'APPROVED' as const,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    ownerAddress: 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG',
    name: 'Rainforest Trust',
    description: 'Protecting old-growth forests through land purchase and community partnerships.',
    website: 'https://rainforesttrust.example',
    contactEmail: 'hello@rft.example',
    country: 'Brazil',
    status: 'PENDING' as const,
  },
];

export const SEED_DONORS = [
  { address: 'GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP' },
  { address: 'GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN' },
];

export async function seed(client: PrismaClient = prisma) {
  // --- NGOs ---
  const ngo1 = await client.ngo.upsert({
    where: { ownerAddress: SEED_NGOS[0].ownerAddress },
    create: SEED_NGOS[0],
    update: { name: SEED_NGOS[0].name, verified: SEED_NGOS[0].verified },
  });

  const ngo2 = await client.ngo.upsert({
    where: { ownerAddress: SEED_NGOS[1].ownerAddress },
    create: SEED_NGOS[1],
    update: { name: SEED_NGOS[1].name, verified: SEED_NGOS[1].verified },
  });

  await client.ngo.upsert({
    where: { ownerAddress: SEED_NGOS[2].ownerAddress },
    create: SEED_NGOS[2],
    update: { name: SEED_NGOS[2].name },
  });

  // --- Applications ---
  for (const app of SEED_APPLICATIONS) {
    await client.ngoApplication.upsert({
      where: { id: app.id },
      create: app,
      update: {},
    });
  }

  // --- Donors ---
  const donor1 = await client.donor.upsert({
    where: { address: SEED_DONORS[0].address },
    create: SEED_DONORS[0],
    update: {},
  });

  const donor2 = await client.donor.upsert({
    where: { address: SEED_DONORS[1].address },
    create: SEED_DONORS[1],
    update: {},
  });

  // --- Streams ---
  await client.stream.upsert({
    where: { onChainId: 1n },
    create: {
      onChainId: 1n,
      donorId: donor1.id,
      ngoId: ngo1.id,
      tokenAddress: USDC,
      rate: '100000000',
      balance: '5000000000',
      withdrawn: '500000000',
      status: 'ACTIVE',
    },
    update: {},
  });

  await client.stream.upsert({
    where: { onChainId: 2n },
    create: {
      onChainId: 2n,
      donorId: donor2.id,
      ngoId: ngo1.id,
      tokenAddress: USDC,
      rate: '50000000',
      balance: '2000000000',
      withdrawn: '250000000',
      status: 'ACTIVE',
    },
    update: {},
  });

  await client.stream.upsert({
    where: { onChainId: 3n },
    create: {
      onChainId: 3n,
      donorId: donor1.id,
      ngoId: ngo2.id,
      tokenAddress: USDC,
      rate: '75000000',
      balance: '0',
      withdrawn: '1000000000',
      status: 'CANCELLED',
    },
    update: {},
  });

  await client.stream.upsert({
    where: { onChainId: 4n },
    create: {
      onChainId: 4n,
      donorId: donor2.id,
      ngoId: ngo2.id,
      tokenAddress: USDC,
      rate: '200000000',
      balance: '8000000000',
      withdrawn: '800000000',
      status: 'ACTIVE',
    },
    update: {},
  });

  console.log('Seed complete.');
}

if (process.argv[1]?.includes('seed.ts') || process.argv[1]?.includes('seed.js')) {
  seed()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
