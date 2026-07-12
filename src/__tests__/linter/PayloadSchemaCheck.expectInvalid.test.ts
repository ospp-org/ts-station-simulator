import { describe, it, expect } from 'vitest';
import { PayloadSchemaCheck } from '../../linter/checks/PayloadSchemaCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new PayloadSchemaCheck();

// status-notification (Event) requires `bayNumber` and `services` (>=1 item).
// This payload omits both -- genuinely schema-invalid, mirroring
// scenarios/chaos/malformed-messages.yaml's deliberate-invalid sends.
function invalidStatusStep(expectInvalid?: boolean): Record<string, unknown> {
  const step: Record<string, unknown> = {
    action: 'send',
    message: 'StatusNotification',
    messageType: 'Event',
    payload: { bayId: 'bay_a1b2c3d4', status: 'Available' },
  };
  if (expectInvalid !== undefined) step.expect_invalid = expectInvalid;
  return step;
}

describe('PayloadSchemaCheck — expect_invalid opt-out', () => {
  it('a `send` step with expect_invalid: true is NOT validated, even though the payload is genuinely invalid', () => {
    const scenario: ParsedScenario = { filePath: 'test.yaml', name: 'test', steps: [invalidStatusStep(true)] };
    expect(check.check(scenario)).toHaveLength(0);
  });

  it('the SAME invalid payload WITHOUT expect_invalid still fails (opt-out is not a blanket weakening)', () => {
    const scenario: ParsedScenario = { filePath: 'test.yaml', name: 'test', steps: [invalidStatusStep(false)] };
    const issues = check.check(scenario);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('bayNumber'))).toBe(true);
    expect(issues.some((i) => i.message.includes('services'))).toBe(true);
  });

  it('omitting expect_invalid entirely (default/undefined) still fails the same invalid payload', () => {
    const scenario: ParsedScenario = { filePath: 'test.yaml', name: 'test', steps: [invalidStatusStep(undefined)] };
    expect(check.check(scenario).length).toBeGreaterThan(0);
  });

  it('expect_invalid on one step does not suppress validation on a DIFFERENT step in the same scenario', () => {
    const scenario: ParsedScenario = {
      filePath: 'test.yaml',
      name: 'test',
      steps: [invalidStatusStep(true), invalidStatusStep(false)],
    };
    const issues = check.check(scenario);
    expect(issues.length).toBeGreaterThan(0);
    // Every remaining issue must belong to step 1 (the non-marked one) --
    // step 0's identical-shaped payload was correctly skipped.
    expect(issues.every((i) => i.step === 1)).toBe(true);
  });
});
