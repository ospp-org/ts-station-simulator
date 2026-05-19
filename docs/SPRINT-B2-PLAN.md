# Sprint B2 Plan — `simulator connect --var` + timeout sweep + (deferred) scenario rewrite

**Date**: 2026-05-19 (UTC 05:02)
**Branch**: main (commits pushed directly per autonomy contract)
**Baseline**: HEAD=`f436dc2`, 145 tests passing across 26 files (v0.2.0).
**Cross-repo check**: csms-server master HEAD=`7f645cc` — **Sprint A3 NOT yet landed** (no `trigger-command` commit). Phase 3 deferred per brief contingency.

## Goal

Three ergonomic improvements identified during Sprint A2/V3 + Sprint B:

1. **`simulator connect --var KEY=VALUE` flag** — mirror Sprint B's `run`-mode pattern. Unblocks csms-server hand-rolled REST → MQTT → sim Accept flow that drives sessions/reservations coverage.
2. **Timeout sweep** — bump `timeout_ms: 5000` → `15000` across the 17 sister scenarios flagged in Sprint B's "Latent issue" section.
3. **Scenario rewrite for `/api/v1/testing/trigger-command/{stationId}`** — DEFERRED (Sprint A3 not landed). Phase 3 will document the deferred work + provide the migration recipe so a follow-up sprint can complete it once A3 lands.

Optional 4th item (time permitting): housekeeping P7.2 (`scenarios/device-management/get-configuration-filtered.yaml`).

## Cross-repo coordination

| Repo | HEAD | Sprint A3 (trigger-command endpoint)? |
|---|---|---|
| ts-station-simulator | `f436dc2` (v0.2.0) | n/a — consumer side |
| csms-server | `7f645cc` (Sprint A2/V3 report) | ❌ Not landed; last 10 commits all pre-A3 |

Decision: Phases 1 + 2 ship as planned. Phase 3 is **DEFERRED** with inventory + migration recipe captured in the final report so it can be picked up cleanly once Sprint A3 lands in csms-server.

## Phase 1 — `--var` flag on `simulator connect` (~90 min)

### 1.1 Mirror the `run`-mode pattern

Reference: `src/cli/index.ts:87-92` (run mode option), `src/cli/index.ts:108-109` (parse + thread), `src/cli/userVars.ts:4-32` (validator). All three remain unchanged — connect mode just calls the same helpers.

In `src/cli/index.ts`:

1. **`ConnectCommandOptions` interface** (line 373-376) — add `var: string[]`:
   ```ts
   interface ConnectCommandOptions {
     target?: string;
     station?: string;
     var: string[];
   }
   ```

2. **Add `.option(...)` to the connect command** (after line 382, before `.action(...)`):
   ```ts
   .option(
     '--var <pair>',
     'Override deterministic ID ({{KEY}}). Currently honored: bayId_<N>. Repeatable.',
     (value: string, previous: string[]) => [...previous, value],
     [] as string[],
   )
   ```

3. **Parse + apply in `.action()` handler** — after `targetName`/`stationId` resolution (around line 391, before bay-derivation loop):
   ```ts
   const userVars = parseUserVars(opts.var ?? []);
   ```

4. **Override bay slots at the bay-derivation loop** (line 436-443):
   ```ts
   for (let i = 1; i <= bayCount; i++) {
     const defaultBayId = `bay_${stationHex}${String(i).padStart(2, '0')}`;
     const overrideBayId = userVars.get(`bayId_${i}`);
     bays.push({
       bayId: overrideBayId ?? defaultBayId,
       bayNumber: i,
       services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
     });
   }
   ```

5. **Log overrides** — mirror `logUserVars()` from run mode (after the broker-URI gray lines, before bay construction):
   ```ts
   if (userVars.size > 0) {
     console.log(chalk.cyan(
       `  Overrides (${userVars.size}): ${[...userVars.entries()].map(([k,v]) => `${k}=${v}`).join(', ')}`,
     ));
   }
   ```

6. **Warn on unmapped keys** — keys that don't match `^bayId_\d+$` are accepted by the parser but are no-ops in connect mode. Surface that to the user:
   ```ts
   const knownPrefix = /^bayId_\d+$/;
   for (const k of userVars.keys()) {
     if (!knownPrefix.test(k)) {
       console.warn(chalk.yellow(`  Warning: --var ${k}=... not recognized by connect mode (ignored)`));
     }
   }
   ```
   Also warn if `bayId_N` index exceeds `bayCount`.

### 1.2 Optional sub-task — persist `bayIds` from provisioning artifact

