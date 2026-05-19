# Sprint B4 — Plan

**Sprint**: B4 — station_pool support + bay_id resolution from provisioning artifact + MQTT clean-disconnect protocol
**Authored**: 2026-05-19
**HEAD at start**: `3ddd7f4` (Sprint B3 final report; v0.4.0 tag)
**Target HEAD at end**: v0.5.0 tag
**Mode**: Autonomous

---

## End goal

Close three concerns surfaced in the Sprint V4 E2E coverage run before the Sprint V5 retest:

1. **Phase 1** — Add an in-scenario, multi-station registry (`station_pool`) so a single scenario can provision and address N stations. Required for fleet/multi-station scenarios that V4 marked `FAIL-MULTI-STATION-*` (5 scenarios) and unlocks future fleet scaling.
2. **Phase 2** — Wire `bay_id` resolution from the provisioning artifact. Fixes V4 Finding #1 (21 of 91 scenarios fail with 404 `BAY_NOT_FOUND` because sim auto-generates random bay IDs that don't match real DB bays).
3. **Phase 3** — Harden the MQTT clean-disconnect protocol so sequential scenarios cannot collide on `clientId`. Fixes V4 Finding #6 (2 scenarios failed with top-level "Connection closed" and 0 steps recorded).

End state:
- 3 atomic feature commits + tests
- Re-run V4 failed scenarios against a local mock CSMS endpoint → coverage shift from ~21 BAY-ID failures + 2 CONNECTION-CLOSED failures to 5 or fewer
- `v0.5.0` annotated tag pushed
- `docs/SPRINT-B4-REPORT-<UTC>.md` final report
- Ready for Sprint V5 to consume `v0.5.0`

---

## Research summary (Block A complete)

### Existing state

| Concern | Existing surface | Gap for B4 |
|---|---|---|
| `StationPool` allocator | `StationPoolAllocator` in `ScenarioRunner.ts:338-369` is config-driven (round-robins one stationId per scenario from `target.stationPool: string[]`) | No in-scenario registry; no per-station MQTT lifecycle; templates cannot address `pool.station[N]` |
| `provision` step | `ProvisionStep` already POSTs `/api/v1/stations/provision`, captures `bayIds` into `context.captured.bayId_1..N`, persists certs to `tests/artifacts/<target>/<stationId>/` | No `provisioning` template namespace; no auto-hydration when running with `--station <id>` against a pre-provisioned target |
| MQTT clientId | `MqttConnection.ts:65` sets `clientId: this.stationId` (deterministic per stationId); disconnect is `mqtt.end(false, {}, cb)` (graceful but no timeout guard) | Sequential scenarios with the same stationId can collide if the broker hasn't fully released the prior session; no UUID suffix |

### Affected scenarios (V4 categorization)

- **FAIL-AUTO-BAY-ID-MISMATCH (21 scenarios)** — `scenarios/sessions/*.yaml` (17) + `scenarios/reservations/*.yaml` (4) → Phase 2.
- **FAIL-MULTI-STATION-* (5 scenarios)** — `scenarios/fleet/fleet-mixed-workload.yaml`, `scenarios/security/*` (TamperDetected), `scenarios/sessions/session-with-reservation.yaml`, `scenarios/sessions/session-rejected-invalid-service.yaml`, `scenarios/core/boot-rejected.yaml` → Phase 1 unlocks; not all become PASS in B4 because UAT-side bootstrap is also required.
- **FAIL-CONNECTION-CLOSED (2 scenarios)** — `scenarios/device-management/change-configuration-rejected.yaml`, `scenarios/sessions/session-fault-during-service.yaml` → Phase 3.

---

## Phase 1 — station_pool architecture (~75 min)

### Design

**Naming.** To avoid clashing with the existing config-driven `target.stationPool: string[]`, introduce the runtime registry under `src/scenarios/stations/StationPool.ts`. The existing config field stays unchanged (semantic: "pre-allocated stationIds for one-per-scenario allocation"). The new runtime registry is per-scenario state.

**Data shape.**
```ts
interface PoolEntry {
  stationId: string;
  bayIds: string[];
  certPath: string;
  keyPath: string;
  chainPath: string;
  brokerCaPath?: string;
  clientIdSuffix: string;   // unique per entry for MQTT clientId
}

class StationPool {
  register(entry: PoolEntry): void;
  get(stationId: string): PoolEntry | undefined;
  first(): PoolEntry | undefined;
  at(index: number): PoolEntry | undefined;
  list(): readonly PoolEntry[];
  size(): number;
}
```

