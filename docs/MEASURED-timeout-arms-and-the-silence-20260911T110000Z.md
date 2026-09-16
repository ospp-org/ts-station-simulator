# The fifteen timeout arms, and what an operator sees when one fires

**Measured 2026-09-11** against csms-server `7e90dd94`, spec `v0.40.0`, simulator `ae79ee8` +
working tree. UAT.

Companion to [`MEASURED-server-refusal-paths-20260911T090000Z.md`](MEASURED-server-refusal-paths-20260911T090000Z.md),
which mapped what the server does when a station says **no**. This one is what it does when the
station says **nothing**.

---

## 0. The premise that was wrong

The work started from "no scenario in the corpus leaves a command unanswered." That is false, and
the instrument took three attempts to state correctly. Recording all three, because two of them
would have produced a confident wrong number:

1. **"Does a later step answer this action?"** — too coarse. A file that leaves session #1's
   StartService unanswered and then starts session #2 and answers *that* one reads as fully
   answered. Reported 8 unanswered.
2. **FIFO pairing.** Better, but backwards: `SendStep.resolveSendCorrelation` reverse-scans
   `context.receivedMessages` for the **most recent** unconsumed Request of that action
   (`SendStep.ts:311-320`) — LIFO, not FIFO. FIFO credited the wrong wait and moved which one
   looked silent.
3. **`max(delay)` instead of the sum.** `firmware-command-timeout-no-response.yaml` carries **two**
   back-to-back `delay: 200000` steps. Taking the maximum said 200s against a 360s requirement and
   would have reported the one file named for a command timeout as never reaching it — a false
   accusation against a correct file.

Corrected, with LIFO pairing and delays summed **after** each unanswered wait:

| | |
|---|--:|
| server-command waits in the corpus | **128** |
| answered | 112 |
| **left unanswered** | **16** |
| of those, waiting long enough for the sweep to land | **2** |

The two: `device-management/firmware-command-timeout-no-response.yaml` (402s waited against 360s
needed) and `sessions/session-start-ack-timeout-and-the-bay-it-half-claims.yaml`. The other
fourteen end within a couple of seconds and the pool is torn down under them — the command does
expire, later, with nothing watching.

**So 2 of the 15 timeout arms were already exercised**, and one of them (StartService) is a money
arm. The premise was wrong in the way that mattered: it would have produced a duplicate of an
existing file.

---

## 1. The window, per action

`command:check-timeouts` is `->everyMinute()->withoutOverlapping(10)` (`routes/console.php:27-30`),
named in the registry as `SCAN_CADENCE_SECONDS = 60` (`PendingCommandRegistry.php:96`). So the
worst case from dispatch to sweep is the configured timeout **plus a full cadence**:

| timeout (`config/ospp.php:223-235`) | actions | worst case |
|---|---|--:|
| 5s | ReserveBay, CancelReservation | 65s |
| 10s | StartService, StopService | 70s |
| 30s | GetConfiguration, Reset, SetMaintenanceMode, UpdateServiceCatalog | 90s |
| 30s (`DEFAULT_TIMEOUT`, `:87`) | CertificateInstall, TriggerCertificateRenewal, TriggerMessage, DataTransfer | 90s |
| 60s | ChangeConfiguration | 120s |
| 300s | UpdateFirmware, GetDiagnostics | 360s |

11 of the 15 actions are in the config table; the other 4 fall to `DEFAULT_TIMEOUT = 30`.

This is why every silence scenario needs `scenario_timeout_ms`: the runner's default budget is
90_000ms (`ScenarioRunner.ts:90`), which the shortest of these already brushes against once boot
and setup are counted.

---

## 2. What an operator sees when a command expires: nothing

Three negatives, each with its positive control run first, because a grep that finds nothing and a
grep that is broken look identical:

