import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CONS-133 wiring half — the chain must reach the wire, not just exist on disk.
 *
 * `targets.yaml` already declares `certs.station_ca_chain` and provisioning
 * already writes `<stationId>-chain.pem`, but the scenario connect path built
 * its TLS options from `key`/`cert`/`server_ca` only, so the chain path never
 * reached MqttConnection. Fixing presentation in MqttConnection alone would
 * leave it inert on every real scenario run.
 *
 * These assert on what crosses into mqtt.connect(), not on intermediate state.
 */

const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

class FakeMqttClient extends EventEmitter {
  stream?: { getProtocol?: () => string | null };
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => {
    cb?.();
  });
  subscribe = vi.fn((_topic: string, _opts: object, cb?: (err?: Error) => void) => {
    cb?.();
  });
  publish = vi.fn();
}

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    connectCalls.push({ url, opts });
    // Station.connect() awaits the 'connect' event, then subscribes.
    setImmediate(() => fc.emit('connect', {}));
    return fc;
  }),
}));

const { _createStationFromScenarioForTesting, generateVariables } = await import(
  '../../scenarios/ScenarioRunner.js'
);
type TargetConfig = import('../../scenarios/ScenarioRunner.js').TargetConfig;
type ScenarioDefinition = import('../../scenarios/ScenarioRunner.js').ScenarioDefinition;

const LEAF = `-----BEGIN CERTIFICATE-----\nTHREADLEAF\n-----END CERTIFICATE-----\n`;
const INTERMEDIATE = `-----BEGIN CERTIFICATE-----\nTHREADCA\n-----END CERTIFICATE-----\n`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-thread-'));
const STATION_ID = 'stn_deadbeef';

fs.writeFileSync(path.join(tmpRoot, `${STATION_ID}-key.pem`), '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n');
fs.writeFileSync(path.join(tmpRoot, `${STATION_ID}.pem`), LEAF);
fs.writeFileSync(path.join(tmpRoot, `${STATION_ID}-chain.pem`), INTERMEDIATE);

const tpl = (suffix: string) => path.join(tmpRoot, `{{stationId}}${suffix}`);

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function scenarioDef(): ScenarioDefinition {
  return {
    name: 'chain threading',
    station: { stationVendor: 'SimVendor', stationModel: 'SimModel', bayCount: 1 },
    steps: [],
  } as unknown as ScenarioDefinition;
}

async function connectWith(target: TargetConfig, def = scenarioDef()) {
  const variables = generateVariables(def, target, null, undefined);
  variables.set('stationId', STATION_ID);
  const station = _createStationFromScenarioForTesting(def, variables, target);
  await station.connect();
  return station;
}

function blockCount(pem: string): number {
  return pem.split('-----BEGIN CERTIFICATE-----').length - 1;
}

describe('scenario connect path — threads the station CA chain through to TLS (CONS-133)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('resolves {{stationId}} in the target chain template and presents leaf + intermediate', async () => {
    const station = await connectWith({
      mqttUrl: 'mqtts://x',
      tls: { key: tpl('-key.pem'), cert: tpl('.pem'), chain: tpl('-chain.pem') },
    } as TargetConfig);

    expect(connectCalls).toHaveLength(1);
    const presented = String(connectCalls[0].opts.cert);
    expect(presented).toContain('THREADLEAF');
    expect(presented).toContain('THREADCA');
    expect(blockCount(presented)).toBe(2);

    await station.disconnect();
  });

  it('UNCHANGED: a target declaring no chain still presents the leaf alone', async () => {
    const station = await connectWith({
      mqttUrl: 'mqtts://x',
      tls: { key: tpl('-key.pem'), cert: tpl('.pem') },
    } as TargetConfig);

    const presented = String(connectCalls[0].opts.cert);
    expect(presented).toContain('THREADLEAF');
    expect(blockCount(presented)).toBe(1);

    await station.disconnect();
  });

  it('a scenario that strips the client cert (no_client_cert) strips the chain too', async () => {
    const def = scenarioDef();
    (def as unknown as { tls: { no_client_cert: boolean } }).tls = { no_client_cert: true };

    const station = await connectWith(
      {
        mqttUrl: 'mqtts://x',
        tls: { key: tpl('-key.pem'), cert: tpl('.pem'), chain: tpl('-chain.pem') },
      } as TargetConfig,
      def,
    );

    expect(connectCalls[0].opts.cert).toBeUndefined();
    expect(connectCalls[0].opts.key).toBeUndefined();

    await station.disconnect();
  });
});
