# The server's refusal paths, and how many the wire has ever touched

**Measured 2026-09-11** against csms-server `7e90dd94`, spec `v0.40.0`, `@ospp/protocol v0.38.0`,
simulator `ae79ee8` + working tree. UAT.

The question is not "how conformant is the simulator". It is **which server path never gets
exercised**, because the simulator is what validates the server.

---

## 1. What the server does when a station refuses — derived from the writers

Three surfaces, counted separately because they are reached by different bytes.

### S1 — the station answers a server command with a refusal

`MessageDispatcher::route()` (`MessageDispatcher.php:527-535`) routes every RESPONSE by **action
name only**; it never reads `payload.status` or `errorCode`. So the refusal is decided inside the
handler, and there are **15** registered response handlers
(`grep -rn registerResponseHandler app/`) carrying **16 refusal branch-points** — StopService has
two.

| branch-point | what the refusal does | class |
|---|---|---|
| StartService | `FailSessionAction(NeverStarted)` → full refund, every kind | **MONEY** |
| StopService, `errorCode == 3006` | `CompleteSessionAction(StationLostSession)` → UserDuration pro-rata, Fixed/MultiUnit **full refund** | **MONEY** |
| StopService, any other code | `forceCompleteFullDelivery` → bills `duration_requested`, **refund 0** | **MONEY** |
| ReserveBay | `reservations.status = CANCELLED` + `ReservationCancelled(StationRejected)` | STATE |
| CancelReservation | `station_journal` row | STATE |
| UpdateFirmware | `firmware_updates.status = failed` + journal | STATE |
| GetDiagnostics | `diagnostics_uploads.status = failed`, `failure_reason = rejected_by_station` + journal | STATE |
| ChangeConfiguration | `station_configurations.desired_status = rejected` | STATE |
| GetConfiguration, Reset, SetMaintenanceMode, UpdateServiceCatalog, CertificateInstall, TriggerCertificateRenewal, TriggerMessage, DataTransfer | `station_journal` row only | STATE ×8 |

**16 branch-points: 3 MONEY, 13 STATE, 0 COMPENSATION, 0 LOG-ONLY.**

**Not one of them is log-only.** `StationJournalRecorder::record()` is
`DB::table('station_journal')->insert(...)` (`StationJournalRecorder.php:449`) — a real table with
a real read surface (`GET /api/v1/admin/stations/{id}/journal`), not a log line. `12 of 15`
handlers write `KIND_COMMAND_REFUSED`; the three that do not are StartService (it fails the
session instead), ReserveBay (it cancels the reservation) and ChangeConfiguration (it writes the
desired-state columns). One caveat, stated because it is the difference between STATE and
nothing: every journal write goes through `JournalWrite::attempt()`, which catches `Throwable`,
`Log::critical`s "the observation is lost, the message it describes is not", and returns `null`
(`JournalWrite.php:59-72`). So the 8 journal-only arms are durable on the happy path and
recoverable nowhere if that insert throws. And `PendingCommandRegistry::resolve()` is an
`UPDATE pending_commands SET status='resolved'` on every arm, refusal included.

**The pair that matters most.** StopService's two arms are reached by the SAME message, the SAME
schema and the SAME shape. The only discriminator is one integer:

```php
// StopServiceResponseHandler.php:124
$desync = $dto->errorCode === OsppErrorCode::SESSION_NOT_FOUND->value;
```

On an AllOrNothing kind that integer is the difference between charging the customer everything
and refunding them everything.

### S2 — the station reports a failure on its own initiative

