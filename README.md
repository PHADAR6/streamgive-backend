# StreamGive — Backend

Indexer and API for StreamGive, a recurring/streaming donation platform for
verified NGOs on Stellar. Watches the on-chain contracts for events and
serves the data that powers the frontend.

## Stack

- TypeScript, Node.js
- Fastify (API server)
- PostgreSQL
- [Architecture overview](ARCHITECTURE.md): how the API, indexer, and
  notification dispatcher run together and shut down.

## API

Routes are split into two groups:

| Prefix | Routes |
|--------|--------|
| `/v1`  | NGOs, streams, donors, impact, NGO applications, indexer status |
| _(none)_ | `GET /health`, `GET /health/ready`, `GET /metrics` |

`GET /v1/health` is **not** a valid route and returns 404. Health checks and
metrics sit at the root so load balancers and uptime monitors can reach them
without knowing the API version.

See the [API reference](docs/API.md) for every endpoint, its parameters,
authentication requirements, and response examples.

Interactive API documentation via Swagger UI is available at `/docs` (e.g.
`http://localhost:3000/docs` in local development), and the OpenAPI JSON document
is available at `/docs/json`.

Swagger UI and the OpenAPI JSON endpoints are only registered outside of
production (`NODE_ENV !== 'production'`). In production environments, Swagger UI
is disabled and the `/docs` route is not registered (returning 404). For API
documentation on deployed production instances, consult the [API reference](docs/API.md).

## Rate limits

The API allows up to **100 requests per minute per client IP** by default.
`POST /v1/ngo-applications` has a tighter limit of **5 requests per minute
per client IP**. Exceeding a limit returns `429 Too Many Requests` with
`{"error":"rate_limited"}`. Responses include `Retry-After` and
`X-RateLimit-*` headers to help clients know when to retry. Cross-origin
browser clients can read those headers because they are listed in the CORS
`Access-Control-Expose-Headers` response.

The global limit can be adjusted with `RATE_LIMIT_MAX` and
`RATE_LIMIT_WINDOW`; the application submission limit can be adjusted with
`RATE_LIMIT_APPLICATION_MAX` and `RATE_LIMIT_APPLICATION_WINDOW`.

Rate-limit state is kept in memory by each server process, not shared between
instances or persisted. With multiple instances, each instance tracks its own
limits, so a client's effective allowance can be higher than the configured
per-instance limit. Restarting an instance also clears its rate-limit state.

## Prometheus metrics

`GET /metrics` returns Prometheus text format (`text/plain; version=0.0.4`).
It exposes HTTP request totals and duration, indexer checkpoint and lag, and webhook
delivery totals. Configure Prometheus to scrape it on the API host and port.

Set `METRICS_TOKEN` to require `Authorization: Bearer <token>` on `/metrics`.
When it is unset, the endpoint stays public; see [ENVIRONMENT.md](ENVIRONMENT.md).

## NGO Verification Model

An NGO's verified status consists of two distinct steps kept deliberately separate:

1. **Off-Chain Application Review (`NgoApplication.status`)**: An NGO submits an off-chain application containing organization details and verification documents. Admins review and update the application status (e.g., `APPROVED` or `REJECTED`) within the database.
2. **On-Chain Contract Approval (`Ngo.verified`)**: Once an application is reviewed off-chain, an admin executes an on-chain transaction (`approve_ngo`) to grant the NGO verified status on the Stellar smart contract. The indexer listens for on-chain events (`ngo_approved` / `ngo_revoked`) and updates the `Ngo.verified` field accordingly.

Keeping off-chain application review separate from on-chain contract approval ensures that sensitive organizational details and review metadata remain off-chain, while the Stellar ledger remains the single source of truth for execution permissions and verified status.

## Admin Authentication

Admin routes are protected by a signed request scheme (`requireAdminSignature`). Each request must include:

- `x-admin-address` — the admin's Stellar public key (`G...`), which must appear in `ADMIN_ADDRESS` or `ADMIN_ADDRESSES`.
- `x-admin-timestamp` — the current time as a Unix timestamp in **milliseconds** (e.g. `Date.now()` in JavaScript).
- `x-admin-signature` — a base64 or hex Ed25519 signature over the signed payload (see below).

### Signed payload

The signature is produced by signing the following string with the admin's Stellar keypair via the SEP-53 generic message-signing scheme (`SHA-256(prefix + message)`, where `prefix = "Stellar Signed Message:\n"`):

```
METHOD:url:timestamp:bodyHash
```

- **METHOD** — HTTP method in upper-case, e.g. `GET`, `POST`, `PATCH`.
- **url** — the full request URL including path and query string, e.g. `/v1/ngo-applications?status=PENDING`.
- **timestamp** — the `x-admin-timestamp` value (milliseconds).
- **bodyHash** — lower-case hex SHA-256 of the raw request body, or the SHA-256 of an empty buffer (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) for bodyless requests (GET, DELETE, etc.).

Including the body hash in the signed payload prevents an attacker who intercepts a valid request from replaying it with a different body (e.g. a different `reviewNote`) inside the replay window.

### Timestamp rules

The timestamp must be within ±5 minutes of the server's clock. The unit is **milliseconds**, not seconds. Sending a 10-digit seconds-precision timestamp is rejected with `timestamp_unit_mismatch` (not `stale_signature`) so clients get a clear signal.

### Error codes

| Error | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid headers, address not on allow-list, or signature did not verify |
| `stale_signature` | 401 | Timestamp is malformed or outside the ±5-minute replay window |
| `timestamp_unit_mismatch` | 401 | Timestamp looks like seconds (< 10^11); send milliseconds |
| `replayed_signature` | 401 | The same address+timestamp+method+url has already been used in this window |
| `admin_auth_not_configured` | 503 | Neither `ADMIN_ADDRESS` nor `ADMIN_ADDRESSES` is set |

