import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyServerOptions } from 'fastify';

// Fastify includes request.id in the child logger bound to every request.
// Honour a caller-supplied id so logs can be correlated across services,
// and use an unpredictable id when the request starts here.
export const requestIdOptions = {
  requestIdHeader: 'x-request-id',
  genReqId: () => randomUUID(),
} satisfies Pick<FastifyServerOptions, 'requestIdHeader' | 'genReqId'>;

// Keep caller-provided ids small and log-safe. Restricting characters also
// prevents control-character injection in response headers and log records.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

function safeRequestId(id: string): string {
  return VALID_REQUEST_ID.test(id) ? id : randomUUID();
}

export function registerRequestIdHeader(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    request.id = safeRequestId(request.id);
    reply.header('x-request-id', request.id);
  });
}