**13** request/event handlers; **11 of 13** branch on a failure condition (Heartbeat cannot — its
payload is schema-enforced `{}`; DataTransfer's two arms the spec itself calls "not an error").
**3 of 13** reach money: BootNotification (a non-reconnect reboot fails stuck sessions through
`FailSessionAction::settleForceFailed`), StatusNotification (`isFaulted()` → `BayFaulted` →
`FailSessionAction(BayFault)`, only when a session sits on that bay), and SessionEnded (7 arms,
all settling). **1** is compensation: ConnectionLost → `FailOfflineSessionJob`.

Worth naming because it inverts the expectation: **TransactionEvent and AuthorizeOfflinePass —
the offline-money surface — reach MONEY on ZERO of their rejection branches.** The debit at
`Reconciler.php:382` runs only after every check has passed.

### S3 — the station never answers

One sweeper, `command:check-timeouts`, every minute (`routes/console.php:27-30`). The claim
`UPDATE ... SET status='expired'` (`PendingCommandRegistry.php:488-493`) is universal STATE. Then
**15** per-action arms:

- **MONEY 2** — StartService (`NeverStarted`, full refund), StopService (`StopAckLost`, pro-rata)
- **COMPENSATION 1** — ReserveBay → sends a *new* `CancelReservation`
- **STATE 2** — UpdateFirmware, ChangeConfiguration
- **LOG-ONLY 10** — CancelReservation (a no-op by design; the row is already closed) plus **9**
  actions that hit `handleUncompensatedTimeout()` and only `Log::warning('no compensation arm')`

So the log-only category the brief asked about is **not** in the refusal paths at all. It is in
the **timeout** paths: `10 of 15`. A station that answers "no" is always recorded; a station that
says nothing is, for 9 of 15 commands, forgotten.

---

## 2. How many were exercised — with the denominator

### By the 149 scenarios, before this work

Parsed, not grepped: **668** `send` steps, **104** with `messageType: Response`, and **6** of
those are refusals — in **4** files, across **4** of the 14 answerable actions.

| action | Response sends | refusals |
|---|--:|--:|
| StartService | 46 | 1 |
| StopService | 9 | **0** |
| UpdateFirmware | 12 | 3 |
| CertificateInstall | 3 | 1 |
| ChangeConfiguration | 3 | 1 |
| ReserveBay · CancelReservation · Reset · SetMaintenanceMode · UpdateServiceCatalog · TriggerMessage · GetConfiguration · GetDiagnostics · DataTransfer | 33 | **0** |

**4 of the 16 branch-points, and 1 of the 3 MONEY branch-points.** Four distinct error codes ever
reached the server from this tool: `3017`, `5017`, `4011`, `5108` — **4 of 119**.

`sessions/stop-service-rejected.yaml` is not a counter-example, and it is the one worth naming: it
pins the number `3006`, but that 3006 is produced SERVER-side, pre-dispatch, for an unknown
sessionId, and the station never sees a StopService at all. Its header generalised that into "the
station-rejection path is no longer reachable," which is false for a session the server itself
created — and it was false about two money branches. Corrected in place.

### By the server's own PHP suites

**15 of 15** handlers have a refusal test, and **15 of 15** have an accept test. Both StopService
arms are covered at unit and integration level, including
`StopServiceResponseHandlerIntegrationTest` "on a MultiUnit session settles a FULL REFUND".

**So the finding is not "the server's refusal handling is untested."** It is tested in-process.
What had never happened is a refusal crossing a broker, against a real database, into real
settlement — which is the only place the fixture, the schema, the signing and the money agree or
disagree.

### After this work

**112** Response sends, **11** refusals, **8 of 14** actions, **9 of 16** branch-points, and
**3 of 3** MONEY branch-points. Distinct codes on the wire: **9 of 119** (`3006`, `3007`, `3014`,
`3017`, `4011`, `5017`, `5020`, `5024`, `5108`).

---

## 3. Which of the 41 absent refusals say anything about the server

A row counts if obeying it puts something on the wire that the server then HANDLES. A row that
only validates input and sends nothing says nothing about the server.

The 41 rows carry **42** rule labels (group C lists 6 labels over 5 rows). Adjudicated against the
spec text, label by label:

- **30 of 42** put a `Rejected` RESPONSE on the wire.
- **+2** — `N.r1`/`N.r2`, DataTransfer `UnknownVendor`/`UnknownData`. The spec says outright
  "MUST NOT respond with an error code — this is not an error condition"
  (`data-transfer.md` §5 r1), and the response schema has no `errorCode` field. But the SERVER
  routes both into `KIND_COMMAND_REFUSED` (`DataTransferResponseHandler.php:137-153`). By the
  spec's taxonomy they are not refusals; by the server's, they are.
- **+2** — `J.r3`/`J.r4`, firmware checksum and signature. These do NOT refuse: rule 1 makes the
  station answer `Accepted` and start downloading, so the failure arrives later as a
  `FirmwareStatusNotification` with `Failed` (and `5112` on a SecurityEvent, because the
  notification "carries no `errorCode` field and is closed to additional properties"). The server
  handles it — `FirmwareStatusNotificationHandler.php:150-161` writes `failure_reason` — but on a
  different message type.

**34 of 42 labels reach a server path. 8 do not** (33 of 41 excluding the offline row, which stays
last).

The 8, with the reason each is silent toward the server:

| label | why it says nothing |
|---|---|
| C · reserve-bay r7 | an identical repeat returns the **same `Accepted`** — not a refusal at all |
| G · change-configuration r2 | atomicity is invisible: the discarded key's own `results[]` entry still reads `Accepted` (`change-configuration.md` §8.4 worked example) |
| H · get-configuration WriteOnly | omitted from both arrays, and the spec says this is "not… an error" |
| M · trigger-message r7 | discards an earlier *pending* notification; nothing new is sent |
| O · dedup r1 | maintaining the seen-`messageId` set — internal bookkeeping, zero wire effect |
| O · dedup r3 | replays the **cached** response verbatim; mints nothing new |
| O · dedup r4 | a colliding-but-different payload "is not refused, it is *handled*" |
| O · discard-on-age | "MUST discard… SHOULD log a warning" — local log only |

Two citations in the gaps list are off by section and are corrected here: the `2001`-while-Booting
rule is `02-transport.md` **§4.1:324**, not §6.1 (which is topic ACLs); the discard-on-age rule is
**§5.1:461**, not §5.2 (which is never-expire messages).

Two rows are conditional rather than absolute. `L` / `05-state-machines.md:135` splits itself — "In
`Pending` that rejection is sent as a RESPONSE; in `Rejected` the command is not processed at all"
— so it is a refusal only for a `Pending` station. And `2001` is optional: the rule reads
"**MUST** be queued and processed after boot completes, **or** rejected with error `2001`", two
conforming paths of which only one reaches the wire.

---

## 4. What was added, and why a scenario rather than a handler

Scenario mode instantiates **1 of 20** handlers (`ScenarioRunner.ts:1358`), so none of the 41
refusals is reachable from a scenario however well the station is built. But a scenario can
**write** a refusal as easily as an acceptance: `SendStep` auto-correlates a `messageType:
Response` to the most recent unconsumed inbound Request of the same action
(`SendStep.ts:302-320`), so the server's `PendingCommandRegistry` resolves it exactly as it would
a real one. Nothing about how the simulator works had to change.

Four files, money first:

| file | code | server branch proven |
|---|---|---|
| `sessions/stop-service-refused-while-running-bills-full.yaml` | `3007` | full delivery — **500 charged, 0 refunded**, `settledAs: full_delivery` |
| `sessions/stop-service-refused-session-not-found-desync.yaml` | `3006` | `settledAs: StationLostSession` |
| `reservations/reserve-bay-refused-by-station.yaml` | `3014` | the promised reservation is **cancelled**, not left pending |
| `device-management/get-diagnostics-refused-invalid-time-window.yaml` | `5020` | `failure_reason: rejected_by_station` — distinct from the accept-then-fail arm's `reported_by_station` |
| `device-management/catalog-refused-keeps-the-previous-one.yaml` | `5024` | **zero catalog writes** — proven by a second publish reclaiming the same version |

All five pass against UAT. **No server defect surfaced**: every branch did what its writers say.
The value is that five of them are now load-bearing instead of merely written.

**Runs.** Corpus `149 → 154`. Full suite, pooled, 5 workers:

| | total | passed | failed | skipped |
|---|--:|--:|--:|--:|
| baseline (`post-dc7ca1c5`) | 149 | 130 | 1 | 18 |
| run 1 | 153 | 133 | **2** | 18 |
| run 2 | 153 | **134** | 1 | 18 |
| run 3 | 154 | **135** | 1 | 18 |

`130 + 5 = 135`, with the same single failure and the same 18 skips in every run.

Run 1's extra failure was `SecurityEvent: BruteForceAttempt` reporting `fetch failed` — a
transport error, which is not a result. Re-run standalone it passes 7/7, and it did not recur in
run 2. The one standing failure in every run is the documented Multi-Unit Jam Drive
(`payments[].status` stays `pending`), unchanged from the baseline. The five new files passed
every run they were in, plus their standalone runs — no scenario failed intermittently.

### How the catalog invariant is asserted without a column

`stations.current_catalog_version` is exposed by no Resource (grepped `app/Http/Resources/`, zero
hits), so "the refusal wrote nothing" has no direct read-back. But
`UpdateServiceCatalogAction.php:325` derives the next version from that column under
`stations ... lockForUpdate()`, so **publishing twice reads it twice**. The file captures the
version the first publish claims and asserts the second claims the same one — which is only
possible if the refused publish advanced nothing.

Pinned to a literal `"2"` (the way the accept-path sibling does it) this would have been a flake:
a pooled run shares 5 stations across the corpus and there are now two files that publish, so a
collision on one station would fail for a fixture reason. Capturing is also the truer statement —
the property is that two numbers are equal, not that either is 2.

The two StopService files are deliberately a **pair on one field**: same endpoint, same
`details.settledAs`, opposite values, one differing byte on the wire. That is what proves the
discriminator exists rather than that a number came out.

### What is deliberately NOT asserted

The 3006 file does not assert a credit amount. That arm passes `actualDurationSeconds: null`, so
the server derives delivered time from its own clock, and `StationLostSession` carries no
low-delivery floor (`TerminalReason.php:110` ⇒ `false`). The charge is `ceil(elapsed/60 × 100)`
over a wall-clock interval no scenario can pin — asserting a number there would be asserting the
runner's latency. `details.settledAs` is the deterministic field that actually decides the money,
so the assertion is placed there.

A MultiUnit booking WOULD make that arm deterministic (`AllOrNothingSettlement.php:62` full-refunds
it). Not taken: it changes the service kind as well as the error code, and would stop being a
clean discriminator against its sibling.

### One fixture fact, measured the hard way

`POST /admin/stations/{id}/diagnostics` answers **409 `COMMAND_PRE_EMPTED` / `6008`**
(`details.reason: device_management_not_declared`, `wouldBe: 2007`) unless the boot declared
`capabilities.deviceManagementSupported: true`. The boot declaration gates every
device-management command, so any future refusal file for Reset, SetMaintenanceMode,
GetConfiguration, ChangeConfiguration, UpdateFirmware or TriggerMessage needs it too.

---

## 5. Still zero

**9 of 16** branch-points are on the wire. The **7** that are not are all STATE, none money, and
all of them write a `station_journal` row and nothing else:

CancelReservation · GetConfiguration · Reset · SetMaintenanceMode · TriggerMessage ·
TriggerCertificateRenewal · DataTransfer

They are worth less per file than the five above, because for each of them the journal row IS the
whole observable — there is no second surface to disagree with it. Two notes for whoever takes
them:

- `CertificateInstall` and `TriggerCertificateRenewal` are an inverted pair: their **accept**
  branches are `Log::info` only, so the refusal row is the sole durable trace of the entire
  interaction. The refusal is better covered than the acceptance.
- `DataTransfer`'s `UnknownVendor`/`UnknownData` are the one place the spec and the server
  disagree on what a refusal is. `data-transfer.md` §5 r1 says "MUST NOT respond with an error
  code — this is not an error condition" and the response schema has no `errorCode` field at all;
  the server files both into `KIND_COMMAND_REFUSED`. A file there documents the disagreement as
  much as it covers a branch.

The bigger remaining hole is not in this list at all. It is **S3**: 10 of 15 timeout arms persist
nothing, and no scenario in the corpus drives one — a station that stays silent is a different
and less-covered story than a station that says no.
