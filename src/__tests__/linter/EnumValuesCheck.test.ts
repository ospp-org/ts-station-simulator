import { describe, it, expect } from 'vitest';
import { EnumValuesCheck } from '../../linter/checks/EnumValuesCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new EnumValuesCheck();

function makeScenario(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', steps };
}

describe('EnumValuesCheck', () => {
  it('valid bootReason "PowerOn" — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'Request', payload: { bootReason: 'PowerOn' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('invalid bootReason "InvalidReason" — 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'Request', payload: { bootReason: 'InvalidReason' } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('bootReason');
  });

  it('valid bay status "Available" — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StatusNotification', messageType: 'Event', payload: { status: 'Available' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('invalid bay status "BadStatus" — 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StatusNotification', messageType: 'Event', payload: { status: 'BadStatus' } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('bay status');
  });

  it('valid SessionEnded reason "TimerExpired" — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'SessionEnded', messageType: 'Event', payload: { reason: 'TimerExpired' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('valid SessionEnded reason "Local" (v0.4.0) — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'SessionEnded', messageType: 'Event', payload: { reason: 'Local' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('valid SessionEnded reason "LocalOutOfCredit" (v0.4.0) — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'SessionEnded', messageType: 'Event', payload: { reason: 'LocalOutOfCredit' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('valid SessionEnded reason "Deauthorized" (v0.4.0) — 0 issues', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'SessionEnded', messageType: 'Event', payload: { reason: 'Deauthorized' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('invalid SessionEnded reason "BadReason" — 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'SessionEnded', messageType: 'Event', payload: { reason: 'BadReason' } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('SessionEnded reason');
  });

  it('invalid messageType "BadType" — 1 issue', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'BadType', payload: { bootReason: 'PowerOn' } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('messageType');
  });

  it('template variable bootReason "{{captured.reason}}" — 0 issues (skip templates)', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'Request', payload: { bootReason: '{{captured.reason}}' } },
    ]));
    expect(issues).toHaveLength(0);
  });
});
