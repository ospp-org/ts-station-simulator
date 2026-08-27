import { describe, it, expect } from 'vitest';
import { MultiUnitDeclaredCheck } from '../../linter/checks/MultiUnitDeclaredCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new MultiUnitDeclaredCheck();

const scenario = (
  steps: ParsedScenario['steps'],
  declarations: Record<string, unknown> = {},
): ParsedScenario => ({ filePath: 'test.yaml', name: 'test', steps, declarations });

const useStep = {
  action: 'api_call',
  method: 'POST',
  url: '/w/{{baySlug_1}}/process',
  body: { service_id: '{{serviceId_multiunit}}', unit_count: 2 },
};

/**
 * The failure this exists for is a PASS, not a failure: a file using
 * `{{serviceId_multiunit}}` without declaring the capacity resolves the variable fine (the
 * id is a constant) and, in a run where SOME OTHER file declared it, finds the row and goes
 * green. Its own precondition is then invisible, and it breaks the day it runs alone.
 */
describe('MultiUnitDeclaredCheck', () => {
  it('flags a step using the variable when the file declares nothing', () => {
    const issues = check.check(scenario([useStep]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('requires_multiunit_service');
    expect(issues[0].step).toBe(0);
  });

  it('accepts it when the file declares the capacity', () => {
    expect(check.check(scenario([useStep], { requires_multiunit_service: 2 }))).toHaveLength(0);
  });

  it('a non-numeric declaration does not satisfy it', () => {
    // `requires_multiunit_service: true` reads as "yes I need it" and seeds nothing —
    // the CLI filters on `typeof === 'number'` to build the capacity.
    expect(check.check(scenario([useStep], { requires_multiunit_service: true }))).toHaveLength(1);
  });

  it('finds the variable in a key position, not only in a value', () => {
    const issues = check.check(scenario([
      { action: 'api_call', expect_body: { 'data[serviceId={{serviceId_multiunit}}].id': 'x' } },
    ]));
    expect(issues).toHaveLength(1);
  });

  // The control: it must not fire on the 145 files that have nothing to do with any of this.
  it('says nothing about a file that never mentions the service', () => {
    expect(check.check(scenario([
      { action: 'send', message: 'BootNotification', payload: { stationId: '{{stationId}}' } },
      { action: 'api_call', method: 'POST', body: { service_id: '{{serviceId_1}}' } },
    ]))).toHaveLength(0);
  });

  // And the inverse is deliberately NOT an issue — see the check's docblock.
  it('does not complain about a declaration with no use', () => {
    expect(check.check(scenario(
      [{ action: 'send', message: 'Heartbeat' }],
      { requires_multiunit_service: 3 },
    ))).toHaveLength(0);
  });
});
