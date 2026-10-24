import type { FastifyInstance } from 'fastify';

import { prisma } from '../db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

function retentionDays(): number {
  const configured = Number(process.env.LOG_RETENTION_DAYS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RETENTION_DAYS;
}

export async function pruneOldLogs(
  now = new Date(),
): Promise<{ notifications: number; deadLetters: number }> {
  const cutoff = new Date(now.getTime() - retentionDays() * DAY_MS);
  const [notifications, deadLetters] = await Promise.all([
    prisma.notificationLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    // Unresolved events may still be needed for recovery and are never expired.
    prisma.indexerDeadLetter.deleteMany({ where: { resolvedAt: { lt: cutoff } } }),
  ]);

  return { notifications: notifications.count, deadLetters: deadLetters.count };
}

export function registerLogRetention(app: FastifyInstance): void {
  let timer: NodeJS.Timeout | undefined;

  app.addHook('onReady', async () => {
    const run = async () => {
      try {
        const removed = await pruneOldLogs();
        if (removed.notifications || removed.deadLetters) {
          console.info('pruned expired logs', removed);
        }
      } catch (error) {
        console.error('failed to prune expired logs', error);
      }
    };

    await run();
    timer = setInterval(() => void run(), DAY_MS);
    timer.unref();
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
