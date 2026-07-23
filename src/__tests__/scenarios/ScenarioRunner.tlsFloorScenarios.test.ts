import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/**
 * Integration-level proof that the ACTUAL committed S1-S4 conformance YAML
 * files (scenarios/tls-floor/) — not just synthetic ScenarioDefinition
 * objects — parse and wire correctly through the real loadScenario() /
 * createStationFromScenario() / runScenario() pipeline. This is a
 * regression guard: if someone edits those YAML files later and breaks the
 * tls/expect_connect_failure shape, this fails without needing a live
 * broker.
 *
 * S1/S2 are asserted at the unit level (build the Station + run just the
 * first `assert` step) rather than through the full `runScenario()` step
 * loop — the remaining boot/session steps need a real (or much more
 * elaborate fake) OSPP responder and are exactly the part deferred to a
 * live broker. S3/S4 have zero steps by design (see their YAML doc) so
 * `runScenario()` runs them to completion directly.
 */

type ConnectBehavior = 'success' | 'error';
let behavior: ConnectBehavior = 'success';
// Configurable so a test can drive classifyRefusalReason through different TLS-
// alert shapes (S5's certificate_revoked vs S3/S4's version/handshake refusal).
let errorMessage = 'unsupported protocol';

const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
const fakeClients: FakeMqttClient[] = [];

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
    connectCalls.push({ url, opts });
    const fc = new FakeMqttClient();
    fakeClients.push(fc);
    if (behavior === 'success') {
      setImmediate(() => fc.emit('connect', {}));
    } else {
      setImmediate(() => fc.emit('error', new Error(errorMessage)));
    }
    return fc;
  }),
}));

const {
  ScenarioRunner,
  _createStationFromScenarioForTesting,
  generateVariables,
} = await import('../../scenarios/ScenarioRunner.js');
const { AssertStep } = await import('../../scenarios/steps/AssertStep.js');
const { createContext } = await import('../../scenarios/ScenarioContext.js');
import type { TargetConfig } from '../../scenarios/ScenarioRunner.js';

const scenarioPath = (name: string) =>
  path.resolve(process.cwd(), 'scenarios', 'tls-floor', name);

