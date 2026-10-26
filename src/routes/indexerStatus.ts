
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getCheckpointState } from '../indexer/checkpoint.js';
import { WATCHED_CONTRACT_IDS } from '../indexer/contracts.js';
import { getLatestLedgerSequence } from '../stellar/rpc.js';

export async function indexerStatusRoutes(fastify: FastifyInstance) {
  /**
   * Reports whether the indexer is configured and its checkpoint/ledger lag.
   * @route GET /v1/indexer/status
   * @auth Public
   * @returns 200 `{ configured, checkpointLedger, updatedAt, latestLedger, ledgerLag }`; ledger values and timestamp are null when not configured.
   */
  fastify.get(
    '/indexer/status',
    {
      schema: {
        tags: ['Indexer'],
        summary: 'Reports whether the indexer is configured and its checkpoint/ledger lag',
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const watchedEnvString =
        process.env.WATCHED_CONTRACT_IDS ?? process.env.CONTRACT_IDS;

      const envWatched =
        watchedEnvString !== undefined
          ? watchedEnvString
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [
              process.env.NGO_REGISTRY_CONTRACT_ID ?? '',
              process.env.DONATION_VAULT_CONTRACT_ID ?? '',
            ].filter(Boolean);

      const isConfigured =
        envWatched.length > 0 || WATCHED_CONTRACT_IDS.length > 0;

      if (!isConfigured) {
        return reply.send({
          configured: false,
          checkpointLedger: null,
          updatedAt: null,
          latestLedger: null,
          ledgerLag: null,
        });
      }

      const [checkpoint, latestLedger] = await Promise.all([
        getCheckpointState(),
        getLatestLedgerSequence(),
      ]);

      const checkpointLedger = checkpoint?.lastLedger ?? null;
      const updatedAt = checkpoint?.updatedAt
        ? checkpoint.updatedAt.toISOString()
        : null;
      const ledgerLag =
        checkpointLedger !== null ? latestLedger - checkpointLedger : null;

      return reply.send({
        configured: true,
        checkpointLedger,
        updatedAt,
        latestLedger,
        ledgerLag,
      });
    },
  );
}
