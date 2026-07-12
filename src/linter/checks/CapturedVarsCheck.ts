import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

// `provision` (src/scenarios/steps/ProvisionStep.ts) and `provision_station_pool`
// (src/scenarios/steps/ProvisionStationPoolStep.ts) imperatively seed runtime
// state outside of a step's own `capture:` map. This check only tracks the
// `{{captured.*}}` namespace, so it must special-case these two step kinds or
// it false-flags every downstream `{{captured.bayId_N}}` reference as "never
// captured".
const PROVISION_ACTION = 'provision';
const PROVISION_POOL_ACTION = 'provision_station_pool';

export class CapturedVarsCheck implements LintCheck {
  name = 'captured-vars';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];
    const capturedVars = new Set<string>();

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];

      // Collect captures defined by this step's own `capture:` map.
      if (step.capture && typeof step.capture === 'object') {
        for (const key of Object.keys(step.capture as Record<string, unknown>)) {
          capturedVars.add(key);
        }
      }

      // Collect captures a `provision` step seeds imperatively at runtime.
      // `provision_station_pool` is intentionally a no-op HERE: it registers
      // stations into `context.pool`, addressed via the separate
      // `{{ pool.* }}` template namespace (see ScenarioContext.ts), and never
      // writes to `context.captured` — so it has nothing to contribute to
      // *this* check.
      if (step.action === PROVISION_ACTION) {
        for (const v of provisionSeededVars(step)) capturedVars.add(v);
      } else if (step.action === PROVISION_POOL_ACTION) {
        // no-op — see comment above.
      }

      // Check all string values in the step for {{captured.X}} references
      const refs = findCapturedRefs(step);
      for (const ref of refs) {
        if (!capturedVars.has(ref)) {
          issues.push({
            file: scenario.filePath,
            step: i,
            stepAction: step.action as string,
            message: `{{captured.${ref}}} used but never captured by a prior step`,
          });
        }
      }
    }

    return issues;
  }
}

/**
 * Enumerate exactly the `captured.*` variable names a `provision` step seeds
 * at runtime, per ProvisionStep.ts execute():
 *
 *   - `bayId_1` .. `bayId_N` — ProvisionStep captures one entry per server-
 *     returned bayId (`context.captured.set(\`bayId_${i+1}\`, bayIds[i])`).
 *     The server-returned count is not known statically, but the step's own
 *     `bay_count` field is the declared, POSTed intent (ProvisionStep sends
 *     it as `bayCount` and the response is expected to match). We derive N
 *     from `bay_count` rather than blanket-allowing `bayId_*`: a typo'd
 *     `{{captured.bayId_99}}` when the step only provisions 4 bays must
 *     still be flagged. If `bay_count` is missing/invalid, ProvisionStep
 *     throws before capturing anything, so we seed no bayId_N vars and let
 *     any bayId_N reference correctly flag.
 *   - `cert_path`, `key_path` — always set unconditionally.
 *   - the step's `capture_certs_path_into` value, default `"certs_dir"`.
 */
function provisionSeededVars(step: Record<string, unknown>): string[] {
  const vars: string[] = ['cert_path', 'key_path'];

  const bayCount = step.bay_count;
  if (typeof bayCount === 'number' && Number.isInteger(bayCount) && bayCount >= 1) {
    for (let i = 1; i <= bayCount; i++) vars.push(`bayId_${i}`);
  }

  const capturePathVar = step.capture_certs_path_into;
  vars.push(
    typeof capturePathVar === 'string' && capturePathVar.length > 0
      ? capturePathVar
      : 'certs_dir',
  );

  return vars;
}

function findCapturedRefs(obj: unknown): string[] {
  const refs: string[] = [];
  const regex = /\{\{captured\.([^}]+)\}\}/g;

  function walk(value: unknown): void {
    if (typeof value === 'string') {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(value)) !== null) {
        refs.push(match[1]);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === 'object') {
      for (const val of Object.values(value)) walk(val);
    }
  }

  walk(obj);
  return refs;
}
