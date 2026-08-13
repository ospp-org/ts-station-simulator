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

/**
 * Drop the on-disk fixture dependency from a loaded definition so the BEHAVIOUR
 * assertions below run identically on a developer box and in CI.
 *
 * S5 names a specific revoked leaf (`certs/uat/stn_985c8a8b.*`). That is the
 * point of the file and it is asserted as contract at the call sites. But
 * `certs/` is gitignored in full, so those bytes exist only where they were
 * provisioned: keeping them would make this test assert "the machine happens to
 * have a July-2026 UAT artifact", and it would fail in CI for a reason that has
 * nothing to do with the scenario's shape. Both dropped fields are covered by
 * dedicated tests — the cert/key/chain wiring in ScenarioRunner.revocationRefusal
 * .test.ts (against temp files), the skip gate in ScenarioRunner.requiresFiles
 * .test.ts — so nothing here goes unproven, it only stops being proven twice in
 * the one place that cannot do it portably.
 */
function stripFixtureDependency<T extends { tls?: Record<string, unknown>; requires_files?: string[] }>(
  def: T,
): T {
  const { cert: _cert, key: _key, chain: _chain, ...tlsRest } = def.tls ?? {};
  return { ...def, tls: tlsRest, requires_files: undefined };
}

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
    // The stub's default 'unsupported protocol' is exactly what C4 measured
    // live against UAT, and it classifies as this reason.
    expect(def.expect_refusal_reason).toBe('client-tls-version');
    expect(def.steps).toHaveLength(0);

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('passed');
    expect(connectCalls[0]?.opts.minVersion).toBe('TLSv1.1');
    expect(connectCalls[0]?.opts.maxVersion).toBe('TLSv1.1');
  });

  it('S4 strips key/cert via no_client_cert and reports PASSED on a broker CERTIFICATE rejection', async () => {
    behavior = 'error';
    // S4 now pins expect_refusal_reason: broker-bad-certificate, so the stub has
    // to emit the alert a broker actually raises when mTLS is enforced and the
    // peer presented nothing. The default 'unsupported protocol' is S3's
    // client-side version refusal and classifies as `client-tls-version` — it
    // would (correctly) FAIL S4 now, which is the whole point of the pin.
    errorMessage = 'peer did not return a certificate';
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s4-rejects-missing-client-cert.yaml'));
    expect(def.expect_connect_failure).toBe(true);
    expect(def.expect_refusal_reason).toBe('broker-bad-certificate');
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

  it('S4 reports FAILED when the refusal is a bounded TIMEOUT — a hang is not proof of mTLS enforcement', async () => {
    behavior = 'error';
    // No connect and no error would classify `timeout`; drive the same outcome
    // through the classifier with a detail it maps there. Before
    // expect_refusal_reason was pinned, this reported PASSED — which is what
    // made S4 a security control whose pass condition was "anything failed".
    errorMessage = 'no connect/error event within 50ms (treated as rejection)';
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s4-rejects-missing-client-cert.yaml'));
    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('failed');
  });

  it('S4 reports FAILED when the refusal is a client-side TLS-VERSION error — wrong layer, wrong proof', async () => {
    behavior = 'error';
    errorMessage = 'unsupported protocol';
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s4-rejects-missing-client-cert.yaml'));
    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(def, target);

    expect(result.status).toBe('failed');
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
    expect(def.steps).toHaveLength(0);
    // The file NAMES the revoked leaf rather than inheriting the target's cert
    // pattern — that is the whole repair, so it is asserted as contract.
    expect(def.tls).toEqual({
      min_version: 'TLSv1.2',
      max_version: 'TLSv1.2',
      cert: 'certs/uat/stn_985c8a8b.pem',
      key: 'certs/uat/stn_985c8a8b-key.pem',
      chain: 'certs/uat/stn_985c8a8b-chain.pem',
    });
    expect(def.requires_files).toEqual([
      'certs/uat/stn_985c8a8b.pem',
      'certs/uat/stn_985c8a8b-key.pem',
      'certs/uat/stn_985c8a8b-chain.pem',
    ]);

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(stripFixtureDependency(def), target);

    expect(result.status).toBe('passed');
  });

  it('S5 reports FAILED when the revoked-cert scenario is refused for a NON-CRL reason (invariant-6 guard on the real file)', async () => {
    behavior = 'error';
    errorMessage = 'no protocols available'; // client-side TLS-version refusal
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s5-rejects-revoked-cert.yaml'));

    const target: TargetConfig = { mqttUrl: 'mqtts://x' } as TargetConfig;
    const result = await runner.runScenario(stripFixtureDependency(def), target);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/expected 'broker-certificate-revoked'/);
  });

  /**
   * S6/S6b are asserted at the SHAPE level only. Their behaviour needs the local
   * dev Station CA to have signed a fixture pair, which no CI checkout has (and
   * `certs/` is gitignored, so none ever will) — running them here would prove
   * the machine lacked a file, not that the YAML is right. The refusal-reason
   * gate they rely on is proven directly in ScenarioRunner.revocationRefusal
   * .test.ts, and the fixture gate in ScenarioRunner.requiresFiles.test.ts; what
   * is left, and what this guards, is that the committed files keep declaring
   * the right instruments.
   */
  it('S6 declares the expiry proof: pinned TLS 1.2, the expired leaf, and the EXPIRED refusal reason (not the generic bucket)', async () => {
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(scenarioPath('s6-rejects-expired-cert.yaml'));

    expect(def.expect_connect_failure).toBe(true);
    expect(def.expect_refusal_reason).toBe('broker-certificate-expired');
    expect(def.steps).toHaveLength(0);
    expect(def.tls).toMatchObject({
      min_version: 'TLSv1.2',
      max_version: 'TLSv1.2',
      cert: 'certs/local/stn_e0000001.pem',
    });
    // Local-CA fixture: a pooled (UAT) run would refuse it for an untrusted
    // chain, i.e. for a reason that is not this file's subject.
    expect(def.skip_when_pooled).toBeTruthy();
    expect(def.requires_files).toContain('certs/local/stn_e0000001.pem');
  });

  /**
   * S7/S7b are the PORTABLE revocation proof — same claim as S5, no UAT, no
   * privileged account, no committed key material. Shape-level only, for the
   * same reason as S6: the fixtures are minted by a script into a gitignored
   * directory and the verifier is a container pair, so running them here would
   * measure whether this machine had done `up`.
   */
  it('S7 declares the portable revocation proof, and does NOT replace S5', async () => {
    const runner = new ScenarioRunner();
    const s5 = await runner.loadScenario(scenarioPath('s5-rejects-revoked-cert.yaml'));
    const s7 = await runner.loadScenario(scenarioPath('s7-rejects-revoked-cert-local.yaml'));

    // Same claim, same instrument...
    expect(s7.expect_connect_failure).toBe(true);
    expect(s7.expect_refusal_reason).toBe('broker-certificate-revoked');
    expect(s7.expect_refusal_reason).toBe(s5.expect_refusal_reason);
    expect(s7.steps).toHaveLength(0);
    // ...different authority, so the two are complementary rather than one
    // superseding the other. S5 still exists and still names the UAT leaf.
    expect(s7.tls?.cert).toContain('certs/local-crl/');
    expect(s5.tls?.cert).toContain('certs/uat/');
    expect(s7.requires_files).toContain('certs/local-crl/stn_r0000001.pem');
    expect(s7.skip_when_pooled).toBeTruthy();
  });

  it('S7b is the one-variable control: same pinned version, and the leaf is what differs', async () => {
    const runner = new ScenarioRunner();
    const s7 = await runner.loadScenario(scenarioPath('s7-rejects-revoked-cert-local.yaml'));
    const s7b = await runner.loadScenario(scenarioPath('s7b-accepts-nonrevoked-cert-local.yaml'));

    expect(s7b.tls?.min_version).toBe(s7.tls?.min_version);
    expect(s7b.tls?.max_version).toBe(s7.tls?.max_version);
    expect(s7b.tls?.cert).not.toBe(s7.tls?.cert);

    // The control must ACCEPT — without it, a fail-closed verifier that cannot
    // fetch the CRL refuses everything and satisfies S7 while enforcing nothing.
    expect(s7b.expect_connect_failure).toBeFalsy();
    expect(s7b.steps[0]).toMatchObject({
      action: 'assert',
      field: 'connection.tlsProtocol',
      equals: 'TLSv1.2',
    });
  });

  it('S6b is the one-variable control: SAME pinned version, DIFFERENT leaf, and it asserts a completed handshake', async () => {
    const runner = new ScenarioRunner();
    const s6 = await runner.loadScenario(scenarioPath('s6-rejects-expired-cert.yaml'));
    const s6b = await runner.loadScenario(scenarioPath('s6b-accepts-unexpired-cert.yaml'));

    // TLS version held constant between proof and control — otherwise the
    // version, not the validity, could explain the difference in outcome.
    expect(s6b.tls?.min_version).toBe(s6.tls?.min_version);
    expect(s6b.tls?.max_version).toBe(s6.tls?.max_version);
    // ...and the leaf is the thing that differs.
    expect(s6b.tls?.cert).not.toBe(s6.tls?.cert);

    expect(s6b.expect_connect_failure).toBeFalsy();
    expect(s6b.steps[0]).toMatchObject({
      action: 'assert',
      field: 'connection.tlsProtocol',
      equals: 'TLSv1.2',
    });
  });
});
