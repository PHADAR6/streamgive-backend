# Architecture

StreamGive's backend runs its HTTP API, Soroban event indexer, and notification
dispatcher in one Node.js process. They share the process environment, database
client, logger, and in-memory metrics; the indexer starts alongside the API
rather than as a separate service.

## API

Fastify serves the public and admin REST endpoints under `/v1`, along with
unversioned `/health`, `/health/ready`, and `/metrics` endpoints. Route handlers
use the shared Prisma client to read and write PostgreSQL. The HTTP server and
indexer therefore use the same database connection pool and process lifecycle.

## Indexer

At startup, the process begins polling the configured Soroban RPC endpoint for
events from the watched NGO registry and donation vault contracts. The dispatcher
sends each event to the corresponding contract handler. Handlers update the
database and trigger notification dispatch where appropriate. The indexer saves
its checkpoint to PostgreSQL after each processed event, resumes from that
checkpoint after a restart, and retries transient failures with backoff.

## Notifications

Notifications are dispatched by the same process in response to events and
application changes. When configured, the webhook channel sends JSON to
`NOTIFY_WEBHOOK_URL`; an optional `NOTIFY_WEBHOOK_SECRET` signs the payload.
Email delivery is currently a stub. Notification delivery records are stored
in PostgreSQL, while a bounded event-id set used to avoid repeat work is local
to the process.

## Process boundaries and scaling

PostgreSQL stores application data, indexer checkpoints, and notification logs.
Some operational state, including HTTP metrics and rate-limit counters, is
held in process memory and is not shared across instances.

Run the API and indexer together as one backend instance. Adding backend
instances also starts additional indexer workers and creates independent
in-memory state; it is not equivalent to scaling a stateless API tier. Any
multi-instance deployment must account for those per-process responsibilities
and state explicitly.

## Shutdown

On `SIGTERM` (container or orchestrator shutdown) or `SIGINT` (Ctrl+C), the
process requests the indexer to stop. The worker cancels its pending poll and
waits for any poll already in progress to finish. The process then closes the
Fastify server, allowing in-flight HTTP requests to complete, and exits with a
success status. If shutdown fails, the process logs the error and exits with a
failure status. An unhandled promise rejection follows the same cleanup path
and exits with a failure status.