describe('TLS floor S1-S4 — the actual committed scenario files (integration)', () => {
  beforeEach(() => {
    behavior = 'success';
    errorMessage = 'unsupported protocol';
    connectCalls.length = 0;
    fakeClients.length = 0;
  });

  it('S1 pins minVersion=maxVersion=TLSv1.2 and its first assert passes when negotiated as 1.2', async () => {
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s1-pinned-tls12-a7608e.yaml'));
    expect(def.tls).toEqual({ min_version: 'TLSv1.2', max_version: 'TLSv1.2' });
    expect(def.steps[0]).toMatchObject({ action: 'assert', field: 'connection.tlsProtocol', equals: 'TLSv1.2' });

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const variables = generateVariables(def, target, null, undefined);
    const station = _createStationFromScenarioForTesting(def, variables, target);
    await station.connect();

    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].opts.minVersion).toBe('TLSv1.2');
    expect(connectCalls[0].opts.maxVersion).toBe('TLSv1.2');

    // Simulate the broker actually negotiating 1.2 (matches the pin).
    fakeClients[0].stream = { getProtocol: () => 'TLSv1.2' };
    await expect(
      new AssertStep().execute(def.steps[0], createContext(), station),
    ).resolves.toBeUndefined();

    await station.disconnect();
  });

  it('S2 applies no tls override (default 1.3 floor, no ceiling) and its first assert passes when negotiated as 1.3', async () => {
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s2-default-negotiates-tls13.yaml'));
    expect(def.tls).toBeUndefined();
    expect(def.steps[0]).toMatchObject({ action: 'assert', field: 'connection.tlsProtocol', equals: 'TLSv1.3' });

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const variables = generateVariables(def, target, null, undefined);
    const station = _createStationFromScenarioForTesting(def, variables, target);
    await station.connect();

    // DEFAULT unchanged: no tls block on the target at all here, so
    // MqttConnection never even enters its tlsConfig branch.
    expect(connectCalls[0].opts.minVersion).toBeUndefined();
    expect(connectCalls[0].opts.maxVersion).toBeUndefined();

    fakeClients[0].stream = { getProtocol: () => 'TLSv1.3' };
    await expect(
      new AssertStep().execute(def.steps[0], createContext(), station),
    ).resolves.toBeUndefined();

    await station.disconnect();
  });

  it('S3 pins minVersion=maxVersion=TLSv1.1, expect_connect_failure, reports PASSED on a broker rejection', async () => {
    behavior = 'error';
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s3-rejects-tls11-below-floor.yaml'));
    expect(def.expect_connect_failure).toBe(true);
    expect(def.steps).toHaveLength(0);

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('passed');
    expect(connectCalls[0]?.opts.minVersion).toBe('TLSv1.1');
    expect(connectCalls[0]?.opts.maxVersion).toBe('TLSv1.1');
  });

  it('S4 strips key/cert via no_client_cert, expect_connect_failure, reports PASSED on a broker rejection', async () => {
    behavior = 'error';
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s4-rejects-missing-client-cert.yaml'));
    expect(def.expect_connect_failure).toBe(true);
    expect(def.tls).toEqual({ no_client_cert: true });
    expect(def.steps).toHaveLength(0);

    // Target WOULD supply a client cert — proving no_client_cert actively strips it.
    const target: TargetConfig = {
      mqttUrl: 'mqtts://x',
      tls: { key: 'certs/uat/{{stationId}}-key.pem', cert: 'certs/uat/{{stationId}}.pem' },
    } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('passed');
    expect(connectCalls[0]?.opts.key).toBeUndefined();
    expect(connectCalls[0]?.opts.cert).toBeUndefined();
  });

  it('S5b (positive control) pins TLS 1.2 and its assert passes when a valid cert negotiates 1.2 under enable_crl_check', async () => {
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s5b-accepts-valid-cert-crl-on.yaml'));
    expect(def.tls).toEqual({ min_version: 'TLSv1.2', max_version: 'TLSv1.2' });
    expect(def.steps[0]).toMatchObject({ action: 'assert', field: 'connection.tlsProtocol', equals: 'TLSv1.2' });

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const variables = generateVariables(def, target, null, undefined);
    const station = _createStationFromScenarioForTesting(def, variables, target);
    await station.connect();

    expect(connectCalls[0].opts.minVersion).toBe('TLSv1.2');
    expect(connectCalls[0].opts.maxVersion).toBe('TLSv1.2');

    // Broker negotiated 1.2 and accepted the (valid) leaf under enable_crl_check.
    fakeClients[0].stream = { getProtocol: () => 'TLSv1.2' };
    await expect(
      new AssertStep().execute(def.steps[0], createContext(), station),
    ).resolves.toBeUndefined();

    await station.disconnect();
  });

  it('S5 pins TLS 1.2, expect_refusal_reason=broker-certificate-revoked, reports PASSED on a CRL revocation alert', async () => {
    behavior = 'error';
    // The in-handshake TLS alert 44 shape mqtt.js/OpenSSL surfaces under 1.2.
    errorMessage =
      'Client network socket disconnected before secure TLS connection: tlsv1 alert certificate revoked';
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s5-rejects-revoked-cert.yaml'));
    expect(def.expect_connect_failure).toBe(true);
    expect(def.expect_refusal_reason).toBe('broker-certificate-revoked');
    expect(def.tls).toEqual({ min_version: 'TLSv1.2', max_version: 'TLSv1.2' });
    expect(def.steps).toHaveLength(0);

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('passed');
  });

  it('S5 reports FAILED when the revoked-cert scenario is refused for a NON-CRL reason (invariant-6 guard on the real file)', async () => {
    behavior = 'error';
    errorMessage = 'no protocols available'; // client-side TLS-version refusal
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s5-rejects-revoked-cert.yaml'));

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/expected 'broker-certificate-revoked'/);
  });
});
