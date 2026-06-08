# INVESTIGATE — Offline enablement + provisioning mechanics

- **Mode:** READ-ONLY investigation. No code changes, no commits, no UAT mutations.
- **Date (UTC):** 2026-05-29T11:07:24Z
- **Effort:** max
- **Purpose:** Answer 3 questions to inform the design of a "self-provisioning setup"
  sprint that makes component-suite scenarios hermetic (create their world, clean up),
  the way `e2e/*` scenarios already do. Context: the UAT coverage suite is down because
  component scenarios depend on a permanent station pool that has evaporated (F-PROC-1).
  We are **not** fixing that here — gathering facts to design the fix.
- **Repos audited (read-only):**
  - ts-station-simulator: `/home/gabi/dev/projects/ospp/ts-station-simulator`
  - spec: `/home/gabi/dev/projects/ospp/spec` (prose under `spec/spec/`)
  - csms-server: `/home/gabi/dev/projects/osp/csms-server`

---

## Executive summary — the three decisive verdicts

1. **Q1 — Per-user "offline enabled" is NOT an OSPP protocol concept.** The protocol gives
   a *station* offline toggle (`OfflineModeEnabled`) and station capability flags
   (`offlineModeSupported`, `bleSupported`). There is **no field, key, message, or error
   code** for per-user offline eligibility. Per-user offline access is realized **entirely**
   by the OSP server's decision to issue / refuse / revoke an OfflinePass — pure issuer policy
   that never appears on the wire. (Grep of the entire spec for `eligib`/`entitle`/`opt-in`/
   `offline_enabled` → **0 hits**.)

2. **Q2 — `users.offline_enabled` is DB-ONLY to enable.** No controller, action, route, or
   artisan command sets it `true` at runtime. The column defaults `FALSE`; the **only**
   runtime write in application code sets it `false` (fraud auto-disable). The flag is only
   ever set `true` in non-production code (a seeder and a test factory). Turning a user
   offline-enabled today requires **out-of-band DB access or a privileged seeder** — there is
   no application write path, and the existing `E2EBootstrapSeeder` sets it `false`.

3. **Q3 — 90 of 93 scenarios are pool-dependent; only the 3 `e2e/*` self-provision; teardown
   is NOT automatic.** The reusable hermetic primitive already exists end-to-end in the e2e
   scenarios (register → provision → boot). But it has two gaps blocking lift-and-reuse:
   (a) a **200-vs-201 status mismatch** between the simulator and the live provisioning
   endpoint, masked by a unit test that mocks the wrong status; and (b) **no engine-level
   teardown** — cleanup has always been a manual, external bootstrap-agent responsibility.

**Headline for the next sprint:** Adopt the e2e register→provision recipe as a **per-scenario
hermetic setup** (90 scenarios to convert), fix the 200/201 contract, add an engine-level
teardown, and — critically for the offline-pass subset — resolve that **`offline_enabled`
cannot be flipped sim-side** (needs a privileged step or new server endpoint).

---

## Q1 — SPEC: offline CONFIG / ENABLEMENT dimension (not signing)

All citations under `/home/gabi/dev/projects/ospp/spec/`. Config registry: `spec/08-configuration.md`.
(Per brief: the signing/crypto dimension was settled in the C-015 SPEC GATE and is **not** re-audited here.)

### A. The Offline profile — actually **12 keys**, not ~8

The profile is **"Offline / BLE"** and is **Conditional — required only if
`capabilities.bleSupported = true`** (`spec/08-configuration.md:71`, `:75`, `:127`). The
profile-grouping header lists **12** keys (`:71`); the per-key table is `:129–142`. The brief
expected ~8; the spec defines **12** = 3 offline-semantic + 1 revocation + 8 BLE-transport
tuning. **All 12 are `RW` + `Dynamic`.**

