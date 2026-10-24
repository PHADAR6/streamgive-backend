# StreamGive REST API

This reference documents the HTTP endpoints currently registered by the
backend. Except for health checks and metrics, API routes are mounted under
`/v1`. Replace values in angle brackets in the examples with real IDs,
addresses, timestamps, and signatures. JSON response fields shown are
representative; timestamps are ISO 8601 strings.

## Authentication

Routes marked **Admin signature** require all three headers:

- `x-admin-address`: an allowed Stellar public key configured by
  `ADMIN_ADDRESS` or `ADMIN_ADDRESSES`.
- `x-admin-timestamp`: the current Unix timestamp in milliseconds.
- `x-admin-signature`: the SEP-53 Stellar message signature for
  `METHOD:PATH_AND_QUERY:TIMESTAMP`, where the timestamp is the exact header
  value. For example, sign `GET:/v1/ngo-applications?limit=20:1760000000000`
  for that request.

The signed message must use the generic Stellar message-signing operation.
Signatures expire when the timestamp is more than five minutes from the
server's clock, and a signature cannot be replayed. Admin routes return
`401` for missing or invalid authentication, `503` with
`{"error":"admin_auth_not_configured"}` if no admin address is configured,
and `401` with `{"error":"timestamp_unit_mismatch"}` for a timestamp in
seconds.

