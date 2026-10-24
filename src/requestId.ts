import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyServerOptions } from 'fastify';

// Fastify includes request.id in the child logger bound to every request.
// Honour a caller-supplied id so logs can be correlated across services,
// and use an unpredictable id when the request starts here.
export const requestIdOptions = {
  requestIdHeader: 'x-request-id',
  genReqId: () => randomUUID(),
} satisfies Pick<FastifyServerOptions, 'requestIdHeader' | 'genReqId'>;

// Visible ASCII and space/tab only: a control character or newline in the
// echoed header would make Node throw ERR_INVALID_CHAR, turning a malformed
// caller header into a 500 (and newline injection into a header-splitting
// risk if that validation ever regressed).
const VALID_REQUEST_ID = /^[\x20-\x7E]+$/;

function safeRequestId(id: string): string {
  return VALID_REQUEST_ID.test(id) ? id : randomUUID();
}

export function registerRequestIdHeader(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    request.id = safeRequestId(request.id);
    reply.header('x-request-id', request.id);
  });
}
