import type { FastifyInstance } from 'fastify';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { getPublicNgoName } from './ngoName.js';

/**
 * Query for GET /v1/streams: optional Stellar `donor` and `ngoAddress`,
 * NGO UUID `ngo`, contract-address `token`, `ACTIVE`/`CANCELLED` status,
 * `limit` from 1–100 (default 100), and an optional stream UUID `cursor`.
 */
const querySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  donor: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/)
    .optional(),
  ngo: z.string().uuid().optional(),
  // Filter by the NGO's Stellar wallet address instead of its internal UUIT.
  ngoAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/)
    .optional(),
  token: z
    .string()
    .refine((value) => StrKey.isValidContract(value), {
      message: 'Invalid Stellar contract address',
    })
    .optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  // A stream id from a previous page's last item; results start right after it.
  cursor: z.string().uuid().optional(),
});

/**
 * OpenAPI description of the `/streams` query, generated from `querySchema` so
 * the documented parameters cannot drift from what is actually validated.
 * `$schema` is dropped because it is not valid inside an OpenAPI parameter.
 */
const querystringDocs = z.toJSONSchema(querySchema, {
  io: 'input',
  unrepresentable: 'any',
}) as Record<string, unknown>;
delete querystringDocs.$schema;

/** Params for stream detail and activity routes; `id` must be a stream UUID. */
const idParamSchema = z.object({ id: z.string().uuid() });

/** PostgreSQL BigInt is signed 64-bit; on-chain IDs are non-negative integers. */
const onChainIdParamSchema = z.object({
  onChainId: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n)
    .transform((value) => BigInt(value)),
});

/**
 * Query for GET /v1/streams/:id/activity: `limit` from 1–100 (default 100)
 * and an optional event UUID `cursor`.
 */
const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  // An event id from a previous page's last item; results start right after it.
  cursor: z.string().uuid().optional(),
});

const streamInclude = {
  donor: { select: { address: true } },
  ngo: { select: { id: true, name: true, displayName: true, ownerAddress: true } },
} as const;

// onChainId is a BigInt; Fastify's default JSON.stringify serializer (no
// response schema is defined yet) throws on BigInt, so it has to go out as
// a string.
export function serializeStream<
  T extends { onChainId: bigint; ngo: { name: string; displayName?: string | null } },
>(stream: T) {
  const { onChainId, ngo, ...rest } = stream;
  return {
    ...rest,
    onChainId: onChainId.toString(),
    ngo: { ...ngo, name: getPublicNgoName(ngo) || null, registered: ngo.name !== '' },
  };
}

