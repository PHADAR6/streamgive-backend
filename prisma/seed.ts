import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

async function main() {
  // --- NGOs ---
  const ngo1 = await prisma.ngo.upsert({
    where: { ownerAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV4UAEV4Z7X' },
    create: {
      ownerAddress: 'GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV4UAEV4Z7X',
      name: 'Clean Water Initiative',
      verified: true,
    },
    update: { name: 'Clean Water Initiative', verified: true },
  });

  const ngo2 = await prisma.ngo.upsert({
    where: { ownerAddress: 'GBVNQZPF7UEKNMB7KFSM3NGZK2STHOMZH4QAE7OZXNLMV5NDDQHYJ6' },
    create: {
      ownerAddress: 'GBVNQZPF7UEKNMB7KFSM3NGZK2STHOMZH4QAE7OZXNLMV5NDDQHYJ6',
      name: 'Education For All',
      verified: true,
    },
    update: { name: 'Education For All', verified: true },
  });

  const ngo3 = await prisma.ngo.upsert({
    where: { ownerAddress: 'GDMTKCJQ3ZF7QBZIAQJF7MXBLLQ2BXSWBMF7KIT3TGOLKD2PBN5Q4GX' },
    create: {
      ownerAddress: 'GDMTKCJQ3ZF7QBZIAQJF7MXBLLQ2BXSWBMF7KIT3TGOLKD2PBN5Q4GX',
      name: 'Rainforest Trust',
      verified: false,
    },
    update: { name: 'Rainforest Trust' },
  });

  // --- Applications ---
  await prisma.ngoApplication.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      ownerAddress: ngo1.ownerAddress,
      name: 'Clean Water Initiative',
      description:
        'We bring clean drinking water to rural communities across Sub-Saharan Africa through bore-hole drilling and maintenance.',
      website: 'https://cleanwaterinitiative.example',
      contactEmail: 'contact@cleanwater.example',
      country: 'Kenya',
      status: 'APPROVED',
    },
    update: {},
  });

  await prisma.ngoApplication.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      ownerAddress: ngo2.ownerAddress,
      name: 'Education For All',
      description:
        'Funding school construction, teacher training, and scholarship programmes for children in under-served regions.',
      website: 'https://educationforall.example',
      contactEmail: 'apply@efa.example',
      country: 'Nigeria',
      status: 'APPROVED',
    },
    update: {},
  });

  await prisma.ngoApplication.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      ownerAddress: ngo3.ownerAddress,
      name: 'Rainforest Trust',
      description: 'Protecting old-growth forests through land purchase and community partnerships.',
      website: 'https://rainforesttrust.example',
      contactEmail: 'hello@rft.example',
      country: 'Brazil',
      status: 'PENDING',
    },
    update: {},
  });

  // --- Donors ---
  const donor1 = await prisma.donor.upsert({
    where: { address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGCL5A5GPCMB2G77BN5Z2Z' },
    create: { address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGCL5A5GPCMB2G77BN5Z2Z' },
    update: {},
  });

  const donor2 = await prisma.donor.upsert({
    where: { address: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFQB7YPHYAQIJDPXAUXFKP8L' },
    create: { address: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFQB7YPHYAQIJDPXAUXFKP8L' },
    update: {},
  });

  // --- Streams ---
  await prisma.stream.upsert({
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

  await prisma.stream.upsert({
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

  await prisma.stream.upsert({
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

  await prisma.stream.upsert({
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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
