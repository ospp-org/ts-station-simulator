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
> The single compact measurement: **13 distinct codes emitted, out of the 119** in the enum this
> package already imports. *(The denominator read 118 until 2026-09-11; the enum's own docblock
> says 119, and 119 distinct names and 119 distinct numeric values are on disk.)*

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

## THE DECISION: this stays a scenario corpus, and does not become a virtual station

**Taken 2026-09-11. Anyone reopening it should not have to re-measure — the numbers are here.**

The obvious reading of this document is "wire up the other 19 handlers and make the simulator a
faithful station." That is **not** what we are doing, and the reason is what the measurements
above and in
[`MEASURED-server-refusal-paths-20260911T090000Z.md`](MEASURED-server-refusal-paths-20260911T090000Z.md)
actually showed.

**The numbers the decision rests on:**

| | |
|---|--:|
| station-side MUST obligations measured | **70** |
| absent at the first measurement | **41** |
| closed in the first batch | **11** — leaving **30** absent, **36 of 70** short of complete |
| of the 41, rule labels that reach a server path a scenario can drive | **34 of 42** |
| of those, ones that put a `Rejected` RESPONSE on the wire | **30** |
| labels that say nothing about the server whatever the station does | **8** |

**Why scenarios win.** A scenario reaches the same server code a conformant handler would. That is
not an approximation — it was measured: a scenario `send` with `messageType: Response`
auto-correlates to the pending Request (`SendStep.ts:302-320`), so the server's
`PendingCommandRegistry` resolves it exactly as it would a real station's answer, and its response
handler runs unchanged. **9 of the server's 16 refusal branch-points and 4 of its 15 timeout arms
are now driven this way, including 3 of 3 that move money** — with no change to how the simulator
works.

**What tightening the handlers would buy, and who it is for.** Fidelity. A station that *decides*
to refuse rather than being scripted to. That is worth having — and it is **the integrator's
problem**, not this tool's: the integrator is building real firmware against the spec, and the
conformance rows above are the checklist for it. This simulator exists to validate the **server**.

**What it would cost.** Changing the receiver changes the instrument every other scenario is
validated against. 154 files currently pass against a lenient station; making it strict turns every
latent server defect into a simultaneous scenario failure, and the first one to land hides the
rest. That is the exact hazard §7 of `RUNNING-AGAINST-UAT.md` describes for the inbound schema
gate, which was measured in `warn` before being trusted in `strict` for precisely this reason.
A scenario carries none of that risk: it adds a file, it does not move the floor under 154 others.

**So the rule going forward.** A row here is worth closing when it makes the *station* more
faithful for the integrator. A server path is worth reaching with a *scenario*. The two are
different jobs and the same document should not be read as asking for both.

**What does NOT follow from this.** The eleven already closed stay closed, and
`ConformanceRefusals.test.ts` keeps pinning them — this is a decision about what to build next,
not a retraction. And the handler default is untouched: no row here is closed by making the
station refuse by default.

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

---

## Two claims about `connect` mode, recorded 2026-09-12

Both came out of an adversarial run of the firmware integration guide against UAT, by a session
allowed to read only the guide. Neither blocks us — we drive the server with **scenarios** — and
neither is a row in the table above, because neither is a station-side MUST. They are recorded
because both make the tool *look* like something it is not.

**Every number below is derived by a command, and the command is printed with it.** Nothing here
is obtained by subtracting one claim from another.

### 1. "All 20 OSPP handlers are wired" is true about registration and false about behaviour

`README.md`, under `### connect`, reads *"All 20 OSPP handlers are wired (boot, heartbeat,
**session lifecycle**, configuration, firmware, diagnostics, maintenance, catalog, trigger,
certificates, data transfer, status, **meter**, security event)."*

The count is right:

```
ls src/handlers/*.ts | wc -l                          -> 22
  minus Handler.ts (the interface) and bayRefusal.ts (a helper)
  = 20 handlers on disk
grep -c '^      reg(OsppAction\.' src/cli/index.ts    -> 20   (connect mode)
grep -c 'registerHandler' src/scenarios/ScenarioRunner.ts -> 1 (scenario mode; see the section above)
```

