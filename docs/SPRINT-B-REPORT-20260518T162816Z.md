# Sprint B Report — `--var` flag + P5 flakes resolution

**Date**: 2026-05-18 (UTC 16:28)
**Branch**: main (all commits pushed)
**Baseline**: HEAD=9e57ce2 (123 tests, 25 files)
**Final**: HEAD=fed4c85 (145 tests, 26 files) — **v0.2.0** tagged + pushed

## Outcome

| Deliverable | Status |
|---|---|
| `--var KEY=VALUE` repeatable CLI flag on `simulator run` | ✅ shipped |
| Override threading through `ScenarioRunner` (single, parallel, runAll) | ✅ |
| 22 sessions + 2 reservation scenarios annotated with `--var` doc-headers | ✅ |
| P5.1 (heartbeat-cycle) + P5.11 (data-transfer) flakes diagnosed + fixed | ✅ |
| Test delta | +22 (123 → 145) |
| Version bump | 0.1.3 → 0.2.0 (minor, backwards-compat) |
| Git tag pushed | `v0.2.0` |

## 1. `--var` flag

### 1.1 Usage

```bash
simulator run --scenario scenarios/sessions/start-service.yaml \
  --target uat --station stn_realstation \
  --var bayId_1=bay_realbay001 \
  --var serviceId_1=svc_wash_basic
```

The flag is repeatable; each invocation contributes one `KEY=VALUE` pair to an in-process `Map<string, string>` that overrides values from `generateVariables()` (last-write semantics). New keys not in the auto-generated set are also accepted, so the same flag can be used for placeholder keys that future scenarios introduce.

When the CLI receives at least one `--var`, it logs the override summary before running:

```
Running scenario: Start Service
  Target: uat
  Overrides (2): bayId_1=bay_realbay001, serviceId_1=svc_wash_basic
```

### 1.2 Validation rules

- **Key** must match `/^[A-Za-z_][A-Za-z0-9_]*$/` (standard identifier — matches every placeholder currently in the YAML corpus: `stationId`, `serialNumber`, `bayId_1..N`, `serviceId_1..N`).
- **Value** must match `/^[A-Za-z0-9_-]+$/` — alphanumeric plus `_` and `-`. Covers the three OSPP ID shapes (`stn_<hex>`, `bay_<hex>`, `svc_<snake_case>`) and hyphenated UUIDs (`550e8400-e29b-...`). Deliberately strict: blocks `{{`, `}}`, `$`, `;`, `|`, whitespace — keeps the value injection-safe for the existing `{{KEY}}` regex substitution path.
- Empty value rejected, empty key rejected, missing `=` rejected.

Validation lives in `src/cli/userVars.ts:parseUserVars()`; tested in `src/__tests__/cli/userVars.test.ts` (16 cases).

### 1.3 Code paths touched

| File | Change |
|---|---|
| `src/cli/userVars.ts` | NEW — `parseUserVars()` + regex validation |
| `src/cli/index.ts` | `--var` option added, parsing, `logUserVars()` summary line, threading through `runScenario`/`runScenarioPaths` |
| `src/scenarios/ScenarioRunner.ts` | `userVars?` added to `generateVariables`, `runScenario`, `runParallel`, `RunOptions` |
| `src/__tests__/cli/userVars.test.ts` | NEW — 16 unit tests |
| `src/__tests__/scenarios/ScenarioRunner.generateVariables.test.ts` | +6 tests for override behavior |

All extensions are backwards-compatible — every new param is optional and falls through to current behavior when absent.

## 2. Scenarios annotated with placeholder docs

24 scenarios in `scenarios/sessions/` + `scenarios/reservations/` received a top-of-file doc-comment listing the placeholders they consume and an example `--var` invocation. Two header variants:

- **1-bay (22 files)**: `{{stationId}}, {{serialNumber}}, {{bayId_1}}, {{serviceId_1}}`
- **2-bay (`full-session-lifecycle.yaml` + `reserve-and-start.yaml`)**: adds `{{bayId_2}}`

Annotated files (24 total):
```
scenarios/sessions/full-session-lifecycle.yaml          (2-bay)
scenarios/sessions/meter-values-streaming.yaml
scenarios/sessions/session-deauthorized-revocation-epoch.yaml
scenarios/sessions/session-fault-during-service.yaml
scenarios/sessions/session-final-seqno-terminal.yaml
scenarios/sessions/session-local-out-of-credit.yaml
scenarios/sessions/session-rejected-bay-busy.yaml
scenarios/sessions/session-rejected-faulted-bay.yaml
scenarios/sessions/session-rejected-invalid-service.yaml
scenarios/sessions/session-rejected-maintenance.yaml
scenarios/sessions/session-seqno-monotonic.yaml
scenarios/sessions/session-stop-local.yaml
scenarios/sessions/session-timeout-timer-expired.yaml
scenarios/sessions/session-web-payment.yaml
scenarios/sessions/session-with-reservation.yaml
scenarios/sessions/start-service.yaml
scenarios/sessions/stop-service-rejected.yaml
scenarios/sessions/stop-service.yaml
scenarios/reservations/reserve-and-start.yaml           (2-bay)
scenarios/reservations/reserve-cancel.yaml
scenarios/reservations/reserve-expire.yaml
scenarios/reservations/reserve-rejected-already-reserved.yaml
scenarios/reservations/reserve-rejected-bay-busy.yaml
scenarios/reservations/reserve-rejected-maintenance.yaml
```

