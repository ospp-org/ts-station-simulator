# Running the scenario suite against UAT

Written after a full 107-scenario run on 2026-08-07 in which **11 of 18 failures were
not defects** — they were missing environment, missing fixtures, missing `--var`s, or
the wrong run mode. Every one of those cost time to attribute. This file is the list
of things that have to be true, so the next run's failures mean something.

---

## 1. Environment — all of it, or scenarios fail for reasons unrelated to the code

| variable | needed by | notes |
|---|---|---|
| `OSPP_PROTOCOL_VERSION` | **every scenario** | Must be a member of the server's `supported_versions` set. Negotiation is **exact match** (`VERSIONING.md:25`) — a shared MAJOR implies nothing, and the SDK's MAJOR gate was deleted in 0.12.0. The SDK default is `0.2.1`; spec v0.11.1 mandates **`0.3.0`** on the wire (176 value sites). **Set it explicitly** until the SDK default is corrected, which needs an SDK release. Get it wrong and every boot is refused `1007`. |
| `UAT_EMAIL` / `UAT_PASSWORD` | **must be SET in every mode; the VALUE matters only in `--station`** | Two different things, and conflating them costs a run either way. **Set:** `resolveEnvVarsDeep` walks all of `config/targets.yaml` at load and throws `Environment variable UAT_EMAIL is not set` on any unresolved `${…}` (`cli/config.ts:54-62`), before a single scenario runs — including under `--bootstrap-pool`, which does not use the identity at all. An empty string satisfies it (the check is `=== undefined`). **Value:** in `--bootstrap-pool` it is never authenticated with — a scenario with no `auth:` block resolves to `undefined` and the caller falls through to the per-scenario pool worker, so the `target.credentials` fallback is *structurally unreachable* while the allocator is active (`ScenarioRunner.ts:502-510`), and the builder authenticates as the platform admin and mints its own ephemeral `tenant_owner` (`PoolBootstrap.ts:304-324`). So a stale value that 401s is harmless in pooled mode, and an *unset* one is fatal in every mode. The repo `.env` values are stale; exporting the platform-admin pair into both is the simplest thing that is correct everywhere. This row used to read "needed by any scenario with an `api_call`", which explains neither half. |
| `UAT_E2E_PLATFORM_ADMIN_EMAIL` / `_PASSWORD` | the whole `security` suite | Any scenario declaring an `auth` override startup-**fails** the entire run without these, before a single scenario executes. They live in `~/.config/osp-e2e-secrets.env`, and the values there are **single-quoted** — strip the quotes or the login 422s with "The email field must be a valid email address". |

`.env` cannot simply be `source`d: at least one value contains a shell metacharacter and
zsh fails to parse it. Extract per key.

---

## 2. Two run modes, and what each one cannot do

### `--bootstrap-pool` (the designed mode)

Provisions its own org, location, stations, certs, receipt keys, catalog, identities and
wallets, then tears them down. **This is the only mode in which the whole suite is
meaningful.** It is also the only mode that provisions:

- persisted `<stationId>-receipt-key.pem` → the 4 TransactionEvent scenarios throw
  without it (`SendStep.ts:179-184`)
- `users.offline_enabled` → the 6 offline scenarios
- `bay_programs` rows at provisioning → and therefore `bay_services` bindings
- **one identity per scenario**, single-use FIFO — see §4
- a fresh, unregistered stationId → the 3 `e2e/*` scenarios register a station as part of
  onboarding and answer `409 "Station already exists"` against any existing one

### `--station <existing>` (what a targeted run uses)

Fine for a single scenario or a suite that does not need the above. Costs you, measured:

| what fails | why |
|---|---|
| 3 × `e2e/*` | `409 Station already exists` — they register the station themselves |
| 4 × TransactionEvent (`security/offline-*reconcile*`) | no persisted receipt key |
| 2 × offline pass | wallet balance 0 or negative; `offline_enabled` alone is not enough |
| `device-management/service-catalog-update` | `bay_services` empty → `400 VALIDATION_ERROR (6004)` "has no (bay, program) binding", ungated by any flag |
| `tls-floor/s5-rejects-revoked-cert` | needs a genuinely revoked certificate |
| 2 × offline pass, **in pooled mode too** | `uatPrivileged.ts` seeds wallets at `balance 0` and `AuthorizeOfflineSessionAction` pre-debits with `allowNegative:false`. Bootstrapping does NOT fix this; fund the fixture. Do not flip `allowNegative`. |
| whole-suite runs | rate limiting — see §4 |

