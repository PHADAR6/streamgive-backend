import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { committedTotalsByToken } from './tokenTotals.js';

/**
 * Query for GET /v1/donors: `sort` is committed or withdrawn (default
 * committed), `order` is asc or desc (default desc), `limit` is 1–100
 * (default 100), and `cursor` is an optional donor UUID.
 */
const querySchema = z.object({
  sort: z.enum(['committed', 'withdrawn']).default('committed'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

// Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
/** Params for GET /v1/donors/:address; `address` must match a Stellar G... public key. */
const addressParamSchema = z.object({
  address: z.string().regex(/^G[A-Z2-7]{55}$/),
});

export async function donorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists donors ranked by committed or withdrawn amount.
   * @route GET /v1/donors
   * @query sort, order, limit, cursor
   * @auth Public
   * @returns 200 `{ donors: DonorWithTotals[], nextCursor: string | null }`; 400 `{ error: "invalid_request" }` for invalid query or cursor.
   */
  app.get(
    '/donors',
    {
      schema: {
        tags: ['Donors'],
        summary: 'Lists donors ranked by committed or withdrawn amount',
      },
    },
    async (request, reply) => {
    const parsedQuery = querySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const { sort, order, limit, cursor } = parsedQuery.data;
    const rows = await prisma.donor.findMany({
      include: {
        streams: { select: { balance: true, withdrawn: true, status: true, tokenAddress: true } },
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
        committedByToken: committedTotalsByToken(streams),
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

    return sendPublicCacheable(request, reply, {
      donors,
      nextCursor: hasMore ? donors[donors.length - 1].id : null,
    });
  });

  // Per-donor summary so the dashboard (and other clients) can show donor
  // stats without paging through every stream and summing in the browser.
  /**
   * Returns one donor's aggregate giving statistics.
   * @route GET /v1/donors/:address
   * @param address Stellar public key
   * @auth Public
   * @returns 200 donor with decimal-string `totalCommitted` and `totalWithdrawn`, plus `activeStreamCount` and `distinctNgoCount`; 400 invalid address; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/donors/:address',
    {
      schema: {
        tags: ['Donors'],
        summary: "Returns one donor's aggregate giving statistics",
      },
    },
    async (request, reply) => {
    const parsedParams = addressParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const donor = await prisma.donor.findUnique({
      where: { address: parsedParams.data.address },
      include: {
        streams: {
          select: {
            ngoId: true,
            balance: true,
            withdrawn: true,
            status: true,
            tokenAddress: true,
          },
        },
      },
    });

    if (!donor) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const { streams, ...rest } = donor;

    // A cancelled stream's remaining balance is no longer committed; only what
    // it already paid out counts, matching GET /donors.
    const totalCommitted = streams
      .reduce(
        (sum, stream) =>
          stream.status === 'CANCELLED'
            ? sum + BigInt(stream.withdrawn)
            : sum + BigInt(stream.balance) + BigInt(stream.withdrawn),
        0n,
      )
      .toString();
    const totalWithdrawn = streams
      .reduce((sum, stream) => sum + BigInt(stream.withdrawn), 0n)
      .toString();

    return sendPublicCacheable(request, reply, {
      ...rest,
      totalCommitted,
      committedByToken: committedTotalsByToken(streams),
      totalWithdrawn,
      activeStreamCount: streams.filter((stream) => stream.status === 'ACTIVE').length,
      distinctNgoCount: new Set(streams.map((stream) => stream.ngoId)).size,
    });
  });

  /**
   * Helper to escape a value for CSV with RFC 4180 rules and formula injection protection.
   */
  function escapeCsvField(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    let str = String(value);
    // Formula-safe: if string starts with dangerous characters, prefix with single quote
    if (/^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }
    // If field contains quotes, commas, or newlines, wrap in quotes and escape internal quotes
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Exports all streams for a donor as a CSV file with formula-safe fields.
   * @route GET /v1/donors/:address/streams.csv
   * @param address Stellar public key
   * @auth Public
   * @returns 200 CSV stream; 400 invalid address; 404 `{ error: "not_found" }`.
   */
  app.get('/donors/:address/streams.csv', async (request, reply) => {
    const parsedParams = addressParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const donor = await prisma.donor.findUnique({
      where: { address: parsedParams.data.address },
    });

    if (!donor) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const streams = await prisma.stream.findMany({
      where: { donorId: donor.id },
      orderBy: { createdAt: 'desc' },
      include: {
        ngo: { select: { id: true, name: true, displayName: true, ownerAddress: true } },
      },
    });

    const headers = [
      'id',
      'onChainId',
      'ngoId',
      'ngoName',
      'ngoAddress',
      'tokenAddress',
      'rate',
      'lastRate',
      'balance',
      'withdrawn',
      'status',
      'createdTxHash',
      'createdAt',
      'updatedAt',
    ];

    const rows = streams.map((stream) => {
      const ngoName = stream.ngo.displayName || stream.ngo.name || '';
      return [
        stream.id,
        stream.onChainId.toString(),
        stream.ngoId,
        ngoName,
        stream.ngo.ownerAddress,
        stream.tokenAddress,
        stream.rate,
        stream.lastRate ?? '',
        stream.balance,
        stream.withdrawn,
        stream.status,
        stream.createdTxHash ?? '',
        stream.createdAt.toISOString(),
        stream.updatedAt.toISOString(),
      ];
    });

    const csvContent = [
      headers.map(escapeCsvField).join(','),
      ...rows.map((row) => row.map(escapeCsvField).join(',')),
    ].join('\r\n');

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="donor-${parsedParams.data.address}-streams.csv"`,
    );

    return reply.send(csvContent ? `${csvContent}\r\n` : '');
  });
}
