# Deploying the backend

This service is a Fastify API and a Soroban event indexer running in one
process. It needs a Postgres database and a deployed pair of contracts —
contract ids for the current testnet deployment are in
`streamgive-contracts/deployments.json`.

It is deployed on Render's free tier from `render.yaml`, using the
Dockerfile in this directory. Any host that can run a container works; the
one real constraint is discussed under "Keeping it awake".

## Prerequisites

- A Postgres database reachable from the internet. Supabase's free tier is
  fine — use the **session pooler** connection string, not the direct one,
  which resolves to IPv6 only and will fail from most networks.
- The frontend's public URL, for `CORS_ORIGINS`.

## First deploy

In Render: **New → Blueprint**, point it at this repository, and let it read
`render.yaml`. It prompts for the three values marked `sync: false`:

| Variable        | Value                                                    | Why it is not in `render.yaml`  |
| --------------- | -------------------------------------------------------- | ------------------------------- |
| `DATABASE_URL`  | Supabase session pooler URL, password percent-encoded    | Secret                          |
| `ADMIN_ADDRESS` | the `G...` wallet that is admin on the deployed registry | Public, but deployment-specific |
| `CORS_ORIGINS`  | the frontend's URL, e.g. `https://streamgive.vercel.app` | Public, but deployment-specific |

`sync: false` marks values Render cannot know when it reads the blueprint; it
is not a list of secrets. Two of those three are public.

The blueprint pins the rest of the required configuration — `NODE_ENV`,
`SOROBAN_RPC_URL`, both contract ids, and `INDEXER_POLL_INTERVAL_MS` — because
the same values are correct on every deployment.

Nothing else has to be set for the service to boot. The rest of
[`ENVIRONMENT.md`](./ENVIRONMENT.md) is optional, and each value either has a
default in code or belongs to a feature you can enable later, which is why none
of it is in `render.yaml`. The one feature that cannot work until you add a
variable is webhook delivery: add `NOTIFY_WEBHOOK_URL` (and, to sign the
deliveries, `NOTIFY_WEBHOOK_SECRET`) under Environment → Add Environment
Variable. The remaining optional settings — `ADMIN_ADDRESSES`, `LOG_LEVEL`,
`TRUST_PROXY`, `RATE_LIMIT_*`, `INDEXER_START_LEDGER`,
`INDEXER_MAX_EVENTS_PER_POLL`, `INDEXER_LAG_THRESHOLD` — are safe to leave
unset unless you are overriding the documented default.

## The ordering problem

The frontend needs this API's URL, and this API needs the frontend's URL for
`CORS_ORIGINS`. Neither exists before the other, so:

1. Deploy this backend and note its URL (`https://<name>.onrender.com`)
2. Deploy the frontend with `NEXT_PUBLIC_API_URL` set to that
3. Come back and set `CORS_ORIGINS` to the frontend's real URL

Until step 3, every browser request fails as `Failed to fetch`, which looks
like the server being down rather than a CORS refusal. It isn't. Put a
placeholder in at step 1 and correct it at step 3.

## Database schema

The app does not migrate on boot. Deploy the committed migrations from a
machine that has `DATABASE_URL` set:

```sh
npx prisma migrate deploy
```

## Keeping it awake

Render's free web services **spin down after about 15 minutes without HTTP
traffic**, and take 30–60 seconds to wake. Two consequences:

- A visitor arriving cold waits through that wake-up on a blank page.
- While stopped, nothing is indexed. The indexer runs inside this process.

### How long the indexer can be down without losing events

Missed events are _recoverable_ rather than lost, but only while the saved
checkpoint is still inside the RPC's retention window.

That window is a property of the RPC endpoint, not of this repository. It is
reported as `ledgerRetentionWindow` by `getHealth`, and it differs by network
and by provider:

| Endpoint                                                                                | `ledgerRetentionWindow` | At ~5 s per ledger |
| --------------------------------------------------------------------------------------- | ----------------------- | ------------------ |
| `https://soroban-testnet.stellar.org` (what `render.yaml` uses)                         | 120,960                 | **~7 days**        |
| Mainnet RPC endpoints (typical), as described in [`docs/INDEXER.md`](./docs/INDEXER.md) | 17,280                  | **~24 hours**      |