None of these are defects. They are the mode's boundary, and a summary line cannot tell
them apart from a real failure.

---

## 3. Scenarios with REQUIRED `--var`s

**Since 2026-08-12 this is enforced at startup, not discovered mid-run.** The runner derives
each scenario's required variables from the file and checks them before any bootstrap:

- **`--scenario <file>` → refused immediately**, naming the variables and the flags to pass.
  You asked for that file by name; a silent skip would answer a question you did not ask.
- **`--suite` / `--all` → skipped transparently**, listed up front before the pool is
  provisioned, and still counted in the total so `passed + failed + skipped` holds.

Until then an `--all` run reached step 9 of `single-session-drive` after eight minutes and
threw `Template variable not found: reason` — a documented, known, *permanent* red line in
every full run. That is the cost this closes: a standing failure teaches you to skim the
failure list, and the run where it means something looks like the twenty where it did not.

The requirement is computed by asking `generateVariables` what it provides, so the check
cannot drift from the generator. It reads `steps` and `station` and never `description` —
a scenario that documents its own `--var` in its header mentions the token in prose, and a
text-level scan cannot tell documentation from dependency. (The first survey written for this
did scan raw text, and reported `single-session-drive` — the one file known to fail this way
— as clean.) `ScenarioRunner.variablePreflight.test.ts` pins the corpus list below, so a new
scenario referencing an ungenerated variable has to be a deliberate decision.

| scenario | required |
|---|---|
| `multiunit-e2e/single-session-drive` | `--var reason=<SessionEndReason>` e.g. `TimerExpired`. A parameterized sweep — run it once per reason. **No default on purpose:** a default would pin one arm and report the sweep as done. Passes 12/12 with it. |
| `multiunit-e2e/multiunit-batch-drive` | same `--var reason=…`. Carries `skip_when_pooled`, so in a pooled run it keeps that reason; in a non-pooled bulk run the preflight is what catches it. |
| `sessions/session-rejected-invalid-service-cross-station` | `--var stationA_bayId=… --var stationB_serviceId=…`, plus **two** manually provisioned stations in one org with disjoint catalogs. `skip_when_pooled` carries the reason. |
| `security/offline-auth-transaction-reconcile{,-hostile}` | `--var offlineTxId=… --var authId=… --var sessionId=…` — the header says so. These describe a grant issued out of band; there is no API that mints one on UAT. |
| most `sessions/*`, `reservations/*` | **`--station` mode only:** `--var serviceId_1=<real svc_*>` — otherwise a random serviceId is generated and `/sessions/start` 404s `3004 INVALID_SERVICE` |

`{{bayId_N}}` is hydrated automatically from `<stationId>-bays.json`.

**`{{serviceId_1..4}}` are hydrated too, in `--bootstrap-pool`** — the row above is a
`--station` constraint, not a general one. The pool bootstrap seeds `DEFAULT_SEED_SERVICES`
(`uatPrivileged.ts:158-170`) deliberately matching the runner's `defaultServices`
(`ScenarioRunner.ts:574`), so each of the four resolves to a real `station_services` row on
every bootstrapped station. Passing `--var serviceId_1=…` in pooled mode is unnecessary and
overrides a valid id with one the catalog may not carry. Outside bootstrap the ids are still
merely *generated* — same text, no row behind it — which is what the `3004` above is.

---

## 4. The rate limit is correct. The pooled design is correct. A single identity is not.

`POST /api/v1/sessions/start` is behind `throttle:session-mutate` —
`Limit::perMinute(10)->by($request->user()?->id ?? $request->ip())`
(`csms-server AppServiceProvider.php:116`), i.e. **10 per minute per user**.

Running 20 `sessions` scenarios on one identity produced a `429` whose retry was
scheduled **35 s** out, against a `wait_for` budget of 15 s — so `start-service` failed
with `Timeout waiting for StartService Request`, three steps and one subsystem away from
the actual cause. The same scenario passes standalone.

**Do not raise the limit.** It guards the money path: a real customer starting more than
ten washes a minute is abusive, and 10/min/user is a production control, not a test
inconvenience. Nor is the suite's design at fault — `--identity-pool-size` defaults to
`max(scenarioCount, workers)` and mints **one single-use identity per scenario**
precisely so each gets its own bucket, which models N distinct customers. That is what a
fleet actually is.