| claim | control that passed first |
|---|---|
| `CommandTimeoutScanner` never calls `StationJournalRecorder` — 0 hits | the same grep finds **3** in `ResetResponseHandler.php` |
| no `KIND_*` exists for timeout/expiry — 0 hits | the same grep finds all **23** kinds, including `KIND_COMMAND_REFUSED` |
| `pending_commands` has no REST route — 0 hits | the same grep finds the `station_journal` route at `routes/api/v1/admin.php:97` |

The durable record **does** exist, and this is the part that refines the finding:
`PendingCommandRegistry::getExpiredCommands()` runs
`UPDATE pending_commands SET status='expired' WHERE status='pending' AND timeout_at <= now()
RETURNING ...` (`:488-493`) for **every** expired command, before `handleTimeout()` is called at
all. So the row is written unconditionally, for all 15 arms.

**It has no reader.** Not a route, not a Resource, not a journal row. On UAT that table holds
**3549** expired rows — ChangeConfiguration 2329, TriggerMessage 804, UpdateFirmware 107,
StopService 33, TriggerCertificateRenewal 28, StartService 28, ReserveBay 28, CancelReservation 21
— and no operator surface exposes one of them.

So the gap is **not persistence, it is visibility**, and it is a one-line difference from a
surface that already works: a refused command lands in `station_journal` as `command_refused` and
is readable at `GET /api/v1/admin/stations/{stationId}/journal?kind=…`; an expired command lands
in a table with no door. The two money arms are the partial exception — their effect is visible
through the session's own `fail_reason`/`fail_error_code`, though not through the station's
history.

---

## 3. The nine that compensate nothing — what each actually needs

The rule applied:

- **everything that expires needs a durable, immutable record;**
- **compensation only where there is something to compensate;**
- **retry only where the effect is idempotent AND still wanted AND bounded — and a time-bound
  command is never retried, it is compensated.**

Idempotency is not inferred: `03-messages.md:54` defines the property per message as "whether the
message can be safely retried", and each row below quotes that table.

| action | pre-dispatch row | idempotent | time-bound | needs |
|---|---|:--:|:--:|---|
| GetConfiguration | nothing | Y | N | record + bounded retry |
| Reset | nothing | **N** — "each reset triggers a new reboot cycle" (:1624) | N | **record only** |
| SetMaintenanceMode | nothing | Y | N | record + bounded retry |
| UpdateServiceCatalog | nothing | Y | **Y** — `catalogVersion` is a version fence | **record only** |
| GetDiagnostics | `diagnostics_uploads.status='pending'` | N | Y | record + compensation — **already met** |
| CertificateInstall | nothing | Y | **Y** — signed for one CSR/keypair | **record only** |
| TriggerCertificateRenewal | nothing | Y | N | record + bounded retry |
| TriggerMessage | nothing | Y | N | record + bounded retry |
| DataTransfer | nothing | N — "vendor-defined" (:2314) | N | **record only** |

**4 record-only · 4 record + bounded retry · 1 record + compensation (already satisfied).**

The comment at `CommandTimeoutScanner.php:117-119` — "eight write nothing before dispatch, and
GetDiagnostics is already swept" — was verified independently rather than trusted, and **both
halves are true**. 8 of 9 have no pre-dispatch write (`ResetStationAction.php` for instance
contains exactly one line matching any write-or-dispatch pattern: the `sendCommand` at `:156`).
And GetDiagnostics is swept — but by `DetectStalledDiagnostics` (`diagnostics:detect-stalled`,
`->everyFiveMinutes()`, `routes/console.php:217`), a wholly separate sweep of
`diagnostics_uploads`. "Already swept" means swept *elsewhere*, not by the class under review.

**The non-obvious result.** UpdateServiceCatalog and CertificateInstall are both spec-idempotent,
which reads as "safe to retry" — and both are time-bound, so under the rule they get **no retry at
all**. A blind resend would ship the cached correlation data: a superseded `catalogVersion`, or a
certificate for a keypair the station has already rotated past. Their idempotency guarantee is
scoped to the *same* version or the *same* serial (`03-messages.md:2191`), which is exactly the
case a late retry does not satisfy. Time-bound dominates idempotent, and these two are why that
clause earns its place in the rule.

