# Sprint B Plan — `--var` flag + P5 flakes investigation

**Date**: 2026-05-18
**Branch**: main (commits will be pushed directly per autonomy contract)
**Baseline**: HEAD=9e57ce2, 123 tests passing across 25 files (V2 baseline match).

## Goal

1. New CLI flag `--var KEY=VALUE` (repeatable) on `simulator run` that overrides default `{{KEY}}` placeholder values in scenario YAMLs. Unblocks csms-server Phase 3 + 4 coverage (sessions, reservations) where real bay IDs must be plugged in from server state.
2. Investigation + fix (or document) for P5.1 (heartbeat-cycle) + P5.11 (data-transfer) flakes from V2 report.
3. Sim package version bump 0.1.3 → 0.2.0 (minor: feature add).
4. Report at `docs/SPRINT-B-REPORT-<UTC>.md`.

## Phase 1 — `--var` flag implementation

### 1.1 — CLI option (`src/cli/index.ts`)

Add to the `run` subcommand definition (after `--output-file`):

```ts
.option(
  '--var <pair>',
  'Override scenario placeholder ({{KEY}}). Format: KEY=VALUE. Repeatable.',
  (value: string, previous: string[]) => [...previous, value],
  [] as string[],
)
```

Add `var: string[]` (default `[]`) to `RunCommandOptions` interface.

In the `.action()` handler, before `resolveTarget()`:

```ts
const userVars = parseUserVars(opts.var ?? []);
```

Pass `userVars` (a `Map<string, string>`) into `runner.runScenario()`, `runScenarioPaths()` (which forwards to `runner.runParallel()`/single calls).

### 1.2 — `parseUserVars` utility

New module `src/cli/userVars.ts`:

