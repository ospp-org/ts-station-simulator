import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { ScenarioDefinition, TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * `attest_device` is a step the runner knows: an unknown action fails its step with "Unknown step
 * action". What it captures, and that the attestation is captured as an object, is
 * AttestDeviceStep.test.ts's.
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

describe('ScenarioRunner — attest_device', () => {
  it('runs the step', async () => {
    const result = await new ScenarioRunner().runScenario(
      {
        name: 'attest',
        station: { stationId: 'stn_test0001', bayCount: 1 },
        steps: [
          {
            action: 'attest_device',
            challenge: randomBytes(32).toString('base64'),
            root: 'untrusted',
            capture: { att: 'deviceKeyAttestation' },
          },
        ],
      } as unknown as ScenarioDefinition,
      target,
    );

    const attest = result.steps.find((s) => s.action === 'attest_device');
    expect(attest?.status, attest?.error).toBe('passed');
  });
});
