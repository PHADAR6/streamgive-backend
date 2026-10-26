# Environment variables

Copy `.env.example` to `.env` (and `.env.test.example` to `.env.test` for the test suite) and fill these in.

## Loading and precedence

When the application starts, [`src/index.ts`](./src/index.ts) imports `dotenv/config` before the server, indexer, or database modules. Dotenv reads `.env` and fills only variables that are not already present in `process.env`. Shell exports and hosting-platform settings therefore take precedence over `.env` values.

The Vitest setup in [`test/setup.ts`](./test/setup.ts) loads `.env.test` before the test modules. It follows the same rule: existing environment variables are not overwritten. CI sets `DATABASE_URL` directly to its PostgreSQL service in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml), so that CI value takes precedence over any `DATABASE_URL` in `.env.test`. The `db:push:test` script also explicitly loads `.env.test` for local test-schema setup.

Many settings are read from `process.env` once when their module is imported, not each time they are used. For example, `src/db.ts` captures `DATABASE_URL`, `src/stellar/rpc.ts` captures `SOROBAN_RPC_URL`, `src/indexer/contracts.ts` captures the contract IDs, and `src/indexer/worker.ts` captures its polling and start-ledger settings. Set these values before starting the app or importing those modules; changing `process.env` afterward will not update the already-created client or values. Tests that change such settings must reset and re-import the relevant modules.

Admin requests are authenticated with a signed timestamp header. The timestamp **must be a Unix timestamp in milliseconds** (i.e. `Date.now()`). Timestamps in seconds are rejected with a `timestamp_unit_mismatch` error; multiply by `1000` if you only have seconds. Timestamps are compared against `Date.now()` with a 5-minute clock skew allowance (`stale_signature`). Send `Date.now()` directly; do not send `Math.floor(Date.now() / 1000)`.

