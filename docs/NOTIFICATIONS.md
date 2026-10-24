# Notification events

When `NOTIFY_WEBHOOK_URL` is set, the backend POSTs a JSON body to that URL for
each notification it emits. Every body is discriminated by its `type` field.
The matching TypeScript definitions live in
[`src/notifications/types.ts`](../src/notifications/types.ts).

All events may include an optional `eventId` — the on-chain event id used to
deduplicate deliveries and to retry failed sends. Deliveries are signed with
the `x-streamgive-signature` header as described in the "Notification events"
section of the [README](../README.md#notification-events).

## `ngo_registered`

Emitted when an NGO signs up through the `register` entry point of the
`ngo-registry` contract.

```json
{
  "type": "ngo_registered",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the newly registered NGO.
- `eventId` — optional; the on-chain event id for this registration.

## `ngo_approved`

Emitted when an admin approves a registered NGO.

```json
{
  "type": "ngo_approved",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

## `ngo_revoked`

Emitted when an admin revokes a verified NGO.

```json
{
  "type": "ngo_revoked",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

## `stream_created`

Emitted when a donor opens a new donation stream to an NGO.

```json
{
  "type": "stream_created",
  "streamId": "1234",
  "donorAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

## `stream_withdrawn`

Emitted when accrued funds are withdrawn to the NGO from an active stream.

```json
{
  "type": "stream_withdrawn",
  "streamId": "1234",
  "amount": "500000000",
  "eventId": "0000000100-0000000000"
}
```

- `amount` — the amount withdrawn, in the stream token's base units, as a
  string.

## `stream_cancelled`

Emitted when a stream is cancelled, settling accrued funds to the NGO and
refunding the remaining balance to the donor.

```json
{
  "type": "stream_cancelled",
  "streamId": "1234",
  "settledToNgo": "500000000",
  "refundToDonor": "1500000000",
  "eventId": "0000000100-0000000000"
}
```

## `application_submitted`

Emitted when an NGO application is submitted through the API.

```json
{
  "type": "application_submitted",
  "applicationId": "clx1y2z3...",
  "ownerAddress": "GABC...",
  "name": "Red Cross",
  "eventId": "0000000100-0000000000"
}
```

## `application_reviewed`

Emitted when an admin approves or rejects an NGO application.

```json
{
  "type": "application_reviewed",
  "applicationId": "clx1y2z3...",
  "ownerAddress": "GABC...",
  "status": "APPROVED",
  "reviewNote": "Verified against public records.",
  "eventId": "0000000100-0000000000"
}
```

- `status` — either `APPROVED` or `REJECTED`.
- `reviewNote` — optional admin review note.
