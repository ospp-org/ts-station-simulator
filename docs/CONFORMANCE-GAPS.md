# The 41 refusals this station does not make

**Measured 2026-09-11 against spec `v0.40.0` and `@ospp/protocol v0.38.0`.**

**Denominator: 70.** Bounded on purpose — station-side **MUST refuse / MUST validate**
obligations on **inbound Server→Station** messages, taken from the numbered processing rules of
the **15** Server→Station actions (`07-errors.md` §4.2), the inbound transport rules of
`02-transport.md` §3.2/§3.3/§5.2/§6.1, `06-security.md:414`, and `05-state-machines.md:135`.
Excluded, so the bound is auditable: SHOULDs, MAYs, server-side obligations, BLE/offline profile
rules, and obligations the spec itself calls unreachable for a station with no such limit.

**Baseline 2026-09-11: 23 implemented · 6 partial · 41 absent.**
**After the first batch: 34 implemented · 6 partial · 30 absent.** Groups **A, B, C, D.3, F**
and **I.3** — **11** closed, all on the integrator's path, pinned by
`src/__tests__/handlers/ConformanceRefusals.test.ts` (16 tests: 11 refusals, **5 controls**).
Codes emitted rose **13 → 17** of 118.

> **THE INSTRUMENT.** Codes are referenced **symbolically** in this tree
> (`OsppErrorCode.BAY_NOT_FOUND`), never numerically. **A numeric grep is a broken instrument**
> and will report every one of these as "absent" whether or not it is. The working form is
> `grep -rhoE 'OsppErrorCode\.[A-Z_0-9]+' src`, and its positive control is that it finds
> `PROGRAM_NOT_DECLARED` (`StartServiceHandler.ts:82`) and `BAY_NOT_FOUND`
> (`StartServiceHandler.ts:26`).
>
> The single compact measurement: **13 distinct codes emitted, out of the 118** in the enum this
> package already imports.

> **WHY IT MATTERS MORE THAN ANY ROW BELOW.** This station is the receiver every scenario and
> every end-to-end traversal is validated against. For each absent row it answers `Accepted`
> where a conforming station must refuse, so a test whose expectation is *"the station accepted
> it"* cannot tell **correct** from **unchecked**. Everything validated with this tool was
> validated by a lenient receiver, and real firmware will be stricter.

---

## The groups

Ordered by the integrator's path — provisioning, boot, signing, session, catalog first; offline
and radio last, because that path is not built.

| # | group | count | mechanism | path |
|---|---|--:|---|---|
| ~~**A**~~ ✅ | unknown `bayId` → `3005` | **3** | one guard, three handlers. **Worse than absent today: all three `throw` and send nothing** | session |
| ~~**B**~~ ✅ | bay-state arms on SetMaintenanceMode | **2** | reuse `bayRefusal.ts`, which already maps `Reserved`→`3014` and `Unknown`→`3002` | session |
| **C** *(3 of 5 done)* | reservation lifecycle | **5** | needs **retention of terminal reservations** (`reserve-bay.md` §5.2). Two are currently **inverted** — answered `Accepted` where the spec requires a refusal | session |
| **D** *(1 of 2 done)* | StopService validation | **2** | `3007` is a 3-line field comparison; the duplicate-replay rule needs retention | session |
| **E** | StartService validation | **4** | `3003`/`3010` are small; `5103`/`3009` need a durable pre-effect record and a hardware model | session |
| ~~**F**~~ ✅ | catalog binding validity → `5024` | **1** | the declared topology is already in the handler | catalog |
| **G** | ChangeConfiguration | **4** | one key registry — mutability, type, range — serves all four | boot/config |
| **H** | GetConfiguration WriteOnly | **1** | same registry | boot/config |
| **I** *(1 of 2 done)* | GetDiagnostics | **2** | `5020` is a field comparison; `1011` needs a probe | device-mgmt |
| **J** | firmware integrity | **2** | needs a download model | device-mgmt |
| **K** | certificate validation | **3** | chain walk + type binding + keygen failure | provisioning/signing |
| **L** | restricted-state gate | **3** | one lifecycle flag, read by three places | boot |
| **M** | TriggerMessage in-flight | **1** | in-flight set | device-mgmt |
| **N** | DataTransfer vendor registry | **2** | one registry | device-mgmt |
| **O** | transport: dedup, queue, age | **5** | dedup is **0 of 4** sub-rules — a re-delivered QoS-1 REQUEST executes **twice** | transport |
| **P** | offline buffer → `5111` | **1** | needs the offline buffer | **offline — last** |

**3+2+5+2+4+1+4+1+2+2+3+3+1+2+5+1 = 41.**

## The rows

**A — unknown `bayId` → `3005 BAY_NOT_FOUND`.** `reserve-bay.md` §6 r1, `cancel-reservation.md`
r1, `set-maintenance-mode.md` r1. Each handler calls `station.getBayState(...)`, which **throws**
(`Station.ts:857`), so today the server gets **no response at all** rather than a refusal.

**B — SetMaintenanceMode bay-state arms.** `set-maintenance-mode.md` §6 table: bay `Reserved`
with `enabled: true` → `3014 BAY_RESERVED`; bay `Unknown`, either direction → `3002
BAY_NOT_READY`. The handler tests `OCCUPIED` only.

