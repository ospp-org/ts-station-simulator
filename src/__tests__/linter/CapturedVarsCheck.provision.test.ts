import { describe, it, expect } from 'vitest';
import { CapturedVarsCheck } from '../../linter/checks/CapturedVarsCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new CapturedVarsCheck();

function scenarioWith(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', steps };
}

// Regression coverage for the CapturedVarsCheck provision-awareness fix: a
// `provision` step (src/scenarios/steps/ProvisionStep.ts) imperatively seeds
// `context.captured` with bayId_1..bayId_N (N = the step's own `bay_count`),
// cert_path, key_path, and its capture_certs_path_into value (default
// "certs_dir") -- all OUTSIDE of a `capture:` map, which is all this check
// otherwise looks at.
describe('CapturedVarsCheck — provision-awareness', () => {
  it('a `provision` step seeds bayId_1..bay_count -- a reference within range produces no issue', () => {
    const scenario = scenarioWith([
      { action: 'provision', token_var: 'provisioning_token', serial_number: '{{serialNumber}}', bay_count: 4 },
      { action: 'send', message: 'StatusNotification', payload: { bayId: '{{captured.bayId_4}}' } },
    ]);
    expect(check.check(scenario)).toHaveLength(0);
  });

  it('a `provision` step also seeds cert_path, key_path, and the default "certs_dir"', () => {
    const scenario = scenarioWith([
      { action: 'provision', token_var: 'provisioning_token', serial_number: '{{serialNumber}}', bay_count: 1 },
      {
        action: 'send',
        message: 'X',
        payload: {
          cert: '{{captured.cert_path}}',
          key: '{{captured.key_path}}',
          dir: '{{captured.certs_dir}}',
        },
      },
    ]);
    expect(check.check(scenario)).toHaveLength(0);
  });

  it('honors a custom capture_certs_path_into name instead of the "certs_dir" default', () => {
    const scenario = scenarioWith([
      {
        action: 'provision',
        token_var: 'provisioning_token',
        serial_number: '{{serialNumber}}',
        bay_count: 1,
        capture_certs_path_into: 'my_dir',
      },
      { action: 'send', message: 'X', payload: { d: '{{captured.my_dir}}' } },
    ]);
    expect(check.check(scenario)).toHaveLength(0);
    // The default name is NOT also registered once overridden -- it genuinely
    // isn't captured under that key at runtime (ProvisionStep sets ONE key).
    const usesDefaultToo = scenarioWith([
      {
        action: 'provision',
        token_var: 'provisioning_token',
        serial_number: '{{serialNumber}}',
        bay_count: 1,
        capture_certs_path_into: 'my_dir',
      },
      { action: 'send', message: 'X', payload: { d: '{{captured.certs_dir}}' } },
    ]);
    expect(check.check(usesDefaultToo)).toHaveLength(1);
  });

  it('an out-of-range bayId reference (beyond bay_count) still fails -- NOT a blanket allow', () => {
    const scenario = scenarioWith([
      { action: 'provision', token_var: 'provisioning_token', serial_number: '{{serialNumber}}', bay_count: 4 },
      { action: 'send', message: 'StatusNotification', payload: { bayId: '{{captured.bayId_99}}' } },
    ]);
    const issues = check.check(scenario);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.bayId_99');
  });

  it('a bayId_N reference BEFORE the provision step still fails (seeding is ordered, not global)', () => {
    const scenario = scenarioWith([
      { action: 'send', message: 'StatusNotification', payload: { bayId: '{{captured.bayId_1}}' } },
      { action: 'provision', token_var: 'provisioning_token', serial_number: '{{serialNumber}}', bay_count: 4 },
    ]);
    const issues = check.check(scenario);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.bayId_1');
  });

  it('a provision step with a missing/invalid bay_count seeds no bayId_N vars (any reference still flags)', () => {
    const scenario = scenarioWith([
      { action: 'provision', token_var: 'provisioning_token', serial_number: '{{serialNumber}}' },
      { action: 'send', message: 'StatusNotification', payload: { bayId: '{{captured.bayId_1}}' } },
    ]);
    const issues = check.check(scenario);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.bayId_1');
  });

  it('provision_station_pool seeds no {{captured.*}} var -- pool vars live under the disjoint {{pool.*}} namespace', () => {
    const scenario = scenarioWith([
      { action: 'provision_station_pool', count: 3, bay_count: 2 },
      { action: 'send', message: 'StatusNotification', payload: { bayId: '{{captured.bayId_1}}' } },
    ]);
    const issues = check.check(scenario);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('captured.bayId_1');
  });
});
