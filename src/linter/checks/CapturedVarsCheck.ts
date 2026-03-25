import type { LintIssue, LintCheck, ParsedScenario } from '../types.js';

export class CapturedVarsCheck implements LintCheck {
  name = 'captured-vars';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];
    const capturedVars = new Set<string>();

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];

      // Collect captures defined by this step
      if (step.capture && typeof step.capture === 'object') {
        for (const key of Object.keys(step.capture as Record<string, unknown>)) {
          capturedVars.add(key);
        }
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
