# INVESTIGATE / DESIGN — Service-catalog gap + rate-limit 429s

- **Date (UTC):** 2026-05-31T04:08:43Z
- **Mode:** Phase 1 READ-ONLY. No code changes. STOP after this note; implement on approval.
- **Goal:** push UAT full-suite coverage from 77/93 → ≥79/93 by closing the two named
  clusters from `docs/REPORT-SPRINT-pool-bootstrap-20260530T011548Z.md` §5.3.
- **Repo state:** `main` @ `931319a`. Working tree includes one untracked precursor
  INVESTIGATE doc from the offline-provisioning sprint.
- **Scope rule (re-stated):** PROD is frozen. UAT and csms-server are NOT — if a fix needs
  a server change, we implement + deploy to UAT (same pattern as the KeyStore fix). Off
  limits: only `csms-*-prod` containers.

---

## 1a — SERVICE-CATALOG cluster (5 scenarios)

### Failing scenarios + the exact serviceId each requests

All 5 scenarios use the template variable `{{serviceId_1}}` in their `POST /api/v1/sessions/start`
body. The runner resolves this in `ScenarioRunner.ts:374-377`:

```
const defaultServices = ['wash_basic', 'wash_premium', 'dry', 'vacuum'];
for (let i = 0; i < defaultServices.length; i++) {
  vars.set(`serviceId_${i + 1}`, generateServiceId(defaultServices[i]));
}
```

`generateServiceId('wash_basic')` = `'svc_wash_basic'` (`StationConfig.ts:50-52` — lowercase +
non-alphanumeric to `_`). So every scenario in this cluster requests **exactly `svc_wash_basic`**:

| # | Scenario | Endpoint | service_id sent |
|---|----------|----------|-----------------|
| 6 | `reservations/reserve-rejected-bay-busy.yaml` | `POST /sessions/start` (then `POST /reservations`) | `svc_wash_basic` |
| 13 | `sessions/full-session-lifecycle.yaml` | `POST /sessions/start` | `svc_wash_basic` |
| 14 | `sessions/session-seqno-monotonic.yaml` | `POST /sessions/start` | `svc_wash_basic` |
| 15 | `sessions/session-stop-local.yaml` | `POST /sessions/start` | `svc_wash_basic` |
| 16 | `sessions/session-timeout-timer-expired.yaml` | `POST /sessions/start` | `svc_wash_basic` |

### Spec — how the catalog is established

Quoting `spec/spec/01-architecture.md:110`:

> Each bay supports one or more services. The available services for a station are defined
> in the service catalog, which the server pushes to the station via UpdateServiceCatalog
> (see [Chapter 03 — Message Catalog](03-messages.md), Section 6.9).

And `spec/spec/01-architecture.md:152`:

> Service (`svc_`) | Server | During service catalog setup, pushed via UpdateServiceCatalog.

And `spec/spec/profiles/transaction/start-service.md:48`:

> 5. The station **MUST** validate that the `serviceId` exists in its service catalog. If not,
> it **MUST** respond with `3004 INVALID_SERVICE`.

And `spec/spec/07-errors.md:252`:

> | 3004 | `INVALID_SERVICE` | … The `serviceId` in the request does not exist in the station's
> service catalog. | Verify the service ID against the station's UpdateServiceCatalog [MSG-021]
> data. |

The wire spec defines catalog setup as server → station MQTT push (`UpdateServiceCatalog`).
It is silent on HOW the server arrives at the catalog rows it pushes — that's an issuer
implementation concern, which is what the CSMS server defines next.

### CSMS server — three-tier catalog model + the validation path

`csms-server` represents the catalog across three tables, post Brief L:

- `service_definitions` — tenant-level template (one row per `org_id × svc_*`). Carries
  `pricing_type` (enum `PerMinute | Fixed`) + recommended price. `UNIQUE(organization_id,
  service_id)`. From `database/migrations/2026_05_14_204444_create_service_definitions_table.php`.
- `station_services` — per-station instance. `FK → service_definitions(id)` RESTRICT;
  `FK → stations(id)` CASCADE; `UNIQUE(station_id, service_definition_id)`. Holds actual
  per-station prices + `available`. From `2026_05_14_204445_create_station_services_table.php`.
