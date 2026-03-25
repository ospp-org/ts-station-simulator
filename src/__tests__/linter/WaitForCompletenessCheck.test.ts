import { describe, it, expect } from 'vitest';
import { WaitForCompletenessCheck } from '../../linter/checks/WaitForCompletenessCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new WaitForCompletenessCheck();

function makeScenario(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', steps };
}

describe('WaitForCompletenessCheck', () => {
  it('wait_for with timeout_ms — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: 5000 },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('wait_for without timeout_ms — 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'wait_for', message: 'BootNotification', messageType: 'Response' },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('timeout_ms');
  });

  it('wait_for with timeout_ms: 0 — 1 issue (not positive)', () => {
    const issues = check.check(makeScenario([
      { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: 0 },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('timeout_ms');
  });

  it('wait_for with timeout_ms: -1 — 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: -1 },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('timeout_ms');
  });

  it('non-wait_for step without timeout_ms — 0 issues (only checks wait_for)', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'Request', payload: {} },
    ]));
    expect(issues).toHaveLength(0);
  });
});
