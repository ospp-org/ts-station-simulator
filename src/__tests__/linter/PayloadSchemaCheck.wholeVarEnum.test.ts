import { describe, it, expect } from 'vitest';
import { PayloadSchemaCheck } from '../../linter/checks/PayloadSchemaCheck.js';
import type { ParsedScenario, LintIssue } from '../../linter/types.js';

const check = new PayloadSchemaCheck();

// session-ended-event's `reason` is an enum (TimerExpired | Fault | Local |
// LocalOutOfCredit | Deauthorized). A whole-value non-captured runtime --var
// template like {{reason}} (see scenarios/multiunit-e2e/*.yaml) is resolved
// from a CLI `--var reason=...` flag the linter cannot see ahead of time.
function sessionEndedStep(reasonValue: unknown): Record<string, unknown> {
  return {
    action: 'send',
    message: 'SessionEnded',
    messageType: 'Event',
    payload: {
      sessionId: 'sess_a1b2c3d4',
      bayId: 'bay_a1b2c3d4',
      reason: reasonValue,
      actualDurationSeconds: 60,
      creditsCharged: 10,
    },
  };
}

function reasonIssues(reasonValue: unknown): LintIssue[] {
  const scenario: ParsedScenario = { filePath: 'test.yaml', name: 'test', steps: [sessionEndedStep(reasonValue)] };
  return check.check(scenario).filter((i) => i.message.includes('/reason'));
}

describe('PayloadSchemaCheck — whole-value non-captured --var vs enum', () => {
  it('does NOT flag a whole-value {{reason}} runtime --var against the reason enum', () => {
    expect(reasonIssues('{{reason}}')).toHaveLength(0);
  });

  it('tolerates whitespace in the whole-value var token', () => {
    expect(reasonIssues('{{ reason }}')).toHaveLength(0);
  });

  it('STILL flags a literal invalid reason value (not a template) -- real typos are not masked', () => {
    expect(reasonIssues('NotARealReason').length).toBeGreaterThan(0);
  });

  it('STILL flags a non-whole-value embedded template on reason', () => {
    // "prefix-{{reason}}" resolves to a string at runtime that is never a
    // real enum member -- this is a genuinely different case from a bare
    // runtime --var and must stay validated.
    expect(reasonIssues('prefix-{{reason}}').length).toBeGreaterThan(0);
  });

  it('a valid literal reason (no template) passes as before', () => {
    expect(reasonIssues('TimerExpired')).toHaveLength(0);
  });
});
