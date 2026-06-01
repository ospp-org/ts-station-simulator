# INVESTIGATE / DESIGN — Per-station identity (one structural fix for the 14 rate-limit failures)

- **Date (UTC):** 2026-06-01T03:36:04Z
- **Mode:** Phase 1 READ-ONLY. No code, no commits. STOP after this note.
- **Reframing premise (from the brief):** The 14 rate-limit failures are a *test-isolation defect*,
  not a server-capacity problem. ~30 piece-level scenarios all auth as ONE identity (`UAT_EMAIL`),
  collapsing what a real client (30 stations, 30 contexts) would split into one
  `session-mutate` bucket. The fix is to give each piece-level scenario its own identity,
  not to raise the server limit.
- **Effort:** max.
- **Scope rule re-stated:** PROD frozen; UAT and csms-server NOT frozen. This sprint touches
  neither — fix is sim-side only.

---

## 1 — Two test classes (confirmed from the scenario tree)

### 1a — e2e self-build flow (3 scenarios — KEEP FUNCTIONAL, do NOT change)

`scenarios/e2e/`:
- `e2e-new-customer-onboarding.yaml`
- `e2e-returning-customer-session.yaml`
- `e2e-session-end-matrix.yaml`

These build their world from scratch via API: they call `POST /api/v1/auth/register` at the
start (`e2e-new-customer-onboarding.yaml:36`) to create their OWN user, then drive the full
SMB-owner-signs-up → org-created → station-registered → session flow. They are correct by
construction — each run gets its own user, its own org, its own station.

The 3 currently fail with **403 on `POST /organizations`** (`platform.organizations.create`
is `platform_admin`-only per `RolesAndPermissionsSeeder.php:199-200`). That's an
`UAT_EMAIL`-permission gap (C-018-adjacent), **out of scope** of this sprint and untouched
by the proposed change.

### 1b — Piece-level scenarios (~33 — the source of the 14 rate-limit failures)

All non-e2e scenarios that drive a `session-mutate` endpoint (raw grep `sessions/start`,
`sessions/{`, `/reservations`, `/cancel`, `admin/stations.*catalog`). Categorized:

- `scenarios/reservations/*` (6) — reserve-and-start, reserve-cancel, reserve-expire,
  reserve-rejected-already-reserved, reserve-rejected-bay-busy, reserve-rejected-maintenance.
- `scenarios/sessions/*` (~18) — full-session-lifecycle, meter-values-streaming, session-*,
  start-service, stop-service, stop-service-rejected.
- `scenarios/device-management/*` (2) — reset-rejected-active-sessions, service-catalog-update.
- `scenarios/chaos/*` (2), `scenarios/fleet/*` (2).

These all assume a **shared bootstrapped pool + shared identity** — no `auth/register` step,
no captured token. They take the identity straight from `target.credentials` (which the
runner injects as `context.apiCredentials`, see §2 below).

### 1c — Three representative piece-level scenarios (raw)

| Scenario | Identity | Station | Mutating API calls |
|---|---|---|---|
| `sessions/full-session-lifecycle.yaml` | `UAT_EMAIL` (default; no `set_auth_token`, no `auth/register`) | `{{stationId}}` — pool allocator hand-out from `target.stationPool` | `POST /sessions/start` (background, line 82), `POST /sessions/{captured.sessionId}/stop` (foreground, line 158) |
| `reservations/reserve-rejected-bay-busy.yaml` | `UAT_EMAIL` | pool hand-out | `POST /sessions/start` (background, line 60), `POST /reservations` (foreground, line 97) |
| `sessions/meter-values-streaming.yaml` | `UAT_EMAIL` | pool hand-out | `POST /sessions/start` (background) |

All three share one user → one `session-mutate` bucket. Verified via `ApiCallStep.ensureAuth`
which uses `tokenCache.get(\`${baseUrl}::${email}\`)` (`ApiCallStep.ts:166`) — same email
across all scenarios → same cached token → same `user_id` server-side → same bucket.

---

## 2 — Isolation mechanics today (raw evidence)

### 2a — Identity is resolved ONCE, globally, from `target.credentials`

`ScenarioRunner.ts:661` (per-scenario hand-off):
```
context.apiCredentials = target.credentials;
```

`target.credentials` is hydrated from `config/targets.yaml`:
```
uat:
  credentials:
    email: "${UAT_EMAIL}"
    password: "${UAT_PASSWORD}"
```

