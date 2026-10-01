import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

const querySchema = z.object({
  sort: z.enum(['committed', 'withdrawn']).default('committed'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

export async function donorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/donors', async (request, reply) => {
    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const { sort, order, limit, cursor } = parsedQuery.data;
    const rows = await prisma.donor.findMany({
      include: {
        streams: { select: { balance: true, withdrawn: true, status: true } },
      },
    });

    const ranked = rows
      .map(({ streams, ...donor }) => ({
        ...donor,
        totalCommitted: streams
          .reduce(
            (sum, stream) =>
              stream.status === 'CANCELLED'
                ? sum + BigInt(stream.withdrawn)
                : sum + BigInt(stream.balance) + BigInt(stream.withdrawn),
            0n,
          )
          .toString(),
        totalWithdrawn: streams
          .reduce((sum, stream) => sum + BigInt(stream.withdrawn), 0n)
          .toString(),
      }))
      .sort((left, right) => {
        const leftValue = BigInt(sort === 'committed' ? left.totalCommitted : left.totalWithdrawn);
        const rightValue = BigInt(
          sort === 'committed' ? right.totalCommitted : right.totalWithdrawn,
        );
        const comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;

        if (comparison !== 0) return order === 'asc' ? comparison : -comparison;
        return left.id.localeCompare(right.id);
      });

    const cursorIndex = cursor ? ranked.findIndex((donor) => donor.id === cursor) : -1;
    if (cursor && cursorIndex === -1) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const start = cursorIndex + 1;
    const page = ranked.slice(start, start + limit + 1);
    const hasMore = page.length > limit;
    const donors = hasMore ? page.slice(0, limit) : page;

    return {
      donors,
      nextCursor: hasMore ? donors[donors.length - 1].id : null,
    };
  });
}