| # | Key | Default | Access | Mutability (range) | Governs | Citation |
|---|-----|---------|:------:|--------------------|---------|----------|
| 1 | `OfflineModeEnabled` | `true` | RW | Dynamic | **Station-wide offline master switch** — when `true`, station accepts offline session auth via BLE; when `false`, all BLE auth rejected | `08-configuration.md:131` |
| 2 | `MaxOfflineTransactions` | `50` | RW | Dynamic (10–500) | Max offline tx buffered before server reconciliation | `:132` |
| 3 | `OfflinePassMaxAge` | `3600` | RW | Dynamic (300–86400) | Max age (s) for a pass to be valid; older passes MUST be rejected | `:133` |
| 4 | `BLEAdvertisingEnabled` | `true` | RW | Dynamic | Master switch for BLE advertising | `:134` |
| 5 | `MaxConcurrentBLEConnections` | `1` | RW | Dynamic (1–3) | Max simultaneous BLE GATT connections | `:135` |
| 6 | `BLEAdvertisingInterval` | `200` | RW | Dynamic (100–2000 ms) | BLE advertising interval | `:136` |
| 7 | `BLETxPower` | `4` | RW | Dynamic (−20–10 dBm) | BLE TX power | `:137` |
| 8 | `BLEConnectionTimeout` | `30` | RW | Dynamic (10–120) | Idle seconds before dropping a BLE connection | `:138` |
| 9 | `BLEMTUPreferred` | `247` | RW | Dynamic (23–517) | Preferred ATT MTU bytes | `:139` |
| 10 | `BLEStatusInterval` | `5` | RW | Dynamic (1–30) | BLE Service Status (FFF5) notification interval | `:140` |
| 11 | `RevocationEpoch` | `0` | RW | Dynamic (0–2147483647) | Global pass revocation epoch; server bumps to batch-revoke passes issued before it | `:141` |
| 12 | `BLEMaxRetries` | `3` | RW | Dynamic (1–10) | Max BLE reconnection attempts before error state | `:142` |

Access legend: `RW`=ReadWrite, `R`=ReadOnly, `W`=WriteOnly (`:39–43`). Mutability legend:
`Dynamic`=immediate (`Accepted`), `Static`=after reboot (`RebootRequired`) (`:55–58`).

### B. `OfflinePassPublicKey` (Security profile) — config-key facts only

`spec/08-configuration.md:119` (listed under the **Security** profile, `:70`):

- Name (verbatim): `OfflinePassPublicKey`; Type: string; **Default: `--`** (none)
- **Access: `W` (WriteOnly)** — by the legend, WriteOnly keys are accepted via
  ChangeConfiguration but MUST NOT be returned in GetConfiguration (anti-leak, `:43`, `:49`)
- Mutability: **Dynamic**; Range: "valid SEC1 key"
- Verbatim description: *"Server's ECDSA P-256 public key for OfflinePass signature
  verification … Updated via ChangeConfiguration during key rotation. Stations MUST accept
  passes signed by the current or immediately previous key."*