```ts
export function parseUserVars(pairs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const VAL_RE = /^[A-Za-z0-9_-]+$/;
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq < 1) {
      throw new Error(`--var "${raw}" must be in KEY=VALUE form`);
    }
    const key = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      throw new Error(`--var key "${key}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
    }
    if (!VAL_RE.test(value)) {
      throw new Error(`--var value "${value}" for key "${key}" must match /^[A-Za-z0-9_-]+$/`);
    }
    out.set(key, value);
  }
  return out;
}
```

The KEY regex is a standard identifier (matches scenario placeholder names like `bayId_1`, `stationId`, `serviceId_3`). The VALUE regex covers OSPP ID shapes (`stn_...`, `bay_...`, `svc_...`) plus UUIDs (with hyphens) and free-form alphanumeric tokens.

### 1.3 — Thread `userVars` through `ScenarioRunner`

In `src/scenarios/ScenarioRunner.ts`:

- Extend `generateVariables(scenario, target, poolStationId?, userVars?)`:
  ```ts
  if (userVars) for (const [k, v] of userVars) vars.set(k, v);
  ```
  Last write wins — user `--var` values override auto-generated ones.

- Extend `runScenario(scenario, target, userVars?)` to accept and forward `userVars` to `generateVariables`.

- Extend `runParallel(scenarios, target, maxWorkers, userVars?)` to forward.

- Extend `runAll(scenarioDir, target, options)` so `options.userVars?` is honored.

- Add `userVars?: Map<string,string>` to `RunOptions` interface.

The signatures stay backwards-compatible (new param optional, undefined falls through to current behavior).

### 1.4 — CLI plumbing in `src/cli/index.ts`

In `runScenarioPaths()`, accept `userVars` and pass into each branch:

```ts
async function runScenarioPaths(
  runner, scenarioPaths, target, parallel, maxWorkers, userVars?: Map<string,string>,
): Promise<ScenarioResult[]> {
  ...
  if (parallel && maxWorkers > 1) {
    return runner.runParallel(scenarios, target, maxWorkers, userVars);
  }
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runner.runScenario(scenario, target, userVars));
  }
  return results;
}
```

Also: emit a one-line log when `userVars.size > 0` so the user can confirm overrides took effect:

```
chalk.cyan(`  Overrides (${userVars.size}): ${[...userVars.entries()].map(([k,v]) => `${k}=${v}`).join(', ')}`)
```

### 1.5 — Unit tests

New file `src/__tests__/cli/userVars.test.ts`:

- valid `KEY=VALUE` parses into `Map`
- multiple `--var` accumulate
- `KEY=VALUE=WITH=EQUALS` — value can contain `=`? **NO**, our VAL_RE forbids it; the parser uses `indexOf('=')` so the first `=` splits, but VAL_RE rejects extra `=`. Test: `KEY=a=b` → throws.
- empty value rejected
- empty key rejected
- malformed (no `=`) rejected
- key with hyphen rejected (not a valid identifier)
- value with `}}` or `{{` rejected (would break template substitution)
- value with whitespace rejected

Extend `src/__tests__/scenarios/ScenarioRunner.generateVariables.test.ts`:

- with `userVars = Map([['bayId_1', 'bay_real001']])`, `vars.get('bayId_1') === 'bay_real001'`
- userVars overrides auto-generated `stationId` when provided
- userVars can define NEW vars not in auto-generated set (e.g. `customFoo=bar`)
- empty userVars Map → identical output to undefined

## Phase 2 — YAML scenario doc-comments

Add a `# --var:` header comment block to scenarios that use bayId placeholders, listing the placeholders they expect:

Scenarios in scope (those using `{{bayId_1}}`, `{{bayId_2}}`):
- `scenarios/sessions/*.yaml` (~17 files using bayId_1, several with bayId_2)
- `scenarios/reservations/*.yaml` (6 files)
- `scenarios/core/happy-boot.yaml`, `scenarios/fleet/*.yaml` (where applicable)

Format (placed at top of YAML, before `name:`):

```yaml
# Placeholders required (may be overridden via --var KEY=VALUE):
#   {{stationId}}, {{serialNumber}}, {{bayId_1}}, {{bayId_2}}, {{serviceId_1}}
# Example invocation against real Phase 3 state:
#   simulator run --scenario scenarios/sessions/start-service.yaml \
#     --target uat --station stn_abc12345 \
#     --var bayId_1=bay_realbay1
name: "Start Service"
...
```

Only add this header to scenarios that meaningfully benefit from `--var` (i.e. those with `{{bayId_N}}` placeholders that map to real server-side bay IDs). Scenarios that exclusively use auto-generated IDs won't get a comment (over-documenting churns diffs).

Hard scope cap: ≤25 scenarios edited in Phase 2.

## Phase 3 — P5.1 + P5.11 investigation

The V2 report (csms-server side) reported these two `core/` scenarios as P5 flakes. Investigation steps:

1. **Re-run individually against UAT** with `--output console`:
   ```bash
   simulator run --scenario scenarios/core/heartbeat-cycle.yaml --target uat --output console
   simulator run --scenario scenarios/core/data-transfer.yaml --target uat --output console
   ```
2. Capture exact assertion failure text + which step failed.
3. Diagnostic matrix:
   - **Symptom A — `wait_for Heartbeat Response` timeout (10s)**: broker side. heartbeat-cycle has 3 such waits @ 10s; if the CSMS heartbeat handler hangs/slow, fix is in csms-server (out of scope; document). If the wait_for FIFO correlation drops the response, fix is in sim (Drift 7-E adjacent).
   - **Symptom B — `wait_for DataTransfer Response` timeout**: same dichotomy; check the CSMS DataTransferHandler exists + responds.
   - **Symptom C — `assert payload.status equals "Accepted"` failure**: CSMS rejected the message; capture exact rejection reason — likely a config drift fixable on the server side.
   - **Symptom D — BootNotification `wait_for` 5s timeout (line 35 of both scenarios)**: stale hardcoded 5s timeout, predates the recent default bump to 15s. Fixable in YAML.

4. Decisions:
   - Sim bug → fix + add regression test
   - Server-side → log finding in Sprint B report for csms-server Sprint C follow-up
   - Stale assertion / hardcoded short timeout → fix YAML

5. **Expected most-likely cause** (hypothesis, to validate by running): both scenarios hardcode `timeout_ms: 5000` for the BootNotification wait_for, while recent commit 9e57ce2 bumped the *default* timeout 5s → 15s. The bumped default doesn't help scenarios that hardcode a value. Under UAT latency (TLS + cross-region), the 5s ceiling could legitimately flake.

## Phase 4 — Tests + version bump + push

1. `npm test` — all green. Target: 123 baseline + new tests (estimate +8–12 from Phase 1).
2. `npm run build` — clean TypeScript build (NodeNext + ESM, all `.ts` imports use `.js`).
3. Bump `package.json` version: `0.1.3` → `0.2.0` (minor: feature add, backwards-compatible).
4. Git operations (sequenced, one commit per logical change):
   - `feat(cli): --var flag for placeholder substitution (unblocks csms-server Phase 3 + 4 coverage)`
   - `docs(scenarios): annotate Phase 3/4 scenarios with --var placeholder requirements`
   - `fix(scenarios): P5.1/P5.11 hardcoded BootNotification timeout` (if Phase 3 lands a YAML fix)
   - `chore: bump version 0.1.3 → 0.2.0`
5. Push to `origin/main`. Tag `v0.2.0`. Push tag.

## Phase 5 — Final report

Author `docs/SPRINT-B-REPORT-20260518T153743Z.md` covering:
- `--var` flag: code paths, validation rules, examples
- Scenarios annotated with placeholder docs (file list)
- P5.1 + P5.11 root cause + resolution (or csms-server follow-up bullet)
- Version published + tag
- Total tests delta

Commit + push.

## Out of scope (per brief)

- csms-server changes
- Phase 3 + 4 actual coverage exercising on UAT (csms-server Sprint C)
- Cross-scenario refactors beyond `--var` introduction

## Autonomy contract

Continue-with-note on judgment calls. Halt only on unrecoverable infrastructure failure (compiler crash, missing dependency, etc.).
