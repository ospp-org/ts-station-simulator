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

const { ScenarioRunner, findMissingRequiredFile } = await import('../../scenarios/ScenarioRunner.js');

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
