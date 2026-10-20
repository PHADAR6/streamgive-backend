import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';
import { getPublicNgoName } from './ngoName.js';
import { committedTotalsByToken } from './tokenTotals.js';

/** Params for NGO detail, donor, and admin update routes; `id` must be an NGO UUID. */
const idParamSchema = z.object({ id: z.string().uuid() });
const RECENT_STREAMS_LIMIT = 10;

interface NgoListRow {
  id: string;
  ownerAddress: string;
  name: string;
  displayName: string | null;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Admin update body; optional `displayName` is a string, null to clear, or omitted to preserve. */
const updateNgoSchema = z.object({
  displayName: z.string().nullable().optional(),
});

/** Public directory sort mode: newest, oldest, or name (default newest). */
const sortSchema = z.enum(['newest', 'oldest', 'name']).default('newest');

/**
 * Public directory query: `limit` from 1–100 (default 100), optional NGO
 * UUID `cursor`, `sort` mode, and optional case-insensitive `q` up to
 * 100 characters.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  sort: sortSchema,
  // Name search: case-insensitive substring match, capped to prevent abuse.
  q: z.string().max(100).optional(),
});

/** Donor-list query: `limit` from 1–100 (default 100) and optional donor UUID `cursor`. */
const donorListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
});

function committedAmount(stream: {
  status: 'ACTIVE' | 'CANCELLED';
  balance: string;
  withdrawn: string;
}): bigint {
  return stream.status === 'CANCELLED'
    ? BigInt(stream.withdrawn)
    : BigInt(stream.balance) + BigInt(stream.withdrawn);
}

/** Lookup query; `address` must be a Stellar G... public key. */
const lookupQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  address: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/),
});

/**
 * Admin directory query: `limit` from 1–100 (default 100), optional NGO UUID
 * `cursor`, and optional `verified` string (`true` or `false`).
 */
const adminListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().uuid().optional(),
  // Optional boolean filter as a query string (so 'true'/'false' arrive as
  // strings); omitted means "everything, verified or not".
  verified: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/** Builds the GET /ngos/:id response shape from a unique Prisma `where`. */
