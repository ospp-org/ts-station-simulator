import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

/**
 * A step that uses `{{serviceId_multiunit}}` and a file that declares
 * `requires_multiunit_service:` are two halves of one thing, and NEITHER of them owns the
 * pair.
 *
 * The variable resolves unconditionally — the service id is a constant, so substitution
 * always succeeds. What is conditional is the ROW: the pool bootstrap seeds the multi-unit
 * catalog entry only when some selected scenario declared it. A file that uses the variable
 * without the declaration therefore runs, sends a real-looking `service_id`, and gets
 * `404 Service not found` from the quote — or, if another file in the same run happened to
 * declare it, PASSES. Passing because of a neighbour is worse than failing: the file's own
 * precondition is invisible, and it breaks the day it is run alone.
 *
 * The inverse — declaring the capacity and never using the variable — is left alone
 * deliberately. It costs one column value on a row nothing reads, and a file may reasonably
 * declare the capacity while addressing the service through a `--var`.
 *
 * The DECLARED NUMBER is not checked against the units the steps drive. It could not be:
 * the DSL has no loop, so the unit count is unrolled as a series of `wait_for` rounds that
 * this check would have to recognise by shape — and a wrong guess there would refuse a
 * correct file. The bootstrap's own read-back (`verifyMultiUnitSeed`) is where an
 * insufficient capacity is caught, against the database rather than against a heuristic.
 */
const MULTIUNIT_VAR = '{{serviceId_multiunit}}';
const DECLARATION = 'requires_multiunit_service';

export class MultiUnitDeclaredCheck implements LintCheck {
  name = 'multiunit-declared';

  check(scenario: ParsedScenario): LintIssue[] {
    const declared = scenario.declarations[DECLARATION];
    if (typeof declared === 'number') return [];

    const issues: LintIssue[] = [];
    for (let i = 0; i < scenario.steps.length; i++) {
      if (!mentions(scenario.steps[i])) continue;
      issues.push({
        file: scenario.filePath,
        step: i,
        stepAction: String(scenario.steps[i].action ?? ''),
        message:
          `${MULTIUNIT_VAR} used but the file does not declare "${DECLARATION}: <units>". ` +
          `The variable always resolves (the service id is a constant) — the CATALOG ROW is ` +
          `what the declaration seeds, and without it the quote answers 404, or passes only ` +
          `because another scenario in the same run declared it.`,
      });
    }
    return issues;
  }
}

function mentions(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(MULTIUNIT_VAR);
  if (Array.isArray(value)) return value.some(mentions);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k.includes(MULTIUNIT_VAR) || mentions(v));
  }
  return false;
}