// streamId is a BigInt and must be stringified the same way as onChainId.
function serializeStreamEvent<T extends { streamId: bigint | null }>(event: T) {
  const { streamId, ...rest } = event;
  return {
    ...rest,
    streamId: streamId === null ? null : streamId.toString(),
  };
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Lists streams newest first with optional donor, NGO, token, and status filters.
   * @route GET /v1/streams
   * @query donor, ngo, ngoAddress, token, status, limit, cursor
   * @auth Public
   * @returns 200 `{ streams: Stream[], hasMore: boolean, nextCursor: string | null }`; 400 `{ error: "invalid_request", details }` for any invalid query parameter.
   */
  app.get(
    '/streams',
    {
      // `querySchema` is the only validator for this query. Fastify would
      // otherwise also validate `schema.querystring` with Ajv and reject some
      // requests first with a body that has no `details`, so Fastify's own
      // validation is turned off here and `schema.querystring` below is documentation only.
      validatorCompiler: () => (data) => ({ value: data }),
      schema: {
        tags: ['Streams'],
        summary: 'List donation streams',
        description: 'Returns streams newest first, with optional filters and cursor pagination.',
        querystring: querystringDocs,
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
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
      // `donor` filters by wallet address (donors have no public directory of
      // their own); `ngo` filters by the NGO's internal id, matching what
      // GET /ngos and /ngos/:id expose; `ngoAddress` filters by the NGO's
      // Stellar wallet address for clients that only have the on-chain key.
      const { donor, ngo, ngoAddress, token, status, limit, cursor } = parsedQuery.data;

      const rows = await prisma.stream.findMany({
        where: {
          ...(donor ? { donor: { address: donor } } : {}),
          ...(ngo ? { ngoId: ngo } : {}),
          ...(ngoAddress ? { ngo: { ownerAddress: ngoAddress } } : {}),
          ...(token ? { tokenAddress: token } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: streamInclude,
      });

      const hasMore = rows.length > limit;
      const streams = hasMore ? rows.slice(0, limit) : rows;

      return sendPublicCacheable(request, reply, {
        streams: streams.map(serializeStream),
        hasMore,
        nextCursor: hasMore ? (streams.at(-1)?.id ?? null) : null,
      });
    },
  );

  /**
   * Returns a stream by its on-chain ID.
   * @route GET /v1/streams/chain/:onChainId
   * @param onChainId Non-negative decimal on-chain stream ID
   * @auth Public
   * @returns 200 serialized stream (including string `onChainId`); 400 invalid ID; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/streams/chain/:onChainId',
    {
      schema: {
        tags: ['Streams'],
        summary: 'Get a donation stream by on-chain ID',
        params: {
          type: 'object',
          properties: { onChainId: { type: 'string', pattern: '^\\d+$' } },
          required: ['onChainId'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = onChainIdParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const stream = await prisma.stream.findUnique({
        where: { onChainId: parsedParams.data.onChainId },
        include: streamInclude,
      });

      if (!stream) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return sendPublicCacheable(request, reply, serializeStream(stream));
    },
  );

  /**
   * Returns a stream by its UUID.
   * @route GET /v1/streams/:id
   * @param id Stream UUID
   * @auth Public
   * @returns 200 serialized stream (including string `onChainId`); 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/streams/:id',
    {
      schema: {
        tags: ['Streams'],
        summary: 'Get a donation stream',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const stream = await prisma.stream.findUnique({
        where: { id: parsedParams.data.id },
        include: streamInclude,
      });

      if (!stream) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return sendPublicCacheable(request, reply, serializeStream(stream));
    },
  );

  /**
   * Lists on-chain events for a stream, newest first.
   * @route GET /v1/streams/:id/activity
   * @param id Stream UUID
   * @query limit, cursor
   * @auth Public
   * @returns 200 `{ events: StreamEvent[], hasMore: boolean, nextCursor: string | null }` with `streamId` serialized as a string or null; 400 invalid params/query or unknown cursor; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/streams/:id/activity',
    {
      schema: {
        tags: ['Streams'],
        summary: 'List activity events for a stream',
        description:
          'Returns on-chain events for the given stream, newest first, with cursor pagination.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const parsedQuery = activityQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsedQuery.error.flatten() });
      }

      const { limit, cursor } = parsedQuery.data;

      const stream = await prisma.stream.findUnique({
        where: { id: parsedParams.data.id },
        select: { onChainId: true },
      });

      if (!stream) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Validate the cursor before using it: an unknown cursor would silently
      // produce an empty page, which is indistinguishable from a real empty
      // last page and makes bugs very hard to diagnose. Treating it as a 400
      // is consistent with how GET /donors handles an unknown cursor.
      if (cursor) {
        const cursorEvent = await prisma.streamEvent.findUnique({
          where: { id: cursor },
          select: { id: true },
        });
        if (!cursorEvent) {
          return reply.code(400).send({ error: 'invalid_request' });
        }
      }

      const rows = await prisma.streamEvent.findMany({
        where: { streamId: stream.onChainId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;

      return sendPublicCacheable(request, reply, {
        events: events.map(serializeStreamEvent),
        hasMore,
        nextCursor: hasMore ? (events.at(-1)?.id ?? null) : null,
      });
    },
  );
}