`ApiCallStep.ensureAuth()` (`:162-198`) caches the JWT per `(apiBaseUrl, email)` in a
module-level `tokenCache: Map<string, string>` (`:63`). Every scenario in the run resolves
to the SAME cache key and uses the SAME token. There is no per-scenario or per-worker
override path.

### 2b — Pool allocator hands out distinct stations per concurrent acquire

`StationPoolAllocator` (`ScenarioRunner.ts:552-583`):
```
class StationPoolAllocator {
  private readonly pool: string[];
  private readonly inUse: Set<string> = new Set();
  private nextIndex = 0;
  private readonly waiting: Array<(stationId: string) => void> = [];

  async acquire(): Promise<string> {
    for (let attempts = 0; attempts < this.pool.length; attempts++) {
      const id = this.pool[this.nextIndex % this.pool.length];
      this.nextIndex++;
      if (!this.inUse.has(id)) { this.inUse.add(id); return id; }
    }
    return new Promise<string>((resolve) => this.waiting.push(resolve));
  }

  release(stationId: string): void {
    this.inUse.delete(stationId);
    if (this.waiting.length > 0) {
      this.inUse.add(stationId);
      this.waiting.shift()!(stationId);
    }
  }
}
```

→ Two concurrent scenarios get DIFFERENT stations (no collision). With pool_size = 5 and
workers = 5, each worker holds a distinct station at any moment. The pool of stations is
already isolated; the identity is what's collapsed.

### 2c — The session-mutate bucket key

`AppServiceProvider.php:111-117`:
```
RateLimiter::for('session-mutate', function (Request $request) {
    if (app()->isLocal()) return Limit::none();
    return Limit::perMinute(10)->by($request->user()?->id ?? $request->ip());
});
```

Keyed on **`user_id`**. One user → one bucket. N users → N independent buckets.

---

## 3 — Three isolation options, evaluated

### (a) Per-worker identity (N = pool_size workers ≈ 5)

Bootstrap provisions N users. The runner pairs each worker with one user for the worker's
lifetime; the worker auths as its assigned user across every scenario it runs.

- **Pros:** Smallest user count. Cleanly mirrors "1 client per worker" mental model.
- **Cons:** Identity isn't tied to persistent state. If a worker's user/station mapping
  changes mid-run, the abstraction frays. Indirection between (worker → identity) and
  (worker → station-currently-held) is independent — two state machines.

### (b) Per-scenario identity (N = ~93 users)

One user per scenario, created at scenario start, torn down at scenario end.

- **Pros:** Maximum isolation. Each scenario sees a pristine bucket.
- **Cons:** N is 18× larger than (a) for no additional functional gain (workers are already
  the unit of concurrency, so the binding bucket constraint is per-worker, not per-scenario).
  Bootstrap and teardown overhead grow linearly. Heavyweight.

### (c) Per-station identity (N = pool_size ≈ 5) — RECOMMENDED

Bootstrap provisions N users, **one per pool station, persistently paired**. The pool
allocator returns a `(stationId, credentials)` tuple instead of just `stationId`. The runner
sets `context.apiCredentials` from the tuple's credentials, NOT from `target.credentials`,
when a scenario acquires a pool slot.

- **Pros:**
  - Identity is tied to PERSISTENT state (the station). When a scenario acquires station X,
    it acquires station-X-user. One abstraction.
  - Pool_size = workers gives 1-to-1 worker-user mapping at any moment (since at most one
    worker holds a given station at a time). Workers don't share buckets.
  - With pool_size > workers, scales naturally — multiple stations queue per worker, each
    with its bucket; worker bursts can be absorbed across the queue's buckets.
  - Maps cleanly to real-world: each station has its own "operator account" in the wild.
- **Cons:** Marginally more state to track (N pairs vs N solo users). Negligible.

**(a) and (c) collapse when pool_size = workers.** (c) is preferred for the clearer
state-machine: identity follows the station, not the worker.

---

## 4 — Recommended change: per-station identity

### 4a — Bootstrap implementation channel

Two viable paths, both build on the existing `uatPrivileged.ts` privileged-DB pattern:

**Path A — API InviteMember + DB token-fetch + API AcceptInvite (RECOMMENDED).**
Uses the public invitation flow end-to-end, with one minimal DB SELECT to bridge the
email-only token-delivery gap.

