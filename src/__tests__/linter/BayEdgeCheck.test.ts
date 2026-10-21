import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { BayEdgeCheck } from '../../linter/checks/BayEdgeCheck.js';
import { ScenarioLinter } from '../../linter/ScenarioLinter.js';
import type { ParsedScenario } from '../../linter/types.js';

const check = new BayEdgeCheck();

function makeScenario(steps: Record<string, unknown>[]): ParsedScenario {
  return { filePath: 'test.yaml', name: 'test', declarations: {}, steps };
}

const report = (previousStatus: unknown, status: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'send',
  message: 'StatusNotification',
  messageType: 'Event',
  payload: { bayId: '{{bayId_1}}', bayNumber: 1, status, ...(previousStatus === undefined ? {} : { previousStatus }) },
  ...extra,
});

/**
 * 05-state-machines.md §2.3: the twenty-one Station rows are the only edges a StatusNotification
 * may report. The corpus reported `Occupied -> Available` at the end of 43 washes.
 */
describe('BayEdgeCheck — a bay report takes an edge of the state machine', () => {
  it('flags Occupied -> Available, the wash tail the corpus reported 43 times', () => {
    const issues = check.check(makeScenario([report('Occupied', 'Available')]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(0);
    expect(issues[0].message).toMatch(/Occupied -> Available, which is not a Station row/);
  });

  it('accepts the wash tail the table has, Occupied -> Finishing -> Available', () => {
    expect(check.check(makeScenario([report('Available', 'Occupied'), report('Occupied', 'Finishing'), report('Finishing', 'Available')]))).toEqual([]);
  });

  it('flags the other edges the table lacks and accepts the ones it has', () => {
    expect(check.check(makeScenario([report('Occupied', 'Reserved')]))).toHaveLength(1);
    expect(check.check(makeScenario([report('Reserved', 'Finishing')]))).toHaveLength(1);
    expect(check.check(makeScenario([report('Available', 'Unknown')]))).toHaveLength(1);
    expect(check.check(makeScenario([report('Available', 'Reserved'), report('Reserved', 'Available')]))).toEqual([]);
    expect(check.check(makeScenario([report('Unknown', 'Occupied'), report('Faulted', 'Unavailable')]))).toEqual([]);
  });

  it('does not judge a report with no previousStatus or a templated one', () => {
    expect(check.check(makeScenario([report(undefined, 'Available')]))).toEqual([]);
    expect(check.check(makeScenario([report('{{previous}}', 'Available')]))).toEqual([]);
    expect(check.check(makeScenario([report('Occupied', '{{status}}')]))).toEqual([]);
  });

  it('does not judge a probe marked expect_invalid_transition, and judges the next report again', () => {
    const issues = check.check(makeScenario([
      report('Occupied', 'Reserved', { expect_invalid_transition: true }),
      report('Occupied', 'Available'),
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0].step).toBe(1);
  });

  it('runs as part of the scenario linter', () => {
    expect(new ScenarioLinter()['checks'].some((c: { name: string }) => c.name === 'bay-edge')).toBe(true);
  });
});

/**
 * Every scenario file under scenarios/, as `npm run lint:scenarios` reads it. The denominator
 * comes first: a walk that found no reports would pass the empty-list assertion while guarding
 * nothing.
 */
describe('BayEdgeCheck — the scenario corpus', () => {
  const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

  function yamlFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
      else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
    }
    return out.sort();
  }

  it('reports no bay edge the state machine does not have', () => {
    let judged = 0;
    const offenders: string[] = [];
    for (const file of yamlFiles(SCENARIOS_DIR)) {
      const parsed = parseYaml(readFileSync(file, 'utf-8')) as { name?: string; steps?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.steps)) continue;
      const steps = parsed.steps as Record<string, unknown>[];
      judged += steps.filter((s) => s?.action === 'send' && s?.message === 'StatusNotification'
        && typeof (s.payload as Record<string, unknown> | undefined)?.previousStatus === 'string').length;
      const { steps: _steps, ...declarations } = parsed;
      const rel = path.relative(SCENARIOS_DIR, file);
      for (const issue of check.check({ filePath: rel, name: parsed.name ?? rel, steps, declarations })) {
        offenders.push(`${rel} step ${issue.step}: ${issue.message}`);
      }
    }

    expect(judged).toBeGreaterThan(100);
    expect(offenders, `bay reports along an edge §2.3 does not have:\n${offenders.join('\n')}`).toEqual([]);
  });
});