**C — reservation lifecycle.** `cancel-reservation.md` r2 (`3012` when no reservation with that
id ever existed), r3 (`3013 RESERVATION_EXPIRED`), r6 (`3012` when already consumed by a
StartService); `reserve-bay.md` §5.1 r7 (identical repeat → same `Accepted`, no timer restart),
r9a (`3013`), r9b (`3012`). **Inverted today:** the expiry timer *deletes* the record
(`ReserveBayHandler.ts:32`), so an expired or consumed reservation falls through to the
idempotent arm and is answered **`Accepted`**. The handler also never compares
`request.reservationId` with the one it holds, so cancelling with the **wrong id** succeeds.

**D — StopService.** `stop-service.md` r1 (`3005` unknown bay) and r3 (`3007 SESSION_MISMATCH`
when the `sessionId` is valid but names a different bay). The handler looks up by `sessionId`
alone, so an unknown bay is answered `3006` — the wrong code — and a stop naming the right
session and the wrong bay is **Accepted**.

**E — StartService.** `start-service.md` r7 (`3003` service not physically available — the
handler *comments* that availability is deliberately not consulted), r8b (`3010` duration above
the station maximum — no such config key exists), r9a (`5103` cannot durably record the
pre-effect record; sessions are an in-memory `Map`), r9b (`3009` hardware failed to activate).

**F — catalog.** `update-service-catalog.md` r8: a `bindings` entry naming a `(bayNumber,
programNumber)` pair the station did not declare → `5024 UNSUPPORTED_SERVICE`, and the previous
catalog stays in force. The handler has **no refusal branch at all** — it is the only
Server→Station request handler here with a zero-branch accept path.

**G/H — configuration.** `change-configuration.md` r2 (atomic: one rejected key → apply none),
r4 (`5108` read-only), r5 (unknown key → `NotSupported`), r6 (`5109` unparseable/out of range);
`get-configuration.md` §5.1 (a WriteOnly key appears in neither array and raises no error). The
read-only flags exist — in the *other* handler (`GetConfigurationHandler.ts:17-22`) — and are
never consulted on the write path.

**I — diagnostics.** `get-diagnostics.md` r3 (`5020 INVALID_TIME_WINDOW` when `startTime` is
after `endTime`) and r1 (`1011` when `uploadUrl` is unreachable).

**J — firmware.** `update-firmware.md` r3 (`5015` checksum mismatch → MUST NOT install) and r4
(`5112` signature absent or invalid).

**K — certificates.** `03-messages.md` (`4011` chain verification fails, `4012` certificate type
does not match the pending CSR) and `06-security.md` (`4014` keypair generation fails).

**L — restricted state.** `05-state-machines.md` §1.4 (a `Pending`/`Rejected` station MUST refuse
StartService and ReserveBay with `3002`), `02-transport.md` §6.1 (`2001` — process no server
command while `Booting`), `trigger-message.md` §5 (a restricted station Rejects every trigger
except BootNotification and SignCertificate). `BootNotificationHandler` handles `Pending` and
`Rejected` by logging and scheduling a retry, and records nothing any other handler reads.

**M/N — device-management odds.** `trigger-message.md` r7 (MUST NOT queue two triggers for the
same `requestedMessage`); `data-transfer.md` r1/r2 (`UnknownVendor` / `UnknownData` — the handler
answers `Accepted` to every vendor).

**O — transport.** `02-transport.md` §3.3 r1/r3/r4 — no seen-`messageId` set, no cached-response
replay, so **dedup is 0 of 4**; §3.2 (`5107` — commands processed sequentially, queue bounded at
10); §5.2 (discard a message older than its category's max age). `MessageRouter.route()` does a
bare `emit` into async handlers, so commands are fully concurrent today.

**P — offline.** `07-errors.md:475` (`5111 BUFFER_FULL` — refuse new StartService at ≥90 % buffer).
**Last, deliberately:** the offline leg is not built here.

## Two shapes that are worse than absent

1. **Three handlers throw instead of refusing** (group A) — the server sees a timeout, not a
   refusal, which is the one outcome that teaches an integrator nothing.
2. **Two answers are inverted** (group C) — `Accepted` where the spec requires `3013`/`3012`.
   An absent check is a gap; an inverted one is a wrong statement on the wire.

Also structural: the inbound MAC and JSON-Schema gates are **implemented and fail closed**
(`MessageRouter.ts:119-201`), but both **drop silently**. For `1005`/`1012` that matches the spec;
for `update-service-catalog.md` r1/r4, which require a `Rejected` **response**, it means the
server sees a timeout instead of a refusal. Those two are counted as **partial**, not absent.


---

## Why none of the 149 scenarios could break — and why that is the bigger finding

**Scenario mode instantiates 1 of the 20 handlers.** Derived with a working instrument, after the
first one failed its own control:

```
grep -rn 'Handler(' src/ | grep 'new '
  src/cli/index.ts            -> 20 of 20 handlers      (normal mode)
  src/scenarios/ScenarioRunner.ts:1358 -> BootNotificationHandler, and nothing else
```

*(The first attempt grepped `src/station/Station.ts` and found **0**, which would have "proved"
that normal mode registers nothing. The registration lives in `cli/index.ts`. A negative whose
positive control fails is not a measurement.)*

So the 149 scenarios exercise **1 of 20** handlers. None of the eleven refusals added here is
reachable from a scenario, which is why the suite stayed at **149 OK** — and it is also why the
suite could never have caught any of the 41. It is a wire-framing, signing and server-behaviour
net; it is **not** a station-conformance net, and the two should not be confused when a green run
is cited as evidence.

**Nothing here depended on leniency.** The honest reason is not that the scenarios are strict —
it is that they never reach the code that was lenient.