**YAML step**: `provision_station_pool`
```yaml
- action: provision_station_pool
  count: 5
  prefix: "stn_pool_"           # optional; default deterministic
  bay_count: 2                   # passed to each ProvisionStep call
  token_capture_pattern: "..."   # optional, see below
```

Implementation iterates `count` times, internally driving a per-station provisioning flow analogous to ProvisionStep. For simplicity in B4, the provision step assumes that the scenario has already captured a provisioning token per station via prior `api_call` steps (or that a single shared token can be re-used in dev-mode targets). The new step writes a `pool.json` index into `tests/artifacts/<target>/pool/` for inspection.

**Template wiring**: Extend `substituteTemplateValue()` (`ScenarioRunner.ts:164-185`) with a `pool.*` namespace:
- `{{ pool.first.id }}` / `{{ pool.first.bayIds[0] }}`
- `{{ pool.station[0].id }}` (alias `pool.stations[0].id`)
- `{{ pool.size }}`

Parser supports bracketed indexing for both `station[N]` and `bayIds[N]`.

**Context extension**: Add `pool?: StationPool` to `ScenarioContext`.

**ScenarioRunner integration**: Initialize `context.pool = new StationPool()` at scenario start. The `provision_station_pool` step populates it. Existing single-station scenarios are unaffected.

**MQTT** (overlaps with Phase 3): Each pool entry receives a unique `clientIdSuffix` so multiple pool entries can connect to the broker without collision.

### Tests
- `src/__tests__/scenarios/stations/StationPool.test.ts` — registry CRUD (register/get/first/at/list/size)
- `src/__tests__/scenarios/steps/ProvisionStationPoolStep.test.ts` — YAML step with mocked fetch (verifies N provision calls + pool populated)
- `src/__tests__/scenarios/ScenarioRunner.poolTemplates.test.ts` — template substitution renders `{{ pool.first.bayIds[0] }}` correctly

### Atomic commit
`feat(sim): station_pool runtime registry + provision_station_pool YAML step`

---

## Phase 2 — bay_id resolution from provisioning artifact (~45 min)

### Design

**Two complementary input paths**:

(a) **In-scenario provision step**: `ProvisionStep` already captures bayIds. Extend it to additionally populate a structured `context.provisioning` field:
```ts
context.provisioning = {
  stationId: string;
  bayIds: string[];
  certPath: string;
  keyPath: string;
};
```
Existing `captured.bayId_1..N` keys remain (no breaking change).

(b) **Pre-provisioned artifact hydration**: When the runner is invoked with a stationId (via `--station` or via `target.stationPool` allocation) and a persisted artifact `tests/artifacts/<target>/<stationId>/bays.json` exists, hydrate `context.provisioning` at scenario start. The `simulator provision` CLI (`src/cli/index.ts:550`) is updated to write this `bays.json` (currently only echoes bayIds to stdout).

**Template wiring**: Extend `substituteTemplateValue()` with a `provisioning.*` namespace:
- `{{ provisioning.stationId }}`
- `{{ provisioning.bayIds[0] }}` (bracket indexing)
- `{{ provisioning.certPath }}` / `{{ provisioning.keyPath }}`

If a scenario references `provisioning.*` but `context.provisioning` is empty, the template engine throws a clear error (`Provisioning artifact not available; add a provision step or pre-provision via 'simulator provision' CLI`). No silent fallback — Finding #1 was caused exactly by silent fallback to random bayIds.

### Scenario updates (the 21 from Finding #1)

For each affected scenario in `scenarios/sessions/*.yaml` and `scenarios/reservations/*.yaml`, replace `{{ bayId_1 }}` with `{{ provisioning.bayIds[0] }}` and `{{ bayId_2 }}` → `{{ provisioning.bayIds[1] }}`. Bay-related references in `payload.bayId`, `body.bay_id`, capture-key sources, and assertions are all updated.

Scenarios that don't have a way to populate provisioning (i.e., are run against `local` mock CSMS in tests) keep working via the new disk-hydration path when `bays.json` is present. For unit-test runs the test fixture writes the file.

### CLI

Update `simulator provision` to also write `bays.json` alongside the certs (one-line addition; backward-compatible).

### Tests
- `src/__tests__/scenarios/ScenarioRunner.provisioningTemplates.test.ts` — template render with both populated and missing provisioning
- `src/__tests__/scenarios/ScenarioRunner.bayHydration.test.ts` — `bays.json` disk read at scenario start
- `src/__tests__/cli/provision.baysJson.test.ts` — CLI writes `bays.json`