The wrong component was the run: one identity replaying 20 scenarios models one customer
starting 20 washes in eight minutes, which *should* be throttled. If you must run a suite
without a bootstrap, rotate identities per suite and expect throttling within one.

---

## 5. State the suite leaves behind, and one that bites the next scenario

**`StationPoolAllocator` does not reset station state on release** (`ScenarioRunner.ts:919`
— it is pure mutual exclusion, an `inUse` set with `acquire`/`release`). So a scenario that
mutates the station and fails before restoring hands the next scenario a dirty station,
**in pooled runs too**, not just single-station runs.

Live instance, and currently the only one: `core/boot-disabled-station-boots-and-stays-gated`
disables the station via `PATCH /admin/stations/{id}/active` and re-enables it near the end.
On the happy path it restores. If it fails in between, the station stays disabled and every
later scenario on it fails `502 STATION_OFFLINE` — which is what happened on the 2026-08-07
run and cost `core/data-transfer-response` a failure that had nothing to do with it.

There is no per-scenario teardown/`finally` in the DSL, so a scenario cannot self-heal.
Until there is, when a run shows a cluster of `502 STATION_OFFLINE`, check `is_active`
before reading anything into them:

```sql
SELECT station_id, is_active FROM stations WHERE station_id = 'stn_…';
```

Also accumulating, from runs whose teardown did not complete: `certs/uat/` key sets,
`tests/artifacts/uat/` directories, and `pool-handle.json` holding a finished run's
credentials. `persistedKeySet` **reuses** an existing key set rather than flagging it, so a
half-provisioned directory is silently adopted.

**A fixed id in a shared environment poisons itself permanently.**
`security/offline-transaction-reconcile.yaml` hardcoded `offlineTxId: otx_a0000000001`. The
server's Reconciler dedups on that id before verify/score/debit, so it is reconcilable exactly
ONCE per database — a row written on 2026-08-07 was still making the scenario answer
`Duplicate` instead of `Accepted` on 2026-08-10. Teardown was not the gap (it already sweeps
`offline_transactions`, but user-scoped, and the poisoning run was outside that scope), and no
sweep makes a fixed global id safe against two concurrent runs. **Fixed 2026-08-10:** the
scenario now uses `{{runOfflineTxId}}`, generated fresh per run. Same shape as the depleting
wallet — a scenario must not depend on shared mutable state it does not own. If you add a
scenario that writes a keyed row, generate the key.

**Accumulated state moves the failure, which is worse than repeating it.** The three
`e2e/*` scenarios failed `409 "Station already exists"` on the first run. On the second
they failed **earlier**, with `422 "The email has already been taken"` — because the first
run got past registration and created the user before dying. Same root cause, different
symptom, and nothing about the second message points at the first. If an `e2e` failure
message changes between runs without the code changing, suspect residue rather than a
regression.

### A server defect this surfaced — `PATCH /active` can 500 with the flag committed

`StopAllStationSessionsAction::execute()` catches **only** `OsppException`, with the
comment *"The bulk stop must never fail the whole disable because one session cannot
stop."* But `SignOutgoingMiddleware` throws `UnsignableMessageException`, and the two are
sibling `final class … extends RuntimeException` — so it escapes the catch, propagates out
of `setActive()`, and returns **500 Server Error** after `is_active` has already been
written.

There is an ordering irony in it: the same endpoint KICKS the station off the broker
(deliberately, ADR-0004 §4), which ends the MQTT session and therefore the session key —
so the auto-stop races the very condition that makes `StopService` unpublishable. And the
kick immediately below it *is* wrapped best-effort, for exactly this reason.

Symptom when it happens: the disable half-applies, the caller sees only "Server Error",
and every later scenario on that station fails `502 STATION_OFFLINE`. On the 2026-08-07
re-run this single defect accounted for **all three** `core` failures — the disable
scenario itself, plus `data-transfer-response` and `reconnect-recovery` downstream of the
station being left disabled. It reproduces only when the station has an in-flight session
at disable time, which is why the same scenario passes standalone.

