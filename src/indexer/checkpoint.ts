import { prisma } from '../db.js';

const CHECKPOINT_ID = 'main';

export async function getCheckpoint(): Promise<number | undefined> {
  const row = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  return row?.lastLedger;
}

export async function saveCheckpoint(ledger: number): Promise<void> {
  await prisma.indexerCheckpoint.upsert({
    where: { id: CHECKPOINT_ID },
    create: { id: CHECKPOINT_ID, lastLedger: ledger },
    update: { lastLedger: ledger },
  });
}
