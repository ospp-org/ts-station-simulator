import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ScenarioRunner,
  type ScenarioDefinition,
  type TargetConfig,
} from '../../scenarios/ScenarioRunner.js';

/**
 * The durations THIS RUNNER reports are measurements too, and they were taken off
 * the wall clock at every one of their 17 call sites.
 *
 * They are what the console summary prints, what `JsonReporter` sums into
 * `summary.durationMs`, and what `JUnitReporter` writes as each `<testcase
 * time=...>`. A clock correction landing inside a run therefore changed numbers
 * we publish as measurements OF THE SERVER — the run would have reported the
 * correction rather than the latency, and nothing in the report says which.
 *
 * Same rule as the billed duration (`spec/profiles/core/heartbeat.md:44` rule 5),
 * for the same reason: an interval is a DIFFERENCE, and a difference of two wall
 * clock readings is only as stable as the clock between them.
 *
 * Real elapsed time here, faked wall clock: the scenario runs a genuine 60ms
 * delay while `Date.now()` is stepped an hour forward underneath it.
 */

const TARGET: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
};

const T0 = new Date('2026-03-29T00:59:40.000Z');
const JUMP_MS = 3_600_000;
const DELAY_MS = 60;

function delayOnlyScenario(): ScenarioDefinition {
  return {
    name: 'clock-step-during-a-measured-step',
    // No broker is involved: nothing connects and nothing is published.
    defer_mqtt_connect: true,
    station: { bayCount: 1, stationModel: 'WashPro X200', stationVendor: 'SimCorp' },
    steps: [{ action: 'delay', ms: DELAY_MS }],
  } as unknown as ScenarioDefinition;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ScenarioRunner — the durations it REPORTS are elapsed time, not clock arithmetic', () => {
  it('a +1h wall-clock step inside a step does not appear in the reported durationMs', async () => {
    // Fake ONLY Date: setTimeout stays real, so the delay step really waits, and
    // performance.now() keeps measuring real elapsed time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);

    // A real timer, firing inside the 60ms step, plants the correction.
    const planted = setTimeout(() => { vi.setSystemTime(Date.now() + JUMP_MS); }, 20);

    const result = await new ScenarioRunner().runScenario(delayOnlyScenario(), TARGET);
    clearTimeout(planted);

    // POSITIVE CONTROL ON THE PLANT: if the step never landed, everything below
    // is green for want of a jump rather than because the fix works.
    expect(Date.now() - T0.getTime()).toBeGreaterThanOrEqual(JUMP_MS);

    expect(result.status).toBe('passed');
    expect(result.steps).toHaveLength(1);
    // The step really took ~60ms. On the wall clock it reported ~3_600_060.
    expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(DELAY_MS - 5);
    expect(result.steps[0].durationMs).toBeLessThan(5_000);
    expect(result.durationMs).toBeLessThan(5_000);
    // WHOLE MILLISECONDS, as the wall-clock version reported. `performance.now()`
    // is sub-millisecond, so an unrounded difference put a fractional tail on
    // every console line and every JUnit `time`. The clock changed; the unit did not.
    expect(Number.isInteger(result.steps[0].durationMs)).toBe(true);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });

  it('INVERSE CONTROL: with no correction, the reported duration still measures the real delay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);

    const result = await new ScenarioRunner().runScenario(delayOnlyScenario(), TARGET);

    expect(Date.now() - T0.getTime()).toBe(0); // nothing planted, and the wall clock is frozen
    expect(result.status).toBe('passed');
    // A frozen wall clock would have reported 0 for a step that genuinely ran
    // 60ms — the same defect from the other side, and the reason a runner that
    // "worked" on the wall clock was only ever working by luck of the clock.
    expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(DELAY_MS - 5);
    expect(result.steps[0].durationMs).toBeLessThan(5_000);
  });
});