- `service_catalogs` — audit log row per push (catalog_version, services_data JSONB,
  previous_catalog_version). From `2026_02_20_000015_create_service_catalogs_table.php`.

Plus `stations.current_catalog_version` (NULL on first-ever push → '1'; incremented thereafter).
From `2026_05_14_204500_add_current_catalog_version_to_stations.php`.

The validation that throws `INVALID_SERVICE` lives at `app/Http/Controllers/Api/V1/SessionController.php:45-48`:

```
$serviceUuid = $this->stationQuery->resolveServiceUuid($request->validated('service_id'));
if ($serviceUuid === null) {
    return $this->errorResponse(OsppErrorCode::INVALID_SERVICE,
        "Service {$request->validated('service_id')} not found", 404);
}
```

`StationQueryService::resolveServiceUuid` (`app/Modules/Station/Services/StationQueryService.php:96-111`)
JOINs the three-tier model:

```
DB::table('station_services as ss')
    ->join('service_definitions as sd', 'ss.service_definition_id', '=', 'sd.id')
    ->where('sd.service_id', $serviceId)
    ->orderBy('ss.created_at')
    ->value('ss.id');
```

So validation succeeds **iff at least one `station_services` row exists whose joined
`service_definitions.service_id` equals the requested `svc_*`**. NULL → 404 `INVALID_SERVICE`.

### Root cause — why the bootstrap leaves these tables empty

`POST /api/v1/admin/stations` (what the bootstrap calls per station) routes to
`RegisterStationAction` (`app/Modules/Station/Actions/RegisterStationAction.php:25-57`). Per the
class docblock (lines 13-22, quoted verbatim):

> Per Brief L architectural decision: registration writes NOTHING into the services tier.
> The operator establishes the catalog via a separate PUT /catalog call after the station
> boots — which auto-creates service_definitions and upserts station_services. This avoids
> the sub-gap-D drift where registration emitted spec-invalid stub rows with hardcoded
> 'per_minute' and no pricing fields.

The action's body confirms this: it creates `stations` + N `bays` rows and nothing else. The
`services: [...]` payload nested inside our `bays:` request body in
`PoolBootstrap.ts:384-387` is **silently ignored** by the action. The old permanent UAT pool
had a catalog pushed out-of-band (per the F-PROC-1 report §3.2 + §7); the per-run bootstrap
does not.

### The "obvious" path is blocked

`PUT /api/v1/admin/stations/{stationId}/catalog` (`StationManagementController.php:518-555`) hands
off to `UpdateServiceCatalogAction::execute`. That action explicitly requires the station to be
MQTT-connected before it will dispatch (`UpdateServiceCatalogAction.php:46-50`):

```
if ($station->is_online === false) {
    throw new OsppException(OsppError::from(
        OsppErrorCode::STATION_OFFLINE,
        "Station {$stationId} is offline",
    ));
}
```

And even when online, the three-tier rows are written only by the Response handler
(`UpdateServiceCatalogResponseHandler::handleAccepted`, lines 88-158) — i.e., after the station
sends `UpdateServiceCatalog Response Accepted` over MQTT. The bootstrap does not connect any
station to MQTT; stations only connect when a scenario runs. Driving an MQTT handshake during
bootstrap (boot → wait is_online → PUT → Accepted reply → disconnect) is feasible but a
significant complexity addition for the bootstrap layer.

### Decision — Option A: privileged DB seed during bootstrap (fidelity-correct)

**Same pattern as the existing offline_enable step.** The bootstrap already does privileged
DB writes via `uatPrivileged.ts` (SSH + docker exec + psql). Extend it with a
`seedServiceCatalog(orgId, stationIds, services, dbConfig)` helper that, in **one transaction
per call**, writes rows operationally indistinguishable from what
`UpdateServiceCatalogResponseHandler::handleAccepted` would have written for a real
`UpdateServiceCatalog REQ → station Accepted` roundtrip.

#### Column fidelity (handler vs. seed, side by side)

`service_definitions` (one INSERT per `(org, svc_*)` if absent; **preserved unchanged if
present** — mirrors `resolveOrCreateDefinition` at handler:170-196):

