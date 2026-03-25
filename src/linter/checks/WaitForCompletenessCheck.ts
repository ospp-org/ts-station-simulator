import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

export class WaitForCompletenessCheck implements LintCheck {
  name = 'wait-for-completeness';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (step.action !== 'wait_for') continue;

      const timeoutMs = step.timeout_ms;
      if (timeoutMs === undefined || timeoutMs === null) {
        issues.push({
          file: scenario.filePath,
          step: i,
          stepAction: 'wait_for',
          message: `Missing timeout_ms on wait_for step`,
        });
      } else if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
        issues.push({
          file: scenario.filePath,
          step: i,
          stepAction: 'wait_for',
          message: `timeout_ms must be a positive number, got ${JSON.stringify(timeoutMs)}`,
        });
      }
    }

    return issues;
  }
}
