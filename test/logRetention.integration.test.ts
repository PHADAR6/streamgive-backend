import { afterEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/db.js';
import { pruneOldLogs } from '../src/maintenance/logRetention.js';
import { resetDb } from './helpers/db.js';

describe('pruneOldLogs', () => {
  const originalRetentionDays = process.env.LOG_RETENTION_DAYS;

  afterEach(async () => {
    if (originalRetentionDays === undefined) delete process.env.LOG_RETENTION_DAYS;
    else process.env.LOG_RETENTION_DAYS = originalRetentionDays;
    await resetDb();
  });

  it('removes expired notification logs and resolved dead letters but keeps recent or unresolved rows', async () => {
    process.env.LOG_RETENTION_DAYS = '30';
    const now = new Date('2026-10-21T12:00:00.000Z');
    const old = new Date('2026-09-01T12:00:00.000Z');
    const recent = new Date('2026-10-01T12:00:00.000Z');

    const oldNotification = await prisma.notificationLog.create({
      data: { eventType: 'stream.created', channel: 'test', success: true, createdAt: old },
    });
    const recentNotification = await prisma.notificationLog.create({
      data: { eventType: 'stream.created', channel: 'test', success: true, createdAt: recent },
    });
    const oldResolved = await prisma.indexerDeadLetter.create({
      data: { eventId: 'old-resolved', ledger: 1, error: 'test', resolvedAt: old },
    });
    const recentResolved = await prisma.indexerDeadLetter.create({
      data: { eventId: 'recent-resolved', ledger: 2, error: 'test', resolvedAt: recent },
    });
    const unresolved = await prisma.indexerDeadLetter.create({
      data: { eventId: 'unresolved', ledger: 3, error: 'test', resolvedAt: null, createdAt: old },
    });

    expect(await pruneOldLogs(now)).toEqual({ notifications: 1, deadLetters: 1 });
    expect(await prisma.notificationLog.findUnique({ where: { id: oldNotification.id } })).toBeNull();
    expect(await prisma.notificationLog.findUnique({ where: { id: recentNotification.id } })).not.toBeNull();
    expect(await prisma.indexerDeadLetter.findUnique({ where: { id: oldResolved.id } })).toBeNull();
    expect(await prisma.indexerDeadLetter.findUnique({ where: { id: recentResolved.id } })).not.toBeNull();
    expect(await prisma.indexerDeadLetter.findUnique({ where: { id: unresolved.id } })).not.toBeNull();
  });
});
