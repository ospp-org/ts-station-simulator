import { BayStatus, EffectedBy, canBayTransition } from '@ospp/protocol';
import type { LintCheck, LintIssue, ParsedScenario } from '../types.js';

/**
 * A BAY REPORT ALONG AN EDGE THE STATE MACHINE DOES NOT HAVE — 05-state-machines.md §2.3, read on
 * every StatusNotification a scenario sends.
 *
 * §2.3 is "the canonical table": twenty-one `Station` rows, the complete set a station may effect
 * and so the complete set a StatusNotification may report, and "any transition not listed is
 * invalid and MUST NOT be performed". There is no `Occupied -> Available` row - a bay leaves a wash
 * through `Finishing` (§7.2) - and measured on 2026-10-13, 43 steps in 36 corpus files reported
 * exactly that edge at the end of a wash, so every one of them drove the server through a
 * transition no conforming station sends, and the server's anomaly journal for it was what the
 * corpus exercised instead of the wash's real tail.
 *
 * The table is the SDK's (`canBayTransition` with `EffectedBy.STATION`), read rather than restated,
 * so it moves with the spec the SDK is pinned to. A report whose `previousStatus` or `status` is
 * absent or templated is not judged: the post-boot report carries no `previousStatus`, and a
 * template's value is the run's. A step that reports an invalid edge ON PURPOSE - to probe what the
 * server does with one - says so with `expect_invalid_transition: true`, and is not judged either.
 */
export class BayEdgeCheck implements LintCheck {
  name = 'bay-edge';

  check(scenario: ParsedScenario): LintIssue[] {
    const issues: LintIssue[] = [];
    scenario.steps.forEach((step, i) => {
      if (step.action !== 'send' || step.message !== 'StatusNotification') return;
      if (step.expect_invalid_transition === true) return;
      const payload = (step.payload ?? {}) as Record<string, unknown>;
      const from = payload.previousStatus;
      const to = payload.status;
      if (!isLiteralStatus(from) || !isLiteralStatus(to)) return;
      if (canBayTransition(from, to, EffectedBy.STATION)) return;
      issues.push({
        file: scenario.filePath,
        step: i,
        stepAction: 'send',
        message:
          `StatusNotification reports ${from} -> ${to}, which is not a Station row of ` +
          `05-state-machines.md §2.3 (a bay leaves a wash Occupied -> Finishing -> Available). ` +
          `Report the edges the bay takes, or mark a deliberate probe expect_invalid_transition: true.`,
      });
    });
    return issues;
  }
}

const STATUSES: ReadonlySet<string> = new Set(Object.values(BayStatus));

function isLiteralStatus(value: unknown): value is BayStatus {
  return typeof value === 'string' && STATUSES.has(value);
}
