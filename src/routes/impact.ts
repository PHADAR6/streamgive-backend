import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { getPublicNgoName } from './ngoName.js';
import { committedTotalsByToken } from './tokenTotals.js';

/** Params for GET /v1/impact/:ngoId; `ngoId` must be an NGO UUID. */
const paramsSchema = z.object({ ngoId: z.string().uuid() });

/**
 * Public "impact" view for one NGO — a superset of /ngos/:id's profile
 * stats, framed around relative impact rather than admin/profile detail:
 * active vs. cancelled breakdown, and this NGO's share of everything ever
 * committed platform-wide. That platform-wide comparison is the reason
 * this isn't just folded into /ngos/:id — a plain profile page shouldn't
 * need to scan every stream on the platform to render.
 */
export async function impactRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Returns platform-wide committed/withdrawn totals and activity counts.
   * @route GET /v1/impact
   * @auth Public
   * @returns 200 `{ totalCommitted: string, totalWithdrawn: string, activeStreams: number, verifiedNgoCount: number }`.
   */
  app.get(
    '/impact',
    {
      schema: {
        tags: ['Impact'],
        summary: 'Returns platform-wide committed/withdrawn totals and activity counts',
      },
    },
    async (request, reply) => {
    const [streams, verifiedNgoCount] = await Promise.all([
      prisma.stream.findMany({
        select: { balance: true, withdrawn: true, status: true, tokenAddress: true },
      }),
      prisma.ngo.count({ where: { verified: true } }),
    ]);

    // For cancelled streams the balance was refunded to the donor and never
    // delivered to any NGO, so only count withdrawn.  Active streams count
    // balance + withdrawn (balance will be withdrawn in the future).
    const totalCommitted = streams.reduce(
      (sum, s) =>
        s.status === 'CANCELLED'
          ? sum + BigInt(s.withdrawn)
          : sum + BigInt(s.balance) + BigInt(s.withdrawn),
      0n,
    );
    const totalWithdrawn = streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);
    const activeStreams = streams.filter((s) => s.status === 'ACTIVE').length;

    return sendPublicCacheable(request, reply, {
      totalCommitted: totalCommitted.toString(),
      committedByToken: committedTotalsByToken(streams),
      totalWithdrawn: totalWithdrawn.toString(),
      activeStreams,
      verifiedNgoCount,
    });
  });

  /**
   * Returns one NGO's contribution and share of platform-wide impact.
   * @route GET /v1/impact/:ngoId
   * @param ngoId NGO UUID
   * @auth Public
   * @returns 200 NGO impact totals, stream counts, unique donor count, and `platformSharePercent`; 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/impact/:ngoId',
    {
      schema: {
        tags: ['Impact'],
        summary: 'Get impact totals for one NGO',
        params: {
          type: 'object',
          properties: { ngoId: { type: 'string', format: 'uuid' } },
          required: ['ngoId'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { ngoId } = parsedParams.data;

      const ngo = await prisma.ngo.findUnique({
        where: { id: ngoId },
        include: {
          streams: {
            select: {
              status: true,
              balance: true,
              withdrawn: true,
              donorId: true,
              tokenAddress: true,
            },
          },
        },
      });

      if (!ngo) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // For cancelled streams the balance was refunded to the donor, so only
      // count withdrawn.  Active streams count balance + withdrawn.
      const ngoCommitted = ngo.streams.reduce(
        (sum, s) =>
          s.status === 'CANCELLED'
            ? sum + BigInt(s.withdrawn)
            : sum + BigInt(s.balance) + BigInt(s.withdrawn),
        0n,
      );
      const ngoWithdrawn = ngo.streams.reduce((sum, s) => sum + BigInt(s.withdrawn), 0n);

      // Scans every stream on the platform — fine at MVP scale, but this is
      // the first thing to replace with a maintained running total if the
      // streams table grows large.
      const allStreams = await prisma.stream.findMany({
        select: { balance: true, withdrawn: true, status: true, tokenAddress: true },
      });
      const platformCommitted = allStreams.reduce(
        (sum, s) =>
          s.status === 'CANCELLED'
            ? sum + BigInt(s.withdrawn)
            : sum + BigInt(s.balance) + BigInt(s.withdrawn),
        0n,
      );

      const percentScale = 1_000_000_000_000n;
      const platformSharePercent =
        platformCommitted > 0n
          ? Number((ngoCommitted * 100n * percentScale) / platformCommitted) /
            Number(percentScale)
          : 0;

      return sendPublicCacheable(request, reply, {
        ngoId: ngo.id,
        name: getPublicNgoName(ngo),
        totalCommitted: ngoCommitted.toString(),
        committedByToken: committedTotalsByToken(ngo.streams),
        platformCommittedByToken: committedTotalsByToken(allStreams),
        totalWithdrawn: ngoWithdrawn.toString(),
        activeStreams: ngo.streams.filter((s) => s.status === 'ACTIVE').length,
        cancelledStreams: ngo.streams.filter((s) => s.status === 'CANCELLED').length,
        uniqueDonors: new Set(ngo.streams.map((s) => s.donorId)).size,
        platformSharePercent,
      });
    },
  );
}
