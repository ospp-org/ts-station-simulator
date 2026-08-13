import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScenarioDefinition, TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * `requires_files` — a TRANSPARENT skip for scenarios whose subject is a
 * DELIBERATELY BROKEN certificate (revoked, expired) that cannot be provisioned
 * on demand and that `certs/` being gitignored keeps out of the repo.
 *
 * The behaviour under test is a distinction, not a convenience:
 *
 *   missing INSTRUMENT  -> skipped   (the fixture is not here; nothing was measured)
 *   present instrument, -> failed    (the property regressed; that is a real red)
 *   property regressed
 *
 * Getting that backwards in either direction is the whole risk. Skip-on-regression
 * would hide a broker that stopped enforcing revocation; fail-on-absence is what
 * put a permanently-red line in every pooled run and taught readers to ignore it.
 */

let connectSucceeds = true;

class FakeMqttClient extends EventEmitter {
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => { cb?.(); });
  subscribe = vi.fn((_t: string, _o: object, cb?: (e?: Error) => void) => { cb?.(); });
  publish = vi.fn();
}

vi.mock('mqtt', () => ({
  connect: vi.fn(() => {
    const fc = new FakeMqttClient();
    setImmediate(() => {
      if (connectSucceeds) fc.emit('connect', {});
      else fc.emit('error', new Error('sslv3 alert certificate expired'));
    });
    return fc;
  }),
}));

const { ScenarioRunner, findMissingRequiredFile, findMissingTargetCert } =
  await import('../../scenarios/ScenarioRunner.js');

const target: TargetConfig = {
  mqttUrl: 'mqtts://localhost:8883',
  apiBaseUrl: 'http://localhost:8080',
} as TargetConfig;

function scenario(overrides: Partial<ScenarioDefinition>): ScenarioDefinition {
  return {
    name: 'fixture-gated scenario',
    station: { bayCount: 1, stationModel: 'M', stationVendor: 'V' },
    steps: [],
    ...overrides,
  } as ScenarioDefinition;
}

describe('findMissingRequiredFile', () => {
  let dir: string;
  let present: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sim-reqfiles-'));
    present = path.join(dir, 'leaf.pem');
    writeFileSync(present, 'PEM');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when nothing is required (undefined and empty are both "requires nothing")', () => {
    expect(findMissingRequiredFile(undefined)).toBeNull();
    expect(findMissingRequiredFile([])).toBeNull();
  });

  it('returns null when every required file is present', () => {
    expect(findMissingRequiredFile([present, present])).toBeNull();
  });

  it('returns the FIRST missing path, so the reason names one concrete file', () => {
    const absentA = path.join(dir, 'gone-a.pem');
    const absentB = path.join(dir, 'gone-b.pem');
    expect(findMissingRequiredFile([present, absentA, absentB])).toBe(absentA);
  });
});

/**
 * The target-level gap `requires_files` structurally cannot cover: a fixed path
 * in a target's cert block (live example: local-mtls's `ca:`) is inherited by
 * every scenario aimed at that target and declarable by none of them.
 */
describe('findMissingTargetCert — the dependency no scenario can declare', () => {
  let dir: string;
  let present: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sim-targetcert-'));
    present = path.join(dir, 'broker-ca.pem');
    writeFileSync(present, 'PEM');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('flags a fixed target cert path that is absent', () => {
    expect(findMissingTargetCert({ tls: { serverCa: path.join(dir, 'gone.pem') } }))
      .toBe(path.join(dir, 'gone.pem'));
  });

  it('passes when the fixed paths are present, and when a target declares none', () => {
    expect(findMissingTargetCert({ tls: { serverCa: present } })).toBeNull();
    expect(findMissingTargetCert({})).toBeNull();
  });

  /**
   * The load-bearing exclusion. `certs/uat/{{stationId}}.pem` is written per run
   * by provisioning and is correctly absent beforehand — flagging it would make
   * every defer_mqtt_connect scenario inconclusive on a clean box, which is the
   * false alarm that teaches people to ignore the signal.
   */
  it('IGNORES templated paths — provisioning writes those, so absence proves nothing', () => {
    expect(findMissingTargetCert({
      tls: {
        key: path.join(dir, '{{stationId}}-key.pem'),
        cert: path.join(dir, '{{stationId}}.pem'),
        chain: path.join(dir, '{{stationId}}-chain.pem'),
      },
    })).toBeNull();
  });

  it('still catches a fixed path sitting alongside templated ones', () => {
    expect(findMissingTargetCert({
      tls: { cert: path.join(dir, '{{stationId}}.pem'), serverCa: path.join(dir, 'gone.pem') },
    })).toBe(path.join(dir, 'gone.pem'));
  });
});

