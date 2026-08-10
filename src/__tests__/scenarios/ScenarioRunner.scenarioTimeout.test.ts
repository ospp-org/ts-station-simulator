import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ScenarioRunner,
  DEFAULT_SCENARIO_TIMEOUT_MS,
  type ScenarioDefinition,
  type TargetConfig,
  type ScenarioResult,
} from '../../scenarios/ScenarioRunner.js';

/**
 * The runner had no per-scenario bound. A scenario blocked forever hung the whole run, and
 * because verdicts print only in the final report, one hang cost every other result.
 */

const TARGET: TargetConfig = { mqttUrl: 'mqtt://localhost:1883', apiBaseUrl: 'http://localhost:8080' };

const ok = (name: string): ScenarioResult => ({ name, status: 'passed', durationMs: 1, steps: [] });
const never = () => new Promise<ScenarioResult>(() => { /* blocks forever, on purpose */ });

function def(name: string, extra: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    name,
    station: { bayCount: 1, stationModel: 'WashPro X200', stationVendor: 'SimCorp' },
    steps: [],
    ...extra,
  };
}

/** Reach the private bound directly — the mechanism, without a broker. */
function bounded(runner: ScenarioRunner, s: ScenarioDefinition): Promise<ScenarioResult> {
  return (runner as unknown as {
    runScenarioBounded(s: ScenarioDefinition, t: TargetConfig): Promise<ScenarioResult>;
  }).runScenarioBounded(s, TARGET);
}

describe('per-scenario timeout — the bound itself', () => {
  it('the default is derived from the corpus: above the 60.8s band, below arc8 at 347.8s', () => {
    expect(DEFAULT_SCENARIO_TIMEOUT_MS).toBeGreaterThan(60_800);
    expect(DEFAULT_SCENARIO_TIMEOUT_MS).toBeLessThan(347_831);
  });

  it('a scenario that blocks forever FAILS on its budget instead of hanging', async () => {
    const runner = new ScenarioRunner();
    vi.spyOn(runner, 'runScenario').mockImplementation(() => never());

    const r = await bounded(runner, def('hangs', { scenario_timeout_ms: 60 }));

    expect(r.status).toBe('failed');
    expect(r.steps[0].error).toMatch(/exceeded its 60ms budget/);
    // Must say the RUNNER gave up, so nobody hunts for a failing assertion.
    expect(r.steps[0].error).toMatch(/RUNNER giving up, not an assertion failing/);
  });

  it('does not interfere with a scenario that finishes inside its budget', async () => {
    const runner = new ScenarioRunner();
    vi.spyOn(runner, 'runScenario').mockImplementation(async s => ok(s.name));

    expect((await bounded(runner, def('quick'))).status).toBe('passed');
  });

  it('honours a per-scenario override rather than the default', async () => {
    const runner = new ScenarioRunner();
    vi.spyOn(runner, 'runScenario').mockImplementation(async s => {
      await new Promise(r => setTimeout(r, 120));
      return ok(s.name);
    });

    const started = Date.now();
    const r = await bounded(runner, def('slow-but-legit', { scenario_timeout_ms: 5_000 }));
    expect(r.status).toBe('passed');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('an orphaned scenario rejecting later cannot surface as an unhandled rejection', async () => {
    const runner = new ScenarioRunner();
    vi.spyOn(runner, 'runScenario').mockImplementation(() =>
      new Promise<ScenarioResult>((_, rej) => setTimeout(() => rej(new Error('late boom')), 120)));

    const r = await bounded(runner, def('rejects-late', { scenario_timeout_ms: 40 }));
    expect(r.status).toBe('failed');
    // Give the orphan time to reject; an unhandled rejection would fail the suite here.
    await new Promise(r2 => setTimeout(r2, 250));
  });
});

describe('per-scenario timeout — THE POINT: a hang must not cost the other results', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scn-timeout-'));
    const yaml = (name: string, budget: number) =>
      `scenario_timeout_ms: ${budget}\n` +
      `name: "${name}"\n` +
      `station:\n  bayCount: 1\n  stationModel: "WashPro X200"\n  stationVendor: "SimCorp"\n` +
      `steps: []\n`;
    // Names drive the stub; filenames drive run order (runAll sorts).
    fs.writeFileSync(path.join(dir, '1-before.yaml'), yaml('before', 5_000));
    fs.writeFileSync(path.join(dir, '2-hangs.yaml'), yaml('hangs', 60));
    fs.writeFileSync(path.join(dir, '3-after.yaml'), yaml('after', 5_000));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('the run completes and the scenarios after the hang still report', async () => {
    const runner = new ScenarioRunner();
    vi.spyOn(runner, 'runScenario').mockImplementation(async s =>
      s.name === 'hangs' ? never() : ok(s.name));

    const results = await runner.runAll(dir, TARGET, { cooldownMs: 0 });

    expect(results.map(r => `${r.name}:${r.status}`)).toEqual([
      'before:passed',
      'hangs:failed',
      'after:passed',
    ]);
  });
});

describe('the one legitimate override in the corpus', () => {
  it('arc8-reconnect-preserve declares a budget above its measured 347.8s', () => {
    const src = fs.readFileSync(
      path.resolve('scenarios/sessions/arc8-reconnect-preserve.yaml'), 'utf8');
    const m = src.match(/^scenario_timeout_ms:\s*(\d+)/m);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(347_831);
  });

  it('and it is the ONLY file that overrides — every new override should be argued for', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name))
        : e.name.endsWith('.yaml') ? [path.join(d, e.name)] : []);

    const overriding = walk(path.resolve('scenarios'))
      .filter(f => /^scenario_timeout_ms:/m.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.basename(f));

    expect(overriding).toEqual(['arc8-reconnect-preserve.yaml']);
  });
});
