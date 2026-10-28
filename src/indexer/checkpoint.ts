import { prisma } from '../db.js';

const CHECKPOINT_ID = 'main';

export interface IndexerCheckpoint {
  lastLedger: number;
  lastEventId?: string;
  updatedAt?: Date;
}

export async function getCheckpointState(): Promise<IndexerCheckpoint | undefined> {
  const row = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  return row
    ? {
        lastLedger: row.lastLedger,
        lastEventId: row.lastEventId ?? undefined,
        updatedAt: row.updatedAt,
      }
    : undefined;
}

export async function getCheckpoint(): Promise<number | undefined> {
  return (await getCheckpointState())?.lastLedger;
}

export async function saveCheckpoint(ledger: number, eventId: string | null = null): Promise<void> {
  await prisma.indexerCheckpoint.upsert({
    where: { id: CHECKPOINT_ID },
    create: { id: CHECKPOINT_ID, lastLedger: ledger, lastEventId: eventId },
    update: { lastLedger: ledger, lastEventId: eventId },
  });
}