| Column | Handler INSERT | Seed | Match |
|---|---|---|---|
| `id` | `Str::uuid7()` | DB default `uuid_generate_v4()` | ⚠ cosmetic (no reader checks UUID format; sort locality only) |
| `organization_id` | `$orgId` | `handle.orgId` | ✓ |
| `service_id` | `svc['serviceId']` | `'svc_wash_basic' / 'svc_wash_premium' / 'svc_dry' / 'svc_vacuum'` | ✓ |
| `service_name` | `svc['serviceName']` | `'Basic Wash' / 'Premium Wash' / 'Dry' / 'Vacuum'` | ✓ |
| `pricing_type` | `svc['pricingType']` (PascalCase) | `'PerMinute'` | ✓ |
| `recommended_price_credits_per_minute` | `100` (our payload) | `100` | ✓ |
| `recommended_price_credits_fixed` | `null` | `null` | ✓ |
| `recommended_price_local_*` | `null` | `null` | ✓ |
| `is_active` | `true` | `true` | ✓ |
| `created_at`/`updated_at` | `now()` | `NOW()` | ✓ |

Conflict clause: `ON CONFLICT (organization_id, service_id) DO NOTHING` — handler does not
overwrite (its docblock: *"Subsequent pushes that hit an existing definition do NOT
overwrite it — definition updates only flow through the dedicated REST endpoints"*).

`station_services` (one UPSERT per `(station, definition)` — mirrors `updateOrInsert` at
handler:128-141):

| Column | Handler | Seed | Match |
|---|---|---|---|
| `id` | DB default | DB default | ✓ |
| `station_id` | `$station->id` (UUID) | subselect on `stations.station_id = ANY(stn_*)` | ✓ |
| `service_definition_id` | resolved id | subselect on `service_definitions WHERE org+svc_*` | ✓ |
| `price_credits_per_minute` | `100` | `100` | ✓ |
| `price_credits_fixed` | `null` | `null` | ✓ |
| `price_local_*` | `null` | `null` | ✓ |
| `available` | `true` | `true` | ✓ |
| `created_at` | DB default | DB default | ✓ |
| `updated_at` | `now()` | `NOW()` | ✓ |

Conflict clause: `ON CONFLICT (station_id, service_definition_id) DO UPDATE SET
price_credits_per_minute = EXCLUDED.price_credits_per_minute, …, updated_at = NOW()` —
mirrors Laravel `updateOrInsert`.

`service_catalogs` (one INSERT per station — mirrors handler:106-114):

| Column | Handler | Seed | Match |
|---|---|---|---|
| `id` | `Str::uuid7()` | DB default | ⚠ cosmetic |
| `station_id` | `$station->id` | subselect | ✓ |
| `catalog_version` | `'1'` (first push) | `'1'` | ✓ |
| `previous_catalog_version` | NULL (first push) | NULL | ✓ |
| `services_data` | JSON of `ServiceItemDto::toPayload()` | byte-identical (see below) | ✓ |
| `applied_at` | `now()` | `NOW()` | ✓ |
| `created_at` | `now()` | `NOW()` | ✓ |

`services_data` JSON shape (key order matches PHP's `ServiceItemDto::toPayload` →
JSON.stringify produces identical bytes):
```
[{"serviceId":"svc_wash_basic","serviceName":"Basic Wash","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100},
 {"serviceId":"svc_wash_premium","serviceName":"Premium Wash","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100},
 {"serviceId":"svc_dry","serviceName":"Dry","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100},
 {"serviceId":"svc_vacuum","serviceName":"Vacuum","pricingType":"PerMinute","available":true,"priceCreditsPerMinute":100}]
```

`stations.current_catalog_version` (bump NULL → `'1'`):

```
UPDATE stations SET current_catalog_version = '1', updated_at = NOW()
WHERE station_id = ANY(<stationIds>) AND current_catalog_version IS NULL;
```

`bay_services` — deliberately NOT touched. Handler does not write it (`bay_services`
migration docblock: *"Brief L core creates the table but does NOT yet wire up the write path
in StatusNotificationHandler — that ships in Brief L-prime. Until then the table is
intentionally empty"*). Seed mirrors: no write.

#### Teardown orphan-sweep (added — fidelity-correct symmetry)

Current `buildTeardownSql` already deletes `service_catalogs` and `stations` (which cascades
`station_services`). Add one more `DELETE` so the seed's symmetric ownership is honored and
the validator-masking surface is narrowed:

```sql
DELETE FROM service_definitions sd
WHERE sd.organization_id = '<orgId>'
  AND sd.service_id = ANY(ARRAY['svc_wash_basic','svc_wash_premium','svc_dry','svc_vacuum'])
  AND NOT EXISTS (SELECT 1 FROM station_services ss WHERE ss.service_definition_id = sd.id);
```

Why this is safe and right:
- `station_services.service_definition_id` is `ON DELETE RESTRICT` — the `NOT EXISTS` clause
  is intent-explicit but FK enforces anyway.
- Scoped to OUR seeded `svc_*` set within OUR `$orgId`. Won't touch other orgs or other
  service codes.
- Self-healing for the existing stale `'Premium Wash'` row: first run after this lands UPSERTs
  through it (matches handler), runs scenarios, teardown then drops the now-orphan row.
  Subsequent runs insert canonical `'Basic Wash'` fresh.
- Re-running teardown on already-clean state is a no-op.

#### ServiceIds + names

The runner's default set (`ScenarioRunner.ts:374` → `defaultServices = ['wash_basic',
'wash_premium', 'dry', 'vacuum']`) → `serviceId_1..4 = svc_wash_basic, svc_wash_premium,
svc_dry, svc_vacuum`. The runner expects `serviceName = 'Basic Wash'` for `svc_wash_basic`
(`PoolBootstrap.ts:386` + `ScenarioRunner.ts:483-487`); the seed uses canonical names per
code (`'Basic Wash' / 'Premium Wash' / 'Dry' / 'Vacuum'`). No scenario ASSERTS on
`service_name` — grep confirms all 25 references are inside outbound `payload:` blocks of
`send` steps, zero in `assert:` blocks. So the stale-row name mismatch (first run only) is
purely cosmetic; second run is fully canonical via the orphan-sweep.

#### Why this over MQTT-handshake (B) or a new server endpoint (C)

- We already pay the privileged-DB-access cost (same SSH+psql channel as offline_enable).
  Adding the seed + orphan-sweep is the smallest delta to the bootstrap surface area.
- B requires connecting stations to MQTT during bootstrap purely to serve the catalog
  roundtrip — multiplies bootstrap I/O, adds a new failure mode (handshake timeout) before
  any scenario runs.
- C (new server endpoint that bypasses MQTT) permanently adds a non-spec test-only surface
  to the production server. The cost / payoff ratio is worse than A.

**Cross-repo posture:** A is **sim-side only**, no csms-server change.

#### Masking finding (test-isolation)

GATE 2 (Phase-1.5 verification, full-suite-style sequential run) exposed that the F-PROC-1
report's "5 service-catalog failures" was an undercount. The validator path
`StationQueryService::resolveServiceUuid` (`:104-108`) JOINs `station_services × service_definitions`
by `service_definitions.service_id` **without filtering by `ss.station_id`**. In a multi-scenario
run, if any earlier scenario (e.g. `device-management/service-catalog-update.yaml`) leaves
behind a `station_services` row, subsequent scenarios that request the same `svc_*` borrow that
row and pass — even when their own station has no catalog. The reservations suite at workers=1,
run in isolation with no prior catalog push, made `reserve-and-start` fail with
`INVALID_SERVICE` despite not being on the F-PROC-1 failure list.

Consequence: **the real recovered count after the seed lands is unknown** until a clean
full-suite post-seed run produces it. No projection. The clean run is the truth.

The orphan-sweep above narrows the surface for OUR seeded codes within OUR org — future runs
cannot mask via a definition we created and forgot. It does NOT fix the broader
validator-not-station-scoped issue (see Section 3 below).

---

## 1b — RATE-LIMIT cluster (2 scenarios)

### Endpoint + throttle window

Both failing scenarios drive `POST /api/v1/reservations`:

- `reservations/reserve-rejected-already-reserved.yaml` — calls it **twice** (the second is the
  one being asserted).
- `reservations/reserve-rejected-maintenance.yaml` — calls it once.

Per `routes/api/v1/sessions.php:33`:

```
Route::middleware(['idempotency.required', 'throttle:session-mutate'])->group(function () {
    Route::post('/reservations', [ReservationController::class, 'store'])->name('reservations.store');
    Route::post('/reservations/{id}/cancel', [ReservationController::class, 'cancel'])->name('reservations.cancel');
});
```

`POST /sessions/start` is in the same group (line 17) — so reservations **share the
session-mutate bucket with every `sessions/start` call** the suite makes.

The limit definition (`app/Providers/AppServiceProvider.php:111-117`):

```
RateLimiter::for('session-mutate', function (Request $request) {
    if (app()->isLocal()) {
        return Limit::none();
    }
    return Limit::perMinute(10)->by($request->user()?->id ?? $request->ip());
});
```

→ **10 requests / minute / user-id** on UAT (`isLocal()` false). Returns 429 once exceeded.

### Per-IP, per-user, or per-route

`by($request->user()?->id ?? $request->ip())` — keyed on `user_id` when authenticated (always
true here; bootstrap and every scenario use the same `UAT_EMAIL` JWT). It is **per-user, not
per-route**: the limit pools `sessions/start` + `sessions/{id}/stop` + `reservations` +
`reservations/{id}/cancel` into one bucket. With a single identity driving the whole suite,
this is the binding constraint.

### Concurrency context

The F-PROC-1 report § 5.3 row 5,7 explicitly tags these as "rate limit under --workers 5".
The full live suite was run with `--workers 5`. With:
- ~30+ pool-dependent scenarios firing a `sessions/start` mutation each
- 6 reservation scenarios firing `POST /reservations` (often plus a cancel)
- All under one user_id

—the bucket overflows the moment 5 workers pile mutations into the same sliding minute. Note
the report did **not** verify single-threaded vs parallel; the failure was inferred from the
load shape + Laravel's standard 429 message. The 10/min ceiling is low enough that even
sequential runs that bunch mutations within 60s would hit it (15+ mutating scenarios within
a minute would 429 the tail), so the issue is structurally workers-independent, just much
more acute at workers=5.

### Decision — Option B: 429-aware retry in `ApiCallStep`

Today `ApiCallStep.ts` (306 lines) treats any non-`expect_status` response as a hard failure
(line 245-269) — there is no retry path. Add a bounded 429 retry:

- On any HTTP 429, **respect the `Retry-After` header** when present (Laravel's
  `ThrottleRequests` middleware sets it to the seconds remaining in the window). Fall back to
  exponential backoff with jitter (e.g. 500ms → 1s → 2s, ±20% jitter) when absent.
- **Cap at 3 retries.** After the cap, fall through to the normal expect_status mismatch error
  (so a genuine misconfiguration still surfaces, never silent infinite retry).
- Scoped to **api_call steps only** (the scenarios' own MQTT `wait_for` timing is unrelated).
- A scenario that intentionally tests 429 would need an opt-out (`retry_on_429: false`) — none
  exist today. Document the new behavior in the scenario template comments.

**Why this over the alternatives:**
- **Lower `--workers` for bootstrap runs** doubles wall-clock (~206s → 400s+) without solving
  the underlying single-identity contention.
- **Per-worker user identities** require either platform_admin or another privileged DB seed
  (users + organization_members + Spatie role rows) — high blast radius for a 2-scenario fix.
- **Raise the server limit** (or scope it per-station) is a csms-server change deployable to UAT,
  but B fixes the symptom inside the simulator with no server surface change. Worth raising as
  a follow-up if more scenarios start hitting the ceiling.

**Cross-repo posture:** B is **sim-side only**, no csms-server change.

**Recovers:** both `reserve-rejected-already-reserved` and `reserve-rejected-maintenance`. Also
hardens any future mutation-heavy scenario against the same ceiling.

---

## 2 — Out of scope (re-stated; not touched this sprint)

Confirmed unchanged from F-PROC-1 § 5.3 categorization:

- e2e org-create permissions (#2–4) — needs platform_admin / C-018.
- Cert-admin permissions (#8, #9, #12) — perm gap, C-018-adjacent.
- Server 500 on `POST /offline/passes` (#10) — separate csms-server defect, F-PROC-1 § 6.
- Server reconciliation `RetryLater` (#11) — server behavior.
- `Reset Rejected Active Sessions` (#1) — shared-state / stale-active-session.

---

## 3 — Possible production validation bug — server follow-up (not this sprint)

**Severity: prod correctness / overbilling risk.** Surfaced while resolving the seed-fidelity
question; logged here so it isn't lost.

`app/Modules/Station/Services/StationQueryService.php:96-111` (`resolveServiceUuid`) — called
from `SessionController::start` (line 45) before every session — JOINs `station_services ×
service_definitions` on `service_definitions.service_id = :svcId` **without filtering by
station**. It returns the first matching `station_services.id` ordered by `created_at`.

```
DB::table('station_services as ss')
    ->join('service_definitions as sd', 'ss.service_definition_id', '=', 'sd.id')
    ->where('sd.service_id', $serviceId)
    ->orderBy('ss.created_at')
    ->value('ss.id');
```

The comment on lines 101-103 acknowledges this: *"Returns the first match by created_at;
per-station scoping (when a service code is present on multiple stations) moves to callers
in Brief L-prime."*

**Production impact when more than one station in an org carries the same `svc_*` code:**
a session-start request naming a `service_id` that the request's actual station does NOT
carry — but some other station in the same org does — will be **accepted**. `sessions.service_id`
then FK's at the *other* station's `station_services` row, and downstream pricing,
reporting, and billing read THAT row's prices. A station could start and bill a service it
doesn't offer.

The session is bay-scoped (`bay_id` is the request's other anchor), so the wrong-catalog bill
attaches to a real bay on the real station — fraud detection would not trivially flag it. The
window only widens as orgs add stations with diverging catalogs.

**Proposed fix (server, post-sprint):**
- Change signature: `resolveServiceUuid(string $serviceId, ?string $osppStationId = null): ?string`.
- When `$osppStationId` is provided: add `WHERE ss.station_id = (SELECT id FROM stations
  WHERE station_id = :osppStationId)`.
- Update callers — `SessionController::start` passes the station id derived from the request
  bay; `SessionCommandAdapter::resolveServiceUuid` likewise.
- Add a regression test: two stations in one org with disjoint catalogs; cross-station
  `service_id` rejected with `INVALID_SERVICE`.

**Why this sprint doesn't fix it:**
- Out of brief scope (we're closing the UAT coverage gap, not auditing prod validators).
- Cross-repo csms-server change requires a separate deploy + regression-test cycle.
- The orphan-sweep in commit #1 narrows OUR exposure to the masking effect; broader fix is
  the server change above.

---

## 4 — Implementation plan (on approval)

One concern per commit, in this order. Re-runs the full suite after each so we can attribute
delta cleanly.

1. **`feat(bootstrap): seed service catalog (service_definitions/station_services/service_catalogs)
   for the per-run pool`**
   - New `uatPrivileged.ts` helper: `seedServiceCatalog(orgId, stationIds, services, dbConfig)`.
     - `service_definitions`: `INSERT … ON CONFLICT (organization_id, service_id) DO NOTHING`
       (mirrors handler `resolveOrCreateDefinition` — preserves existing rows).
     - `station_services`: `INSERT … ON CONFLICT (station_id, service_definition_id) DO UPDATE
       SET price_credits_per_minute = EXCLUDED.…, updated_at = NOW()` (mirrors Laravel
       `updateOrInsert`).
     - `service_catalogs`: one audit-log `INSERT` per station with `catalog_version = '1'`,
       `previous_catalog_version = NULL`, `services_data = <canonical JSON>`.
     - `stations.current_catalog_version`: `UPDATE … SET '1' WHERE current_catalog_version
       IS NULL` (preserves natural increment for any subsequent real `UpdateServiceCatalog`).
   - Wire-up: call from `bootstrapPool()` after the `registerAndProvisionStation` loop, before
     the `offline-enable` step. Always required (no `--no-seed-catalog` flag).
   - DB reachability check (`assertUatDbReachable`) moved to ALWAYS run (was conditional on
     `enableOffline`); seed is non-optional, so DB must be reachable for every bootstrap.
   - **Teardown orphan-sweep** (NEW): add `DELETE FROM service_definitions WHERE
     organization_id = :orgId AND service_id = ANY(:svcCodes) AND NOT EXISTS (SELECT 1 FROM
     station_services WHERE service_definition_id = sd.id)` to `buildTeardownSql`, placed
     after the `stations` delete (so cascade has dropped `station_services` first). Self-heals
     the existing stale `'Premium Wash'` row on the first run.
   - ServiceIds + names = the runner's default set: `svc_wash_basic / svc_wash_premium /
     svc_dry / svc_vacuum`, names `Basic Wash / Premium Wash / Dry / Vacuum`, all
     `PerMinute` @ 100 credits/min.
   - Unit tests: SQL text shape (verify the exact ON CONFLICT clauses and the JSON byte
     shape of `services_data`), the orphan-sweep is present in `buildTeardownSql`, empty
     stationIds is a no-op, sqlLiteral escaping intact.
   - Live UAT validation: clean full suite after the change — **expected count: unknown**.
     The projected "+5" was an undercount of the actual gap because the validator masking
     (Section 3) let several scenarios borrow stale rows from earlier ones in the F-PROC-1
     run. The clean post-seed full-suite run is the source of truth; will be reported raw
     with the per-scenario list of flips.

2. **`feat(engine): bounded 429-aware retry in ApiCallStep (Retry-After + jitter, cap 3)`**
   - In `ApiCallStep.ts`, on status 429: parse `Retry-After` (seconds or HTTP date), else use
     500ms × 2^attempt with ±20% jitter; max 3 retries; pass-through to expect_status mismatch
     on exhaustion.
   - Opt-out hook (`retry_on_429: false`) for future scenarios that test the ceiling explicitly.
   - Unit tests: respects Retry-After header, exponential backoff path, cap, opt-out, no retry
     on other 4xx, retry then succeed → expect_status check still runs.
   - Live UAT validation: clean full suite after the change. Reported raw, no projection.

---

## 5 — Gate verifications (post-approval, before implementation)

Both gates the user requested before approving implementation came back clean:

**GATE 1 — bootstrap a single station, query the catalog tables (raw).**
- `stations.current_catalog_version = NULL` for `stn_f92d8557`.
- `station_services` count for that station = **0**. Structural hypothesis confirmed:
  `RegisterStationAction` writes nothing to the services tier.
- `service_catalogs` count = 0; `bay_services` count = 0.
- `service_definitions` count for the org = **1** stale row:
  `(svc_wash_basic, "Premium Wash", PerMinute, 100)` from `2026-05-29 21:20:00+00` —
  leaked from a prior `device-management/service-catalog-update.yaml` run whose teardown
  didn't clean it. 0 paired `station_services` org-wide, so validation still fails today.
  The orphan-sweep in commit #1 sweeps this on the first run.
- Post-teardown: pristine (`stations=0, pool_locations=0, station_services=0,
  service_catalogs=0, offline_enabled=false`). The 1 stale `service_definitions` row
  persists (not ours; teardown won't sweep it until our seed first owns it).

**GATE 2 — reservations suite single-threaded (`--suite reservations --workers 1`).**
- Both rate-limit-cluster scenarios — `Reserve Rejected — Already Reserved` and
  `Reserve Rejected — Bay Maintenance` — **passed**. No 429.
- Verdict: the 429s are a pure parallelism artifact at workers=5 (one user-id bucket,
  10/min, ~30+ mutating scenarios). The retry/backoff in commit #2 is the correct
  surgical fix.
- **Masking casualty surfaced**: `Reserve and Start` failed with `INVALID_SERVICE` —
  NOT on the F-PROC-1 failure list. This is the masking effect in action (Section 3):
  in the F-PROC-1 full run, an earlier scenario's `station_services` row let it pass;
  in our isolated reservations-suite run, no such row existed. The post-seed full run
  will reveal the actual recovered set; could include `Reserve and Start` and other
  unknown masking casualties.

---

**STOP — awaiting approval before any code change.**
