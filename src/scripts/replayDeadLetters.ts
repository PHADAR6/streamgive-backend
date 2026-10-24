import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import { prisma } from '../db.js';
import { WATCHED_CONTRACT_IDS } from '../indexer/contracts.js';
import { rebuildEventFromDeadLetter } from '../indexer/deadLetter.js';
import { dispatchEvent } from '../indexer/dispatch.js';
import type { ContractEvent, EventHandler } from '../indexer/worker.js';

const MAX_ERROR_LENGTH = 2000;

function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

export interface ReplayReport {
  attempted: number;
  resolved: number;
  failed: number;
}

export interface ReplayOptions {
  /** Overridable for tests; production uses the real dispatcher. */
  dispatcher?: EventHandler;
}

/**
 * Re-runs every unresolved dead letter through the event dispatcher.
 *
 * A row is marked resolved only when the dispatcher returns without
 * recording a new failure. Some handlers report a permanent failure by
 * calling `recordDeadLetter` and returning rather than throwing (an event
 * for an unknown stream, for example), so the row is re-read after dispatch
 * and left unresolved when its attempt count moved.
 *
 * Rows are processed oldest-first and one at a time: the handlers apply
 * relative balance changes, and replaying two events for the same stream out
 * of order would be worse than replaying them slowly.
 */
export async function replayDeadLetters(options: ReplayOptions = {}): Promise<ReplayReport> {
  const dispatcher = options.dispatcher ?? dispatchEvent;
  const deadLetters = await prisma.indexerDeadLetter.findMany({
    where: { resolvedAt: null },
    orderBy: [{ ledger: 'asc' }, { eventId: 'asc' }],
  });

  let resolved = 0;
  let failed = 0;

  for (const deadLetter of deadLetters) {
    try {
      // An unwatched contract id would fall through dispatchEvent's default
      // branch as a silent no-op, which would wrongly mark the row resolved.
      if (deadLetter.contractId === null || !WATCHED_CONTRACT_IDS.includes(deadLetter.contractId)) {
        throw new Error(
          `contract ${deadLetter.contractId ?? '<none>'} is not one of the currently watched contracts`,
        );
      }

      const event = rebuildEventFromDeadLetter(deadLetter);
      // The dead-letter row stores the fields handlers actually read, not
      // the RPC envelope's remaining metadata (event type, indexes, etc.).
      await dispatcher(event as unknown as ContractEvent);

      const current = await prisma.indexerDeadLetter.findUnique({
        where: { id: deadLetter.id },
        select: { attempts: true },
      });
      if (current !== null && current.attempts > deadLetter.attempts) {
        failed += 1;
        continue;
      }

      await prisma.indexerDeadLetter.update({
        where: { id: deadLetter.id },
        data: { resolvedAt: new Date(), attempts: { increment: 1 } },
      });
      resolved += 1;
    } catch (err) {
      failed += 1;
      await prisma.indexerDeadLetter.update({
        where: { id: deadLetter.id },
        data: { error: describeError(err), attempts: { increment: 1 } },
      });
    }
  }

  return { attempted: deadLetters.length, resolved, failed };
}

async function main(): Promise<void> {
  const report = await replayDeadLetters();
  console.log(
    `Replayed ${report.attempted} unresolved dead letter(s): ` +
      `${report.resolved} resolved, ${report.failed} still failing.`,
  );

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