1. Login as `UAT_EMAIL` (already done in `bootstrapPool()`).
2. For each pool slot `i`:
   - `POST /api/v1/organizations/{orgId}/members/invite` with `{ email:
     "sim-worker-${runStamp}-${i}@test.local", role: "tenant_operator" }`. Server returns
     `InvitationResource` with `id`, `email`, `role`, `status`, but **NOT the raw token**
     (`InvitationResource.php:21-33` — token omitted from the public projection).
   - **Privileged DB SELECT** (mirrors existing `runUatSql` usage): `SELECT token FROM
     invitations WHERE id = :invId` to retrieve the raw token. Read-only; no write.
   - `POST /api/v1/auth/accept-invite/{token}` with `{ password: <fixed>, name: ... }`.
     Server creates the user with the invited role + returns a JWT bundle
     (`AuthController.php:92` `acceptInvite` action, *"Returns a JWT bundle so the invitee
     is logged in immediately"*).
3. Cache the per-station `{ email, password }` in the bootstrap handle.

**Path B — Pure DB seed.** Insert `users` + `organization_members` + `model_has_roles` rows
directly. Bypasses `MemberObserver` (server-side observer that auto-syncs Spatie role rows
when an `organization_members` row is inserted via Eloquent), so we'd need to insert
`model_has_roles` ourselves, plus handle the per-tenant role duplication noted at
`RolesAndPermissionsSeeder.php:219-221`. More moving parts; rejected unless Path A hits a
blocker.

Both paths use the same SSH+psql channel as `setOfflineEnabled` / `seedServiceCatalog` /
the teardown SQL — no new infrastructure.

**Role choice — `tenant_operator`.** Permission-seeded perms (lines 349-368) include
`sessions.view`, `sessions.stop`, `reservations.view`, `reservations.cancel`, `bays.update`,
`stations.configure` — sufficient for piece-level scenarios. Crucially, the
`session-mutate` routes (`POST /sessions/start`, `POST /reservations`, etc.) **are NOT
gated on a Spatie permission** — `routes/api/v1/sessions.php:17-20` shows only
`auth.jwt + idempotency.required + throttle:session-mutate`. So any authenticated role
works for the actual mutation; `tenant_operator` is the principled "non-owner staff"
choice and matches real-world deployment.

### 4b — Pool allocator change

Extend `StationPool` entries (or thread a parallel map) so each pool slot carries
`{ stationId, email, password }`. `StationPoolAllocator.acquire()` returns the tuple;
release is unchanged. `ScenarioRunner.runOne()` reads the tuple and sets
`context.apiCredentials = tuple.credentials` BEFORE the first `ApiCallStep` runs.
`ApiCallStep.ensureAuth()` already keys its `tokenCache` per `(baseUrl, email)`, so each
station's user gets its own cached JWT automatically — zero ApiCallStep change.

### 4c — Teardown additions

Symmetric ownership, same channel as the existing teardown SQL:

```sql
-- After DELETE FROM stations cascade, before the orphan-sweep block:
DELETE FROM organization_members om
WHERE om.user_id IN (SELECT id FROM users WHERE email = ANY(:seededEmails));

DELETE FROM model_has_roles mhr
WHERE mhr.model_id IN (SELECT id FROM users WHERE email = ANY(:seededEmails));

DELETE FROM invitations WHERE email = ANY(:seededEmails);
DELETE FROM users WHERE email = ANY(:seededEmails);
```

Idempotent (re-running deletes 0 rows). Scoped by email pattern minted at bootstrap so it
cannot touch real users.

---

## 5 — Why this fixes all 14 at the root

**The math.** Today's bucket: one user → 10 mutations/minute. The suite fires ~20 mutating
scenarios in ~5 minutes wall-clock at workers=5; each scenario has 1–3 mutations →
~30–40 mutations bunched into ≤2 minutes of contended windows → bucket overflows, 14 fail.

After per-station identity (N = pool_size = 5): five buckets → 5 × 10 = **50 mutations/min
of headroom**. The same 30–40 mutations spread across 5 buckets averages ~6–8 per worker
per minute, well under the 10/min ceiling. **No bucket contention possible by construction**
unless a single station+worker pair sustainably exceeds 10 mutations/minute — which no
scenario does (each takes 1–3 mutations and ~3–15s; the bucket replenishes faster than the
worker can drain it).

**Why this is at the root, not a workaround.** The 10/min is the production limit. The
production model assumes one user per client; the test currently violates that. Once each
station has its own user, the limit applies as designed and the tests cease to be a special
case.

**Side benefit: addresses the masking finding partially without server change.** The
prod-bug elevation (validator not station-scoped, `StationQueryService.php:104-108`)
remains a server follow-up. But with each station carrying its OWN seeded catalog AND its
OWN user driving sessions FOR THAT station, the residual cross-station leakage surface
collapses to the validator's choice of *which* equivalent row to return — and since every
station's catalog seed contains the same 4 codes with the same pricing, the choice is
functionally equivalent. Test isolation is regained even though the server bug remains.

---

## 6 — What this fix does NOT require (re-stated explicitly)

- **No `session-mutate` server limit change.** The 10/min stays as designed.
- **No retry as a dependency.** The 429 retry from commit #2 stays in (it's harmless and
  absorbs incidental spikes), but the design no longer leans on it to recover scenarios.
  After per-station identity, the retry should fire ~0 times in a healthy run.