## Environment variable reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string. Inside `docker compose`, the backend service overrides this to point at the `postgres` service, not `localhost`. |
| `PORT` | No | `3000` | Port the Fastify server listens on. |
| `SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint the indexer polls. |
| `STELLAR_NETWORK_PASSPHRASE` | No | SDK Testnet passphrase | Network passphrase used for read-only contract simulations and Soroban RPC transactions. |
| `NGO_REGISTRY_CONTRACT_ID` | No* | — (empty) | Deployed `ngo-registry` contract ID. See `streamgive-contracts/deployments.json`. The indexer no-ops until both contract IDs are set. |
| `DONATION_VAULT_CONTRACT_ID` | No* | — (empty) | Deployed `donation-vault` contract ID. See `streamgive-contracts/deployments.json`. The indexer no-ops until both contract IDs are set. |
| `WATCHED_CONTRACT_IDS` | No | — (empty) | Optional comma-separated contract IDs to watch for indexer status reporting. Also accepts legacy `CONTRACT_IDS`. Defaults to `NGO_REGISTRY_CONTRACT_ID` and `DONATION_VAULT_CONTRACT_ID`. |
| `INDEXER_POLL_INTERVAL_MS` | No | `5000` | How often the indexer polls `getEvents`. Doubles on each consecutive poll failure, up to a 5-minute cap; see [`docs/INDEXER.md`](./docs/INDEXER.md). |
| `INDEXER_START_LEDGER` | No | Latest ledger | Starting ledger for a new indexer with no saved checkpoint; useful for historical backfills. Existing checkpoints take precedence. |
| `INDEXER_MAX_EVENTS_PER_POLL` | No | RPC default | Positive integer limiting events fetched and processed per poll. The event cursor is checkpointed so the next poll resumes after the last handled event. |
| `INDEXER_LAG_THRESHOLD` | No | `100` | Maximum ledger lag allowed before the `/health/ready` check reports `503 Service Unavailable` with `indexer_lagging`. |
| `CORS_ORIGINS` | No | `http://localhost:3001` | Comma-separated origins allowed to call this API from a browser. |
| `ADMIN_ADDRESS` | No** | — (empty) | One Stellar public key (`G...`) allowed to sign admin requests. It is combined with `ADMIN_ADDRESSES`; it does not have to be the only allowed signer. |
| `ADMIN_ADDRESSES` | No** | — (empty) | Comma-separated additional Stellar public keys (`G...`) allowed to sign admin requests. Values are trimmed, blank entries ignored, and duplicates removed. Set either this or `ADMIN_ADDRESS`; admin routes return `503 admin_auth_not_configured` only when both are empty. |
| `NOTIFY_WEBHOOK_URL` | No | — (empty) | If set, notification events across the platform—stream lifecycle events (`stream_created`, `stream_withdrawn`, `stream_cancelled`), NGO status updates (`ngo_approved`, `ngo_revoked`), and application events (`application_submitted`, `application_reviewed`)—are POSTed here as JSON. |
| `NOTIFY_WEBHOOK_TIMEOUT_MS` | No | `3000` | Maximum duration in milliseconds for a webhook request. Invalid or non-positive values use the default. |
| `NOTIFY_WEBHOOK_SECRET` | No | — (empty) | If set, every webhook POST carries an `x-streamgive-signature` header containing the lowercase hexadecimal HMAC-SHA256 of the raw request body, keyed with this value, so receivers can reject forged notifications. The header is omitted when this is unset. See the README's notification section for the verification recipe. |
| `METRICS_TOKEN` | No | — (empty) | If set, `GET /metrics` requires `Authorization: Bearer <token>`. Missing or incorrect tokens receive `401 { "error": "unauthorized" }`. Unset leaves `/metrics` public. |
| `RATE_LIMIT_MAX` | No | `100` | Global maximum number of requests allowed per time window across the API. |
| `RATE_LIMIT_WINDOW` | No | `1 minute` | Global rate-limit time window, such as `1 minute` or `10000` milliseconds. |
| `RATE_LIMIT_APPLICATION_MAX` | No | `5` | Maximum number of NGO application submissions allowed per time window. |
| `RATE_LIMIT_APPLICATION_WINDOW` | No | `1 minute` | Rate-limit time window for NGO application submissions. |
| `TRUST_PROXY` | No | `true` | Controls Fastify's `trustProxy` setting to read client IPs from `X-Forwarded-For`. Behind reverse proxies such as Render, this helps rate limiting use individual client IPs rather than the proxy IP. Accepts `true` (default), `false`, a bounded hop count (e.g. `1`), or a comma-separated list of trusted IPs/CIDRs. |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, or `trace`. |
| `LOG_RETENTION_DAYS` | No | `90` | Age in days before notification logs and resolved indexer dead letters are pruned daily. Unresolved dead letters are retained. |
| `NODE_ENV` | No | Unset (treated as development) | Set to `production` to switch logging to structured JSON instead of `pino-pretty`. Set automatically inside the Docker image. |
| `HEALTH_CHECK_TIMEOUT_MS` | No | `3000` | Maximum duration in milliseconds allowed for each health-check dependency call before it is reported as degraded. |
| `RESEND_API_KEY` | No | — | Resend API key used to send NGO contact-email verification messages. Required, together with `NOTIFY_EMAIL_FROM` and `API_PUBLIC_URL`, for verification emails to be sent; other notification events remain in log-only stub mode. |
| `NOTIFY_EMAIL_FROM` | No | — | Sender address used by Resend for contact-email verification. Required when `RESEND_API_KEY` is configured. |
| `NOTIFY_EMAIL_TO` | No (planned) | — | Planned recipient address for notification emails. Not yet read by runtime code. |
| `API_PUBLIC_URL` | No | — | Public HTTPS origin used to build NGO contact-email verification links. Required, together with `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM`, to verify NGO application contact addresses. |

\* Required for the indexer to do anything; the app runs fine without them, but it will not see on-chain events.

\** Required for admin-authenticated routes; configure at least one address using `ADMIN_ADDRESS` and/or `ADMIN_ADDRESSES`. Admin timestamps always use Unix milliseconds; there is no `ADMIN_TIMESTAMP_UNIT` runtime setting. Everything else in the API works without the admin address configuration.