## Local development

```
cp .env.example .env
docker compose up -d postgres   # starts Postgres (+ a streamgive_test DB)
npm install
npm run db:deploy               # apply Prisma migrations to streamgive
npm run db:seed                 # optional: load sample NGOs, donors and streams
npm run dev

```

In development, interactive API documentation is available at `http://localhost:3000/docs`; the OpenAPI document is at `/docs/json`. Swagger UI is disabled in production.

The test database is created by the `postgres` service in `docker-compose.yml`
as `streamgive_test`. Start it with `docker compose up -d postgres`, copy
`.env.test.example` to `.env.test`, run `npm run db:push:test` to sync the
Prisma schema to that database, and only then run `npm test`.

## Troubleshooting

**"Can't reach database" / connection errors on startup**

Postgres isn't up yet, or `DATABASE_URL` doesn't point at it. Run
`docker compose up -d postgres` and confirm `DATABASE_URL` in `.env` matches
(`postgresql://streamgive:streamgive@localhost:5432/streamgive` when running
`npm run dev` directly — the `postgres` host only resolves inside
`docker compose`, see the override in `docker-compose.yml`). Then run
`npm run db:deploy` to apply the committed migrations.

**Indexer never picks up events**

If `NGO_REGISTRY_CONTRACT_ID` and `DONATION_VAULT_CONTRACT_ID` are both
unset, this is expected — the indexer no-ops until at least one is set. See
[ENVIRONMENT.md](./ENVIRONMENT.md) for where to get the deployed contract
ids. If they're set and events still aren't showing up, check
`SOROBAN_RPC_URL` is reachable and that the contracts have actually emitted
events since the indexer's checkpoint (a fresh run starts from the current
ledger, not from the contract's history).

**Admin routes return 503**

`ADMIN_ADDRESS` is unset. The admin review endpoints refuse all requests
until it's configured — set it to the Stellar public key (`G...`) that
matches the `admin` configured on the deployed contracts. See
[ENVIRONMENT.md](./ENVIRONMENT.md).

## Data model and API statistics

See [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) for the entity relationship
diagram and the exact calculations used by `/ngos/:id` and `/impact/:ngoId`.

## Notification events

The webhook body is a JSON object discriminated by `type`. The full payload
shapes, including `ngo_registered`, are documented in
[docs/NOTIFICATIONS.md](./docs/NOTIFICATIONS.md).

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromStreamGive(rawBody, timestamp, deliveryId, signatureHeader, secret) {
  if (!timestamp || !deliveryId || !signatureHeader) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const match = /^v1=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!match) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${deliveryId}.${rawBody}`)
    .digest();
  const received = Buffer.from(match[1], 'hex');

  // timingSafeEqual throws on a length mismatch, so check that first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

Call the verifier with the raw body and the three corresponding headers.
Persist accepted delivery IDs for at least the timestamp acceptance window
and reject duplicates, along with any request whose signature does not match.
When `NOTIFY_WEBHOOK_SECRET` is unset the signature header is omitted, so
configure a secret before requiring signed requests.

Failed webhook deliveries are persisted and retried with exponential backoff
for up to five attempts. A delivery that exhausts its attempts remains
recorded as failed for operational inspection.

### Verifying the signature

The webhook URL is not a secret — anyone who learns it can POST whatever they
like to your receiver. Set `NOTIFY_WEBHOOK_SECRET` to a shared secret and
every request will additionally carry:

```
x-streamgive-signature: <hex>
```

where `<hex>` is the lower-case hex HMAC-SHA256 of the **raw request body**,
keyed with `NOTIFY_WEBHOOK_SECRET`. There is no prefix, timestamp or version
tag in the value — it is the bare digest.

### `stream_created`

Emitted when a donor opens a new donation stream to an NGO.

```json
{
  "type": "stream_created",
  "streamId": "1234",
  "donorAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `streamId` — the stream's on-chain id, as a string.
- `donorAddress` — the donor's Stellar account address.
- `ngoId` — the internal (database) id of the receiving NGO.

### `stream_withdrawn`

Emitted when accrued funds are withdrawn to the NGO from an active stream.

```json
{
  "type": "stream_withdrawn",
  "streamId": "1234",
  "amount": "500000000"
}
```

- `streamId` — the stream's on-chain id, as a string.
- `amount` — the amount withdrawn, in the stream's token base units, as a string.

### `stream_cancelled`

Emitted when a stream is cancelled, settling accrued funds to the NGO and
refunding the remaining balance to the donor.

```json
{
  "type": "stream_cancelled",
  "streamId": "1234",
  "settledToNgo": "500000000",
  "refundToDonor": "1500000000"
}
```

- `streamId` — the stream's on-chain id, as a string.
- `settledToNgo` — the amount settled to the NGO at cancellation time, in the stream's token base units, as a string.
- `refundToDonor` — the amount refunded to the donor, in the stream's token base units, as a string.

### `ngo_approved`

Emitted when an admin approves an NGO on-chain.

```json
{
  "type": "ngo_approved",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the approved NGO.

### `ngo_revoked`

Emitted when a previously-approved NGO has its verified status revoked on-chain.

```json
{
  "type": "ngo_revoked",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3..."
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the revoked NGO.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, how to run tests, and
how to open a pull request. The full project-wide contribution guide lives in
[streamgive-docs](https://github.com/streamgive/streamgive-docs).

## Related repositories

- [streamgive-contracts](https://github.com/streamgive/streamgive-contracts) — Soroban smart contracts
- [streamgive-frontend](https://github.com/streamgive/streamgive-frontend) — donor & NGO web app
- [streamgive-docs](https://github.com/streamgive/streamgive-docs) — documentation

## Status

Early development.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
