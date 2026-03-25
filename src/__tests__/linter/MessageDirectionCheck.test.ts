import { describe, it, expect } from 'vitest';
import { MessageDirectionCheck } from '../../linter/checks/MessageDirectionCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new MessageDirectionCheck();

function makeScenario(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', steps };
}

describe('MessageDirectionCheck', () => {
  it('station sends BootNotification Request (Station->Server) — OK', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'Request', payload: {} },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('station sends StartService Response (Server->Station, station responds) — OK', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StartService', messageType: 'Response', payload: { status: 'Accepted' } },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('station sends StartService Request (Server->Station, station cannot send Request) — ERROR', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'StartService', messageType: 'Request', payload: {} },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('StartService');
  });

  it('station sends BootNotification Response — ERROR', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'BootNotification', messageType: 'Response', payload: {} },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('BootNotification');
  });

  it('DataTransfer is bidirectional — always OK', () => {
    const issues = check.check(makeScenario([
      { action: 'send', message: 'DataTransfer', messageType: 'Request', payload: {} },
    ]));
    expect(issues).toHaveLength(0);
  });

  it('wait_for BootNotification Request — ERROR (station sends the request, not receives)', () => {
    const issues = check.check(makeScenario([
      { action: 'wait_for', message: 'BootNotification', messageType: 'Request', timeout_ms: 5000 },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('BootNotification');
  });

  it('wait_for StartService Request — OK (server sends request, station waits)', () => {
    const issues = check.check(makeScenario([
      { action: 'wait_for', message: 'StartService', messageType: 'Request', timeout_ms: 5000 },
    ]));
    expect(issues).toHaveLength(0);
  });
});
