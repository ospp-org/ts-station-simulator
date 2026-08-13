import { describe, it, expect } from 'vitest';
import { PreEmptDiscriminatorCheck } from '../../linter/checks/PreEmptDiscriminatorCheck.js';
import type { ParsedScenario } from '../../linter/types.js';

const scenario = (steps: Record<string, unknown>[]): ParsedScenario => ({
  filePath: 'scenarios/test.yaml',
  name: 'test',
  steps,
});

/**
 * The check exists because a passing scenario gives no signal that it asserted too little.
 * `ResetStationAction` answers 6008 from two gates one after the other — capability
 * (wouldBe 2007) and active-session (wouldBe 3016) — so a file pinning only the code is
 * green whichever one fired, including the one that means its own setup never landed.
 */
describe('PreEmptDiscriminatorCheck', () => {
  const check = new PreEmptDiscriminatorCheck();

  it('flags an api_call asserting 6008 with no wouldBe', () => {
    const issues = check.check(scenario([
      { action: 'api_call', method: 'POST', expect_body: { 'error.ospp_code': 6008 } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(0);
    expect(issues[0].message).toMatch(/without "error\.details\.wouldBe"/);
  });

  it('accepts 6008 asserted together with the discriminator', () => {
    const issues = check.check(scenario([
      {
        action: 'api_call',
        method: 'POST',
        expect_body: { 'error.ospp_code': 6008, 'error.details.wouldBe': 3016 },
      },
    ]));
    expect(issues).toEqual([]);
  });

  it('leaves other codes alone — only 6008 is emitted from more than one gate per method', () => {
    const issues = check.check(scenario([
      { action: 'api_call', method: 'POST', expect_body: { 'error.ospp_code': 3002 } },
    ]));
    expect(issues).toEqual([]);
  });

  it('ignores non-api_call steps and api_calls with no expect_body', () => {
    const issues = check.check(scenario([
      { action: 'send', message: 'BootNotification' },
      { action: 'api_call', method: 'PUT', expect_status: 202 },
    ]));
    expect(issues).toEqual([]);
  });

  it('reports the offending step index when several api_calls precede it', () => {
    const issues = check.check(scenario([
      { action: 'api_call', method: 'POST', expect_status: 201 },
      { action: 'api_call', method: 'POST', expect_status: 200 },
      { action: 'api_call', method: 'POST', expect_body: { 'error.ospp_code': 6008 } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(2);
  });
});