- **No `--workers` reduction.** Workers=5 keeps its parallelism budget. (Higher workers
  would also work, bounded by pool_size.)
- **No per-station-user permissions audit.** `tenant_operator` is sufficient because the
  session-mutate routes don't gate on Spatie permissions.
- **No scenario-YAML edits.** Identity flows in via `context.apiCredentials` from the
  pool allocator; scenarios continue to call ApiCallStep with the same templates.

---

## 7 — Risks / caveats called out

- **`InvitationResource` token omission** — the public response intentionally hides the raw
  token. The DB SELECT is a one-line read-only privileged action mirroring the existing
  `runUatSql` channel; it's not a new capability class.
- **Email collisions on re-bootstrap.** Use a run-stamp in the email pattern
  (`sim-worker-${runId}-${i}@test.local`) so re-runs never collide on the `users.email`
  unique constraint. Teardown sweeps by the same pattern.
- **Server-side `MemberObserver` interaction with API-driven membership.** Path A uses
  the API (InviteMember + AcceptInvite), which fires the observer normally → Spatie roles
  bound correctly. Path B (pure DB) is the riskier path and is the fallback only.
- **Permission breadth check.** Before commit, do a one-line live verification: bootstrap
  one user via Path A, log in as it, fire `POST /sessions/start` against one of its
  station's bays. If it returns 201 (or 422/504 for an MQTT-side reason), the role is
  sufficient. If 403, fall back to `tenant_admin` (broader perms).

---

## 8 — Implementation plan (on approval)

ONE commit, ONE concern:

**`feat(bootstrap): per-station identity — provision N users paired to the pool stations`**
- `uatPrivileged.ts`: add `inviteAndAcceptMember(orgId, email, password, role)` (API + 1
  read-only SQL SELECT for the invite token), plus a `runUatSqlQuery` helper that returns
  rows (existing `runUatSql` only returns raw stdout).
- `PoolBootstrap.ts`: extend `PoolBootstrapHandle` with `users: Array<{ email, password,
  stationId }>`. After the `seedServiceCatalog` step, loop pool stations and provision a
  paired user per station.
- `StationPool.ts` / `StationPoolAllocator`: pool entry carries `credentials`; `acquire()`
  returns the tuple; release unchanged.
- `ScenarioRunner.runOne()`: when `poolStationId` is acquired, set `context.apiCredentials`
  from the pool entry's credentials (falls back to `target.credentials` when no pool).
- `buildTeardownSql`: append DELETEs for `organization_members`, `model_has_roles`,
  `invitations`, `users` scoped to the bootstrap's email set.
- Unit tests: pool entry carries credentials, runner picks them up over `target.credentials`,
  teardown SQL contains the user-cleanup block scoped to seeded emails.
- Live UAT validation: one-scenario sanity (full-session-lifecycle) confirming the new
  user can drive sessions/start; then clean full suite. The truth is the clean run —
  no projection — but the expected outcome is **the 14 rate-limit failures recover**
  leaving the 8 out-of-scope structural blockers as the only remainder.

After landing: commit #2's 429 retry stays in as defense-in-depth, but is now expected to
fire zero or near-zero times in a healthy run.

**STOP — awaiting your approval to implement.**