It is a **station-level** trust anchor (server's verify key in station NVS), **not** per-user.
(Signing semantics intentionally not re-audited per brief.)

### C. Station-side offline behavior the protocol defines (`spec/spec/profiles/offline/`)

- **Connectivity scenarios / capability gating.** Online, Partial A (station offline/phone
  online), Partial B (phone offline/station online), Full Offline (both offline)
  (`README.md:11–18`). A station with `bleSupported:true` MUST support at least Full Offline
  + Partial B (`README.md:43–44`).
- **Transaction buffering.** Station MUST buffer offline tx and sync via TransactionEvent on
  reconnect (`README.md:48`); ceiling = `MaxOfflineTransactions` (`08-configuration.md:132`)
  and pass-embedded `stationMaxOfflineTx` (`offline-pass.md:40`).
- **Local pass verification (Full Offline).** 10 ordered validation checks, stop at first
  failure (`offline-pass.md:53–70`): signature→`2002`, expiry→`2003`, epoch→`2004`, device
  binding→`2002`, station scope→`2006`, maxUses→`4002`, maxTotalCredits→`4002`,
  maxCreditsPerTx→`4004`, minIntervalSec→`4003`, monotonic counter anti-replay→`2005`.
- **Pass freshness.** `expiresAt` ≤ 24h from `issuedAt` (`offline-pass.md:17`); station
  ceiling configurable via `OfflinePassMaxAge` (`offline-pass.md:93`).
- **Local cache / per-pass usage.** Tracks usage per `passId`/`counter`; anti-replay requires
  `counter` strictly > `lastSeenCounter` (`offline-pass.md:70`, `:92`).
- **Reconciliation/replay.** On reconnect: BootNotification with
  `pendingOfflineTransactions>0`, then TransactionEvent(Ended) per buffered tx in ascending
  `txCounter`, each with a signed receipt (`reconciliation.md:14–19`, `:23`); idempotent dedup
  via `offlineTxId` (`:26–32`).

### D. BootNotification offline capability

`spec/03-messages.md:168–170` — the request `capabilities` object carries two **Required**
booleans:

- `capabilities.bleSupported` — *"BLE hardware available and enabled"* (`:169`)
- `capabilities.offlineModeSupported` — *"Station can handle offline sessions"* (`:170`)

**Meaning:** the *station* declares at boot that it supports offline. Says nothing about which
users are eligible. The runtime master switch is the station config key `OfflineModeEnabled`.

### E. VERDICT — per-user offline eligibility: protocol concept or issuer policy?

> **VERDICT: There is NO OSPP protocol concept of per-user offline ENABLEMENT/eligibility.
> Per-user offline access is purely issuer/OSP-server policy that lives OUTSIDE the wire
> protocol — expressed only through whether the server chooses to issue, refuse, or revoke an
> OfflinePass for that user.**

Evidence — spec-wide grep (`*.md`/`*.json`/`*.mmd`, excluding `.git`) returned **0 hits** for
every eligibility term: `offline_enabled`, `offlineEnabled`, `eligib`, `entitle`, `opt-in`,
`opt in`, `opt_in`, `OfflinePolicy`, `userOffline`, `per-user offline` *(independently
re-confirmed in this investigation)*. The OfflinePass schema is `additionalProperties:false`
(`schemas/common/offline-pass.schema.json:126`) with user identity only as `sub`
(`offline-pass.md:14`) — no enablement field can even be carried.

The closest matches are all framed as **server-side issuance policy**, not protocol enablement:

- *"The server creates the pass, populates all fields based on the user's wallet balance and
  **the operator's offline policy**"* — `offline-pass.md:88`
- *"For per-user revocation, **just don't issue them a new pass**."* — `guides/implementors-guide.md:797`
- *"The user's **account MAY be restricted from future offline pass issuance** until the
  balance is positive."* — `reconciliation.md:94`
- Fraud responses *"auto-disable offline **for user**"* — `guides/implementors-guide.md:785`

A rejected pass surfaces only as a validation error code (`2002`/`2004`/`4002` …
`offline-pass.md:61–70`). There is **no** error meaning "this user is not offline-enabled";
`2008 ACTION_NOT_PERMITTED` is RBAC role-based, not offline-eligibility
(`spec/07-errors.md:235`). The only protocol "offline on/off" notions are all **station-level**.

### F. Summary — STATION-level config (protocol) vs ISSUER policy (OSP)

| Dimension | STATION-level (defined in OSPP) | ISSUER / OSP-server policy (outside the wire) |
|-----------|----------------------------------|------------------------------------------------|
| Offline supported at all? | Boot flags `offlineModeSupported`, `bleSupported` (`03-messages.md:169–170`) | — |
| Offline on right now? | `OfflineModeEnabled` (RW/Dynamic, default `true`) (`08-configuration.md:131`) | — |
| Buffer / freshness | `MaxOfflineTransactions`, `OfflinePassMaxAge` (`:132–133`) | — |
| Batch revocation | `RevocationEpoch` pushed via ChangeConfiguration (`:141`) | Server decides *when* to bump (`offline-pass.md:78`) |
| Signature trust anchor | `OfflinePassPublicKey` (WriteOnly, NVS) (`:119`) | Server holds the private signing key |
| **Per-user "offline enabled"** | **NONE — no field/key/message/error** (§E) | **Sole locus.** Decided at issuance via "operator's offline policy"; enforced by *not issuing / refusing to refresh*; per-user numeric limits live *inside* the pass (`maxUses`, `maxTotalCredits`, …) — never an enable/disable toggle |

---

## Q2 — OSP SERVER: how is `users.offline_enabled` actually set?

All citations under `/home/gabi/dev/projects/osp/csms-server/`.

### A. Migration (column definition)

`database/migrations/2026_02_20_000003_create_users_table.php:24` (raw SQL, `DB::statement`):

```
offline_enabled BOOLEAN DEFAULT FALSE,
```

- Type `BOOLEAN`, **Default `FALSE`**, nullable (no `NOT NULL`, but defaulted). Contrast
  `is_active BOOLEAN DEFAULT TRUE` (`:23`). It is the **only** `offline_enabled` line in all
  of `database/migrations/`.

### B. Exhaustive writer inventory (every occurrence in `app/`, `database/`, `routes/`, `config/`)

| file:line | W / R | Who can trigger | Quote |
|-----------|:-----:|-----------------|-------|
| `app/Modules/Auth/AuthServiceProvider.php:48` | **READ** | the gate (`isOfflineEnabled`) | `return (bool) User::where('id', $userId)->value('offline_enabled');` |
| `app/Modules/Auth/AuthServiceProvider.php:58` | **WRITE → false** | `disableOffline()`; called only by fraud listener (system) | `User::where('id', $userId)->update(['offline_enabled' => false]);` |
| `app/Modules/Offline/Listeners/DisableOfflineOnFraudListener.php:43` | **WRITE → false (caller)** | `FraudDetected` event (system-triggered) | `$this->userQuery->disableOffline($event->userId);` |
| `app/Modules/Auth/Models/User.php:76` | mass-assign exposure | — (no prod caller passes it) | `'offline_enabled',` (in `$fillable`) |
| `app/Modules/Auth/Models/User.php:33`, `:96` | READ (docblock / cast) | — | `@property bool $offline_enabled` / `'offline_enabled' => 'boolean'` |
| `database/factories/UserFactory.php:47` | **WRITE → true** | test factory state (`offlineEnabled()`) — **test-only** | `'offline_enabled' => true,` |
| `database/factories/UserFactory.php:33` | WRITE → false | factory default — test-only | `'offline_enabled' => false,` |
| `database/seeders/UserSeeder.php:24,44` | **WRITE → true** | dev/local seed — **non-prod** | `'offline_enabled' => true,` |
| `database/seeders/UserSeeder.php:34,54` | WRITE → false | dev/local seed | `'offline_enabled' => false,` |
| `database/seeders/E2EBootstrapSeeder.php:88` | **WRITE → false** | E2E bootstrap seeder | `'offline_enabled' => false,` |
| `app/Modules/Offline/Actions/IssueOfflinePassAction.php:61` | **READ** | the issuance gate (§D) | `if (! $this->userQuery->isOfflineEnabled($request->userId)) {` |

**Negative confirmations (independently re-run in this investigation):**

- `grep -rniE "offline_enabled'?\s*(=>|=|:)\s*true|enableOffline|->offline_enabled\s*=\s*true" app/ routes/` → **zero hits**.
- `enableOffline` / `enable_offline` anywhere in `app/` → **zero hits**. `UserQueryInterface`
  exposes only `disableOffline()` — there is **no** `enableOffline()` in the contract or any impl.
- The only `User::create` in app code (`RegisterAction`) builds its array from explicit DTO
  fields and **omits** `offline_enabled` (→ defaults `false`); it does not spread request input,
  so the `$fillable` entry is unreachable via registration.
- The only admin user controller (`UserManagementController`) has a single `revokeTokens()`
  method — no offline write.

### C. VERDICT — DB-only vs application write path

> **VERDICT: DB-ONLY to enable. There is NO application code path (controller / action / route
> / artisan command / admin panel) that flips `users.offline_enabled` to `true` at runtime.**

The flag is only ever set `true` in **non-production** code: `UserSeeder.php:24,44` (dev seed)
and `UserFactory.php:47` (test factory). The migration default is `FALSE`. The **only** runtime
write that exists in application code sets it **`false`** (fraud auto-disable:
`FraudScorer` → `FraudDetected` → `DisableOfflineOnFraudListener.php:43` →
`AuthServiceProvider.php:58`). There is no inverse "enable" listener/controller/action/route/
command. Caveat for design: the column *is* in `User::$fillable` (`User.php:76`), so it is
mass-assignable in principle, but **no current caller passes it**. Today, enabling a user's
offline mode requires **manual SQL or a (dev/test) seeder** — and the existing
`E2EBootstrapSeeder` explicitly sets it `false`.

### D. The gate + error 2008

`app/Modules/Offline/Actions/IssueOfflinePassAction.php:61–66`:

```php
if (! $this->userQuery->isOfflineEnabled($request->userId)) {
    throw new OsppException(OsppError::from(
        OsppErrorCode::ACTION_NOT_PERMITTED,        // == 2008
        'Offline mode is not enabled for this user',
    ));
}
```

(Preceded by an `isActive` check at `:54–59` raising `AUTH_GENERIC`.) `ACTION_NOT_PERMITTED`
maps to numeric **`2008`** in the SDK enum (`vendor/ospp/protocol/.../OsppErrorCode.php`).
Both issuance entry points funnel through this same gated action, so even an admin "issue pass"
cannot bypass it — and **issuing a pass only READS the flag, never sets it**:

- App-facing: `POST /api/v1/.../passes` → `OfflinePassController::issue` (`routes/api/v1/offline.php:23`)
- Admin/dashboard: `POST /api/v1/.../offline-passes` → `DashboardOfflinePassController::store`
  (`routes/api/v1/dashboard.php:95`, `permission:offline_passes.issue`) → `IssueOfflinePassAction`

### E. Org-level equivalent?

**User-only. No organization/account-level `offline_enabled` exists today.** The
`organizations` table (`database/migrations/2026_02_20_000005_create_organizations_table.php`)
and its later additions (`slug/billing_email/status/settings`, `type`) carry **no** offline
flag; no org policy references offline. The gate and disable path both key strictly on `userId`
against `users`. An org-level toggle would be net-new (column + gate change).

---

## Q3 — PROVISIONING: the proven path + hermetic vs pool inventory

Citations under `/home/gabi/dev/projects/ospp/ts-station-simulator/` and (server side)
`/home/gabi/dev/projects/osp/csms-server/`.

### A. E2E self-provisioning recipe

`scenarios/e2e/` has exactly **3** files, all self-provisioning with an identical setup
preamble: `e2e-new-customer-onboarding.yaml`, `e2e-returning-customer-session.yaml`,
`e2e-session-end-matrix.yaml`. All set `defer_mqtt_connect: true` so MQTT connect waits until
the cert is issued. Setup steps (line refs from `e2e-new-customer-onboarding.yaml`):

| # | Step | Creds | Creates / does | Lines |
|---|------|-------|----------------|-------|
| 1 | `api_call` POST `/api/v1/auth/register` | anonymous self-signup | the SMB-owner **user** (captures `user_id`) | :34–45 |
| 2 | `api_call` POST `/api/v1/organizations` | **platform-admin** (`platform.organizations.create`) | the **organization** (`owner_email` = captured user) | :50–58 |
| 3 | `api_call` POST `/api/v1/locations` | admin + `X-Organization-Id` | a **location** | :61–75 |
| 4 | `api_call` POST `/api/v1/admin/stations` | admin + `X-Organization-Id` | **registers the station** + 4 bays — **this sets `is_active=true`** | :78–105 |
| 5 | `api_call` POST `/api/v1/admin/stations/{id}/provisioning-tokens` | admin | issues a **provisioning token** (`rawToken`) | :108–117 |
| 6 | **`provision`** | token + generated CSR | the provisioning primitive (§B): keygen + CSR + cert, captures server-assigned bayIds | :122–125 |
| 7 | `connect_mqtt` | fresh client cert | opens the MQTT 5 connection | :128 |
| 8+ | BootNotification → assert Accepted → StatusNotifications (bays Available) → catalog PUT → UpdateServiceCatalog | station + admin | boots, brings bays online, pushes priced catalog | :131–285 |

**Two credential identities:** a **platform-admin JWT** (org/location/station/token/catalog)
and a **per-run user** (signup + driver session calls). There is no separate tenant credential;
the admin operates on the org via the `X-Organization-Id` header. The other two e2e files share
this exact preamble, then diverge on session lifecycle.

### B. The reusable provisioning primitive

`src/cli/provision.ts` is the **crypto helper** (keygen/CSR/PEM). The actual primitive is the
**`provision` step** = `src/scenarios/steps/ProvisionStep.ts` (single) /
`ProvisionStationPoolStep.ts` (pool).

- **Keygen / CSR:** ECDSA **P-256 / SHA-256** via WebCrypto (`provision.ts:5–13`); CSR via
  **`@peculiar/x509`** `Pkcs10CertificateRequestGenerator.create({name:'CN=<stationId>'})`
  (`provision.ts:20–24`); keys exported PKCS#8 PEM. `ProvisionStep` generates **two** keypairs:
  a TLS keypair (→ CSR) and a separate **receipt-signing** keypair (`ProvisionStep.ts:80–88`).
- **Registration call:** `POST ${apiBaseUrl}/api/v1/stations/provision` (`ProvisionStep.ts:91`)
  with body `{provisioningToken, serialNumber, bayCount, tlsCsr, receiptSigningPublicKey}`
  (`:98–105`).
- **Artifacts written** under `<artifacts_dir>/<stationId>/`, default base
  **`tests/artifacts/uat`** (`ProvisionStep.ts:133–135`): `<id>-key.pem`, `<id>.pem`,
  `<id>-chain.pem`, `<id>-receipt-key.pem`, `<id>-receipt-pub.pem`, `<id>-broker-ca.pem`,
  `<id>-mqtt.json`, and `bays.json` (`:138–198`).
- **Server side:** route `POST /provision` (`routes/api/v1/provisioning.php:13`,
  `throttle:auth`) → `ProvisioningController::provision`
  (`app/Http/Controllers/Api/V1/ProvisioningController.php:28`) → `CertificateManager::provision`.
- **What activates the station — the key nuance:** `/stations/provision` does **NOT** set
  `is_active`. `CertificateManager::provision` looks up the **existing** station row
  (`CertificateManager.php:118`), inserts a `certificates` row `'status'=>'active'` (`:165–173`),
  and updates only the station's serial/public-key (`:178`). Activation happens earlier, at
  **registration**: `RegisterStationAction.php:28–46` does `Station::create([... 'is_active'=>true])`
  (`:36`) + `Bay::create([...])` (`:40`). **The hermetic recipe therefore requires BOTH calls,
  in order:** `POST /admin/stations` (creates row + `is_active=true` + bays) **then**
  `POST /stations/provision` (mints cert, fills serial/key). Provision alone cannot create a
  station.
- **Single vs pool:** `ProvisionStationPoolStep` runs the same per-station crypto + provision
  call in a loop, self-generating stationIds (`stn_pool_<hex>`), writing under
  `<artifacts_dir>/pool/<id>/` + `pool/index.json`, registering into an in-memory `StationPool`
  addressable via `{{pool.*}}`. **It is dormant: ZERO of the 93 scenarios use the pool step or
  `{{pool.*}}` namespace** *(independently confirmed: both greps empty)*.

> **⚠ Correctness flag — 200 vs 201 contract drift (latent, masked by the unit test).**
> `ProvisionStep.ts:107` throws on any status `!== 201`. The live endpoint returns **`200`** on
> success (`ProvisioningController.php:43–44`: `->response()->setStatusCode(200)`; error paths
> use 422/503/500). The simulator's own unit test masks this by mocking `status: 201`
> (`src/__tests__/scenarios/steps/ProvisionStep.provisioning.test.ts:26`). Against the live
> server, the `provision` step would throw `"… returned 200"`. This is consistent with the e2e
> scenarios being marked **"pending live UAT"** (commit `6faeba6`) — the hermetic path is very
> likely **unvalidated end-to-end against the live server**. *(Not executed here — out of scope.
> Reported as a static contradiction.)*

### C. Scenario classification — **3 hermetic / 90 pool-dependent**

**Discriminator:** every one of the 93 scenarios references `{{stationId}}` (it's the per-run
identifier the runner injects — `ScenarioRunner` sets `stationId = poolStationId ?? def.stationId
?? generateStationId()`), so `{{stationId}}` is **not** a discriminator. The real marker is
*"does the scenario create + activate its own station?"* = the register-org/register-station +
`action: provision` sequence. *Independently confirmed:* bare `POST /api/v1/organizations`,
`POST /api/v1/auth/register`, bare `POST /api/v1/admin/stations`, and `action: provision` each
appear in **exactly the 3 `e2e/*` files and zero others**.

| Suite | Total | Hermetic | Pool-dependent | Notes |
|-------|------:|---------:|---------------:|-------|
| chaos | 7 | 0 | 7 | all boot a `{{stationId}}`; `connection-timeout.yaml` is `skip:true` |
| core | 16 | 0 | 16 | boot/heartbeat/status |
| device-management | 20 | 0 | 20 | all operate on `/admin/stations/{{stationId}}/…` (config/reset/firmware) — operate-on-existing |
| **e2e** | 3 | **3** | 0 | the only self-provisioners |
| fleet | 3 | 0 | 3 | multi-station load; B4 plan notes they need external "fleet bootstrap" |
| reservations | 6 | 0 | 6 | hit `/api/v1/reservations` on the pre-existing station |
| security | 20 | 0 | 20 | cert-install / offline-pass / security-events |
| sessions | 18 | 0 | 18 | start/stop/meter-values on the pre-existing station |
| **TOTAL** | **93** | **3** | **90** | 3 + 90 = 93 ✓ |

**Where pool stations come from:** the config-driven permanent pool in `config/targets.yaml`
(`uat.station_pool` = 5 IDs; `sandbox` = 28), handed out one-per-scenario by `StationPoolAllocator`
in `ScenarioRunner`, with bayIds hydrated from disk (`certs/uat/<id>-bays.json`). This is the
pool that "evaporated" (F-PROC-1). No ambiguous scenarios — the split is clean because
self-provisioning markers are exclusive to e2e. **Edge note:** ~47 non-e2e scenarios contain
`api_call` steps, but they call *operate-on-existing* admin endpoints — easy to mis-bucket if
grepping `admin/stations` loosely; only the **bare** `POST /api/v1/admin/stations` is creation.

### D. Teardown — **NOT automatic; cleanup was always manual/external**

No engine-level resource teardown. The only per-scenario `finally`
(`ScenarioRunner.ts:746–755`) does just two things:

```ts
} finally {
  try { await station.disconnect(); } catch { /* best-effort */ }
  if (poolStationId && this.poolAllocator) this.poolAllocator.release(poolStationId);
}
```

`release()` is purely in-memory (`this.inUse.delete(stationId)`, `ScenarioRunner.ts:577`).
There is **no** deprovision/delete-station API call, **no** DB cleanup, **no**
`afterAll`/`dispose`/`teardown` hook in `src/` *(independently confirmed: teardown grep returns
only that in-memory delete)*. Cleanup was a **manual, external bootstrap-agent responsibility**:

- `docs/SPRINT-3-REPORT-20260527T082858Z.md:198` — *"Bootstrap rows added then cleaned up at end
  of sprint … **per the bootstrap agent's plan**"* (row-delta table `:200–214`); FK-ordered
  manual DELETE between flaky re-runs (`:134`,`:153`); restore via artisan `e2e:wipe-uat` +
  re-seed (`:220`).
- `config/targets.yaml` (uat comment) — pool *"populated by `/tmp/v5-bootstrap.php` at start of
  brief"* — an out-of-band script.
- `docs/REPORT-SPRINT-C-015-20260529T085731Z.md:71` — the V5-bootstrapped pool was later
  wiped/deactivated; re-creation is explicitly **C-018 / environment-bootstrap**, out of scope.

---

## Cross-cutting — the offline-pass scenario chain (ties Q1 + Q2 + Q3)

`scenarios/security/` holds 5 offline scenarios:
`offline-pass-authorize.yaml`, `offline-pass-rejected.yaml`, `offline-fraud-rapid-transactions.yaml`,
`offline-transaction-reconcile.yaml`, `security-event-offline-pass-rejected.yaml`. Two of them
(`offline-pass-authorize.yaml`, `offline-pass-rejected.yaml`) hit the **`offline_enabled`-gated**
issue/authorize endpoint (the gate from Q2-D). *Independently confirmed:* **no scenario references
`offline_enabled`** and the existing `E2EBootstrapSeeder` sets it **`false`** (`:88`).

**Consequence:** the *positive* offline-pass issuance path needs a user with
`offline_enabled=true`, but (Q2-C) there is **no application write path** and the existing
bootstrap seeder produces `false`. So even a fully hermetic register→provision→boot setup
**cannot, by itself, satisfy the offline-pass-authorize precondition** — it would hit the
`2008 ACTION_NOT_PERMITTED` gate. This is the concrete blocker behind the "pending live UAT"
marker on the recent offline-pass work (commit `6faeba6`), compounded by the 200/201 mismatch
(Q3-B).

---

## RECOMMENDATION — for the self-provisioning setup sprint

*(Recommendation only — not a design or implementation, per scope.)*

### 1. Setup/teardown granularity: **per-scenario hermetic**, not per-run

Deciding input: **90 of 93** scenarios are pool-dependent and **none** share state with another
(each gets a unique `{{stationId}}`; the engine already allocates + releases per scenario). A
single per-run shared station would reintroduce cross-scenario coupling and the exact fragility
that F-PROC-1 exposed. Recommend lifting the e2e **register → provision** preamble into a
**per-scenario setup** (one disposable station + cert per scenario), mirroring how `e2e/*`
already work. The primitive to reuse already exists: the `provision` step + the two admin
`api_call`s (create-station, issue-token). The dormant `ProvisionStationPoolStep` is **not** the
right lift point (per-scenario isolation beats a shared pool here).

A **per-run** shared setup should be reserved only for genuinely cross-cutting fixtures that are
expensive and safe to share read-only (e.g. one org + one location + one admin session per run),
with the **station itself created per scenario**. Net: hybrid — per-run org/admin context,
per-scenario station.

### 2. Can the `offline_enabled` flip be sim-side? **No — it needs a privileged step.**

From Q2-C this is decisive: there is **no API/admin/artisan path** to set `offline_enabled=true`,
so a scenario `api_call` cannot do it. For the offline-pass subset, the next sprint must choose
one of:

- **(a) Privileged out-of-band step** — a seeder/artisan command (or direct SQL) run by the
  bootstrap layer that creates an offline-enabled user. Cheapest; keeps it out of the sim.
  *(Note the existing `E2EBootstrapSeeder` sets `false` — it would need a variant/flag.)*
- **(b) New server capability** — an admin endpoint or artisan command to enable a user
  (`enableOffline()` does not exist in `UserQueryInterface` today). This is **product/backlog**
  work (see §4) — do not design here.
- **(c) Scope the hermetic conversion to the non-offline 88 scenarios first**, leaving the 2
  gated offline-pass-issuance scenarios behind option (a)/(b). Lowest risk for the bulk of the
  suite.

Recommended: pursue **(a)** as the immediate unblock for the offline-pass scenarios, and convert
the other 88 pool-dependent scenarios with the plain register→provision primitive in parallel.

### 3. Blockers / risks for making the component suite hermetic

1. **200/201 contract drift (Q3-B) — must fix first.** `ProvisionStep` expects `201`; the live
   endpoint returns `200`; the unit test mocks `201` and hides it. Until reconciled, *every*
   hermetic scenario that calls `provision` will throw against live UAT. This is the
   highest-priority fix and likely the real reason the e2e/offline work is "pending live UAT."
2. **No teardown today (Q3-D).** Hermetic = create *and* clean up. The engine has no deprovision;
   the next sprint must add an engine-level teardown (delete station/bays/cert; the prior sprints
   relied on FK-ordered manual DELETE / `e2e:wipe-uat`). Without it, hermetic scenarios will leak
   rows on every run and re-accumulate the mess F-PROC-1 cleaned up.
3. **Two credential identities required.** The recipe needs a **platform-admin** JWT
   (`platform.organizations.create`, station/token/catalog) plus a per-run user. The runner must
   have admin creds available (today via `UAT_EMAIL`/`UAT_PASSWORD` in `config/targets.yaml`).
   Confirm these are present/scoped for the target before converting suites.
4. **`offline_enabled` is DB-only (Q2-C).** Already covered in §2 — flagged again because it is a
   hard gate (`2008`) for 2 scenarios, not a soft preference.
5. **Volume.** 90 scenarios to convert from pool-dependent to hermetic. Suggest sequencing:
   fix #1 → add teardown #2 → convert the largest plain suites (sessions 18, security non-offline,
   device-management 20, core 16) → handle fleet (3, needs multi-station setup) → handle the 2
   offline-issuance scenarios via §2(a).