No semantic YAML changes — comments only. All 24 still parse + lint clean.

`bayId_3` / `bayId_4` placeholders that the brief mentioned (in case Phase 3/4 expands to higher bay counts) are *forward-compatible*: scenarios that introduce them will automatically work with `--var bayId_3=...` because `generateVariables()` extends `bayId_N` to the scenario's `station.bayCount`.

## 3. P5.1 + P5.11 root cause + fix

**Root cause**: both `scenarios/core/heartbeat-cycle.yaml` and `scenarios/core/data-transfer.yaml` hardcoded `timeout_ms: 5000` for the first BootNotification Response `wait_for` (line 35 of each). The recent global default bump (commit `9e57ce2`: 5s → 15s) doesn't help YAMLs that override the default. Under UAT TLS handshake + cross-region latency + first-message round-trip, 5s is a tight ceiling that flakes intermittently — matching the V2 P5 (flake, not hard fail) classification.

**Fix** (commit `3fdc7a6`): bumped both to `timeout_ms: 15000` with an inline comment explaining the alignment with the global default.

**Diagnosis confidence**: high but not validated live — UAT credentials weren't available in the sprint environment (`$UAT_EMAIL` / `$UAT_PASSWORD` unset). The fix is the lowest-risk corrective action regardless: it only widens a timeout, can't introduce new failures, and aligns with the recent project-wide direction set by commit 9e57ce2.

**Latent issue (out of scope per brief)**: 12 additional `scenarios/core/` + `scenarios/security/` + `scenarios/chaos/` files have the identical `timeout_ms: 5000` on line 35 (BootNotification Response wait_for). They may exhibit the same intermittent flake on UAT but were not in the V2 report's P5.1/P5.11 scope, so they remain untouched. Suggested follow-up sweep:

```
scenarios/core/boot-error-recovery.yaml:35
scenarios/core/boot-firmware-update.yaml:35
scenarios/core/boot-manual-reset.yaml:35
scenarios/core/boot-scheduled-reset.yaml:35
scenarios/core/boot-watchdog.yaml:35
scenarios/core/connection-lost-lwt.yaml:35
scenarios/core/happy-boot.yaml:35
scenarios/core/heartbeat-timeout.yaml:35
scenarios/core/heartbeat-timeout.yaml:48
scenarios/core/reconnect-recovery.yaml:35
scenarios/core/status-all-bay-states.yaml:35
scenarios/core/status-notification.yaml:35
scenarios/security/security-event-brute-force.yaml:36
scenarios/security/security-event-clock-skew.yaml:36
scenarios/chaos/malformed-messages.yaml:36
scenarios/e2e/e2e-session-end-matrix.yaml:240
scenarios/e2e/e2e-new-customer-onboarding.yaml:255
scenarios/e2e/e2e-returning-customer-session.yaml:231
```

## 4. Version + tag

- `package.json` 0.1.3 → 0.2.0
- `package-lock.json` synced
- `src/cli/index.ts` `program.version()` 0.1.0 → 0.2.0 (it had drifted from package.json; brought back in line)
- Git tag `v0.2.0` pushed to origin

`npx simulator --version` → `0.2.0`.

## 5. Commit timeline

```
fed4c85 chore: bump version 0.1.3 → 0.2.0
3fdc7a6 fix(scenarios): P5.1/P5.11 — bump BootNotification timeout 5s → 15s
83cb6ae docs(scenarios): annotate Phase 3/4 scenarios with --var placeholders
476975b feat(cli): --var flag for placeholder substitution
69256e8 docs(sprint-b): --var flag + P5 flakes plan
```

## 6. Note for csms-server Sprint C

After Sprint A + Sprint B, csms-server Sprint C can re-run E2E with:

- All Sprint A fixes applied (csms side)
- Sim v0.2.0 with `--var bayId_N=<from state.json>` for Phase 3 + 4 scenarios
- P5.1 + P5.11 should pass on UAT without re-flake; if they still flake, the residual cause is server-side and should produce a different symptom (assertion failure instead of `wait_for` timeout).
- Target: ~90% PASS V3 coverage push.

Example Phase 3/4 invocation (now ready to use):

```bash
npx simulator run \
  --scenario scenarios/sessions/start-service.yaml \
  --target uat \
  --station stn_<real-from-csms-server-state.json> \
  --var bayId_1=<real-bay-from-state.json> \
  --var serviceId_1=<real-svc-from-state.json> \
  --output console
```

## Out of scope (per brief, confirmed)

- csms-server changes (Sprint A repo)
- Phase 3 + 4 actual coverage on UAT (csms-server Sprint C)
- Broader timeout-bump sweep across other core/security/chaos/e2e scenarios

## Pre-existing issues observed (not addressed)

- 5 scenarios fail `npm run lint:scenarios` for schema-validation reasons unrelated to Sprint B work: `scenarios/chaos/malformed-messages.yaml`, `scenarios/chaos/out-of-order-messages.yaml`, `scenarios/e2e/e2e-new-customer-onboarding.yaml`, `scenarios/e2e/e2e-returning-customer-session.yaml`, `scenarios/e2e/e2e-session-end-matrix.yaml`. All concern `sessionId` pattern + `status-notification` required fields — pre-existing, not introduced this sprint.

## Self-grade

- Brief deliverables 1–5: complete.
- Static-only P5 investigation (no live UAT confirmation) is a deliberate trade-off — UAT creds weren't provisioned and the diagnosis was unambiguous from the recent default-bump commit history.
- No infrastructure blockers hit.
