import type { FastifyInstance } from 'fastify';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { prisma } from '../db.js';
import { sendPublicCacheable } from './cacheable.js';
import { getPublicNgoName } from './ngoName.js';

// Keep all the existing schemas, serializers, and helper functions here:
// querySchema, querystringDocs, idParamSchema, onChainIdParamSchema,
// activityQuerySchema, streamInclude, serializeStream, serializeStreamEvent.

// Keep the complete streamRoutes function from the main branch,
// including these three routes:
//
// 1. GET /streams
// 2. GET /streams/chain/:onChainId
// 3. GET /streams/:id
//
// Then retain the existing activity route from feat/openapi-security-scheme:

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
   * Lists distinct token addresses seen across streams, with a stream count for each.
   * @route GET /v1/tokens
   * @auth Public
   * @returns 200 `{ tokens: { tokenAddress: string, streamCount: number }[] }`, sorted by stream count descending then address ascending.
   */
  app.get(
    '/tokens',
    {
      schema: {
        tags: ['Streams'],
        summary: 'List tokens used by streams',
        description:
          'Returns distinct token addresses across all streams with the number of streams per token.',
        response: {
          200: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const grouped = await prisma.stream.groupBy({
        by: ['tokenAddress'],
        _count: { _all: true },
        orderBy: [{ _count: { tokenAddress: 'desc' } }, { tokenAddress: 'asc' }],
      });

      return sendPublicCacheable(request, reply, {
        tokens: grouped.map((row) => ({
          tokenAddress: row.tokenAddress,
          streamCount: row._count._all,
        })),
      });
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
   * @returns 200 paginated events; 400 for invalid params/query or unknown cursor; 404 if the stream is not found.
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
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 100,
            },
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
        return reply.code(400).send({
          error: 'invalid_request',
          details: parsedQuery.error.flatten(),
        });
      }

      const { limit, cursor } = parsedQuery.data;

      const stream = await prisma.stream.findUnique({
        where: { id: parsedParams.data.id },
        select: { onChainId: true },
      });

      if (!stream) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Reject unknown cursors instead of silently returning an empty page.
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