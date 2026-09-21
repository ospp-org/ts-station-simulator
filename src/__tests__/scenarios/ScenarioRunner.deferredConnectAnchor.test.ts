import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScenarioDefinition, TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * A DEFERRED CONNECT HAD NO BROKER ANCHOR, AND THE AUTOMATIC ONE ON THE SAME TARGET DID.
 *
 * `createStationFromScenario` resolves `target.tls` — key, cert, chain, serverCa, the TLS
 * floor and ceiling — and hands the whole object to the Station, so a scenario that lets the
 * runner connect for it verifies the broker against `certs.ca` from `config/targets.yaml`.
 *
 * `ConnectMqttStep` then built a FRESH tls object from `certs_dir` alone and passed it to
 * `station.setTls()`, which REPLACES rather than merges (`MqttConnection.ts:395-401`). So a
 * scenario that connects later in its run threw the target's anchor away, and over
 * `local-mtls` — whose broker presents `CN=emqx` issued by a private `OneStopPay MQTT CA`,
 * alone, measured chain depth 1 — the handshake failed with "unable to verify the first
 * certificate". That is the failure `docs/RUNNING-AGAINST-LOCAL.md` recorded against the
 * three self-provisioning `e2e/*` files and left "not diagnosed further".
 *
 * THE PROVISIONED ANCHOR DOES NOT COVER IT. `ProvisionStep` writes
 * `<stationId>-broker-ca.pem` only when the provisioning response carries `brokerRootCa`
 * (`ProvisionStep.ts:268-269`), and csms-server emits that field only in `private_ca` mode
 * (`CertificateManager::loadBrokerRootCa()` returns null for any other mode). Measured on the
 * running local stack on 2026-09-21: `ospp.deployment.broker_ca_mode` is `public_ca`, so the
 * file is never written and the derived path never exists.
 *
 * Two halves, because the fix has two:
 *   * the WIRING — `runScenario` must put the resolved tls on the context, or a step has
 *     nothing to read. Asserted end to end, on what crosses into mqtt.connect().
 *   * the PRECEDENCE — with `certs_dir` captured, which of the three rungs the step takes.
 *     Asserted on the step, because seeding `certs_dir` end to end would need a server to
 *     provision against.
 */

const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

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
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    connectCalls.push({ url, opts });
    setImmediate(() => fc.emit('connect', {}));
    return fc;
  }),
}));

const { ScenarioRunner } = await import('../../scenarios/ScenarioRunner.js');
const { ConnectMqttStep } = await import('../../scenarios/steps/ConnectMqttStep.js');
const { createContext } = await import('../../scenarios/ScenarioContext.js');
const { Station } = await import('../../station/Station.js');

const STATION_ID = 'stn_anchor01';

const LEAF = '-----BEGIN CERTIFICATE-----\nANCHORLEAF\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nANCHORKEY\n-----END PRIVATE KEY-----\n';
const TARGET_ANCHOR = '-----BEGIN CERTIFICATE-----\nTARGETANCHOR\n-----END CERTIFICATE-----\n';
const PROVISIONED_ANCHOR =
  '-----BEGIN CERTIFICATE-----\nPROVISIONEDANCHOR\n-----END CERTIFICATE-----\n';
const STEP_ANCHOR = '-----BEGIN CERTIFICATE-----\nSTEPANCHOR\n-----END CERTIFICATE-----\n';

/**
 * The directory a `provision` step captures into `certs_dir`. It holds the key and the leaf
 * and — like every local provisioning under `public_ca` — NO broker-ca. This is the exact
 * on-disk state the local stack produces.
 */
const certsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-anchor-certs-'));
fs.writeFileSync(path.join(certsDir, `${STATION_ID}-key.pem`), KEY);
fs.writeFileSync(path.join(certsDir, `${STATION_ID}.pem`), LEAF);

/** The target's own fixture bundle — `local-mtls`'s `certs.ca` stands in for this. */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-anchor-fixture-'));
const targetAnchorPath = path.join(fixtureDir, 'broker-ca.pem');
fs.writeFileSync(targetAnchorPath, TARGET_ANCHOR);
const stepAnchorPath = path.join(fixtureDir, 'step-named-ca.pem');
fs.writeFileSync(stepAnchorPath, STEP_ANCHOR);