async function findNgoDetail(where: { id: string } | { ownerAddress: string }) {
  const ngo = await prisma.ngo.findUnique({ where });

  if (!ngo) {
    return null;
  }

  const [approvedApp, streamStats, recentStreamRows, streamsForTokenTotals] = await Promise.all([
    prisma.ngoApplication.findFirst({
      where: { ownerAddress: ngo.ownerAddress, status: 'APPROVED' },
      orderBy: { updatedAt: 'desc' },
      select: { description: true, website: true, country: true },
    }),
    prisma.$queryRaw<
      Array<{
        totalCommitted: string;
        totalWithdrawn: string;
        activeStreamCount: number;
        donorCount: number;
      }>
    >`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN "status" = 'CANCELLED' THEN "withdrawn"::numeric
            ELSE "balance"::numeric + "withdrawn"::numeric
          END
        ), 0)::text AS "totalCommitted",
        COALESCE(SUM("withdrawn"::numeric), 0)::text AS "totalWithdrawn",
        COUNT(*) FILTER (WHERE "status" = 'ACTIVE')::int AS "activeStreamCount",
        COUNT(DISTINCT "donor_id")::int AS "donorCount"
      FROM "streams"
      WHERE "ngo_id" = ${ngo.id}
    `,
    prisma.stream.findMany({
      where: { ngoId: ngo.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECENT_STREAMS_LIMIT + 1,
      select: {
        id: true,
        onChainId: true,
        donor: { select: { address: true } },
        tokenAddress: true,
        rate: true,
        balance: true,
        withdrawn: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.stream.findMany({
      where: { ngoId: ngo.id },
      select: { status: true, balance: true, withdrawn: true, tokenAddress: true },
    }),
  ]);

  const [stats] = streamStats;
  const hasMoreRecentStreams = recentStreamRows.length > RECENT_STREAMS_LIMIT;
  const recentStreams = recentStreamRows.slice(0, RECENT_STREAMS_LIMIT);

  return {
    ...ngo,
    name: getPublicNgoName(ngo) || null,
    registered: ngo.name !== '',
    description: approvedApp?.description ?? null,
    website: approvedApp?.website ?? null,
    country: approvedApp?.country ?? null,
    stats: {
      totalCommitted: stats.totalCommitted,
      committedByToken: committedTotalsByToken(streamsForTokenTotals),
      totalWithdrawn: stats.totalWithdrawn,
      activeStreamCount: stats.activeStreamCount,
      donorCount: stats.donorCount,
    },
    recentStreams: recentStreams.map(({ onChainId, ...stream }) => ({
      ...stream,
      onChainId: onChainId.toString(),
    })),
    recentStreamsNextCursor: hasMoreRecentStreams ? recentStreams.at(-1)?.id ?? null : null,
  };
}

export async function ngoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists verified NGOs with search, sorting, and cursor pagination.
   * @route GET /v1/ngos
   * @query limit, cursor, sort, q
   * @auth Public
   * @returns 200 `{ ngos: NgoSummary[], nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get('/ngos', async (request, reply) => {
    const parsedQuery = listQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    const { limit, cursor, sort, q } = parsedQuery.data;

    const rows = await prisma.$queryRaw<NgoListRow[]>`
      WITH cursor_ngo AS (
        SELECT id, COALESCE(NULLIF(display_name, ''), name) AS public_name, created_at
        FROM ngos
        WHERE id = ${cursor ?? null}::uuid
      )
      SELECT
        ngo.id,
        ngo.owner_address AS "ownerAddress",
        ngo.name,
        ngo.display_name AS "displayName",
        ngo.verified,
        ngo.created_at AS "createdAt",
        ngo.updated_at AS "updatedAt"
      FROM ngos AS ngo
      WHERE ngo.verified = TRUE
        AND (
          ${q ?? null}::text IS NULL
          OR COALESCE(NULLIF(ngo.display_name, ''), ngo.name) ILIKE '%' || ${q ?? null} || '%'
        )
        AND (
          ${cursor ?? null}::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM cursor_ngo AS cursor_row
            WHERE
              (${sort} = 'name' AND (COALESCE(NULLIF(ngo.display_name, ''), ngo.name), ngo.id) > (cursor_row.public_name, cursor_row.id))
              OR (${sort} = 'oldest' AND (ngo.created_at, ngo.id) > (cursor_row.created_at, cursor_row.id))
              OR (${sort} = 'newest' AND (
                ngo.created_at < cursor_row.created_at
                OR (ngo.created_at = cursor_row.created_at AND ngo.id > cursor_row.id)
              ))
          )
        )
      ORDER BY
        CASE WHEN ${sort} = 'name' THEN COALESCE(NULLIF(ngo.display_name, ''), ngo.name) END ASC,
        CASE WHEN ${sort} = 'oldest' THEN ngo.created_at END ASC,
        CASE WHEN ${sort} = 'newest' THEN ngo.created_at END DESC,
        ngo.id ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const ngos = (hasMore ? rows.slice(0, limit) : rows).map((ngo) => ({
      ...ngo,
      name: getPublicNgoName(ngo),
    }));
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return sendPublicCacheable(request, reply, { ngos, nextCursor });
  });

  // Admin counterpart to GET /ngos above: also returns the unverified rows
  // the indexer creates (a `register` event, or a stream to an address that
  // never registered) — exactly what an admin needs to spot streams pointed
  // at NGOs that aren't in the public directory. Optionally narrowed with
  // ?verified=true|false.
  /**
   * Lists all NGOs, including unverified entries, for admin review.
   * @route GET /v1/ngos/all
   * @query limit, cursor, verified
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ ngos: Ngo[], nextCursor: string | null }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get(
    '/ngos/all',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['NGOs'],
        summary: 'Lists all NGOs, including unverified entries, for admin review',
        security: [{ adminAddress: [], adminSignature: [], adminTimestamp: [] }],
      },
    },
    async (request, reply) => {
    const parsedQuery = adminListQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }
    const { limit, cursor, verified } = parsedQuery.data;

    const rows = await prisma.ngo.findMany({
      where: verified === undefined ? {} : { verified },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasMore = rows.length > limit;
    const ngos = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? ngos[ngos.length - 1].id : null;

    return { ngos, nextCursor };
  });

  /**
   * Finds a public NGO profile by Stellar owner address.
   * @route GET /v1/ngos/lookup
   * @query address Stellar public key
   * @auth Public
   * @returns 200 NGO detail with approved application information, totals, and recent streams; 400 invalid address; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/lookup', async (request, reply) => {
    const parsedQuery = lookupQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
    }

    const ngo = await findNgoDetail({ ownerAddress: parsedQuery.data.address });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return sendPublicCacheable(request, reply, ngo);
  });

  /**
   * Lists donors who have streams for the specified NGO.
   * @route GET /v1/ngos/:id/donors
   * @param id NGO UUID
   * @query limit, cursor
   * @auth Public
   * @returns 200 `{ donors: { id, address, totalCommitted }[], nextCursor: string | null }`; 400 invalid params/query; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/:id/donors', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    const parsedQuery = donorListQuerySchema.safeParse(request.query);
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const { id: ngoId } = parsedParams.data;
    const { limit, cursor } = parsedQuery.data;
    const ngo = await prisma.ngo.findUnique({ where: { id: ngoId }, select: { id: true } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const rows = await prisma.donor.findMany({
      where: { streams: { some: { ngoId } } },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        address: true,
        streams: {
          where: { ngoId },
          select: { status: true, balance: true, withdrawn: true, tokenAddress: true },
        },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const donors = page.map(({ streams, ...donor }) => ({
      ...donor,
      totalCommitted: streams
        .reduce((sum, stream) => sum + committedAmount(stream), 0n)
        .toString(),
      committedByToken: committedTotalsByToken(streams),
    }));

    return sendPublicCacheable(request, reply, {
      donors,
      nextCursor: hasMore ? donors[donors.length - 1].id : null,
    });
  });

  /**
   * Returns a public NGO profile with approved application details and impact statistics.
   * @route GET /v1/ngos/:id
   * @param id NGO UUID
   * @auth Public
   * @returns 200 NGO detail with totals and recent streams; 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  app.get('/ngos/:id', async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const ngo = await findNgoDetail({ id: parsedParams.data.id });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return sendPublicCacheable(request, reply, ngo);
  });

  /**
   * Updates or clears the NGO's public display name.
   * @route PATCH /v1/admin/ngos/:id
   * @param id NGO UUID
   * @body `{ displayName?: string | null }`
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 updated NGO with its effective public `name`; 400 invalid params/body; 404 `{ error: "not_found" }`.
   */
  app.patch(
    '/admin/ngos/:id',
    {
      preHandler: requireAdminSignature,
      schema: {
        tags: ['NGOs'],
        summary: "Updates or clears the NGO's public display name",
        security: [{ adminAddress: [], adminSignature: [], adminTimestamp: [] }],
      },
    },
    async (request, reply) => {
    const parsedParams = idParamSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const parsedBody = updateNgoSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsedBody.error.flatten() });
    }

    const ngo = await prisma.ngo.findUnique({ where: { id: parsedParams.data.id } });
    if (!ngo) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const updated = await prisma.ngo.update({
      where: { id: ngo.id },
      data: { displayName: parsedBody.data.displayName },
    });

    return { ...updated, name: updated.displayName || updated.name };
  });
}