So: of the nine, **none needs compensation** — eight have nothing to compensate and the ninth is
already handled. What all nine need is the thing all fifteen need, which is a record an operator
can read.

---

## 4. What was added

Scenarios, not handler changes. Corpus `154 → 156`.

| file | arm | wait | proves |
|---|---|--:|---|
| `sessions/stop-service-unanswered-settles-as-stop-ack-lost.yaml` | StopService — **money** | 90s | `failed` + `1010`, not a hung session and not a billed wash |
| `reservations/reserve-bay-unanswered-compensates-with-a-cancel.yaml` | ReserveBay — **compensation** | 75s | a `CancelReservation` the server publishes unbidden, naming this reservation |

The StartService money arm was **not** duplicated — `session-start-ack-timeout-and-the-bay-it-half-claims.yaml`
already drives it (130s of delay, asserting `failed` / `1010` / `credits_charged: 0`).

Measured wall time: standalone and pooled, ReserveBay **89.4s**; inside the full parallel suite,
ReserveBay **79.9s** and StopService **95.7s**. Both pass in both modes.

**Runs.** Corpus `154 → 156`. Full suite, pooled, 5 workers:

| | total | passed | failed | skipped | wall |
|---|--:|--:|--:|--:|--:|
| refusal baseline (run 3) | 154 | 135 | 1 | 18 | 3006s |
| silence run 1 | 156 | **137** | 1 | 18 | 3142s |
| silence run 2 | 156 | **137** | 1 | 18 | 3143s |
| silence run 3 | 156 | **137** | 1 | 18 | 3170s |

`130 + 7 = 137`, with the same single failure — the documented Multi-Unit Jam Drive — and the same
18 skips throughout. The two silence files cost about **136s** of suite wall time between them,
which is less than their own waits because a 5-worker run overlaps them with other scenarios.

**Contention, which is the specific risk for a file that waits on a schedule.** All four
timeout-driving scenarios in the corpus, timed inside the parallel suite:

| scenario | arm | run 1 | run 2 | run 3 |
|---|---|--:|--:|--:|
| Firmware Update — No Response To The Command | UpdateFirmware | — | 409.5s | 408.5s |
| Session Start ACK Timeout | StartService | — | 145.1s | 144.9s |
| Stop Service Unanswered | StopService | 95.7s | 96.8s | 95.8s |
| Reserve Bay Unanswered | ReserveBay | 79.9s | 80.1s | 80.2s |

Three runs, identical results (`137/1/18` each) and a spread of about **1s** per scenario. The two
new files sit ~10s off their standalone timings, in both directions, which is overlap rather than
drift. Nothing is near its `scenario_timeout_ms`: the closest is StopService at 97s against a 240s
budget. A file that waits on a server schedule cannot be made faster, only given margin, and the
margin holds under a 5-worker run.

### The ReserveBay file is the best-observable timeout in the system

Every other arm's effect is a column to go and read afterwards — which proves the row changed, not
that the server acted. Here the server's action **is a message**, published to a station that has
said nothing since the ReserveBay (`CancelReservationAction.php:198-220`), and it carries the
`reservationId` so it is tied to this scenario rather than to other pool traffic. The
`wait_for` catches it at 0ms because it arrived during the delay and `WaitForStep` drains what is
already buffered (`:129-137`).

It is also the only one of the three with **no competing sweeper**: the reservation is booked for
5 minutes and `reservation:check-expiry` only acts past TTL, four times the window. The
cancellation is attributable to the timeout arm and to nothing else.

### Why neither session file pins `fail_reason`

Two sweepers race for these sessions and are **designed to agree**:

```
command scanner (10s)  CommandTimeoutScanner.php:213-234   StopAckLost, 1010
session STOPPING (60s) SessionTimeoutService.php:87-90     StopAckLost, 1010
```