The brief offers an alternative path: read bayIds from `certs/<target>/<station>-mqtt.json`. The current `ProvisioningArtifacts.mqttConfig` shape (`src/cli/artifacts.ts:5-8`) doesn't persist `bayIds`, but the provisioning response already CAPTURES them (`src/cli/index.ts:644-646` — prints, doesn't persist).

If time permits in Phase 1's budget, also:
- Extend `ProvisioningArtifacts` → add `bayIds?: string[]`
- `persistBrokerArtifacts()` writes `bayIds` into the mqtt.json sidecar
- `loadBrokerArtifacts()` returns them
- Connect mode applies them as defaults BEFORE `--var` overrides
- `--var` still wins (last-write semantics)

This sub-task is OPTIONAL — `--var` alone satisfies the primary deliverable. If skipped, the artifact-derived path is documented as future work in the final report.

### 1.3 Unit tests

New file `src/__tests__/cli/connect-vars.test.ts`:
- `parseUserVars(['bayId_1=bay_xyz'])` → `Map { 'bayId_1' => 'bay_xyz' }` (already tested in userVars.test.ts, but assert connect's contract specifically — invalid value rejected at parse, not at apply)
- `parseUserVars(['bayId_3=bay_extra'])` parses; applying with bayCount=2 → warn (test the warn-emitter helper if extracted)
- Helper that resolves `bays[]` from `(stationId, bayCount, userVars)` returns bay slots with overridden bayIds where applicable

To make the bay-derivation testable, extract the loop into a pure helper `deriveBays(stationId: string, bayCount: number, userVars: Map<string,string>): Bay[]` in `src/cli/connectBays.ts`. Then unit-test that helper directly. The connect action calls it; the rest of the action stays inline (TLS, MQTT, handler registration — already integration-test territory).

### 1.4 CLI smoke

```bash
npm run build  # ensure dist/ has connect command with --var
# Smoke: parse + log only (target=local should fail fast on MQTT connect, but the
#   "Overrides (N): ..." line should fire before the MQTT attempt)
npx simulator connect --target local --station stn_test1234 --var bayId_1=bay_realbay001 2>&1 | head -20
```

Expected: line `Overrides (1): bayId_1=bay_realbay001` appears before MQTT connect attempt.

### 1.5 Atomic commit

```
feat(cli): --var flag on simulator connect (mirror run-mode behavior)
```

If sub-task 1.2 lands, a second commit:
```
feat(cli): persist+restore bayIds from provisioning response in mqtt.json artifact
```

## Phase 2 — Timeout sweep (~30 min)

17 sister scenarios flagged in Sprint B report's "Latent issue" section (lines 108-129). Each file has `timeout_ms: 5000` on a Boot or UpdateServiceCatalog `wait_for` step. Bump to `15000` + inline comment matching Sprint B's pattern.

**Verified file list** (research agent confirmed all 17 files + 18 line edits):

```
scenarios/core/boot-error-recovery.yaml:35
scenarios/core/boot-firmware-update.yaml:35
scenarios/core/boot-manual-reset.yaml:35
scenarios/core/boot-scheduled-reset.yaml:35
scenarios/core/boot-watchdog.yaml:35
scenarios/core/connection-lost-lwt.yaml:35
scenarios/core/happy-boot.yaml:35
scenarios/core/heartbeat-timeout.yaml:35  (BootNotification)
scenarios/core/heartbeat-timeout.yaml:48  (Heartbeat — second wait_for in same file)
scenarios/core/reconnect-recovery.yaml:35
scenarios/core/status-all-bay-states.yaml:35
scenarios/core/status-notification.yaml:35
scenarios/security/security-event-brute-force.yaml:36
scenarios/security/security-event-clock-skew.yaml:36
scenarios/chaos/malformed-messages.yaml:36
scenarios/e2e/e2e-session-end-matrix.yaml:240        (UpdateServiceCatalog)
scenarios/e2e/e2e-new-customer-onboarding.yaml:255   (UpdateServiceCatalog)
scenarios/e2e/e2e-returning-customer-session.yaml:231 (UpdateServiceCatalog)
```

Inline comment to add adjacent to each bumped `timeout_ms`:

```yaml
    # Aligned with global default bump (5s → 15s, commit 9e57ce2). Sprint B2 timeout sweep — sister scenarios from Sprint B P5.1/P5.11 fix.
    timeout_ms: 15000
```

**Out-of-scope discovery** (NOT bumped this sprint): research agent identified 15 additional files with the same `timeout_ms: 5000` hardcoding on BootNotification wait_for (mostly `scenarios/security/security-event-*.yaml` + chaos/security offline + rapid-reconnect). Documented in final report as Sprint C candidate; not edited per brief scope.

Post-edit validation:
```
npm run lint:scenarios   # must show same 5 pre-existing failures, no new ones
```

Atomic commit:
```
fix(scenarios): bump BootNotification timeout 5s → 15s in 17 sister scenarios (Sprint B follow-up)
```

## Phase 3 — Scenario rewrite for `/api/v1/testing/trigger-command/...` (DEFERRED)

Sprint A3 not yet landed in csms-server (checked: csms-server master HEAD=`7f645cc`, last 10 commits all pre-A3). Per brief contingency, defer this phase without blocking.

**Inventory captured for follow-up** (research agent — 27 files, 39 `api_call` steps):

- Sessions: 16 files / 22 calls
- Reservations: 6 files / 8 calls
- Device-management: 1 file / 2 calls
- Fleet: 2 files / 3 calls
- Chaos: 2 files / 2 calls

Current path: `{{target_url}}/api/v1/stations/{{stationId}}/trigger-command`
Future path: `{{target_url}}/api/v1/testing/trigger-command/{{stationId}}`
Body shape: uniform `{action: string, payload: object}` — preserved unchanged after A3.

**Migration recipe** (for the follow-up sprint that picks this up):

```
# After Sprint A3 lands, single-pass sed equivalent across 27 files:
find scenarios -name '*.yaml' -exec sed -i \
  's|/api/v1/stations/{{stationId}}/trigger-command|/api/v1/testing/trigger-command/{{stationId}}|g' \
  {} +
npm run lint:scenarios   # confirm no new failures
```

Then a single atomic commit:
```
fix(scenarios): rewrite api_call paths to /api/v1/testing/trigger-command/<stationId> (Sprint A3 endpoint)
```

Documented in the final report — no commits this sprint.

## Phase 4 — P7.2 housekeeping (~15 min, optional time-permitting)

`scenarios/device-management/get-configuration-filtered.yaml` does not exist (confirmed via `ls`). The csms-server Sprint A2/V3 plan references P7.2 but the file is missing.

**Decision**: create the file. `get-configuration.yaml` already exists as the unfiltered variant; creating the filtered variant is a small additive — 1 file, ~50 lines mirroring the unfiltered shape with a `payload.keys: [...]` filter.

Atomic commit (if landed):
```
feat(scenarios): add device-management/get-configuration-filtered.yaml (P7.2)
```

If time-constrained, skip — document in final report as Sprint C carry-over.

## Phase 5 — Tests + version bump + tag (~30 min)

1. `npm test` — must remain all green. Expected delta: +N from connect-vars.test.ts (estimate +5–8) and possibly +2–3 from artifacts test extension if sub-task 1.2 lands.
2. `npm run build` — clean TypeScript build.
3. `npm run lint:scenarios` — confirm 5 pre-existing schema failures unchanged.
4. `package.json` version `0.2.0` → `0.3.0` (minor: backward-compat feature additions).
5. `package-lock.json` sync: `npm install --package-lock-only --no-audit`.
6. `src/cli/index.ts:54` `program.version('0.2.0')` → `'0.3.0'`.
7. Git tag `v0.3.0` + push.

Atomic commit:
```
chore: bump version 0.2.0 → 0.3.0
```

## Phase 6 — Final report

Author `docs/SPRINT-B2-REPORT-20260519T<UTC>.md`:
- Outcome table (Phase 1 + 2 ✅, Phase 3 deferred, Phase 4 conditional)
- `--var` connect-mode usage examples
- Timeout sweep file list with line numbers
- Phase 3 deferral rationale + migration recipe for follow-up
- Test delta + version + tag
- Note for csms-server Sprint V4

Commit + push.

## Failure handling (deterministic)

| Category | CLI action |
|---|---|
| Test failure after change | Iterate fix. After 3 attempts, mark BLOCKED for that change only |
| TypeScript compile error | Iterate fix |
| Lint:scenarios new failure | Iterate fix |
| MQTT broker unavailable for smoke | Skip live smoke; rely on unit test + log inspection |
| GitHub unreachable | Queue commits; retry every 10 min |

## Out of scope (per brief)

- ANY csms-server changes (Sprint A3 separate repo)
- Phase 6 offline reconciliation
- Performance / load testing
- Schema validation fixes for the 5 pre-existing failing scenarios
- Major sim architecture changes (e.g., replacing `api_call` with real REST flow simulation throughout)
- Sim test-only mocks for csms-server (Sprint A3 builds the real endpoint)
- Bumping the 15 additional `timeout_ms: 5000` files outside Sprint B's flagged list (Sprint C candidate)

## Autonomy contract

End-to-end execution without orchestrator interaction. Halts only on unrecoverable infrastructure failure (compiler crash, dependency-resolver hang). Continue-with-note on all judgment calls — those land in the final report.