afterAll(() => {
  fs.rmSync(certsDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** A target shaped like `local-mtls`: mTLS over mqtts, with a private broker anchor. */
function targetWithAnchor(): TargetConfig {
  return {
    mqttUrl: 'mqtts://x',
    tls: {
      key: path.join(certsDir, '{{stationId}}-key.pem'),
      cert: path.join(certsDir, '{{stationId}}.pem'),
      serverCa: targetAnchorPath,
    },
  } as TargetConfig;
}

/** The same target with no `certs.ca` — a public-CA broker, where the system store is right. */
function targetWithoutAnchor(): TargetConfig {
  return {
    mqttUrl: 'mqtts://x',
    tls: {
      key: path.join(certsDir, '{{stationId}}-key.pem'),
      cert: path.join(certsDir, '{{stationId}}.pem'),
    },
  } as TargetConfig;
}

/**
 * Defer the automatic connect, then connect from a step — the shape all five `connect_mqtt`
 * files in the corpus have. `key_path`/`cert_path` are named because `certs_dir` is captured
 * by a `provision` step and there is no server to provision against here; the precedence
 * block below covers the captured-`certs_dir` form.
 */
function deferredConnectScenario(extra: Record<string, unknown> = {}): ScenarioDefinition {
  return {
    name: 'deferred connect anchor',
    station: { stationId: STATION_ID, bayCount: 1 },
    defer_mqtt_connect: true,
    steps: [
      {
        action: 'connect_mqtt',
        key_path: path.join(certsDir, `${STATION_ID}-key.pem`),
        cert_path: path.join(certsDir, `${STATION_ID}.pem`),
        ...extra,
      },
    ],
  } as unknown as ScenarioDefinition;
}

describe('the deferred connect reaches the target\'s broker anchor (runner wiring)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('CONTROL — the automatic connect on this target already verifies against it', async () => {
    const scenario = {
      name: 'automatic connect anchor',
      station: { stationId: STATION_ID, bayCount: 1 },
      steps: [{ action: 'delay', ms: 1 }],
    } as unknown as ScenarioDefinition;

    const result = await new ScenarioRunner().runScenario(scenario, targetWithAnchor());

    expect(result.status).toBe('passed');
    expect(connectCalls).toHaveLength(1);
    expect(String(connectCalls[0]?.opts.ca)).toContain('TARGETANCHOR');
  });

  it('a step-driven connect gets the same anchor, with no per-step path', async () => {
    const result = await new ScenarioRunner().runScenario(
      deferredConnectScenario(),
      targetWithAnchor(),
    );

    expect(result.status).toBe('passed');
    expect(connectCalls).toHaveLength(1);
    expect(String(connectCalls[0]?.opts.ca)).toContain('TARGETANCHOR');
  });

  it('an explicit broker_ca_path still wins over the target', async () => {
    const result = await new ScenarioRunner().runScenario(
      deferredConnectScenario({ broker_ca_path: stepAnchorPath }),
      targetWithAnchor(),
    );

    expect(result.status).toBe('passed');
    expect(String(connectCalls[0]?.opts.ca)).toContain('STEPANCHOR');
  });

  it('NEGATIVE CONTROL — a target declaring no anchor still falls through to the system store', async () => {
    const result = await new ScenarioRunner().runScenario(
      deferredConnectScenario(),
      targetWithoutAnchor(),
    );

    expect(result.status).toBe('passed');
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]?.opts.ca).toBeUndefined();
  });

  it('the TLS floor and ceiling travel with it — setTls replaced those too', async () => {
    const target = targetWithAnchor();
    (target.tls as Record<string, unknown>).minVersion = 'TLSv1.2';
    (target.tls as Record<string, unknown>).maxVersion = 'TLSv1.2';

    const result = await new ScenarioRunner().runScenario(deferredConnectScenario(), target);

    expect(result.status).toBe('passed');
    expect(connectCalls[0]?.opts.minVersion).toBe('TLSv1.2');
    expect(connectCalls[0]?.opts.maxVersion).toBe('TLSv1.2');
  });
});

describe('ConnectMqttStep — which of the three anchors a captured certs_dir takes', () => {
  beforeEach(() => {
    connectCalls.length = 0;
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
        bays: [
          {
            bayId: 'bay_1',
            bayNumber: 1,
            programs: [{ programNumber: 1, label: 'P1', available: true }],
            services: [],
          },
        ],
      } as unknown as ConstructorParameters<typeof Station>[0],
      { mqttUrl: 'mqtts://x', stationId: STATION_ID },
    );
  }

  function contextWith(dir: string, serverCa?: string) {
    const ctx = createContext();
    ctx.variables.set('stationId', STATION_ID);
    ctx.captured.set('certs_dir', dir);
    ctx.connectTls = serverCa ? { serverCa } : undefined;
    return ctx;
  }

  it('falls through to the target when provisioning wrote no broker-ca (the local public_ca case)', async () => {
    const station = makeStation();
    await new ConnectMqttStep().execute(
      { action: 'connect_mqtt' },
      contextWith(certsDir, targetAnchorPath),
      station,
    );

    expect(String(connectCalls[0]?.opts.ca)).toContain('TARGETANCHOR');
    await station.disconnect();
  });

  it('prefers the provisioned anchor — it is what the server told THIS station to trust', async () => {
    const provisioned = fs.mkdtempSync(path.join(os.tmpdir(), 'ospp-anchor-priv-'));
    fs.writeFileSync(path.join(provisioned, `${STATION_ID}-key.pem`), KEY);
    fs.writeFileSync(path.join(provisioned, `${STATION_ID}.pem`), LEAF);
    fs.writeFileSync(path.join(provisioned, `${STATION_ID}-broker-ca.pem`), PROVISIONED_ANCHOR);

    const station = makeStation();
    await new ConnectMqttStep().execute(
      { action: 'connect_mqtt' },
      contextWith(provisioned, targetAnchorPath),
      station,
    );

    expect(String(connectCalls[0]?.opts.ca)).toContain('PROVISIONEDANCHOR');
    expect(String(connectCalls[0]?.opts.ca)).not.toContain('TARGETANCHOR');

    await station.disconnect();
    fs.rmSync(provisioned, { recursive: true, force: true });
  });

  it('UNCHANGED — no provisioned anchor and no target anchor is still the system store', async () => {
    const station = makeStation();
    await new ConnectMqttStep().execute(
      { action: 'connect_mqtt' },
      contextWith(certsDir),
      station,
    );

    expect(connectCalls[0]?.opts.ca).toBeUndefined();
    await station.disconnect();
  });
});
