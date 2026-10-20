import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';

import { prisma } from './db.js';
import { recordHttpRequest, renderMetrics } from './metrics.js';
import { getCheckpoint } from './indexer/checkpoint.js';
import { requireAdminSignature } from './middleware/adminAuth.js';
import { donorRoutes } from './routes/donors.js';
import { impactRoutes } from './routes/impact.js';
import { indexerStatusRoutes } from './routes/indexerStatus.js';
import { getLatestLedgerSequence } from './stellar/rpc.js';
import { ngoApplicationRoutes } from './routes/ngoApplications.js';
import { ngoRoutes } from './routes/ngos.js';
import { streamRoutes } from './routes/streams.js';
import { registerRequestIdHeader, requestIdOptions } from './requestId.js';
import { registerCompression } from './plugins/compression.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// pino-pretty runs its formatting on a separate worker thread; spawning
// one per Fastify instance is fine for a single long-running process, but
// the test suite calls buildServer() dozens of times, so it's skipped for
// NODE_ENV=test (which Vitest sets by default) as well as production.
const USE_PRETTY_LOGS = !['production', 'test'].includes(process.env.NODE_ENV ?? '');

export type TrustProxySetting =
  boolean | string | string[] | ((address: string, hop: number) => boolean);

/**
 * Parses the TRUST_PROXY environment variable into a valid Fastify trustProxy configuration.
 *
 * Behind a reverse proxy (such as Render's load balancer or Cloudflare), Fastify's
 * socket.remoteAddress is the proxy's IP. Without trustProxy enabled, @fastify/rate-limit
 * keys all clients to that single proxy IP, throttling all users collectively.
 *
 * Supported values:
 * - undefined or empty: defaults to `true` (enabling proxy trust by default behind Render)
 * - 'true': trusts all proxies, reading client IP from the first entry of X-Forwarded-For
 * - 'false': disables proxy trust, using socket remoteAddress
 * - integer string (e.g. '1', '2'): bounded hop count function trusting the specified number of proxy hops
 * - comma-separated list or single string: IP or CIDR ranges to trust
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  if (value === undefined || value.trim() === '') {
    return true;
  }
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  const num = Number(trimmed);
  if (!Number.isNaN(num) && Number.isInteger(num)) {
    if (num <= 0) {
      return false;
    }
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
      // Structured JSON otherwise (production: for log aggregation; test:
      // to avoid the worker-thread overhead above) — pino-pretty is a
      // devDependency on purpose, since the production image never needs it.
      transport: USE_PRETTY_LOGS ? { target: 'pino-pretty' } : undefined,
    },
    // Behind a reverse proxy (e.g. Render's load balancer, Cloudflare), Fastify's
    // underlying socket remoteAddress is the proxy's IP. Without trustProxy enabled,
    // @fastify/rate-limit keys all requests to that shared proxy IP, throttling all
    // users collectively if one client is busy. Enabling trustProxy (or a bounded hop
    // count) ensures request.ip is read from X-Forwarded-For, properly isolating rate
    // limiting per client IP.
    trustProxy: trustProxySetting,
  });

  registerRequestIdHeader(app);
  app.register(registerCompression);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const candidateStatusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
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

  // Register helmet for security headers
  app.register(helmet, {
    contentSecurityPolicy: false, // Disabled for API-only server
    global: true,
  });

  // The browser app runs on a different origin to this API (a different
  // port in development, a different host in deployment), so every call
  // from it is cross-origin and fails as an opaque "Failed to fetch"
  // without these headers.
  //
  // Allowed origins are an explicit list, not a wildcard: the admin routes
  // authenticate with a signature the browser sends as a header, so any
  // origin allowed here can ask a signed-in admin's browser to call them.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
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
    exposedHeaders: ['x-request-id'],
  });

  app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    // Spell the headers out instead of leaning on the plugin's defaults:
    // `Retry-After` is the machine-readable contract clients back off on
    // (RFC 9110 §10.2.3), and the `x-ratelimit-*` headers let a client see
    // its remaining budget before it is throttled.
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    if (startedAt === undefined) return;
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    recordHttpRequest(
      request.method,
      request.routeOptions.url ?? 'unmatched',
      reply.statusCode,
      durationSeconds,
    );
  });

  /**
   * Exposes process-local Prometheus metrics.
   * @route GET /metrics
   * @auth Public
   * @returns 200 Prometheus text format (`text/plain; version=0.0.4`).
   */
  app.get(
    '/metrics',
    {
      schema: {
        tags: ['Metrics'],
        summary: 'Exposes process-local Prometheus metrics',
      },
    },
    async (_request, reply) => {
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics());
    },
  );

  app.register(swagger, {
    openapi: {
      info: {
        title: 'StreamGive API',
        description: 'API for the StreamGive platform',
        version: packageJson.version,
      },
      tags: [
        { name: 'Health', description: 'Service health checks' },
        { name: 'NGOs', description: 'NGO directory and profiles' },
        { name: 'Donors', description: 'Donor statistics and rankings' },
        { name: 'Streams', description: 'Donation streams and activity' },
        { name: 'Impact', description: 'Platform-wide and NGO impact metrics' },
        { name: 'NGO Applications', description: 'NGO verification applications and review' },
        { name: 'Indexer', description: 'Stellar indexer status and checkpoint info' },
        { name: 'Metrics', description: 'Prometheus metrics' },
      ],
      components: {
        securitySchemes: {
          adminAddress: {
            type: 'apiKey',
            name: 'x-admin-address',
            in: 'header',
            description: 'Admin Stellar public key (G...)',
          },
          adminSignature: {
            type: 'apiKey',
            name: 'x-admin-signature',
            in: 'header',
            description: 'Ed25519 signature of ${method}:${url}:${timestamp}',
          },
          adminTimestamp: {
            type: 'apiKey',
            name: 'x-admin-timestamp',
            in: 'header',
            description: 'Request timestamp (UNIX epoch milliseconds)',
          },
        },
      },
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: false },
    });
  }

  /**
   * Checks database and Stellar RPC availability.
   * @route GET /health
   * @auth Public
   * @returns 200 or 503 `{ status: "ok" | "error", db: "ok" | "error", rpc: "ok" | "error" }`.
   */
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Checks database and Stellar RPC availability',
      },
    },
    async (_req, reply) => {
      const [dbResult, rpcResult] = await Promise.allSettled([
        prisma.$queryRaw`SELECT 1`,
        getLatestLedgerSequence(),
      ]);

      const db = dbResult.status === 'fulfilled' ? 'ok' : 'error';
      const rpc = rpcResult.status === 'fulfilled' ? 'ok' : 'error';

      const status = db === 'ok' && rpc === 'ok' ? 'ok' : 'error';
      return reply.code(status === 'ok' ? 200 : 503).send({ status, db, rpc });
    },
  );

  /**
   * Checks readiness, including database availability and indexer lag.
   * @route GET /health/ready
   * @auth Public
   * @returns 200 `{ status: "ok", lag, latestLedger, checkpointLedger }`; 503 `{ status: "error", reason, ... }` when unavailable or not caught up.
   */
  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Health'],
        summary: 'Checks readiness, including database availability and indexer lag',
      },
    },
    async (request, reply) => {
      try {
        // 1. Check DB
        await prisma.$queryRaw`SELECT 1`;

        // 2. Get RPC and Indexer info
        const [latestLedger, checkpointLedger] = await Promise.all([
          getLatestLedgerSequence(),
          getCheckpoint(),
        ]);

        if (checkpointLedger === undefined) {
          return reply.code(503).send({ status: 'error', reason: 'indexer_not_started' });
        }

        const lag = latestLedger - checkpointLedger;
        const threshold = parseInt(process.env.INDEXER_LAG_THRESHOLD ?? '100', 10);

        if (lag > threshold) {
          return reply
            .code(503)
            .send({ status: 'error', reason: 'indexer_lagging', lag, threshold });
        }

        return { status: 'ok', lag, latestLedger, checkpointLedger };
      } catch (error) {
        request.log.error(error);
        return reply.code(503).send({ status: 'error', reason: 'service_unavailable' });
      }
    },
  );

  app.addHook('onRoute', (route) => {
    const schemas: Record<string, object> = {
      '/v1/ngos': {
        tags: ['NGOs'],
        summary: 'List verified NGOs',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            cursor: { type: 'string', format: 'uuid' },
            sort: { type: 'string', enum: ['newest', 'oldest', 'name'], default: 'newest' },
            q: { type: 'string', maxLength: 100 },
          },
        },
      },
      '/v1/ngos/lookup': {
        tags: ['NGOs'],
        summary: 'Find an NGO by Stellar address',
        querystring: {
          type: 'object',
          properties: { address: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          required: ['address'],
        },
      },
      '/v1/ngos/:id/donors': {
        tags: ['NGOs'],
        summary: 'List donors for an NGO',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', format: 'uuid' },
          },
        },
      },
      '/v1/ngos/:id': {
        tags: ['NGOs'],
        summary: 'Get an NGO profile and impact totals',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    };
    const schema = schemas[route.url];
    if (schema) route.schema = { ...route.schema, ...schema };

    const hasAdminAuth =
      route.preHandler === requireAdminSignature ||
      (Array.isArray(route.preHandler) && route.preHandler.includes(requireAdminSignature));

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
      (Array.isArray(route.schema.tags) && route.schema.tags.length === 0)
    ) {
      let tag: string | undefined;
      if (route.url.startsWith('/v1/ngos')) tag = 'NGOs';
      else if (route.url.startsWith('/v1/donors')) tag = 'Donors';
      else if (route.url.startsWith('/v1/streams')) tag = 'Streams';
      else if (route.url.startsWith('/v1/impact')) tag = 'Impact';
      else if (route.url.startsWith('/v1/ngo-applications')) tag = 'NGO Applications';
      else if (route.url.startsWith('/v1/indexer')) tag = 'Indexer';
      else if (route.url.startsWith('/health')) tag = 'Health';
      else if (route.url === '/metrics') tag = 'Metrics';

      if (tag) {
        route.schema = { ...route.schema, tags: [tag] };
      }
    }
  });

  const apiPrefix = { prefix: '/v1' };
  app.register(ngoRoutes, apiPrefix);
  app.register(donorRoutes, apiPrefix);
  app.register(streamRoutes, apiPrefix);
  app.register(impactRoutes, apiPrefix);
  app.register(ngoApplicationRoutes, apiPrefix);
  app.register(indexerStatusRoutes, apiPrefix);

  return app;
}