**20 of 20, in connect mode.** What the sentence then implies — and does not hold — is that a
registered handler *drives* the thing it is named after. `StartServiceHandler` accepts the
command and records the session, and nothing afterwards happens:

```
grep -rn 'durationSeconds' src/ | grep -v __tests__ | wc -l   -> 10 sites
grep -n 'setInterval\|setTimeout' src/station/Station.ts      -> 1 setInterval (heartbeat)
                                                                 3 setTimeout  (waitForConnect,
                                                                   planned-shutdown announce,
                                                                   waitForKick)
```

**Zero of the four timers is session-bound**, and no `durationSeconds` site sits next to any of
them. So in connect mode a station that accepted a `StartService`:

- emits **no** `MeterValues` autonomously — the only emitter is `TriggerMessageHandler`'s
  `case 'MeterValues'`, a one-shot the *server* has to pull, and it reports `liquidMl: 0,
  energyWh: 0` for every active session;
- **does not stop** when `durationSeconds` elapses;
- sends **no** `SessionEnded`, so the server's sweeper is what eventually settles the session.

One of the three is deliberate and should not be read as a gap: `StopServiceHandler` sends no
`SessionEnded` on a commanded stop, because `session-ended.md` §5 makes that a `MUST NOT`. The
genuinely missing path is **natural expiry at `durationSeconds`** — and, under it, the meter
cadence `behavior.meterValuesIntervalSec` advertises (default `30`), which has no consumer
outside `GetConfigurationHandler` reporting it back.

**Not gated.** `scripts/check-doc-claims.mjs` holds five README numbers — scenarios, categories,
linter checks, wire version, actions — and the handler sentence is not among them, which is why it
could say "wired" for as long as it has. `npm run check:doc-claims` passes with it in place.

**Consequence for anyone reading a green run:** connect mode is a wire-framing and signing peer,
not a session-driving station. The guide's chapters 5–10 cannot be executed through it; the
adversarial session wrote its own wire client for exactly that reason, and we use scenarios.

### 2. Connect mode invents its own `serialNumber` instead of the provisioned one

```
grep -rn 'generateSerialNumber' src/ | grep -v __tests__
  src/station/StationConfig.ts          -> the generator, `SN-${uuid[0..8]}`
  src/cli/index.ts:893                  -> connect mode, inline in the Station config
  src/scenarios/bootstrap/PoolBootstrap.ts:924 -> pooled provisioning POST
  src/scenarios/ScenarioRunner.ts:862   -> the scenario `serialNumber` variable
```

Provisioning sends a serial of a different shape entirely (`SIM-<epoch>`, `src/cli/index.ts`,
provision command) and **persists none**: `<stationId>-bays.json` carries `stationId`, `bays` and
`bayIds`, and nothing else. So the value is unrecoverable once the provision process exits, and
the first boot after provisioning always reports a serial the server has not seen.

The server's own journal names the consequence, and this repo already measured the rate —
`docs/traversal-captures/README.md`: **897 `serial_changed` rows against 1218 `station_booted`,
73.6 % of all boots logged as hardware swaps**, with pending offline transactions held for manual
review.

**The split between modes is not uniform**, which is why the ratio is what it is rather than
100 %:

| mode | serial at provisioning | serial at boot | agree? |
|---|---|---|---|
| `connect` | `SIM-<epoch>`, not persisted | `SN-<hex>`, generated fresh | **no** |
| scenario, non-pooled | the `serialNumber` variable, via `{{serialNumber}}` | the same variable | **yes** |
| scenario, pooled (`--bootstrap-pool`) | generated inline for the POST, not persisted | the scenario variable | **no** |

The precedent for the fix is in this tree already: `src/cli/connectBays.ts` describes the
identical defect class for `bayId` — *"`connect` used to invent `bay_<stationHex><NN>` and ignore
the file it had just written… That is measuring the instrument, not the server."* — and closing
that one required the same two halves, a write at provisioning and a read at connect. The write
half now exists for the trust material (`src/cli/artifacts.ts`); the serial has neither half.