**FIXED and deployed — verified 2026-08-10.** csms-server `a566336` added `catch (\Throwable $e)`
at `StopAllStationSessionsAction.php:67`, confirmed present INSIDE the running `csms-app-uat`
container (not merely in git). The 116-scenario run of 2026-08-10 showed zero
`502 STATION_OFFLINE` and zero stations left disabled. Keep the paragraph above as the
explanation of a real failure mode, but do NOT attribute a fresh `502` cluster to it without
re-checking `is_active` first.

---

## 6. Reading a run

- `mqtt:incoming-dlq` on **`csms-redis-queue`** — not `csms-redis-uat`. There are four Redis
  containers on that host; the bridge and consumer use `redis-queue`, `db=0`, **no key
  prefix**, and it needs the password from `config('database.redis.mqtt.password')`. A probe
  against the wrong one returns `0` and reads exactly like an empty queue.
- A schema-invalid **EVENT** gets no reply, so the station never learns. It is hard-failed
  to the DLQ and the scenario carries on — the failure surfaces later, somewhere else.
  `outcome="hard_fail"`, which the `MqttDlqEnvelope` alert does not match.
- `bays.status` is reset to `unknown` on **every** boot
  (`BootNotificationHandler.php:358`), and only an accepted StatusNotification clears it.
- A `409` on `/sessions/start` does not say which gate refused:
  `OCCUPIED→3001`, `UNAVAILABLE→3011`, `FAULTED`/`FINISHING`/`UNKNOWN`→**`3002`**. Assert the
  `ospp_code`, not the status.

### A background `api_call` reports its failure three steps away from the cause

**Grep every run log for `[ApiCallStep:background]` before attributing a `wait_for` timeout.**

`background: true` fires the request without awaiting it, which is required for the synchronous
REST endpoints that block on the station's MQTT Response. The cost is that the step is green the
instant the fetch is *fired*: a status mismatch is downgraded to a `console.warn`, and `capture`
/ `expect_body` are refused outright (`ApiCallStep.ts` throws — an assertion nobody awaits is
not one). So a refused background request leaves the run to fail later, at whatever step notices
the **consequence** — normally a `wait_for` that times out because the request that would have
made the server publish never succeeded.

The reported error names the message that never arrived. It does not name the refusal.

Measured 2026-08-13 on `core/boot-disabled-station-boots-and-stays-gated`: reported as
`Timeout waiting for StartService Request after 15000ms` at step 16; the cause was step 15,
`[ApiCallStep:background] POST /sessions/start: expected 201, got 409 — BAY_NOT_READY/3002`.
Nothing was published, so the `wait_for` had nothing to wait for. This is a property of the
instrument — background mode trades assertion for concurrency, deliberately — not of the
scenario, and it applies to every file using a background call.

### `core/boot-disabled-station-boots-and-stays-gated` — CONTENTION, marked 2026-08-13

Failed in the pooled run of 2026-08-13 with the `BAY_NOT_READY` above. Re-run **three times
standalone** (`--scenario … --bootstrap-pool --pool-size 1`): **passed 3/3**, all 20 steps, with
the backgrounded `POST /sessions/start` returning 201 and `StartService` arriving in 251/289/481 ms
against a 15 s budget — and **zero** `[ApiCallStep:background]` lines in any of the three.

So it is pool-dependent, not a defect in the file. **The precise contention mechanism is NOT
established** and is not claimed here; what is measured is that the refusal does not reproduce
with the station to itself. Consistent with §5 — the allocator is pure mutual exclusion and does
not reset station state on release, and `bays.status` resets to `unknown` on every boot while
this file forces a re-boot by design (disabling severs the connection). Treat a repeat as churn;
treat a standalone failure as new.

---

## A known-good baseline

**SUPERSEDED — this block is the 2026-08-07 `--station` run, kept for history only.**
It predates the 107→116 scenario additions and the audit repairs, so its denominators are
wrong for `core`, `device-management`, `sessions` and `security`.

```
core 12/16 · chaos 6/7 · device-management 19/21 · sessions 18/20 · security 17/22
reservations 6/6 · tls-floor 5/6 · fleet 3/3 · multiunit-e2e 0/3 · e2e 0/3
```

**SUPERSEDED — 2026-08-10, `--bootstrap-pool --pool-size 5`, 116 scenarios, csms-server
`de8d2fc`: 98 passed / 11 failed / 7 skipped.** Denominators differ from the line below
(116 vs 113), so compare SETS, not counts.