describe('requires_files — transparent skip when the fixture is absent', () => {
  let dir: string;
  let present: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sim-reqfiles-run-'));
    present = path.join(dir, 'leaf.pem');
    writeFileSync(present, 'PEM');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { connectSucceeds = true; });

  it('skips (never fails) when a required fixture is missing, naming the file and the hint', async () => {
    const runner = new ScenarioRunner();
    const missing = path.join(dir, 'revoked-leaf.pem');
    const result = await runner.runScenario(
      scenario({
        requires_files: [missing],
        requires_files_hint: 'Run ./scripts/mint-expired-leaf.sh',
        expect_connect_failure: true,
        expect_refusal_reason: 'broker-certificate-expired',
      }),
      target,
    );

    expect(result.status).toBe('skipped');
    expect(result.steps[0]?.error).toContain('revoked-leaf.pem');
    expect(result.steps[0]?.error).toContain('mint-expired-leaf.sh');
  });

  it('does NOT skip when the fixtures are present — the scenario runs and its verdict stands', async () => {
    connectSucceeds = false; // broker refuses with the expiry alert
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({
        requires_files: [present],
        expect_connect_failure: true,
        expect_refusal_reason: 'broker-certificate-expired',
      }),
      target,
    );

    expect(result.status).toBe('passed');
  });

  /**
   * The exit-code half. A skip is honest in the summary but does not move the
   * exit code — only a failure does — so without a KIND on the result, a run
   * whose revocation proof skipped for a missing fixture reports success to CI.
   * `not-applicable` must stay silent (an unimplemented feature will never stop
   * being a legitimate skip); `inconclusive` is what a conclusive run must catch.
   */
  it('tags a missing-fixture skip INCONCLUSIVE — the machine-readable half of the distinction', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ requires_files: [path.join(dir, 'nope.pem')] }),
      target,
    );
    expect(result.status).toBe('skipped');
    expect(result.skipKind).toBe('inconclusive');
  });

  it('tags "does not apply" skips NOT-APPLICABLE, so they never turn a conclusive run red', async () => {
    const runner = new ScenarioRunner();

    const featureGap = await runner.runScenario(
      scenario({ skip: true, skip_reason: 'server feature not implemented' }),
      target,
    );
    expect(featureGap.status).toBe('skipped');
    expect(featureGap.skipKind).toBe('not-applicable');

    // `skip: true` wins over a requires_files on the same file — the ordering
    // boot-pending-retry relies on: while the feature is missing nothing about
    // the system is in question, and the fixture question is moot.
    const both = await runner.runScenario(
      scenario({
        skip: true,
        skip_reason: 'server feature not implemented',
        requires_files: [path.join(dir, 'nope.pem')],
      }),
      target,
    );
    expect(both.skipKind).toBe('not-applicable');
  });

  it('a PRESENT fixture that is no longer refused FAILS — absence is a skip, regression is a red', async () => {
    connectSucceeds = true; // the broker accepted a cert it was supposed to refuse
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({
        requires_files: [present],
        expect_connect_failure: true,
        expect_refusal_reason: 'broker-certificate-expired',
      }),
      target,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/connect\(\) succeeded/);
  });
});
