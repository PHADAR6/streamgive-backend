import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyError, FastifyReply } from 'fastify';

import { prisma } from './db.js';
import { recordHttpRequest, renderMetrics } from './metrics.js';
import { getCheckpoint } from './indexer/checkpoint.js';
import { donorRoutes } from './routes/donors.js';
import { impactRoutes } from './routes/impact.js';
import { indexerStatusRoutes } from './routes/indexerStatus.js';
import { getLatestLedgerSequence } from './stellar/rpc.js';
import { ngoApplicationRoutes } from './routes/ngoApplications.js';
import { ngoRoutes } from './routes/ngos.js';
import { deadLetterRoutes } from './routes/deadLetters.js';
import { streamRoutes } from './routes/streams.js';
import { registerRequestIdHeader, requestIdOptions } from './requestId.js';
import { registerCompression } from './plugins/compression.js';
import { registerLogRetention } from './maintenance/logRetention.js';

// Retain the project's existing imports/definitions for:
// - withTimeout
// - HEALTH_CHECK_TIMEOUT_MS
// - requireAdminSignature

const USE_PRETTY_LOGS = !['production', 'test'].includes(
  process.env.NODE_ENV ?? '',
);

function hasValidBearerToken(
  header: string | undefined,
  expectedToken: string,
): boolean {
  if (header === undefined) return false;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;

  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);

  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

export type TrustProxySetting =
  | boolean
  | string
  | string[]
  | ((address: string, hop: number) => boolean);

export function parseTrustProxy(
  value: string | undefined,
): TrustProxySetting {
  if (value === undefined || value.trim() === '') return true;

  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'true') return true;
  if (lower === 'false') return false;

  const num = Number(trimmed);

  if (!Number.isNaN(num) && Number.isInteger(num)) {
    if (num <= 0) return false;
    return (_address: string, hop: number) => hop < num;
  }

  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return trimmed;
}

export interface BuildServerOptions {
  trustProxy?: TrustProxySetting;
}

