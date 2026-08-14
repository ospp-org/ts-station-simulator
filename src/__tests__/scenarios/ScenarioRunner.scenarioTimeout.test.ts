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

describe('the legitimate overrides in the corpus', () => {
  it('arc8-reconnect-preserve declares a budget above its measured 347.8s', () => {
    const src = fs.readFileSync(
      path.resolve('scenarios/sessions/arc8-reconnect-preserve.yaml'), 'utf8');
    const m = src.match(/^scenario_timeout_ms:\s*(\d+)/m);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(347_831);
  });

  // THE ARGUMENT, as this describe block demands of every new override.
  //
  // reserve-expire cannot be made to fit the 90s default, and not because it is
  // written wastefully. Two server facts set the floor and neither is under the
  // scenario's control:
  //
  //   1. ReservationTransitions::MIN_TTL_MINUTES = 1. The shortest reservation
  //      the API will accept expires 60s after creation. duration_minutes: 1 is
  //      already the minimum.
  //   2. Expiry is a scheduled sweep, not a read-time evaluation —
  //      Schedule::command('reservation:check-expiry')->everyMinute(). The row
  //      flips on the first tick strictly AFTER the expiration time, so the
  //      observable transition lands in the 60-120s band after creation.
  //
  // 60s floor + up to 60s of sweep latency + boot and the ReserveBay round trip
  // exceeds 90s on the worst case, so the default would make this file flaky
  // rather than slow — the worst of both. 130s of delay inside a 180s budget is
  // the worst case plus margin.
  //
  // The alternative was to keep the old 5000ms delay, which fit the default
  // comfortably and proved nothing: at T+5s the reservation has 55 seconds left.
  // That is what this file did for months. A budget that forces a scenario to
  // assert something untrue is not a budget worth keeping.
  it('reserve-expire declares a budget covering the TTL floor plus the sweep interval', () => {
    const src = fs.readFileSync(
      path.resolve('scenarios/reservations/reserve-expire.yaml'), 'utf8');
    const m = src.match(/^scenario_timeout_ms:\s*(\d+)/m);
    expect(m).not.toBeNull();

    // 60s TTL floor + 60s worst-case sweep latency = 120s before the row can
    // flip. The budget must clear that, not merely clear the delay it happens
    // to declare today.
    expect(Number(m![1])).toBeGreaterThan(120_000);

    // And the delay it waits must itself sit inside the budget it declares.
    const delay = Math.max(...[...src.matchAll(/^\s+ms:\s*(\d+)/gm)].map(d => Number(d[1])));
    expect(delay).toBeGreaterThan(120_000);
    expect(Number(m![1])).toBeGreaterThan(delay);
  });

  // THE ARGUMENT, as this describe block demands of every new override.
  //
  // heartbeat-silence-offline-sweep cannot fit the 90s default, and the reason is
  // not that it waits wastefully — it is that the shortest possible observation of
  // this detector is longer than the default. Two server facts set the floor and
  // neither is under the scenario's control:
  //
  //   1. The threshold is `missed_heartbeats_threshold` x the station's recorded
  //      heartbeat interval — 3.5 x 30 = 105s on the UAT config. Nothing the
  //      scenario does can lower it: the interval stored in the tracker key is the
  //      server's effective value, written by the Boot that arms the key.
  //   2. Detection is a scheduled sweep, not a read-time evaluation —
  //      Schedule::command('station:check-heartbeats')->everyMinute(). The row
  //      flips on the first tick strictly AFTER the threshold is crossed, so the
  //      observable transition lands in the 105-165s band after the Boot.
  //
  // 105s threshold + up to 60s of sweep latency already exceeds the 90s default
  // before the Boot and the two arming reads are counted, so the default would
  // make this file fail every time rather than merely be slow.
  //
  // There is no shorter honest version. A file that waited 90s would assert the
  // station is offline before the threshold can even have been crossed — it would
  // not be flaky, it would be wrong. That is the same trap reserve-expire fell
  // into for months with its 5000ms delay, in the opposite direction.
  it('heartbeat-silence-offline-sweep declares a budget covering the threshold plus the sweep interval', () => {
    const src = fs.readFileSync(
      path.resolve('scenarios/core/heartbeat-silence-offline-sweep.yaml'), 'utf8');
    const m = src.match(/^scenario_timeout_ms:\s*(\d+)/m);
    expect(m).not.toBeNull();

    // 105s threshold (3.5 x 30) + 60s worst-case sweep latency = 165s before the
    // row can flip. The budget must clear that, not merely clear the delay the
    // file happens to declare today.
    expect(Number(m![1])).toBeGreaterThan(165_000);

    // And the silence it waits out must itself clear the same floor, and sit
    // inside the budget it declares. A file that declared a generous budget but
    // waited 90s would read as covered while asserting before the threshold.
    const delay = Math.max(...[...src.matchAll(/^\s+ms:\s*(\d+)/gm)].map(d => Number(d[1])));
    expect(delay).toBeGreaterThan(165_000);
    expect(Number(m![1])).toBeGreaterThan(delay);
  });

  // THE ARGUMENT for the three scenarios/e2e files, as this describe block demands.
  //
  // It is a different KIND of argument from the three above, and the difference is
  // worth stating rather than blurring: those three cannot fit the default because a
  // SERVER floor (a TTL, a heartbeat threshold, a sweep interval) is longer than 90s.
  // These three cannot fit it because of their OWN declared waiting — and that waiting
  // is not decoration. Path B is a single-threaded consumer (MqttConsume.php:67-87) at
  // ~5s per message, and each file drains Boot + 4 StatusNotifications + a catalog
  // Response before it can start a session on a bay whose status has landed. A file
  // that skipped the drain would not be faster; it would answer 3002 BAY_NOT_READY.
  //
  // For two of the three the arithmetic settles it with no measurement at all: the
  // `delay:` steps ALONE sum to 91.0s and 166.6s, which is already past the 90s
  // default before a single request is sent. Asserted below, off the committed files.
  //
  // e2e-new-customer-onboarding is the weak one and is named as such. Its delays sum
  // to 55.5s and it last measured 86s end to end (UAT 2026-07-31) — inside the default
  // by 4s. The catalog sequence it now carries is nine requests where there was one, so
  // that margin is roughly a second. The default would make it flaky rather than slow,
  // which is the worst of both, and a flake here reports "the RUNNER giving up" while
  // naming nothing about the file.
  //
  // WHY NONE OF THE THREE HAS EVER MET THIS BOUND. The bound landed 2026-08-10
  // (57063cc). The catalog gate that stopped all three at their `PUT …/catalog` landed
  // 2026-08-06. So from the day the bound existed, every one of these files was already
  // failing four steps upstream of its first long delay — the two have never been in
  // force together, and fixing the catalog is precisely what would have made the
  // runner's own timeout the next failure. That is the whole reason these three lines
  // are being added in the same change as the catalog sequence and not after a red run.
  //
  // The budgets are sized off the delays each file declares, NOT off a measured
  // duration — only the first two have one, and the matrix has never been timed to
  // completion. They are ceilings meant to be replaced by measurement, and the
  // assertion below deliberately bounds them from BOTH sides so an unexamined number
  // cannot drift upward into "no bound at all".
  it('the three e2e files declare budgets that cover their own declared waiting', () => {
    const files = [
      'scenarios/e2e/e2e-new-customer-onboarding.yaml',
      'scenarios/e2e/e2e-returning-customer-session.yaml',
      'scenarios/e2e/e2e-session-end-matrix.yaml',
    ];

    for (const rel of files) {
      const src = fs.readFileSync(path.resolve(rel), 'utf8');
      const m = src.match(/^scenario_timeout_ms:\s*(\d+)/m);
      expect(m, `${rel} must declare a budget`).not.toBeNull();
      const budget = Number(m![1]);

      // The sum, not the max: these files wait repeatedly and the waits are serial.
      const declaredDelayMs = [...src.matchAll(/^\s+ms:\s*(\d+)/gm)]
        .reduce((sum, d) => sum + Number(d[1]), 0);

      // Covers the waiting it declares, with room for the requests around it. A budget
      // that merely cleared the delays would abandon the file mid-teardown.
      expect(budget, `${rel}: budget must exceed its ${declaredDelayMs}ms of delay`)
        .toBeGreaterThan(declaredDelayMs + 30_000);

      // And is a bound, not an absence of one. 2x the declared waiting is the ceiling;
      // past that the file is no longer being bounded by anything it can account for.
      expect(budget, `${rel}: budget is not a bound any more`)
        .toBeLessThanOrEqual(declaredDelayMs * 2 + 60_000);
    }
  });

  // The load-bearing half of the argument for two of the three, checked rather than
  // asserted in prose: their own delays already exceed the default, so the override is
  // arithmetic on the committed file and not a judgement call. If someone later shortens
  // those drains below 90s, THIS test goes red and the override has to be re-argued —
  // which is the outcome wanted, since it would no longer be self-evidently necessary.
  it('two of the three exceed the default on declared delay alone', () => {
    const sums = [
      'scenarios/e2e/e2e-returning-customer-session.yaml',
      'scenarios/e2e/e2e-session-end-matrix.yaml',
    ].map(rel => {
      const src = fs.readFileSync(path.resolve(rel), 'utf8');
      return [...src.matchAll(/^\s+ms:\s*(\d+)/gm)].reduce((s, d) => s + Number(d[1]), 0);
    });

    for (const sum of sums) expect(sum).toBeGreaterThan(DEFAULT_SCENARIO_TIMEOUT_MS);
  });

  it('and those are the ONLY files that override — every new override should be argued for', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name))
        : e.name.endsWith('.yaml') ? [path.join(d, e.name)] : []);

    const overriding = walk(path.resolve('scenarios'))
      .filter(f => /^scenario_timeout_ms:/m.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.basename(f))
      .sort();

    expect(overriding).toEqual([
      'arc8-reconnect-preserve.yaml',
      'e2e-new-customer-onboarding.yaml',
      'e2e-returning-customer-session.yaml',
      'e2e-session-end-matrix.yaml',
      'heartbeat-silence-offline-sweep.yaml',
      'reserve-expire.yaml',
    ]);
  });
});