```
chaos 6/7 · core 17/18 · device-management 19/23 · e2e 0/3 (all skipped) · fleet 3/3
multiunit-e2e 1/3 · reservations 6/6 · security 19/24 · sessions 22/23 · tls-floor 5/6
```

### CURRENT baseline — and why it is a SET, not a number

**Do not compare a run to a pass count. Compare it to the failure SET below.** Two full
pooled runs on identical code, 40 minutes apart on 2026-08-12, produced:

| | passed | failed | skipped | `429`s seen |
|---|---|---|---|---|
| 10:37 | 98 | 4 | 11 | 18 (1 fatal) |
| 11:18 | 95 | 6 | 12 | 23 (4 fatal) |

**Exactly ONE failure appears in both**: `tls-floor/s5-rejects-revoked-cert`. Every other
failure in either run is churn. An earlier version of this very block published `98/4/11` as
*the* baseline; the next run falsified it in under an hour. That is the third time this file
has stated a number that stopped being true, and the reason is that the number was never the
stable thing.

`--all --bootstrap-pool --pool-size 5 --parallel --workers 5`, 113 scenarios,
`OSPP_PROTOCOL_VERSION=0.3.0`. Second run, per suite:

```
chaos 6/7 · core 16/18 · device-management 19/22 · e2e 0/3 · fleet 3/3
multiunit-e2e 0/3 · reservations 5/6 · security 21/24 · sessions 20/21 · tls-floor 5/6
```

**What to actually expect:**

1. **One structural failure, every pooled run** — `tls-floor/s5-rejects-revoked-cert`. The
   pool mints a fresh VALID certificate; the file needs a revoked one, so the connection it
   requires be refused is accepted. Deterministic and explained. Not a defect.
2. **`API auth failed: 429` — environmental, load-dependent, never a defect.** This is the
   dominant source of variance: 4 of the 6 failures in the second run were nothing else.
   **Do not run two full suites back to back** — the second inherits the first's throttle
   state, which is exactly what produced the table above. Wait, or accept the noise.
3. **`reservations/reserve-rejected-already-reserved` — FLAGGED, not attributed.** Expected
   `409`, got `201`: a second reservation on the same `bay_id` was accepted while the first
   was live (both POSTs use `{{bayId_1}}`, same bay, same identity, same scenario). It passed
   in the 10:37 run, so it is not deterministic. Either a race between the station's
   `ReserveBay` Response being processed and the second POST, or a real gap in the conflict
   check — **not investigated, and not to be written off as flake without looking.**
4. **The eleven `security-event-*` scenarios pass — in both runs.** `security` moved
   19/24 → 21/24 when they stopped asserting `data.length: 1`. Measured back-to-back on the
   security suite alone, same pool size, same session: **old files 15/6/3, new files 21/0/3**,
   every one of the six failing on `data.length` (`got 2` ×3, `got 3` ×3).

(The csms-server commit on UAT was not re-verified for either run — no commit is cited here,
because a baseline naming one nobody measured is the same defect as the number it replaced.)

Read a pooled run against THIS line, never against the `--station` one. Pooled mode is the
more honest instrument and legitimately fails MORE: pool stations are provisioned fresh, so
`device_management_supported` starts NULL, whereas the long-lived `stn_d4811083` carried
`true` as residue from a sibling scenario and masked three scenarios that never declared the
capability they need. Comparing the two counts directly manufactures phantom regressions.

Note WHERE the 429s land: the message is `API auth failed: 429 {"message": "Too Many
Attempts."}` — the **login** call, not `/sessions/start`. So it is not the `session-mutate`
limit §4 is about, and reading it as one sends you to the wrong control. What throttle guards
auth on UAT was not measured; what IS measured is that 113 single-use identities means 113
logins, and the endpoint pushes back. §4 buys per-scenario *session* buckets, not immunity at
the authentication step.

And note the volume, which is easy to miss because retry absorbs most of it: the 10:37 run saw
**18** `429`s and only 1 became a failure; the 11:18 run saw **23** and 4 became failures. So
a run reporting one 429-caused failure is not a run that hit the limit once. When failures
cluster in `device-management` or `core` with a `429` in the step error, that is this — count
the occurrences before reading anything structural into it.

Read against `docs/audits/adjudication/SCENARIO-AUDIT-0.13.0.md` in csms-server, which
classifies every failure. A run that reproduces those numbers is telling you the same
things; a run that does not has found something new.
