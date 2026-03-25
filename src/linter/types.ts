export interface LintIssue {
  file: string;
  step: number;
  stepAction: string;
  message: string;
}

export interface LintCheck {
  name: string;
  check(scenario: ParsedScenario): LintIssue[];
}

export interface ParsedScenario {
  filePath: string;
  name: string;
  steps: Record<string, unknown>[];
}
