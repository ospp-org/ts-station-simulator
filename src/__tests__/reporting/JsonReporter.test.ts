import { describe, it, expect } from 'vitest';
import { JsonReporter } from '../../reporting/JsonReporter.js';
import type { ScenarioResult } from '../../scenarios/ScenarioRunner.js';

function makeResults(): ScenarioResult[] {
  return [
    {
      name: 'Scenario A',
      status: 'passed',
      durationMs: 100,
      steps: [
        { stepIndex: 0, action: 'send', status: 'passed', durationMs: 50 },
      ],
    },
    {
      name: 'Scenario B',
      status: 'failed',
      durationMs: 200,
      steps: [
        { stepIndex: 0, action: 'assert', status: 'failed', durationMs: 200, error: 'mismatch' },
      ],
      error: 'mismatch',
    },
  ];
}

describe('JsonReporter', () => {
  it('report() returns valid JSON', () => {
    const reporter = new JsonReporter();
    const output = reporter.report(makeResults());
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('summary has correct totals', () => {
    const reporter = new JsonReporter();
    const parsed = JSON.parse(reporter.report(makeResults()));
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.passed).toBe(1);
    expect(parsed.summary.failed).toBe(1);
    expect(parsed.summary.durationMs).toBe(300);
  });

  it('scenarios are included in output', () => {
    const reporter = new JsonReporter();
    const parsed = JSON.parse(reporter.report(makeResults()));
    expect(parsed.scenarios).toHaveLength(2);
    expect(parsed.scenarios[0].name).toBe('Scenario A');
    expect(parsed.scenarios[1].name).toBe('Scenario B');
  });
});
