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
| `UAT_EMAIL` / `UAT_PASSWORD` | any scenario with an `api_call` | Resolves `${UAT_EMAIL}` in `config/targets.yaml`. The values in the repo `.env` were stale as of this run — they 401. A live pool identity from `tests/artifacts/pool-handle.json` works. |
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
| whole-suite runs | rate limiting — see §4 |

None of these are defects. They are the mode's boundary, and a summary line cannot tell
them apart from a real failure.

---

## 3. Scenarios with REQUIRED `--var`s

Substitution throws when one is missing. Since 2026-08-07 the failure names the step and
the variable; before that it printed a bare red scenario name and nothing else.

| scenario | required |
|---|---|
| `multiunit-e2e/single-session-drive` | `--var reason=<SessionEndReason>` e.g. `TimerExpired`. Its header says so. Passes 12/12 with it. |
| `sessions/session-rejected-invalid-service-cross-station` | `--var stationA_bayId=… --var stationB_serviceId=…`, plus **two** manually provisioned stations in one org with disjoint catalogs. `skip_when_pooled` carries the reason. |
| most `sessions/*`, `reservations/*` | `--var serviceId_1=<real svc_*>` — otherwise a random serviceId is generated and `/sessions/start` 404s `3004 INVALID_SERVICE` |

`{{bayId_N}}` is hydrated automatically from `<stationId>-bays.json`; serviceIds are not.

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

---

## A known-good baseline

Verified against UAT on 2026-08-07, `--station stn_d4811083`, `OSPP_PROTOCOL_VERSION=0.3.0`:

```
core 12/16 · chaos 6/7 · device-management 19/21 · sessions 18/20 · security 17/22
reservations 6/6 · tls-floor 5/6 · fleet 3/3 · multiunit-e2e 0/3 · e2e 0/3
```

Read against `docs/audits/adjudication/SCENARIO-AUDIT-0.13.0.md` in csms-server, which
classifies every failure. A run that reproduces those numbers is telling you the same
things; a run that does not has found something new.
