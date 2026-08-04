import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * CONS-133, the mid-scenario provisioning path.
 *
 * `defer_mqtt_connect: true` + `provision` + `connect_mqtt` is the shape the
 * adjudication's own RED-first assertion describes: serve a provisioning
 * response, then connect with what it handed you. ConnectMqttStep derived
 * key / cert / broker-ca from `certs_dir` by convention but never the chain,
 * so this path presented the leaf alone even after the connection learned how
 * to present a chain. ProvisionStep writes `<stationId>-chain.pem` into that
 * same directory — same convention, one line away.
 */

const connectCalls: Array<{ opts: Record<string, unknown> }> = [];

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
  connect: vi.fn((_url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    connectCalls.push({ opts });
    setImmediate(() => fc.emit('connect', {}));
    return fc;
  }),
}));

const { ConnectMqttStep } = await import('../../../scenarios/steps/ConnectMqttStep.js');
const { createContext } = await import('../../../scenarios/ScenarioContext.js');
const { Station } = await import('../../../station/Station.js');

const LEAF = `-----BEGIN CERTIFICATE-----\nSTEPLEAF\n-----END CERTIFICATE-----\n`;
const INTERMEDIATE = `-----BEGIN CERTIFICATE-----\nSTEPCA\n-----END CERTIFICATE-----\n`;

const STATION_ID = 'stn_step0001';
const certsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-step-'));

fs.writeFileSync(path.join(certsDir, `${STATION_ID}-key.pem`), '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n');
fs.writeFileSync(path.join(certsDir, `${STATION_ID}.pem`), LEAF);
// ProvisionStep's format: leaf + stationCaChain.
fs.writeFileSync(path.join(certsDir, `${STATION_ID}-chain.pem`), LEAF + INTERMEDIATE);

afterAll(() => {
  fs.rmSync(certsDir, { recursive: true, force: true });
});

function makeStation() {
  return new Station(
    {
      stationId: STATION_ID,
      firmwareVersion: '1.0.0',
      stationModel: 'SimModel',
      stationVendor: 'SimVendor',
      serialNumber: 'SIM-1',
      bayCount: 1,
      timezone: 'UTC',
      bays: [{ bayId: 'bay_1', bayNumber: 1, services: [] }],
    } as unknown as ConstructorParameters<typeof Station>[0],
    { mqttUrl: 'mqtts://x', stationId: STATION_ID },
  );
}

function contextWithCertsDir(dir: string) {
  const ctx = createContext();
  ctx.variables.set('stationId', STATION_ID);
  ctx.captured.set('certs_dir', dir);
  return ctx;
}

function blockCount(pem: string): number {
  return pem.split('-----BEGIN CERTIFICATE-----').length - 1;
}

describe('ConnectMqttStep — presents the provisioned chain, not the leaf alone (CONS-133)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('derives <stationId>-chain.pem from certs_dir and presents leaf + intermediate', async () => {
    const station = makeStation();
    await new ConnectMqttStep().execute({ action: 'connect_mqtt' }, contextWithCertsDir(certsDir), station);

    expect(connectCalls).toHaveLength(1);
    const presented = String(connectCalls[0].opts.cert);
    expect(presented).toContain('STEPLEAF');
    expect(presented).toContain('STEPCA');
    expect(blockCount(presented)).toBe(2);

    await station.disconnect();
  });

  it('accepts an explicit chain_path override, mirroring key_path/cert_path', async () => {
    const alt = path.join(certsDir, 'explicit-chain.pem');
    fs.writeFileSync(alt, INTERMEDIATE);

    const station = makeStation();
    await new ConnectMqttStep().execute(
      { action: 'connect_mqtt', chain_path: alt },
      contextWithCertsDir(certsDir),
      station,
    );

    const presented = String(connectCalls[0].opts.cert);
    expect(presented).toContain('STEPLEAF');
    expect(presented).toContain('STEPCA');
    expect(blockCount(presented)).toBe(2);

    await station.disconnect();
  });

  it('stays leaf-only when no chain file exists — the chain is optional, not required', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-step-bare-'));
    fs.writeFileSync(path.join(bare, `${STATION_ID}-key.pem`), '-----BEGIN PRIVATE KEY-----\nK\n-----END PRIVATE KEY-----\n');
    fs.writeFileSync(path.join(bare, `${STATION_ID}.pem`), LEAF);

    const station = makeStation();
    await new ConnectMqttStep().execute({ action: 'connect_mqtt' }, contextWithCertsDir(bare), station);

    const presented = String(connectCalls[0].opts.cert);
    expect(blockCount(presented)).toBe(1);

    await station.disconnect();
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
