# Indexer

The indexer polls the Stellar RPC for contract events emitted by the two
StreamGive smart contracts and writes the results into the PostgreSQL database.
It runs as a background loop inside the same Node.js process as the API server
(see [`src/indexer/worker.ts`](../src/indexer/worker.ts)).

## Watched contracts

| Env var                      | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `NGO_REGISTRY_CONTRACT_ID`   | Tracks NGO registrations and admin approvals                     |
| `DONATION_VAULT_CONTRACT_ID` | Tracks streaming donation lifecycle (create / withdraw / cancel) |

Both ids are optional. The indexer no-ops until at least one is set.

## Event table

Each row shows one on-chain event topic, whether the indexer handles it, and
which database rows it creates or updates when it does. Every handled event also
persists an immutable audit record to the `stream_events` table (`StreamEvent` model)
within the same transaction as its primary state mutation.

### ngo-registry contract

| Topic      | Handled | DB writes                                                                                                                                                                                                                        |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register` | Yes     | Upserts `ngos` row (`ownerAddress`, `name`, `verified = false`). Updates `name` if the row already exists. Writes a `StreamEvent` row (`type = 'register'`). Emits an `ngo_registered` notification. |
| `approved` | Yes     | Sets `verified = true` on the matching `ngos` row via `updateMany` (no-ops if the row does not exist yet — safe for a mid-history start). Writes a `StreamEvent` row (`type = 'approved'`). Emits a `ngo_approved` notification. |
| `revoked`  | Yes     | Sets `verified = false` on the matching `ngos` row via `updateMany` (no-ops if the row does not exist yet). Writes a `StreamEvent` row (`type = 'revoked'`). Emits a `ngo_revoked` notification.                                 |

Handler: [`src/indexer/handlers/ngoRegistry.ts`](../src/indexer/handlers/ngoRegistry.ts)

### donation-vault contract

| Topic      | Handled | DB writes                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created`  | Yes     | Upserts `donors` and `ngos` rows for the involved addresses (creating placeholders if unseen), then upserts a `streams` row with `status = ACTIVE`, initial `balance`, and `withdrawn = 0`. Writes a `StreamEvent` row (`type = 'created'`). Emits a `stream_created` webhook notification.                                                                |
| `withdraw` | Yes     | Subtracts the accrued amount from `streams.balance` and adds it to `streams.withdrawn`. No-ops if the stream row does not exist or is already `CANCELLED`. Writes a `StreamEvent` row (`type = 'withdraw'`). Emits a `stream_withdrawn` notification.                                                                                                      |
| `cancel`   | Yes     | Adds the settled amount to `streams.withdrawn`, zeroes `balance` and `rate`, sets `status = CANCELLED`. No-ops if the stream row does not exist or is already `CANCELLED`. Writes a `StreamEvent` row (`type = 'cancel'`). Emits a `stream_cancelled` notification.                                                                                        |
| `topup`    | No      | The event only publishes the new deposit amount, not how much accrued and settled to the NGO during the same call, so the post-topup balance cannot be reconstructed from the payload alone without either a contract read or duplicating the accrual math. Tracked in [tracking issue #274](https://github.com/StreamGive/streamgive-backend/issues/274). |
| `ratemod`  | No      | Same reason as `topup` — the new rate is known but the accrual that settled at the moment of the rate change is not. Tracked in [tracking issue #274](https://github.com/StreamGive/streamgive-backend/issues/274).                                                                                                                                        |

Handler: [`src/indexer/handlers/donationVault.ts`](../src/indexer/handlers/donationVault.ts)

### StreamEvent writes

In addition to mutating state models (`ngos`, `donors`, `streams`), every handled event
creates an audit log entry in the `stream_events` table (`StreamEvent` Prisma model)
in the same database transaction. Each row records:

- `type`: The event topic (`register`, `approved`, `revoked`, `created`, `withdraw`, `cancel`).
- `streamId`: The on-chain stream ID for donation-vault events, or `null` for ngo-registry events.
- `ledger`: The ledger sequence number containing the event.
- `txHash`: The transaction hash of the triggering transaction.
- `payload`: The structured event data serialised to JSON.

These audit rows provide an immutable event log for activity feeds, reconciliation, and debugging.

## Soroban event decoding assumptions

The handlers below use `scValToNative` followed by TypeScript casts; they do
not validate the decoded values against a runtime schema. Topic positions
listed here are the positions the handler reads. The event name is a Soroban
symbol in topic position 0.

| Contract       | Event      | Topic values decoded after the event name | Value decoded                                                                                                                                                      |
| -------------- | ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ngo-registry   | `register` | Position 1: owner address (`ScAddress`).  | String (`ScString`), used as the NGO name.                                                                                                                         |
| ngo-registry   | `approved` | Position 1: owner address (`ScAddress`).  | Not read by the handler.                                                                                                                                           |
| ngo-registry   | `revoked`  | Position 1: owner address (`ScAddress`).  | Not read by the handler.                                                                                                                                           |
| donation-vault | `created`  | Position 1: stream ID (`u64`).            | Vector of five values, in order: donor address (`ScAddress`), NGO address (`ScAddress`), token address (`ScAddress`), initial deposit (`i128`), and rate (`i128`). |
| donation-vault | `withdraw` | Position 1: stream ID (`u64`).            | Accrued amount (`i128`).                                                                                                                                           |
| donation-vault | `cancel`   | Position 1: stream ID (`u64`).            | Vector of two values, in order: accrued amount (`i128`) and refund (`i128`).                                                                                       |

These are the shapes the current handler code assumes, not runtime-enforced
schemas. A mismatch can make `scValToNative`, destructuring, or a later
conversion throw. The worker catches handler failures, records the event as a
dead letter, and advances the checkpoint when that record succeeds. See the
related [malformed-event hardening issue #85](https://github.com/StreamGive/streamgive-backend/issues/85).

## Checkpoint

The indexer stores its progress in the `indexer_checkpoints` table (a single row
with `id = 'main'`), persisting both `lastLedger` and `lastEventId`. On startup,
it reads this row and resumes from the stored event cursor (`cursor: lastProcessedEventId`).
If no cursor is saved (for example, on the initial run or when an idle scan
advanced the checkpoint to the tip without processing events), it queries from
`startLedger: lastLedger + 1`. Resuming from the event cursor ensures a restart
never re-processes already-seen events while never skipping remaining events in
the same ledger.

**First run** — if no checkpoint row exists the indexer writes the current
ledger (or `INDEXER_START_LEDGER` if configured) as the starting point and
returns without fetching events. The next poll picks up from there, so only
events emitted _after_ the first startup are indexed; the contract's full
history is not back-filled.

**Per-event checkpointing** — the checkpoint (`lastLedger` and `lastEventId`) is
saved after each individual event, not once per batch. Several handlers apply
relative deltas (`balance -= accrued`, etc.), so replaying an already-applied
event after a crash would double-count it. Saving after each event bounds the
damage to "at most the in-flight event" on a crash.

### Failed events

A handler decodes an event's payload with unchecked casts, so an event whose
shape does not match what the handler expects throws. That throw used to
escape the poll loop before the checkpoint was saved, which meant the same
event came back on the next poll, threw again, and blocked every later event
behind it — permanently, since re-reading an undecodable event never makes it
decodable.

Each event is now handled in isolation. A failure is logged, recorded in the
`indexer_dead_letters` table (keyed on the RPC's event id, with the ledger,
contract id and the error message), and the checkpoint advances past it as
normal, so one bad event costs exactly that event rather than the whole
indexer.

Nothing reads those rows automatically — they exist so a failure is
inspectable and replayable rather than silently dropped. Inspect them with:

```sql
SELECT event_id, ledger, contract_id, error FROM indexer_dead_letters ORDER BY ledger;
```

Recording a dead letter is deliberately _not_ fault-tolerant. If that write
throws, the database is unreachable — a transient fault, not a bad event — and
letting it propagate leaves the checkpoint unmoved so the event is retried on
the next poll instead of being skipped over a blip.

### Out-of-window behaviour

The Stellar RPC only retains a sliding window of recent ledgers. The window is
configured per endpoint and reported by `getHealth` as `ledgerRetentionWindow`:
public Mainnet endpoints are typically ~17,280 ledgers (~24 hours), while the
public Testnet endpoint that [`render.yaml`](../render.yaml) deploys against
reports 120,960 (~7 days). It rejects a `getEvents` call whose `startLedger`
falls outside that window with a JSON-RPC `-32600` error.

Two ways the checkpoint can fall outside the window:

| Scenario                        | What happens                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ahead of the tip**            | The indexer checkpoints at the latest ledger, so the very next poll asks for `latest + 1`, which has not closed yet. The poll returns immediately and waits for the next interval — no action needed.                                                                                                                                                                               |
| **Behind the retention window** | If the process is down for longer than the RPC's retention period, the saved checkpoint ages out. The indexer detects the `-32600` error, logs a warning that events in the gap were missed, skips the checkpoint forward to the current ledger, and resumes. This keeps the indexer running rather than looping on a permanent error, at the cost of a gap in the indexed history. |

Skipping the gap is permanent for the running indexer: the missed contract
events are not fetched later. As a result, database projections may be missing
or stale, including NGO registrations and approvals and stream creation,
withdrawal, or cancellation state. Restarting the process does not recover
them because the checkpoint has already advanced. The verification
reconciliation script can repair NGO `verified` flags, but it does not replay
the other event effects.

The skip-forward warning is intentionally loud:

```
indexer: checkpoint <N> has aged out of the RPC's retention window —
skipping to ledger <M>. Events in between were missed and will not be indexed.
```

To recover complete history, replay the missed ledger range from an archive
RPC and reconcile the affected database projections. This is not automated;
use a purpose-built reindex/backfill process rather than simply moving the
checkpoint backward, which could apply relative stream balance changes twice.
The planned tooling is tracked in the [backfill issue #11](https://github.com/StreamGive/streamgive-backend/issues/11).

## Verification reconciliation

If the indexer misses an `approved` / `revoked` event (e.g. because the
checkpoint aged out of the RPC retention window), an NGO's `verified` flag
can drift from the on-chain truth. The reconciliation script reads each NGO's
verified status directly from the ngo-registry contract and compares it against
the database, reporting (and optionally fixing) any mismatches.

### Running it

The script lives at [`src/scripts/reconcileVerification.ts`](../src/scripts/reconcileVerification.ts).
It requires `NGO_REGISTRY_CONTRACT_ID` and a Stellar RPC endpoint to be set
(the same environment variables the indexer uses), and access to the database.

Report only (default) — prints mismatches:

```bash
npx tsx src/scripts/reconcileVerification.ts
```

Apply fixes — updates the database to match on-chain status:

```bash
npx tsx src/scripts/reconcileVerification.ts --fix
```

The script exits with code 0 when no mismatches are found, and exits with code 1
if any mismatches are detected (even when `--fix` is passed and repairs them).

## Polling and backoff

The indexer polls on a self-rescheduling timer rather than a fixed
`setInterval`: each poll schedules the next one only once it has settled. Two
things follow from that. Polls can never overlap, however slow the RPC is. And
a failed poll decides when the next attempt happens, instead of the interval
timer firing regardless of how the previous one went.

A healthy indexer polls every `INDEXER_POLL_INTERVAL_MS` (default 5s). When a
poll fails — `getLatestLedger`, `getEvents`, or a throwing event handler — the
delay to the next poll doubles, up to a cap of 5 minutes:

| Consecutive failures               | 0   | 1   | 2   | 3   | 4   | 5   | 6    | 7+   |
| ---------------------------------- | --- | --- | --- | --- | --- | --- | ---- | ---- |
| Delay (at the default 5s interval) | 5s  | 5s  | 10s | 20s | 40s | 80s | 160s | 300s |

The first failure retries at the normal interval, so a single dropped request
costs nothing. The cap matters for two reasons: a long outage must not drift out
to a delay that looks like a hung indexer, and the indexer still re-checks the
endpoint at a predictable rate so recovery is detected within the cap.

The counter resets on the first poll that completes, so a single success drops
the delay straight back to `INDEXER_POLL_INTERVAL_MS` — one bad patch does not
leave the indexer crawling for the rest of its life.

Failed polls leave the checkpoint where it was, so retries re-scan the same
ledger range. The log line names the failure count and the next delay:

```
indexer poll failed (3 in a row) — retrying in 20000ms
```
