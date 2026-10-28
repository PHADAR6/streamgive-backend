import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const DEFAULT_DATABASE_URL = 'postgresql://streamgive:streamgive@localhost:5432/streamgive';

export function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  const nodeEnv = process.env.NODE_ENV;

  if (!databaseUrl) {
    if (nodeEnv === 'production') {
      throw new Error(
        'FATAL: DATABASE_URL environment variable is required in production but was not provided.',
      );
    }
    return DEFAULT_DATABASE_URL;
  }

  return databaseUrl;
}

const adapter = new PrismaPg({
  connectionString: getDatabaseUrl(),
});

export const prisma = new PrismaClient({ adapter });

export interface NgoVerificationRecord {
  id: string;
  ownerAddress: string;
  verified: boolean;
}

export async function getNgoVerificationRecords(): Promise<NgoVerificationRecord[]> {
  return prisma.ngo.findMany({
    select: { id: true, ownerAddress: true, verified: true },
  });
}

export async function setNgoVerified(id: string, verified: boolean): Promise<void> {
  await prisma.ngo.update({
    where: { id },
    data: { verified },
  });
}