### Atomic commit
`fix(sim): bay_id resolution from provisioning artifact (V4 Finding #1)`

---

## Phase 3 — MQTT clean disconnect protocol (~45 min)

### Diagnosis

`MqttConnection.ts:65` sets `clientId: this.stationId`. Sequential scenarios with the same stationId share a clientId. With `sessionExpiryInterval: 3600` and 5s reconnect period, a broker that hasn't fully released the prior session can reject the second connect, surfacing as "Connection closed" on the new client. The 3s cooldown between scenarios is below the worst-case broker cleanup latency.

### Fix

1. **Per-connect UUID suffix**: Change `clientId: this.stationId` to `clientId: \`${this.stationId}-${crypto.randomUUID()}\`` in `MqttConnection.connect()`. Each connect call gets a fresh clientId; no broker-side session collisions are possible.
2. **Disconnect timeout guard**: `MqttConnection.disconnect()` wraps `mqtt.end(false, {}, cb)` in a 3-second `Promise.race` timeout. On timeout, force-end via `mqtt.end(true, {}, cb)` and proceed. Today there's no timeout, so a stuck graceful disconnect blocks the next scenario indefinitely.
3. **Subscribe state cleared on disconnect**: Set `this.client = null` in the disconnect resolution path so `setTls()` and re-`connect()` work cleanly.

### Why a UUID suffix is safe

- The MQTT 5 spec treats clientId purely as a session-identification key; the broker doesn't infer station identity from it. Identity is enforced by the mTLS client cert (CN=stationId).
- Server-side filtering / observability uses MQTT topic (`csms/station/<stationId>/...`), not clientId.
- CSMS server logs may surface the new clientId format; the surface is grep-friendly (`stationId-<uuid>`).

### Tests
- `src/__tests__/mqtt/MqttConnection.clientId.test.ts` — clientId is unique per connect
- `src/__tests__/mqtt/MqttConnection.disconnect.test.ts` — disconnect resolves within 3s even if mqtt.end never calls back (force-end fallback)
- `src/__tests__/scenarios/ScenarioRunner.sequentialDisconnect.test.ts` — two scenarios with same stationId run sequentially without "Connection closed"

### Atomic commit
`fix(sim): MQTT clean disconnect protocol prevents clientId collision (V4 Finding #6)`

---

## Phase 4 — Validation + tag (~45 min)

1. Full `npm test` — expect 157 baseline + new tests (target 175+ passing).
2. `npm run build` — clean.
3. `npm run lint:scenarios` — baseline 86 OK / 5 errors preserved (or documented if new errors).
4. Local mock CSMS replay: spin up a minimal MQTT broker + HTTP mock that responds 201 for /sessions/start, capture which V4-failed scenarios now PASS.
   - V4 marked 21 BAY-ID-MISMATCH; B4 should flip these to PASS via in-scenario provisioning OR via `--var` override; document the achieved count.
   - V4 marked 2 CONNECTION-CLOSED; B4 should reduce to 0.
   - V4 marked 5 MULTI-STATION; B4 unblocks pool plumbing but doesn't itself add UAT-side fleet bootstrap, so expect partial flip.
5. Bump `package.json:version` 0.4.0 → 0.5.0 (and `src/cli/index.ts` `.version()`).
6. `git tag -a v0.5.0 -m "Sprint B4 station_pool + bay_id resolution + MQTT robustness"`
7. `git push origin main && git push origin v0.5.0`

---

## Block C — Final report (~20 min)

`docs/SPRINT-B4-REPORT-<UTC>.md` mirrors Sprint B3 report structure:
- Per-phase commits + tests + scenarios touched
- Coverage projection: V4 categories → expected V5 outcomes
- New tag `v0.5.0`
- Surfaced findings (any new sim limitations)

---

## Out of scope (deferred / unrelated)

- csms-server changes (separate Sprint A6)
- Sprint V5 UAT retest (separate brief)
- OSPP wire-protocol changes
- Phase 6 offline reconciliation
- ts-station-simulator UAT runs (V5 brief consumes B4 output)
- SMTP wiring, payment processor activation (operator-side, not engineering)
- The 5 pre-existing scenario-lint errors carried since B2
- `stop-service-rejected.yaml` semantic coverage loss (B3 follow-up)
- `session-web-payment.yaml` `sessionSource` assertion (B3 follow-up)