Read the number off the endpoint you actually configured rather than trusting
either figure:

```sh
curl -s -X POST "$SOROBAN_RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

On wake, the indexer resumes from its saved checkpoint and catches up. Only a
gap longer than that window is unrecoverable — at which point it resyncs to the
current ledger and logs a warning naming what it skipped.

### The pinger

An external uptime pinger (cron-job.org, UptimeRobot, …) hitting the service
every 10 minutes keeps it awake, which also keeps the Supabase project clear of
its own 7-day inactivity pause: the indexer queries the database every poll
interval for as long as the process is running.

Which route the pinger should hit depends on what its up/down state is
supposed to mean:

| Target         | What a `200` proves                                                                         | Cost                                    |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| `GET /metrics` | The process is running and routing requests. The handler reads process-local counters only. | Nothing beyond the request              |
| `GET /health`  | The process, Postgres, **and** the Stellar RPC all answered.                                | One DB query and one RPC call per check |

`/health` answers `503` when either dependency fails, so a monitor pointed at
it reports an outage whenever Supabase or the public Stellar RPC has one, even
though nothing in this service is down. That is useful as a dependency check
and misleading as a liveness check; `/metrics` is the dependency-free option.
Both keep the instance awake, so a 10-minute `/metrics` ping is enough to stop
the spin-down.

The same distinction applies to Render itself: `render.yaml` sets
`healthCheckPath: /health`, so a release is only marked healthy once the RPC
answers as well. That is the intent for a deploy — a new instance that cannot
reach the RPC cannot index — but it does mean a third-party incident can stall
a rollout.

One caveat: Render's free plan allows 750 instance-hours per month and a
month is about 730 hours, so a permanently-awake service consumes nearly the
whole allowance. That budget covers **one** free service, not several.

## Running more than one instance

Several pieces of state live in process memory. Each one behaves differently
when a second replica runs, and when the process restarts. The table lists
what the code does today.

| State | Where | Second replica | Restart |
|---|---|---|---|
| Admin signature replay set | `usedSignatures` in `src/middleware/adminAuth.ts` | A signature already used on one replica is accepted again on the other within the replay window. | Cleared, so a signature used before the restart is accepted again within its window. |
| Rate limits (global and NGO applications) | `@fastify/rate-limit` with its default in-memory store. No shared store is configured in `src/server.ts`. | Each replica counts requests separately, so the effective limit is about `RATE_LIMIT_MAX` times the number of replicas. | Counters reset. |
| Notification de-duplication | `deliveredEventIds` in `src/notifications/service.ts` (capped at 10,000 ids) | The database check against `notificationLog` runs before each send, but two replicas handling the same event at the same moment can both send before either writes the log entry. | The in-memory set is cleared. The database check still prevents resends of events logged as delivered. |
| Metrics counters | `src/metrics.ts` | `/metrics` reports one replica's counters. Scrape each replica separately. | Counters reset. |
| Indexer | Started in every process by `src/index.ts`. The checkpoint is in the `indexer_checkpoints` table. | No leader lock exists in `src/indexer`, so each replica polls the same events. Whether that double processing is harmless depends on the handlers being idempotent. This was not verified. | Resumes from the saved checkpoint. |
| Log retention | Daily `setInterval` in `src/maintenance/logRetention.ts`, in every process | Each replica runs the job. | Runs again on the next interval. |

The one coordinated path is NGO application creation, which takes a Postgres
advisory lock keyed on the owner address (`src/routes/ngoApplications.ts`).
That check holds across replicas.

**Recommended instance count: one.** Until the replay set, rate limits, and
indexer are moved to shared storage or given a leader lock, run a single
backend instance. Scale out only after those items are resolved, and keep the
indexer on one instance even then.

## Notes on Supabase

- Free-tier projects pause after 7 days of inactivity. The pinger above
  keeps this service querying the database, which keeps the project active.
- Percent-encode the password in the connection URL. A literal `#`
  truncates it, and a literal `@` breaks host parsing.
