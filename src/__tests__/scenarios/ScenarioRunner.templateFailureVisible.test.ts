import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScenarioDefinition, TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * A scenario that fails INVISIBLY is worse than one that fails wrongly: the second
 * is a wrong answer, the first is no answer at all.
 *
 * Template substitution runs per step and throws on an unresolved `{{var}}` or
 * `{{captured.x}}`. It used to run OUTSIDE the step loop's result recording, so
 * nothing was pushed to `steps` — the console printed a bare red scenario name with
 * no step and no message, and the only way to find the cause was to read the YAML.
 * Two files failed exactly that way on the UAT run: `single-session-drive` (missing
 * a `--var reason` its own header documents as REQUIRED) and
 * `session-rejected-invalid-service-cross-station` (missing two).
 *
 * These pin that the failure is attributed to the step that could not be built, and
 * that the message names the variable.
 */
class FakeMqttClient extends EventEmitter {
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => {
    cb?.();
  });
  subscribe = vi.fn((_topic: string, _opts: object, cb?: (err?: Error) => void) => {
    cb?.();
  });
  publish = vi.fn();
}

vi.mock('mqtt', () => ({
  connect: vi.fn(() => {
    const fc = new FakeMqttClient();
    setImmediate(() => fc.emit('connect', {}));
    return fc;
  }),
}));

const { ScenarioRunner } = await import('../../scenarios/ScenarioRunner.js');

const target: TargetConfig = { mqttUrl: 'mqtt://x' } as TargetConfig;

function scenario(steps: ScenarioDefinition['steps']): ScenarioDefinition {
  return {
    name: 'template failure',
    station: { stationId: 'stn_test0001', bayCount: 1 },
    steps,
  } as ScenarioDefinition;
}

describe('ScenarioRunner — an unresolved template names its step and its variable', () => {
  it('records a FAILED step for the step that could not be built', async () => {
    const result = await new ScenarioRunner().runScenario(
      scenario([
        { action: 'delay', ms: 1 },
        { action: 'send', message: 'Heartbeat', payload: { x: '{{nope}}' } },
      ] as ScenarioDefinition['steps']),
      target,
    );

    expect(result.status).toBe('failed');
    // The step that failed is identified — not an empty steps array.
    const failed = result.steps.filter(s => s.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stepIndex).toBe(1);
    expect(failed[0]?.action).toBe('send');
    expect(failed[0]?.error).toMatch(/template substitution failed/);
    expect(failed[0]?.error).toMatch(/nope/);
  });

  it('keeps the steps that already passed, so the failure has context', async () => {
    const result = await new ScenarioRunner().runScenario(
      scenario([
        { action: 'delay', ms: 1 },
        { action: 'delay', ms: 1 },
        { action: 'send', message: 'Heartbeat', payload: { x: '{{missing}}' } },
      ] as ScenarioDefinition['steps']),
      target,
    );

    expect(result.steps.filter(s => s.status === 'passed')).toHaveLength(2);
    expect(result.steps.at(-1)?.stepIndex).toBe(2);
  });

  it('surfaces the cause on the scenario result too, for reporters that read it', async () => {
    const result = await new ScenarioRunner().runScenario(
      scenario([
        { action: 'send', message: 'Heartbeat', payload: { x: '{{captured.never}}' } },
      ] as ScenarioDefinition['steps']),
      target,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/never/);
  });
});