### 4. Backlog (NOT designed here, per scope)

- **Product feature: app/org-driven offline toggle.** Today `offline_enabled` is user-only and
  DB-only; there is no `enableOffline()` in the contract and no org-level flag (Q2-E). A
  user-facing or org-level offline opt-in (and the admin/app surface to drive it) is net-new
  product work. Noted as backlog only.
- **Re-bootstrapping the UAT pool (C-018 / environment-bootstrap).** The permanent pool that
  evaporated (F-PROC-1) is being replaced by the hermetic approach this investigation supports;
  any interim pool re-creation is a separate, already-scoped effort.

---

## Verification log (what was independently re-confirmed in this investigation)

The three decision-grade verdicts and the load-bearing code citations were verified directly
(not taken on sub-agent trust):

- **Q1 verdict** — re-ran the spec-wide eligibility grep (10 terms → 0 hits) and read the
  issuer-policy context lines (`offline-pass.md:88`, `reconciliation.md:94`,
  `implementors-guide.md:785,797`). Read the full Offline/BLE key table (`08-configuration.md:64–145`)
  confirming **12 keys** and `OfflineModeEnabled` default `true`; confirmed BootNotification
  capability fields (`03-messages.md:168–170`).
- **Q2 verdict** — re-ran the exhaustive `offline_enabled` grep across `app/database/routes/config`
  (13 occurrences, classified W/R), and the negative greps for true-write / `enableOffline`
  (both empty). Confirmed migration default `FALSE` (`:24`), the gate + 2008 throw
  (`IssueOfflinePassAction.php:61–66`), and `E2EBootstrapSeeder.php:88` = `false`.
- **Q3 verdict** — confirmed self-provisioning markers are e2e-exclusive; `{{stationId}}` in all
  93; `{{pool.*}}` step in 0; the `finally` block (`ScenarioRunner.ts:746–755`) and in-memory
  release (`:577`); `is_active=true` at `RegisterStationAction.php:36`; provision returns **200**
  (`ProvisioningController.php:43–44`) vs ProvisionStep's `!== 201` throw (`ProvisionStep.ts:107`)
  vs the test mock `201` (`ProvisionStep.provisioning.test.ts:26`); `CertificateManager::provision`
  looks up an existing station (`:118`) and does not set `is_active`.

Supporting line numbers in the e2e step tables, route files, and `CertificateManager` insert
block come from the read-only sub-agent sweep; the structural claims around each were verified above.

---

## Scope compliance

No code changed, no commits, no UAT DB mutations, no provisioning runs, no scenario runs against
UAT. The 200/201 mismatch is reported as a **static** contradiction (not executed). The
product-feature offline toggle is noted as backlog only, not designed. This document is the sole
artifact produced.
