          withTimeout(getLatestLedgerSequence(), HEALTH_CHECK_TIMEOUT_MS),
          getCheckpoint(),
        ]);

        if (checkpointLedger === undefined) {
          return reply.code(503).send({ status: 'error', reason: 'indexer_not_started' });
        }

        const lag = latestLedger - checkpointLedger;
        const parsedThreshold = parseInt(process.env.INDEXER_LAG_THRESHOLD ?? '100', 10);
        const threshold = Number.isNaN(parsedThreshold) ? 0 : parsedThreshold;

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
  app.register(deadLetterRoutes, apiPrefix);
  registerLogRetention(app);

  return app;
}