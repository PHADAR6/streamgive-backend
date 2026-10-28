import compress from '@fastify/compress';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

export const registerCompression = fp(async function registerCompression(app: FastifyInstance) {
  await app.register(compress, {
    global: true,
    threshold: 1024, // don't compress tiny responses
    encodings: ['br', 'gzip'],
  });
});
