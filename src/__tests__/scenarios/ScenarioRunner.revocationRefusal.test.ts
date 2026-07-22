import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScenarioDefinition, TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * ADR-0005 §7 — the two sim pieces the revocation proof needs:
 *   (a) feed a SPECIFIC (e.g. revoked) client cert into the connect attempt;
 *   (b) CLASSIFY the refusal reason, so "refused" can be attributed to the
 *       broker's CRL check and NOT a client-side TLS-version refusal
 *       (invariant 6). A boolean "did it fail" is not enough.
 *
 * The mqtt.js client is mocked (as in ScenarioRunner.expectConnectFailure),
 * with a CONFIGURABLE error message so we can drive the classifier through the
 * revoked / client-version / handshake shapes.
 */

type ConnectBehavior = 'success' | 'error' | 'hang';
let behavior: ConnectBehavior = 'success';
let errorMessage = 'unsupported protocol';

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
    connectCalls.push({ url, opts });
    const fc = new FakeMqttClient();
    if (behavior === 'success') {
      setImmediate(() => fc.emit('connect', {}));
    } else if (behavior === 'error') {
      setImmediate(() => fc.emit('error', new Error(errorMessage)));
    }
    // 'hang' — never settles; exercises the timeout path.
    return fc;
  }),
}));

const { ScenarioRunner, classifyRefusalReason } = await import('../../scenarios/ScenarioRunner.js');

const target: TargetConfig = {
  mqttUrl: 'mqtts://x',
  apiBaseUrl: 'http://x',
} as TargetConfig;

function scenario(overrides: Partial<ScenarioDefinition>): ScenarioDefinition {
  return {
    name: 'revocation refusal scenario',
    station: { bayCount: 1, stationModel: 'M', stationVendor: 'V' },
    steps: [],
    ...overrides,
  } as ScenarioDefinition;
}

// -- Piece (b): the refusal-reason classifier -------------------------------

describe('classifyRefusalReason (ADR-0005 §7, invariant 6)', () => {
  it('attributes a broker CRL alert (certificate_revoked / alert 44) to broker-certificate-revoked', () => {
    for (const msg of [
      'Client network socket disconnected before secure TLS connection: sslv3 alert certificate revoked',
      'tlsv13 alert certificate revoked',
      'write EPROTO ... alert number 44',
    ]) {
      const c = classifyRefusalReason(msg);
      expect(c.reason).toBe('broker-certificate-revoked');
      expect(c.layer).toBe('broker');
    }
  });

  it('attributes a below-floor TLS-version refusal to the client layer, NOT the broker', () => {
    for (const msg of ['no protocols available', 'unsupported protocol', 'wrong version number']) {
      const c = classifyRefusalReason(msg);
      expect(c.reason).toBe('client-tls-version');
      expect(c.layer).toBe('client');
    }
  });

  it('attributes other broker cert refusals (handshake failure, unknown ca) to broker-bad-certificate', () => {
    expect(classifyRefusalReason('sslv3 alert handshake failure').reason).toBe('broker-bad-certificate');
    expect(classifyRefusalReason('tlsv1 alert unknown ca').reason).toBe('broker-bad-certificate');
  });

  it('classifies the runner bounded-hang message as a timeout, not a broker refusal', () => {
    expect(
      classifyRefusalReason('no connect/error event within 50ms (treated as rejection)').reason,
    ).toBe('timeout');
  });
});

// -- Piece (a): arbitrary cert override -------------------------------------

describe('ScenarioRunner — scenario-level tls.cert/tls.key override (ADR-0005 §7a)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sim-revcert-'));
    writeFileSync(path.join(dir, 'revoked.pem'), 'REVOKED-CERT-BYTES');
    writeFileSync(path.join(dir, 'revoked-key.pem'), 'REVOKED-KEY-BYTES');
    mkdirSync(path.join(dir, 'certs'), { recursive: true });
    writeFileSync(path.join(dir, 'certs', 'stn_fixed01.pem'), 'CERT-FOR-FIXED01');
    writeFileSync(path.join(dir, 'certs', 'stn_fixed01-key.pem'), 'KEY-FOR-FIXED01');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => {
    behavior = 'success';
    connectCalls.length = 0;
  });

  it('feeds a specific cert/key into the connect options (mirrors no_client_cert, but presents instead of drops)', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({
        tls: {
          cert: path.join(dir, 'revoked.pem'),
          key: path.join(dir, 'revoked-key.pem'),
        },
      }),
      target,
    );

    expect(result.status).toBe('passed');
    expect(String(connectCalls[0]?.opts.cert)).toBe('REVOKED-CERT-BYTES');
    expect(String(connectCalls[0]?.opts.key)).toBe('REVOKED-KEY-BYTES');
  });

  it('substitutes {{stationId}} in the scenario cert/key override', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({
        station: { stationId: 'stn_fixed01', bayCount: 1, stationModel: 'M', stationVendor: 'V' },
        tls: {
          cert: path.join(dir, 'certs', '{{stationId}}.pem'),
          key: path.join(dir, 'certs', '{{stationId}}-key.pem'),
        },
      }),
      target,
    );

    expect(result.status).toBe('passed');
    expect(String(connectCalls[0]?.opts.cert)).toBe('CERT-FOR-FIXED01');
  });
});

// -- Pieces (a)+(b) together: the reason-gated proof shape ------------------

describe('ScenarioRunner — expect_refusal_reason gating (ADR-0005 §7, invariant 6)', () => {
  beforeEach(() => {
    behavior = 'error';
    connectCalls.length = 0;
  });

  it('PASSES when the refusal reason matches (broker CRL check refused the revoked cert)', async () => {
    errorMessage = 'sslv3 alert certificate revoked';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({
        expect_connect_failure: true,
        expect_refusal_reason: 'broker-certificate-revoked',
      }),
      target,
    );
    expect(result.status).toBe('passed');
  });

  it('FAILS when the connection is refused for the WRONG reason (a client-side TLS-version refusal cannot satisfy a broker-CRL proof)', async () => {
    errorMessage = 'no protocols available';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({
        expect_connect_failure: true,
        expect_refusal_reason: 'broker-certificate-revoked',
      }),
      target,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/client-tls-version/);
    expect(result.error).toMatch(/expected 'broker-certificate-revoked'/);
  });

  it('without expect_refusal_reason, any refusal still passes (backward compatible with S3/S4)', async () => {
    errorMessage = 'no protocols available';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ expect_connect_failure: true }),
      target,
    );
    expect(result.status).toBe('passed');
  });
});
