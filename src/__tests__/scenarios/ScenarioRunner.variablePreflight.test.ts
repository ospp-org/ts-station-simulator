import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  unsatisfiedVariables,
  type ScenarioDefinition,
  type TargetConfig,
} from '../../scenarios/ScenarioRunner.js';

const TARGET = { mqttUrl: 'mqtt://localhost:1883', apiBaseUrl: 'http://localhost' } as TargetConfig;

function scenario(over: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    name: 'test',
    station: { stationId: '{{stationId}}', bayCount: 2 },
    steps: [],
    ...over,
  } as ScenarioDefinition;
}

const CORPUS = path.resolve('scenarios');
function loadAll(): Array<{ rel: string; def: ScenarioDefinition }> {
  const out: Array<{ rel: string; def: ScenarioDefinition }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yaml') || e.name.endsWith('.yml')) {
        const def = YAML.parse(fs.readFileSync(p, 'utf8')) as ScenarioDefinition;
        if (def?.steps) out.push({ rel: path.relative(CORPUS, p), def });
      }
    }
  };
  walk(CORPUS);
  return out;
}

describe('unsatisfiedVariables — what a scenario asks for that nothing supplies', () => {
  it('is empty when every token is generated', () => {
    expect(unsatisfiedVariables(scenario({
      steps: [{ action: 'send', payload: { stationId: '{{stationId}}', bay: '{{bayId_1}}' } }],
    } as Partial<ScenarioDefinition>), TARGET)).toEqual([]);
  });

  it('names the variable nothing generates', () => {
    expect(unsatisfiedVariables(scenario({
      steps: [{ action: 'send', payload: { reason: '{{reason}}' } }],
    } as Partial<ScenarioDefinition>), TARGET)).toEqual(['reason']);
  });

  it('is satisfied by a --var', () => {
    expect(unsatisfiedVariables(
      scenario({ steps: [{ action: 'send', payload: { reason: '{{reason}}' } }] } as Partial<ScenarioDefinition>),
      TARGET,
      new Map([['reason', 'TimerExpired']]),
    )).toEqual([]);
  });

  it('ignores captured./pool./provisioning. — those resolve from run state, not --var', () => {
    expect(unsatisfiedVariables(scenario({
      steps: [{ action: 'api_call', url: '{{captured.uuid}}/{{pool.size}}/{{provisioning.bayIds.0}}' }],
    } as Partial<ScenarioDefinition>), TARGET)).toEqual([]);
  });

  it('reads mapping KEYS, so a selector carrying a template is checked too', () => {
    expect(unsatisfiedVariables(scenario({
      steps: [{ action: 'api_call', expect_body: { 'data[eventId={{nope}}].type': 'X' } }],
    } as Partial<ScenarioDefinition>), TARGET)).toEqual(['nope']);
  });

  // The bug that made the first version of this survey report the one known-failing
  // scenario as CLEAN: single-session-drive documents {{reason}} in its own header, and a
  // text-level scan cannot tell the documentation from the dependency.
  it('does NOT count a token that appears only in the description', () => {
    expect(unsatisfiedVariables(scenario({
      description: 'ends with reason={{reason}}',
      steps: [{ action: 'send', payload: { ok: 1 } }],
    } as Partial<ScenarioDefinition>), TARGET)).toEqual([]);
  });

  it('bayId_N beyond the declared bayCount is NOT provided', () => {
    expect(unsatisfiedVariables(scenario({
      station: { stationId: '{{stationId}}', bayCount: 2 },
      steps: [{ action: 'send', payload: { b: '{{bayId_4}}' } }],
    } as Partial<ScenarioDefinition>), TARGET)).toEqual(['bayId_4']);
  });
});

/**
 * The class gate. `skip_when_pooled` is hand-maintained: 8 files declare it and
 * single-session-drive simply did not, which is the entire defect. This pins the corpus so a
 * NEW scenario that references an ungenerated variable has to be a deliberate decision.
 */
describe('the corpus, as a standing survey', () => {
  const all = loadAll();

  it('scans the whole corpus', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('exactly these files require a --var, and every one is a known parameterized harness', () => {
    const needing = all
      .filter(({ def }) => unsatisfiedVariables(def, TARGET).length > 0)
      .map(({ rel }) => rel.replace(/\\/g, '/'))
      .sort();

    expect(needing).toEqual([
      'multiunit-e2e/multiunit-batch-drive.yaml',
      'multiunit-e2e/single-session-drive.yaml',
      'security/offline-auth-transaction-reconcile-hostile.yaml',
      'security/offline-auth-transaction-reconcile.yaml',
      'sessions/session-rejected-invalid-service-cross-station.yaml',
    ]);
  });

  it('each one states the requirement in its own header', () => {
    for (const { rel, def } of all) {
      const missing = unsatisfiedVariables(def, TARGET);
      if (missing.length === 0) continue;
      const src = fs.readFileSync(path.join(CORPUS, rel), 'utf8');
      for (const v of missing) {
        expect(src, `${rel} must document --var ${v}`).toContain(v);
      }
    }
  });
});
