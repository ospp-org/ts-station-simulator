import { describe, it, expect } from 'vitest';
import { ScenarioRunner, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';
import { StationPool } from '../../scenarios/stations/StationPool.js';

/**
 * skip_when_pooled — a TRANSPARENT, conditional skip for scenarios that are incompatible
 * with `--all --bootstrap-pool` but run fine standalone:
 *   - e2e/* self-provision their own org+station (409 "Station already exists" vs the pool);
 *   - the cross-station regression needs manual `--var stationA_bayId / stationB_serviceId`.
 *
 * Skipped scenarios report status 'skipped' (NOT 'passed') so the suite total is honest:
 * passed + failed + skipped = N. A green that silently drops scenarios is exactly the
 * misleading-green to avoid.
 */
const target: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
} as TargetConfig;

function scenario(overrides: Partial<ScenarioDefinition>): ScenarioDefinition {
  return {
    name: 'Test Scenario',
    station: { bayCount: 1, stationModel: 'M', stationVendor: 'V' },
    steps: [],
    ...overrides,
  } as ScenarioDefinition;
}

describe('skip_when_pooled — transparent conditional skip under --bootstrap-pool', () => {
  it('skips a pool-incompatible scenario in a bootstrap-pool run (status "skipped", reason recorded)', async () => {
    const runner = new ScenarioRunner();
    runner.setRunPool(new StationPool()); // simulates --bootstrap-pool being active
    const result = await runner.runScenario(
      scenario({ skip_when_pooled: 'self-provisions; collides with the bootstrap pool' }),
      target,
    );
    expect(result.status).toBe('skipped');
    expect(result.steps[0]?.error).toContain('self-provisions');
  });

  it('does NOT skip a skip_when_pooled scenario in a NON-pooled run (it runs normally)', async () => {
    const runner = new ScenarioRunner();
    // No setRunPool() → not a pooled run. defer_mqtt_connect + empty steps so it runs to
    // completion without real infra and is NOT early-skipped.
    const result = await runner.runScenario(
      scenario({ skip_when_pooled: 'x', defer_mqtt_connect: true, steps: [] }),
      target,
    );
    expect(result.status).not.toBe('skipped');
  });

  it('existing unconditional skip:true now reports status "skipped" (transparent), not "passed"', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ skip: true, skip_reason: 'manual-only scenario' }),
      target,
    );
    expect(result.status).toBe('skipped');
    expect(result.steps[0]?.error).toContain('manual-only');
  });
});
