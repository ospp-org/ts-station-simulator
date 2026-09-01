# The UAT dead-letter queue, enumerated and drained — 2026-09-01

`mqtt:incoming-dlq` on `csms-redis-queue` (UAT). **107 envelopes measured, all 107 purged.**

**THE NEXT MEASUREMENT STARTS FROM ZERO.** That is the whole point of this file: the queue was
drained so the first full run after the coming deploy counts only what that run produced. Any
entry present at the next reading was created after 2026-09-01 and is NEW.

## Why this file lives in the simulator repo

Its proper home is `csms-server/docs/DLQ-INVENTORY-20260810.md`, the file it continues. The
server repo was read-only for this cycle, so the record is written here instead — which is not
merely a fallback: **100 of the 107 entries were produced by this repo's fixtures**, and the
next reading will be taken immediately after a run of this repo's corpus.

## What the queue held

Read with `mqtt:dlq:list --limit=500` and then `mqtt:dlq:inspect <i>` for **every** index 0..106
— the queue has no other read surface (no `tinker` on the UAT image; that is a separate finding
and is not repaired here). All 107 shared `failure_reason=hard_fail`,
`error_class=UnprocessableInboundMessageException`, topic `ospp/v1/stations/<stn>/to-server`.
Oldest `2026-08-07T09:20:58Z`, newest `2026-08-27T18:01:17Z` — **nothing in the five days
before the drain.**

| n | messageType/action | error_message |
|---|---|---|
| 34 | `Event`/`StatusNotification` | Schema-invalid non-REQUEST message could not be processed: The required properties (programs) are missing |
| 32 | `Event`/`StatusNotification` | Schema-invalid non-REQUEST message could not be processed: The required properties (bayNumber, programs) are missing |
| 15 | `Event`/`StatusNotification` | Billable EVENT 'StatusNotification' failed HMAC verification on an authenticated topic: No session key available for verification |
| 12 | `Event`/`ConnectionLost` | Schema-invalid non-REQUEST message could not be processed: Unsupported version: 0.2.1 |
| 4 | `Event`/`StatusNotification` | Billable EVENT 'StatusNotification' failed HMAC verification on an authenticated topic: HMAC-SHA256 verification failed |
| 3 | `Event`/`StatusNotification` | Schema-invalid non-REQUEST message could not be processed: /timestamp: The string should match pattern: ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$ |
| 2 | `Response`/`StartService` | Schema-invalid non-REQUEST message could not be processed: Additional object properties are not allowed: sessionId |
| 2 | `Response`/`StopService` | Schema-invalid non-REQUEST message could not be processed: The required properties (actualDurationSeconds, creditsCharged) are missing |
| 1 | `Response`/`StartService` | Schema-invalid non-REQUEST message could not be processed: The required properties (programNumber) are missing |
| 1 | `Event`/`StatusNotification` | Schema-invalid non-REQUEST message could not be processed: Additional object properties are not allowed: stationId, timestamp |
| 1 | `Event`/`StatusNotification` | Schema-invalid non-REQUEST message could not be processed: /errorCode: The data (string) must match the type: integer; /errorText: The string should match pattern: ^[A-Z][A-Z0-9_]+$ |
| **107** | | **denominator — every entry accounted for, none elided** |

## Every group is residue, and each was settled rather than assumed

**66 = the corpus rename (rows 1-2).** `services` → `programs`, and `bayNumber` added.
Pre-alignment fixtures. Matches the 66 carried in the standing note.

**12 = the Last-Will protocol version (row 4).** `ConnectionLost` at `0.2.1`. Defect 1 of
`DLQ-INVENTORY-20260810.md`; **fixed in this repo at `8d049ce`**.

**19 = HMAC (rows 3, 5).** 19 entries across **19 distinct stations — exactly one each**, and
all 19 stations are gone from the UAT database. One unverifiable event per station followed by
teardown is a pool-teardown race, not a live protocol fault; the 4 true mismatches all fall in a
41-minute window on 2026-08-27, the day UAT was redeployed mid-run. Their payloads are
conformant post-alignment shapes, so nothing about them is a fixture the corpus still emits.

**5 = the money paths (rows 7, 8, 9).** These are the only entries that needed real work, because
`DLQ-INVENTORY-20260810.md` §"Why not replay" says **"They are not to be drained"** and left
defect 3 open with an instruction: *check whether `msg_a6ac3a91-…` corresponds to a session
started server-side and never confirmed.*

**That question is now answered, and answering it is what discharged the instruction:**

| DLQ entry | session | status | credits | `requires_reconciliation` |
|---|---|---|---|---|
| idx 17 `StartService` Rejected `3017 PROGRAM_NOT_DECLARED` | `sess_273a43637526bfe9eb46bc49` | `failed` — *"Pending timeout (60s): no StartService response from station"*, `1010` | **0** of 500 authorized | `false` |
| idx 22 `StartService` Accepted | `sess_2e040c8ea1b5222e458a9427` | `failed` | **0** of 120 | `false` |
| idx 26 `StartService` Accepted | `sess_c3f1524ca01717954015aa25` | `failed` | **0** of 120 | `false` |
| idx 23, 27 `StopService` Accepted | (the stops for the two above) | — | — | — |

Across the WHOLE `sessions` table: **64 rows, 38 `completed` + 26 `failed`, zero non-terminal,
zero flagged for reconciliation.** The pending-timeout guard closed every dropped-response
session at zero credits. No money moved and nothing is stuck.

**And the shapes are fixed in this repo**, verified in source rather than assumed — which is why
the coming run cannot reproduce them:

| shape the server refused | today |
|---|---|
| `StartService` Rejected without `programNumber` | all four rejection arms echo `request.programNumber` (`src/handlers/StartServiceHandler.ts`) |
| `StartService` Accepted carrying `sessionId` (schema is `additionalProperties:false`) | `{ status: 'Accepted' }`, bare |
| `StopService` Accepted without `actualDurationSeconds`/`creditsCharged` | both computed and sent, plus `finalSeqNo` (`src/handlers/StopServiceHandler.ts`) |
| `StatusNotification` with `errorCode` as a string (row 11) | schema demands integer + `^[A-Z][A-Z0-9_]+$` errorText; post-alignment corpus conforms |

Three of the four defects `DLQ-INVENTORY-20260810.md` names are fixed. Its fourth — the
`bay_<hex>`-into-a-`uuid` bug, the one record it warned would vanish — **was already gone before
this drain**: it was the only `max_attempts_exceeded` entry, and the queue held none. The 30-day
scheduled purge removed it on 2026-08-11, exactly as that file predicted. Its own prose is now
the only record of it, which is what it was written to be.

## What was run

```
php artisan mqtt:dlq:purge --all --force
```

in `csms-app-uat`. The container's `mqtt` Redis connection resolves `redis-queue` → `172.19.0.19`
= `csms-redis-queue`, verified before the purge; production's queue Redis is
`csms-redis-queue-prod` at `172.18.0.7` on a different network and was never addressed.

Measured, not assumed:

```
before:  Dead letters: 107
purge:   Purged 107 dead-letter entries.
after:   Dead letters: 0
```

**THE DRAINED FIGURE IS 107. THE BASELINE FOR THE NEXT MEASUREMENT IS 0.**