Routes marked **Public** do not require authentication. Public directory,
stream, and impact endpoints may return `304 Not Modified` when the
`If-None-Match` header matches their ETag. See [Caching and conditional requests](#caching-and-conditional-requests).

Unknown routes return `404` with the same body used by every other missing
resource: `{"error":"not_found"}`.

## Caching and conditional requests

Eleven public read endpoints send a validator and a short shared-cache
lifetime. Everything else is uncached.

| Method and path | Cacheable |
|---|---|
| `GET /v1/ngos` | Yes |
| `GET /v1/ngos/lookup` | Yes |
| `GET /v1/ngos/{id}` | Yes |
| `GET /v1/ngos/{id}/donors` | Yes |
| `GET /v1/donors` | Yes |
| `GET /v1/donors/{address}` | Yes |
| `GET /v1/streams` | Yes |
| `GET /v1/streams/{id}` | Yes |
| `GET /v1/streams/{id}/activity` | Yes |
| `GET /v1/impact` | Yes |
| `GET /v1/impact/{ngoId}` | Yes |

Not cacheable: `GET /v1/ngos/all`, `GET /v1/ngo-applications*`, the admin
routes, `GET /v1/donors/{address}/streams.csv`, `GET /v1/indexer/status`,
`GET /health`, `GET /health/ready`, and `GET /metrics`.

### Headers

A cacheable response carries:

```
Cache-Control: public, max-age=30, stale-while-revalidate=60
ETag: "<base64url SHA-256 of the response body>"
```

The ETag is computed over the exact JSON bytes sent, so it changes whenever
the body changes. Responses are not personalised, so a shared cache may store
them for 30 seconds and serve a stale copy for up to a further 60 seconds
while it revalidates.

### Conditional requests

Send the ETag back in `If-None-Match` to get a body-less `304 Not Modified`
while the resource is unchanged:

```
GET /v1/ngos/{id} HTTP/1.1
If-None-Match: "3f2a…"

HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=30, stale-while-revalidate=60
ETag: "3f2a…"
```

`If-None-Match` accepts a comma-separated list of ETags, weak validators
(`W/"…"`, compared as strong), and `*`. A request whose validator no longer
matches receives the full `200` response with the new ETag.

## Integer and amount representation

Stream `onChainId` values are stored as JavaScript `bigint` values in the
backend. Amounts originating from the contract, including `rate`, `lastRate`,
`balance`, and `withdrawn`, are stored as decimal strings to preserve the
contract's full integer precision. Aggregated amounts such as `totalCommitted`
and `totalWithdrawn` are returned as decimal strings too.

JSON cannot serialize JavaScript `bigint` values directly. The API therefore
converts `onChainId` to a decimal string before sending stream responses;
on-chain event `streamId` values are also serialized as strings (or `null`).
Treat these fields as strings when consuming the API. Do not convert IDs or
amounts to JavaScript `number`, which can silently lose integer precision.
For exact integer arithmetic, parse decimal strings with `BigInt` in
JavaScript, and convert results back to strings for JSON.

## Health and metrics

These endpoints are mounted at the server root, not under `/v1`.

### `GET /health`

**Auth:** Public  
**Params:** None.

Checks database and Stellar RPC connectivity. Returns `200` when both checks
succeed and `503` otherwise.

```json
{ "status": "ok", "db": "ok", "rpc": "ok" }
```

### `GET /health/ready`

**Auth:** Public  
**Params:** None.

Checks database connectivity and indexer progress. Returns `200` when ready,
or `503` if the indexer has not started, is too far behind, or a dependency is
unavailable.

```json
{
  "status": "ok",
  "lag": 5,
  "latestLedger": 123455,
  "checkpointLedger": 123450
}
```

### `GET /metrics`

**Auth:** Public, or bearer token when `METRICS_TOKEN` is set

**Params:** None.

If the server has `METRICS_TOKEN` set, this endpoint requires
`Authorization: Bearer <token>`. A missing or wrong token returns
`401 { "error": "unauthorized" }`. When `METRICS_TOKEN` is unset, the
endpoint is public.

Returns Prometheus exposition text (`text/plain; version=0.0.4`), including
HTTP request and duration metrics, indexer checkpoint and lag, and webhook
delivery metrics. Example response:

```text
# HELP streamgive_http_requests_total Total HTTP requests handled.
# TYPE streamgive_http_requests_total counter
streamgive_http_requests_total{method="GET",route="/health",status_code="200"} 1
# HELP streamgive_http_request_duration_seconds HTTP request duration in seconds.
# TYPE streamgive_http_request_duration_seconds summary
streamgive_http_request_duration_seconds_sum{method="GET",route="/health",status_code="200"} 0.001
streamgive_http_request_duration_seconds_count{method="GET",route="/health",status_code="200"} 1
# HELP streamgive_indexer_checkpoint_ledger Last ledger checkpointed by the indexer.
# TYPE streamgive_indexer_checkpoint_ledger gauge
streamgive_indexer_checkpoint_ledger 123450
# HELP streamgive_indexer_latest_ledger Latest ledger observed from Stellar RPC.
# TYPE streamgive_indexer_latest_ledger gauge
streamgive_indexer_latest_ledger 123455
# HELP streamgive_indexer_lag_ledgers Difference between the latest and checkpoint ledgers.
# TYPE streamgive_indexer_lag_ledgers gauge
streamgive_indexer_lag_ledgers 5
# HELP streamgive_notification_deliveries_total Webhook notification delivery attempts.
# TYPE streamgive_notification_deliveries_total counter
streamgive_notification_deliveries_total{outcome="success"} 1
streamgive_notification_deliveries_total{outcome="failure"} 0
```

## NGOs

### `GET /v1/ngos`

**Auth:** Public  
**Query params:**

| Name     | Type                         | Default  | Description                                           |
| -------- | ---------------------------- | -------- | ----------------------------------------------------- |
| `limit`  | integer, 1–100               | `100`    | Maximum results.                                      |
| `cursor` | UUID                         | —        | Continue after this NGO ID.                           |
| `sort`   | `newest`, `oldest`, `name`   | `newest` | Result ordering.                                      |
| `q`      | string, up to 100 characters | —        | Case-insensitive substring search on the public name. |

Lists verified NGOs. `nextCursor` is the last returned NGO ID when another
page is available, otherwise `null`.

```json
{
  "ngos": [
    {
      "id": "<UUID>",
      "ownerAddress": "<STELLAR_PUBLIC_KEY>",
      "name": "Example Aid",
      "displayName": null,
      "verified": true,
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>"
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/ngos/all`

**Auth:** Admin signature  
**Query params:**

| Name       | Type              | Default | Description                    |
| ---------- | ----------------- | ------- | ------------------------------ |
| `limit`    | integer, 1–100    | `100`   | Maximum results.               |
| `cursor`   | UUID              | —       | Continue after this NGO ID.    |
| `verified` | `true` or `false` | —       | Filter by verification status. |

Lists verified and unverified NGOs.

```json
{
  "ngos": [
    {
      "id": "<UUID>",
      "ownerAddress": "<STELLAR_PUBLIC_KEY>",
      "name": "Example Aid",
      "displayName": null,
      "verified": false,
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>"
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/ngos/lookup`

**Auth:** Public  
**Query params:** `address` (required): Stellar public key (`G` followed by
55 base32 characters).

Looks up an NGO profile by its owner address. This endpoint is public and
returns a profile whether or not the NGO is verified. This intentionally
differs from `GET /v1/ngos`, which lists verified NGOs only. For an unverified
or placeholder NGO, `verified` is `false`; `name` and approved-application
fields (`description`, `website`, and `country`) can be `null`. The lookup
does not expose pending application details. Returns `400
{"error":"invalid_request"}` for an invalid address and `404
{"error":"not_found"}` if there is no matching NGO. The response has the same
shape as `GET /v1/ngos/{id}`; see that endpoint's example response.

### `GET /v1/ngos/{id}`

**Auth:** Public  
**Path params:** `id` (required): NGO UUID.

Returns an NGO profile, impact totals, and up to ten recent streams for
verified, unverified, and placeholder NGOs. This public ID lookup is not a
verification check: callers must inspect `verified` before treating an NGO as
approved. Placeholder records can have `registered: false` and `name: null`;
unverified records can have `verified: false` and `null` approved-application
fields (`description`, `website`, and `country`). Pending application details
remain private. Returns
`400 {"error":"invalid_request"}` for an invalid ID or
`404 {"error":"not_found"}` if no NGO exists.

```json
{
  "id": "<UUID>",
  "ownerAddress": "<STELLAR_PUBLIC_KEY>",
  "name": "Example Aid",
  "displayName": null,
  "verified": true,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>",
  "registered": true,
  "description": "Supporting local communities.",
  "website": "https://example.org",
  "country": "Example",
  "stats": {
    "totalCommitted": "12000",
    "committedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "12000" }],
    "totalWithdrawn": "2000",
    "activeStreamCount": 2,
    "donorCount": 3
  },
  "recentStreams": [
    {
      "id": "<UUID>",
      "donor": { "address": "<STELLAR_PUBLIC_KEY>" },
      "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>",
      "rate": "100",
      "balance": "1000",
      "withdrawn": "200",
      "status": "ACTIVE",
      "createdAt": "<ISO-8601>",
      "onChainId": "42"
    }
  ],
  "recentStreamsNextCursor": null
}
```

`description`, `website`, and `country` are `null` when no approved
application supplies them. The public `name` uses the display name when one
is set; `registered` indicates whether an on-chain registry name exists.

### `GET /v1/ngos/{id}/donors`

**Auth:** Public  
**Path params:** `id` (required): NGO UUID.  
**Query params:** `limit` (integer, 1–100, default `100`) and `cursor` (donor
UUID, optional).

Lists donors with streams for this NGO. `committedByToken` reports each
token's committed amount separately; `totalCommitted` remains as a legacy
decimal-string field. Returns `400 {"error":"invalid_request"}` for invalid
parameters and `404 {"error":"not_found"}` if the NGO does not exist.
Responses include an `ETag` and `Cache-Control` with a 30-second public
max-age; send `If-None-Match` to receive `304 Not Modified` when unchanged.

```json
{
  "donors": [
    {
      "id": "<UUID>",
      "address": "<STELLAR_PUBLIC_KEY>",
      "totalCommitted": "1200",
      "committedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "1200" }]
    }
  ],
  "nextCursor": null
}
```

### `PATCH /v1/admin/ngos/{id}`

**Auth:** Admin signature  
**Path params:** `id` (required): NGO UUID.  
**JSON body:** `displayName` (optional; string or `null`).

Updates the public display name. Returns the updated NGO record with `name`
set to the display name when present, otherwise its registered name. Returns
`400 {"error":"invalid_request"}` for invalid input and
`404 {"error":"not_found"}` if the NGO does not exist.

```json
{
  "id": "<UUID>",
  "ownerAddress": "<STELLAR_PUBLIC_KEY>",
  "name": "Example Aid",
  "displayName": "Example Aid",
  "verified": true,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

## Donors

### `GET /v1/donors`

**Auth:** Public  
**Query params:**

| Name     | Type                       | Default     | Description                   |
| -------- | -------------------------- | ----------- | ----------------------------- |
| `sort`   | `committed` or `withdrawn` | `committed` | Amount used to rank donors.   |
| `order`  | `asc` or `desc`            | `desc`      | Sort direction.               |
| `limit`  | integer, 1–100             | `100`       | Maximum results.              |
| `cursor` | UUID                       | —           | Continue after this donor ID. |

Returns donor totals across all streams.
Each donor includes `committedByToken`, an array of `{ tokenAddress, amount }`
entries, so committed amounts in different assets are reported independently.
The legacy `totalCommitted` field remains available.
Responses include an `ETag` and `Cache-Control` with a 30-second public
max-age; send `If-None-Match` to receive `304 Not Modified` when unchanged.

```json
{
  "donors": [
    {
      "id": "<UUID>",
      "address": "<STELLAR_PUBLIC_KEY>",
      "createdAt": "<ISO-8601>",
      "totalCommitted": "1200",
      "committedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "1200" }],
      "totalWithdrawn": "200"
    }
  ],
  "nextCursor": null
}
```

Invalid query parameters or an unknown cursor return
`400 {"error":"invalid_request"}`.

### `GET /v1/donors/{address}`

**Auth:** Public  
**Path params:** `address` (required): Stellar public key (`G` followed by
55 base32 characters).

Returns one donor's totals, number of active streams, and distinct NGO count.
`committedByToken` reports committed amounts separately for each token; the
legacy `totalCommitted` field remains available.
Responses include an `ETag` and `Cache-Control` with a 30-second public
max-age; send `If-None-Match` to receive `304 Not Modified` when unchanged.
Returns `400 {"error":"invalid_request"}` for an invalid address and
`404 {"error":"not_found"}` if no donor exists.

```json
{
  "id": "<UUID>",
  "address": "<STELLAR_PUBLIC_KEY>",
  "createdAt": "<ISO-8601>",
  "totalCommitted": "1200",
  "committedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "1200" }],
  "totalWithdrawn": "200",
  "activeStreamCount": 2,
  "distinctNgoCount": 1
}
```

## Streams

### `GET /v1/streams`

**Auth:** Public  
**Query params:**

| Name         | Type                     | Default | Description                    |
| ------------ | ------------------------ | ------- | ------------------------------ |
| `donor`      | Stellar public key       | —       | Filter by donor address.       |
| `ngo`        | UUID                     | —       | Filter by NGO ID.              |
| `ngoAddress` | Stellar public key       | —       | Filter by NGO owner address.   |
| `token`      | Stellar contract address | —       | Filter by token contract.      |
| `status`     | `ACTIVE` or `CANCELLED`  | —       | Filter by stream status.       |
| `limit`      | integer, 1–100           | `100`   | Maximum results.               |
| `cursor`     | UUID                     | —       | Continue after this stream ID. |

Returns streams newest first. On-chain integer values are serialized as
decimal strings.

```json
{
  "streams": [
    {
      "id": "<UUID>",
      "onChainId": "42",
      "donorId": "<UUID>",
      "ngoId": "<UUID>",
      "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>",
      "rate": "100",
      "lastRate": null,
      "balance": "1000",
      "withdrawn": "200",
      "status": "ACTIVE",
      "createdTxHash": "<TRANSACTION_HASH>",
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>",
      "donor": { "address": "<STELLAR_PUBLIC_KEY>" },
      "ngo": {
        "id": "<UUID>",
        "name": "Example Aid",
        "displayName": null,
        "ownerAddress": "<STELLAR_PUBLIC_KEY>",
        "registered": true
      }
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

Invalid filters return `400 {"error":"invalid_request"}`.

### `GET /v1/streams/{id}`

**Auth:** Public  
**Path params:** `id` (required): stream UUID.

Returns one stream in the same shape as an item from
`GET /v1/streams`. Returns `400 {"error":"invalid_request"}` for an invalid
ID and `404 {"error":"not_found"}` if no stream exists. Example response: the
single stream object shown in the `GET /v1/streams` example (without the
`streams`, `hasMore`, and `nextCursor` wrapper).

### `GET /v1/streams/{id}/activity`

**Auth:** Public  
**Path params:** `id` (required): stream UUID.  
**Query params:** `limit` (integer, 1–100, default `100`) and `cursor` (event
UUID, optional).

Returns the stream's indexed activity newest first. `streamId` is a decimal
string or `null`. Responses include an `ETag` and `Cache-Control` with a
30-second public max-age; send `If-None-Match` to receive `304 Not Modified`
when unchanged.

```json
{
  "events": [
    {
      "id": "<UUID>",
      "type": "created",
      "streamId": "42",
      "ledger": 123450,
      "txHash": "<TRANSACTION_HASH>",
      "payload": {
        "donor": "<STELLAR_PUBLIC_KEY>",
        "ngo": "<STELLAR_PUBLIC_KEY>",
        "token": "<STELLAR_CONTRACT_ADDRESS>",
        "deposit": "1000",
        "rate": "100"
      },
      "createdAt": "<ISO-8601>"
    }
  ],
  "hasMore": false
}
```

Returns `400 {"error":"invalid_request"}` for invalid parameters and
`404 {"error":"not_found"}` if the stream does not exist.

## Impact

### `GET /v1/impact`

**Auth:** Public  
**Params:** None.

Returns platform-wide totals, including `committedByToken` entries with each
token's committed amount.

```json
{
  "totalCommitted": "12000",
  "committedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "12000" }],
  "totalWithdrawn": "2000",
  "activeStreams": 4,
  "verifiedNgoCount": 3
}
```

### `GET /v1/impact/{ngoId}`

**Auth:** Public  
**Path params:** `ngoId` (required): NGO UUID.

Returns impact totals for one NGO and its share of platform-wide committed
funds. `committedByToken` and `platformCommittedByToken` report the NGO and
platform committed amounts per token. Returns `400 {"error":"invalid_request"}` for a malformed UUID and
`404 {"error":"not_found"}` if no NGO exists.

```json
{
  "ngoId": "<UUID>",
  "name": "Example Aid",
  "totalCommitted": "5000",
  "committedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "5000" }],
  "platformCommittedByToken": [{ "tokenAddress": "<STELLAR_CONTRACT_ADDRESS>", "amount": "12000" }],
  "totalWithdrawn": "1200",
  "activeStreams": 2,
  "cancelledStreams": 1,
  "uniqueDonors": 3,
  "platformSharePercent": 41.67
}
```

## NGO applications

### `POST /v1/ngo-applications/challenge`

**Auth:** Public

**JSON body:** `ownerAddress` (required): applicant's Stellar public key.

Issues a one-use challenge that expires after five minutes. Sign the returned
`message` with the owner's Stellar wallet using SEP-53 generic message signing.
The response contains `challenge`, `message`, and `expiresAt`.

### `POST /v1/ngo-applications`

**Auth:** Public  
**JSON body:**

| Name           | Type                         | Required | Description                                            |
| -------------- | ---------------------------- | -------- | ------------------------------------------------------ |
| `ownerAddress` | Stellar public key           | Yes      | Applicant's wallet address.                            |
| `name`         | string, 1–200 characters     | Yes      | Organization name.                                     |
| `description`  | string, 1–5000 characters    | Yes      | Organization description.                              |
| `contactEmail` | email string                 | Yes      | Contact email.                                         |
| `website`      | URL string                   | No       | Website; a missing scheme is normalized to `https://`. |
| `country`      | string, up to 100 characters | No       | Country.                                               |
| `challenge`    | UUID                         | Yes      | Unexpired challenge issued for this owner address.     |
| `signature`    | string                       | Yes      | SEP-53 signature of the issued challenge `message`.    |

Create a challenge first, then include its `challenge` and a signature of its
exact `message` in the application body. A challenge can be used only once.
Creates a pending application and returns `201` with the application record.
Returns `400 {"error":"invalid_request"}` for an invalid body,
`400 {"error":"invalid_or_expired_challenge"}` for a missing, used, or expired
challenge, or `401 {"error":"invalid_signature"}` when the signature does not
match the challenge owner,
`409 {"error":"already_approved"}` if this address already has an approved
application, or `409 {"error":"application_already_pending"}` if one is
pending.

```json
{
  "id": "<UUID>",
  "ownerAddress": "<STELLAR_PUBLIC_KEY>",
  "name": "Example Aid",
  "description": "Supporting local communities.",
  "website": "https://example.org",
  "contactEmail": "contact@example.org",
  "country": "Example",
  "status": "PENDING",
  "reviewNote": null,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

### `GET /v1/ngo-applications/status`

**Auth:** Public  
**Query params:** `ownerAddress` (required): applicant's Stellar public key.

Returns only the most recent application's status and timestamps; it does not
expose application contact details or description. Returns
`400 {"error":"invalid_request"}` for an invalid address and
`404 {"error":"not_found"}` if there is no application.

```json
{
  "status": "PENDING",
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

### `GET /v1/ngo-applications/stats`

**Auth:** Admin signature  
**Params:** None.

Returns counts grouped by application status.

```json
{
  "counts": { "PENDING": 2, "APPROVED": 4, "REJECTED": 1 },
  "total": 7
}
```

### `GET /v1/ngo-applications`

**Auth:** Admin signature  
**Query params:** `status` (`PENDING`, `APPROVED`, or `REJECTED`, optional),
`limit` (integer, 1–100, default `100`), and `offset` (integer, 0–10000,
default `0`). An `offset` above 10000 returns `400 invalid_request`.

Returns application records and the total count matching the optional status.
Records are ordered newest first, with `id` (descending) as a tie-breaker so
pages are stable when several applications share a creation time.

```json
{
  "applications": [
    {
      "id": "<UUID>",
      "ownerAddress": "<STELLAR_PUBLIC_KEY>",
      "name": "Example Aid",
      "description": "Supporting local communities.",
      "website": "https://example.org",
      "contactEmail": "contact@example.org",
      "country": "Example",
      "status": "PENDING",
      "reviewNote": null,
      "createdAt": "<ISO-8601>",
      "updatedAt": "<ISO-8601>"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

### `GET /v1/ngo-applications/{id}`

**Auth:** Admin signature  
**Path params:** `id` (required): application UUID.

Returns one application record. Returns `400 {"error":"invalid_request"}`
for an invalid ID and `404 {"error":"not_found"}` if none exists. Example
response: the application object shown in the `POST /v1/ngo-applications`
example, with its current status and review note.

### `POST /v1/ngo-applications/{id}/approve`

**Auth:** Admin signature  
**Path params:** `id` (required): application UUID.  
**JSON body:** `reviewNote` (optional string, up to 2000 characters); an empty
JSON object is also valid.

Approves a pending application and returns the updated application record.
Returns `400 {"error":"invalid_request"}` for invalid input,
`404 {"error":"not_found"}` if no application exists, or
`409 {"error":"already_reviewed"}` if it is no longer pending. Example
response: the application object shown in the `POST /v1/ngo-applications`
example, with `status` set to `APPROVED` and `reviewNote` set if supplied.

### `POST /v1/ngo-applications/{id}/reject`

**Auth:** Admin signature  
**Path params:** `id` (required): application UUID.  
**JSON body:** `reviewNote` (optional string, up to 2000 characters); an empty
JSON object is also valid.

Rejects a pending application and returns the updated application record.
Returns `400 {"error":"invalid_request"}` for invalid input,
`404 {"error":"not_found"}` if no application exists, or
`409 {"error":"already_reviewed"}` if it is no longer pending. Example
response: the application object shown in the `POST /v1/ngo-applications`
example, with `status` set to `REJECTED` and `reviewNote` set if supplied.

## Indexer

### `GET /v1/indexer/status`

**Auth:** Public  
**Params:** None.

Returns contract configuration and the latest indexer checkpoint. Ledger
values are `null` when no contracts are configured or no checkpoint is
available.

```json
{
  "configured": true,
  "checkpointLedger": 123450,
  "updatedAt": "<ISO-8601>",
  "latestLedger": 123455,
  "ledgerLag": 5
}
```

### `GET /v1/admin/dead-letters`

**Auth:** Admin signature  
**Query params:**

- `limit` (optional integer, 1–100, default 100): maximum items to return.
- `cursor` (optional UUID): ID of the last item from the previous page for keyset pagination.
- `resolved` (optional string, `true` or `false`): filter by resolution status (`resolvedAt != null` vs `resolvedAt == null`). Omit to return both.

Returns paginated records of failed contract events recorded in `indexer_dead_letters`. Returns `400 {"error":"invalid_request"}` for invalid query parameters, `200` with an empty page and the matching filtered `total` for a well-formed cursor UUID that is not present, and `401 {"error":"unauthorized"}` for missing or invalid admin signatures. Pagination uses the ordered `(createdAt, id)` tuple as its boundary, including when multiple records share a timestamp.

```json
{
  "deadLetters": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "eventId": "0000123450-0000000001",
      "ledger": 123450,
      "contractId": "CCPWQBI7FV2CZ7EECOVZ5XHOHK5S7CS6XTBDWPWHBEOKPTIASNGOBQFH",
      "error": "TypeError: Cannot read properties of undefined",
      "topic": ["AAAA..."],
      "value": "AAAA...",
      "txHash": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "attempts": 1,
      "resolvedAt": null,
      "createdAt": "2026-10-21T05:00:00.000Z",
      "updatedAt": "2026-10-21T05:00:00.000Z"
    }
  ],
  "total": 1,
  "hasMore": false,
  "nextCursor": null
}
```

## Interactive API documentation

In non-production environments, Swagger UI is available at `/docs` and the
OpenAPI JSON document at `/docs/json`.
