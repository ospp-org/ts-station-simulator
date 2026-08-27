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
  /**
   * The file's TOP-LEVEL keys, verbatim, minus `steps`.
   *
   * The linter used to see only the step list, which meant no check could ever compare a
   * step against what the file DECLARED about the world it needs. Every precondition key —
   * `requires_pool`, `wallet_balance`, `requires_multiunit_service` — is a promise that some
   * step depends on, and a promise nothing cross-checks is how the two drift apart.
   */
  declarations: Record<string, unknown>;
}
