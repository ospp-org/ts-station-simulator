import { describe, it, expect } from 'vitest';
import { CapturedVarsCheck } from '../../linter/checks/CapturedVarsCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new CapturedVarsCheck();

describe('CapturedVarsCheck', () => {
  it('captured var used after capture produces no issues', () => {
    const scenario: ParsedScenario = {
      filePath: 'test.yaml',
      name: 'test',
      steps: [
        { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: 5000, capture: { heartbeat: 'payload.heartbeatIntervalSec' } },
        { action: 'send', message: 'Heartbeat', payload: { interval: '{{captured.heartbeat}}' } },
      ],
    };
    const issues = check.check(scenario);
    expect(issues).toHaveLength(0);
  });

  it('captured var used BEFORE capture produces 1 issue', () => {
    const scenario: ParsedScenario = {
      filePath: 'test.yaml',
      name: 'test',
      steps: [
        { action: 'send', message: 'Heartbeat', payload: { interval: '{{captured.heartbeat}}' } },
        { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: 5000, capture: { heartbeat: 'payload.heartbeatIntervalSec' } },
      ],
    };
    const issues = check.check(scenario);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.heartbeat');
  });

  it('captured var never captured produces an issue', () => {
    const scenario: ParsedScenario = {
      filePath: 'test.yaml',
      name: 'test',
      steps: [
        { action: 'send', message: 'X', payload: { x: '{{captured.nonexistent}}' } },
      ],
    };
    const issues = check.check(scenario);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.nonexistent');
  });
});
