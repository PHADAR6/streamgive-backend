
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
        return reply
          .code(400)
          .send({
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
