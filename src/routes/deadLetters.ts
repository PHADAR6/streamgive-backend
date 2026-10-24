import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

/**
 * Query schema for GET /v1/admin/dead-letters:
 * - limit: 1 to 100 items per page (default: 100)
 * - cursor: optional UUID pointing to the last item of the previous page
 * - resolved: optional boolean filter ('true' | 'false')
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => (val === undefined ? undefined : val === 'true')),
});

export async function deadLetterRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists failed Soroban contract events recorded in the dead-letter queue.
   * @route GET /v1/admin/dead-letters
   * @query limit, cursor, resolved
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ deadLetters: IndexerDeadLetter[], total: number, hasMore: boolean, nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get(
    '/admin/dead-letters',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['Admin'],
        summary: 'List dead-lettered events',
        description:
          'Returns paginated dead-letter records with an optional resolved status filter.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
            resolved: { type: 'string', enum: ['true', 'false'] },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          401: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedQuery = querySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
      }

      const { limit, cursor, resolved } = parsedQuery.data;

      const where =
        resolved === undefined
          ? {}
          : resolved
            ? { resolvedAt: { not: null } }
            : { resolvedAt: null };

      // Resolve the cursor explicitly. Prisma's `cursor` pagination requires the
      // cursor row to exist; the API contract treats an unknown cursor as an
      // empty page rather than leaking a Prisma record-not-found error.
      const cursorRow = cursor
        ? await prisma.indexerDeadLetter.findUnique({
            where: { id: cursor },
            select: { id: true, createdAt: true },
          })
        : null;

      if (cursor && !cursorRow) {
        return {
          deadLetters: [],
          total: await prisma.indexerDeadLetter.count({ where }),
          hasMore: false,
          nextCursor: null,
        };
      }

      const [total, rows] = await Promise.all([
        prisma.indexerDeadLetter.count({ where }),
        prisma.indexerDeadLetter.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(cursorRow
            ? {
                where: {
                  ...where,
                  OR: [
                    { createdAt: { lt: cursorRow.createdAt } },
                    { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
                  ],
                },
              }
            : {}),
        }),
      ]);

      const hasMore = rows.length > limit;
      const deadLetters = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? deadLetters[deadLetters.length - 1].id : null;

      return {
        deadLetters,
        total,
        hasMore,
        nextCursor,
      };
    },
  );
}