export function buildServer(options?: BuildServerOptions) {
  const requestStartedAt = new WeakMap<object, bigint>();

  const trustProxySetting =
    options?.trustProxy !== undefined
      ? options.trustProxy
      : parseTrustProxy(process.env.TRUST_PROXY);

  const app = Fastify({
    ...requestIdOptions,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: USE_PRETTY_LOGS
        ? { target: 'pino-pretty' }
        : undefined,
    },
    trustProxy: trustProxySetting,
  });

  registerRequestIdHeader(app);
  app.register(registerCompression);

  app.addHook('preParsing', async (request, _reply, payload) => {
    const bodylessMethods = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

    if (bodylessMethods.has(request.method)) {
      (request as typeof request & { rawBody: Buffer }).rawBody =
        Buffer.alloc(0);
      return payload;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of payload) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
      );
    }

    const raw = Buffer.concat(chunks);
    (request as typeof request & { rawBody: Buffer }).rawBody = raw;

    const { Readable } = await import('node:stream');
    return Readable.from(raw);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);

    const candidateStatusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error
        ? error.statusCode
        : undefined;

    const statusCode =
      typeof candidateStatusCode === 'number' &&
      candidateStatusCode >= 400 &&
      candidateStatusCode < 600
        ? candidateStatusCode
        : 500;

    const errorString =
      statusCode === 404
        ? 'not_found'
        : statusCode === 400
          ? 'invalid_request'
          : statusCode === 413
            ? 'payload_too_large'
            : statusCode === 415
              ? 'unsupported_media_type'
              : statusCode === 429
                ? 'rate_limited'
                : 'internal_server_error';

    reply.code(statusCode).send({ error: errorString });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: 'not_found' });
  });

  app.register(helmet, {
    contentSecurityPolicy: false,
    global: true,
  });

  const allowedOrigins = (
    process.env.CORS_ORIGINS ?? 'http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'x-admin-address',
      'x-admin-signature',
      'x-admin-timestamp',
      'x-request-id',
    ],
    exposedHeaders: [
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
  });

  app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  const rootRateLimitedRoutes = new Set([
    '/metrics',
    '/health',
    '/health/ready',
  ]);

  app.addHook('onRequest', async (request, reply) => {
    if (rootRateLimitedRoutes.has(request.routeOptions.url ?? '')) {
      await request.server.rateLimit
        .call(request.server)
        .call(request.server, request, reply);
    }
  });

  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    if (startedAt === undefined) return;

    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

    recordHttpRequest(
      request.method,
      request.routeOptions.url ?? 'unmatched',
      reply.statusCode,
      durationSeconds,
    );
  });

  // Metrics endpoint
  app.get(
    '/metrics',
    {
      onRequest: async (request, reply) => {
        const token = process.env.METRICS_TOKEN?.trim();

        if (
          token &&
          !hasValidBearerToken(request.headers.authorization, token)
        ) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
      },
      schema: {
        tags: ['Metrics'],
        summary: 'Expose Prometheus metrics',
      },
    },
    async (_request, reply) => {
      reply.header(
        'content-type',
        'text/plain; version=0.0.4; charset=utf-8',
      );
      return renderMetrics();
    },
  );

  // Liveness probe
  const healthHandler = async (_req: unknown, reply: FastifyReply) => {
    const dbResult = await Promise.allSettled([
      withTimeout(
        prisma.$queryRaw`SELECT 1`,
        HEALTH_CHECK_TIMEOUT_MS,
      ),
    ]);

    const db = dbResult[0].status === 'fulfilled' ? 'ok' : 'error';
    const status = db === 'ok' ? 'ok' : 'error';

    return reply
      .code(status === 'ok' ? 200 : 503)
      .send({ status, db });
  };

  app.get('/health', healthHandler);
  app.get('/v1/health', healthHandler);

  // Readiness probe
  app.get('/health/ready', async (request, reply) => {
    try {
      await withTimeout(
        prisma.$queryRaw`SELECT 1`,
        HEALTH_CHECK_TIMEOUT_MS,
      );

      const [latestLedger, checkpointLedger] = await Promise.all([
        withTimeout(
          getLatestLedgerSequence(),
          HEALTH_CHECK_TIMEOUT_MS,
        ),
        getCheckpoint(),
      ]);

      if (checkpointLedger === undefined) {
        return reply
          .code(503)
          .send({
            status: 'error',
            reason: 'indexer_not_started',
          });
      }

      const lag = latestLedger - checkpointLedger;
      const parsedThreshold = parseInt(
        process.env.INDEXER_LAG_THRESHOLD ?? '100',
        10,
      );
      const threshold = Number.isNaN(parsedThreshold)
        ? 0
        : parsedThreshold;

      if (lag > threshold) {
        return reply.code(503).send({
          status: 'error',
          reason: 'indexer_lagging',
          lag,
          threshold,
        });
      }

      return {
        status: 'ok',
        lag,
        latestLedger,
        checkpointLedger,
      };
    } catch (error) {
      request.log.error(error);

      return reply
        .code(503)
        .send({
          status: 'error',
          reason: 'service_unavailable',
        });
    }
  });

  // OpenAPI route metadata and security
  app.addHook('onRoute', (route) => {
    const schemas: Record<string, object> = {
      '/v1/ngos': {
        tags: ['NGOs'],
        summary: 'List verified NGOs',
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
            sort: {
              type: 'string',
              enum: ['newest', 'oldest', 'name'],
              default: 'newest',
            },
            q: { type: 'string', maxLength: 100 },
          },
        },
      },
      '/v1/ngos/lookup': {
        tags: ['NGOs'],
        summary: 'Find an NGO by Stellar address',
        querystring: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              pattern: '^G[A-Z2-7]{55}$',
            },
          },
          required: ['address'],
        },
      },
      '/v1/ngos/:id/donors': {
        tags: ['NGOs'],
        summary: 'List donors for an NGO',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
            },
            cursor: { type: 'string', format: 'uuid' },
          },
        },
      },
      '/v1/ngos/:id': {
        tags: ['NGOs'],
        summary: 'Get an NGO profile and impact totals',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
          required: ['id'],
        },
      },
    };

    const schema = schemas[route.url];
    if (schema) {
      route.schema = { ...route.schema, ...schema };
    }

    const hasAdminAuth =
      route.preHandler === requireAdminSignature ||
      (Array.isArray(route.preHandler) &&
        route.preHandler.includes(requireAdminSignature));

    if (hasAdminAuth && !route.schema?.security) {
      route.schema = {
        ...route.schema,
        security: [
          {
            adminAddress: [],
            adminSignature: [],
            adminTimestamp: [],
          },
        ],
      };
    }

    if (
      !route.schema?.tags ||
      (Array.isArray(route.schema.tags) &&
        route.schema.tags.length === 0)
    ) {
      let tag: string | undefined;

      if (route.url.startsWith('/v1/ngos')) tag = 'NGOs';
      else if (route.url.startsWith('/v1/donors')) tag = 'Donors';
      else if (route.url.startsWith('/v1/streams')) tag = 'Streams';
      else if (route.url.startsWith('/v1/impact')) tag = 'Impact';
      else if (route.url.startsWith('/v1/ngo-applications')) {
        tag = 'NGO Applications';
      } else if (route.url.startsWith('/v1/indexer')) {
        tag = 'Indexer';
      } else if (route.url.startsWith('/health')) {
        tag = 'Health';
      } else if (route.url === '/metrics') {
        tag = 'Metrics';
      }

      if (tag) {
        route.schema = {
          ...route.schema,
          tags: [tag],
        };
      }
    }
  });

  // Keep the existing Swagger/OpenAPI registration configuration here.
  // It was not included in the conflicted code you pasted.

  const apiPrefix = { prefix: '/v1' };

  app.register(ngoRoutes, apiPrefix);
  app.register(donorRoutes, apiPrefix);
  app.register(streamRoutes, apiPrefix);
  app.register(impactRoutes, apiPrefix);
  app.register(ngoApplicationRoutes, apiPrefix);
  app.register(indexerStatusRoutes, apiPrefix);
  app.register(deadLetterRoutes, apiPrefix);

  registerLogRetention(app);

  return app;
}