They differ only in the `failReason` prose. Pinning it would pin which sweeper won — scheduler
phase, not server behaviour, and a flake. That they agree is recent and deliberate: the scanner's
own comment (`:225-229`) records that the "former scanner-vs-reaper divergence
(scanner=full-refund-floor, reaper=pro-rata) is closed." So the files pin the pair both produce.

The credit amount is not pinned either: `StopAckLost` on a UserDuration kind pro-rates on
delivered time with no low-delivery floor (`TerminalReason.php:110` ⇒ `false`), and delivered time
is however long the sweep took to land.

---

## 5. Still unobserved

**4 of 15** arms now exercised: StartService, StopService, ReserveBay, UpdateFirmware. The **11**
that are not:

- **ChangeConfiguration** — the only remaining arm that writes durable state on expiry
  (`station_configurations.desired_status = 'expired'`). 120s window. The obvious next file.
- **CancelReservation** — a deliberate no-op arm: the row was already closed by the original send.
  A scenario would pin that it *stays* a no-op.
- **the nine** — nothing to observe, which is the finding rather than a gap in the corpus. A
  scenario there can only demonstrate invisibility, and would have to assert the absence of a
  record that should exist, which turns green into red the day someone fixes it.

That last point is why this file stops at two scenarios. The nine do not need a test; they need a
row an operator can read, and the measurement above is the argument for building one.

---

## 6. The recommendation, and the two arms that come next

### The nine get a ROW, not a scenario — and this is the reason

> A scenario there could only assert the **absence** of a row that ought to exist — and it would
> turn red the day someone adds it.

That is the whole argument and it is worth keeping. A test whose green depends on a gap being open
is a test that punishes the fix. There is no positive thing to assert for an expired Reset today:
no column changes, no message goes out, no surface answers differently. The only assertion
available is "the journal has nothing about this", which is exactly the sentence a repair makes
false.

So the nine were addressed on the other side — **by opening the door**, in csms-server:
`StationJournalRecorder::KIND_COMMAND_EXPIRED`, written by `CommandTimeoutScanner::handleTimeout()`
for every one of the fifteen arms, readable at
`GET /api/v1/admin/stations/{stationId}/journal?kind=command_expired`. The row carries
`details.compensated`, which is what separates an expired StartService that refunded a customer
from an expired Reset that did nothing at all. Once a row exists, a scenario CAN assert something
positive — and the assertion no longer breaks on being fixed.

Forward-only, deliberately: the 3973 expiries already in `pending_commands` are not backfilled.
The journal is read newest-first and capped at 100, and the worst UAT station carries 80 expired
commands against 289 existing journal rows — a backfill would bury that station's boot, fault and
refusal history under a backlog nobody is investigating.

### The two remaining arms, named as next and deliberately not built

**`ChangeConfiguration`** — the only arm left that writes durable state on expiry
(`StationConfigurationWriter::resolveDesired(..., 'expired')`, via
`CommandTimeoutScanner:94-111`). 60s timeout + 60s cadence = **120s** window, so a scenario needs
roughly 135s of delay inside a ~300s budget. It has a correlation requirement the other silence
files do not: the arm needs `correlationData['key']`, and `:100-104` logs an error and gives up
without one — so the file must drive a real `PUT /stations/{id}/config` rather than synthesising a
command, and assert `desired_status` on the config read-back.

**`CancelReservation`** — a **deliberate no-op** arm (`:266-272`, `Log::info` only): the
reservation row was already closed by the original send, so nothing is left to correct. Worth a
scenario precisely because "nothing happens" is a decision here rather than an omission, and the
new `command_expired` row now makes it assertable — `details.compensated: false` on an action that
*has* an arm is the discriminating fact, and it is the reason `COMPENSATING_ACTIONS` excludes it
while the match includes it. 5s timeout + 60s cadence = **65s**.

Neither is built here. Both are one file each, on the pattern the two committed scenarios
establish.
