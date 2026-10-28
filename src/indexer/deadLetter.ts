import { xdr } from '@stellar/stellar-sdk';

import { prisma } from '../db.js';
import type { ContractEvent } from './worker.js';

/** Bounded so a pathological error message can't bloat the row. */
const MAX_ERROR_LENGTH = 2000;

function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_ERROR_LENGTH);
}

function serializeScValToXDR(val: unknown): string {
  if (val && typeof (val as { toXDR: (format?: string) => string | Buffer }).toXDR === 'function') {
    const res = (val as { toXDR: (format: string) => string }).toXDR('base64');
    return typeof res === 'string' ? res : Buffer.from(res).toString('base64');
  }
  return String(val);
}

export interface RebuiltEvent {
  id: string;
  ledger: number;
  contractId: string | null;
  txHash: string | null;
  topic: xdr.ScVal[];
  value: xdr.ScVal | null;
}

/**
 * Rebuilds the contract event from stored dead letter XDR payloads for replay.
 */
export function rebuildEventFromDeadLetter(deadLetter: {
  eventId: string;
  ledger: number;
  contractId: string | null;
  txHash?: string | null;
  topic: string[];
  value: string | null;
}): RebuiltEvent {
  return {
    id: deadLetter.eventId,
    ledger: deadLetter.ledger,
    contractId: deadLetter.contractId,
    txHash: deadLetter.txHash ?? null,
    topic: (deadLetter.topic ?? []).map((xdrStr) => xdr.ScVal.fromXDR(xdrStr, 'base64')),
    value: deadLetter.value ? xdr.ScVal.fromXDR(deadLetter.value, 'base64') : null,
  };
}

/**
 * Records an event the indexer failed to process, so the caller can move the
 * checkpoint past it instead of retrying it on every poll forever.
 *
 * Upsert rather than create: the unique `eventId` is the whole point of the
 * row, and a duplicate insert throwing here would reintroduce exactly the
 * wedge this table exists to prevent (a manual replay that fails again, say).
 * The newest error message wins, and attempts are incremented.
 *
 * Deliberately *not* fault-tolerant — if this write throws, the database is
 * unreachable, which is a transient fault rather than a bad event. Letting it
 * propagate leaves the checkpoint where it is so the event is retried on the
 * next poll rather than skipped over a blip.
 */
export async function recordDeadLetter(event: ContractEvent, err: unknown): Promise<void> {
  const error = describeError(err);
  const topic = Array.isArray(event.topic)
    ? event.topic.map((item) => serializeScValToXDR(item))
    : [];
  const value = event.value !== undefined ? serializeScValToXDR(event.value) : null;
  const txHash = event.txHash ?? null;

  await prisma.indexerDeadLetter.upsert({
    where: { eventId: event.id },
    create: {
      eventId: event.id,
      ledger: event.ledger,
      contractId: event.contractId?.toString() ?? null,
      error,
      topic,
      value,
      txHash,
      attempts: 1,
    },
    update: {
      error,
      topic,
      value,
      txHash,
      attempts: { increment: 1 },
    },
  });
}
