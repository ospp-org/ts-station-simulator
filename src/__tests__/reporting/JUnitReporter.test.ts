import { describe, it, expect } from 'vitest';
import { JUnitReporter } from '../../reporting/JUnitReporter.js';
import type { ScenarioResult } from '../../scenarios/ScenarioRunner.js';
import type { StepResult } from '../../scenarios/ScenarioContext.js';

function makePassedResult(name: string): ScenarioResult {
  return {
    name,
    status: 'passed',
    durationMs: 100,
    steps: [
      { stepIndex: 0, action: 'send', status: 'passed', durationMs: 50 },
      { stepIndex: 1, action: 'assert', status: 'passed', durationMs: 50 },
    ],
  };
}

function makeFailedResult(name: string): ScenarioResult {
  return {
    name,
    status: 'failed',
    durationMs: 200,
    steps: [
      { stepIndex: 0, action: 'send', status: 'passed', durationMs: 50 },
      { stepIndex: 1, action: 'assert', status: 'failed', durationMs: 150, error: 'Expected X got Y' },
    ],
    error: 'Expected X got Y',
  };
}

describe('JUnitReporter', () => {
  it('report() returns valid XML string', () => {
    const reporter = new JUnitReporter();
    const xml = reporter.report([makePassedResult('Test Scenario')]);
    expect(typeof xml).toBe('string');
    expect(xml.length).toBeGreaterThan(0);
  });

  it('contains testsuites root element', () => {
    const reporter = new JUnitReporter();
    const xml = reporter.report([makePassedResult('Test Scenario')]);
    expect(xml).toContain('<testsuites');
  });

  it('contains scenario name as testsuite name', () => {
    const reporter = new JUnitReporter();
    const xml = reporter.report([makePassedResult('Boot Notification Flow')]);
    expect(xml).toContain('Boot Notification Flow');
  });

  it('failed steps include failure element', () => {
    const reporter = new JUnitReporter();
    const xml = reporter.report([makeFailedResult('Failing Scenario')]);
    expect(xml).toContain('<failure');
    expect(xml).toContain('Expected X got Y');
  });
});
