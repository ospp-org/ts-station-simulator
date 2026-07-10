import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScenarioDefinition, TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * C3 TLS-1.2-floor arc: conformance scenarios S3 (TLS 1.1 pinned — below the
 * broker floor) and S4 (no client cert — mTLS enforcement) need the
 * automatic pre-steps `station.connect()` (see ScenarioRunner's
 * defer_mqtt_connect doc) to be REJECTED — and for that rejection to be the
 * scenario's PASS condition, not an ordinary failure.
 *
 * `station.connect()`'s rejection depends on the real mqtt.js client
 * actually emitting an 'error' event; some TLS handshake failures surface
 * as a socket reset instead (which MqttConnection deliberately swallows —
 * see IGNORED_CODES), so the runner treats a bounded timeout with no
 * connect/error as an equally valid "did not connect" outcome. This suite
 * exercises all three shapes: explicit error, unexpected success, and hang.
 */

type ConnectBehavior = 'success' | 'error' | 'hang';
let behavior: ConnectBehavior = 'success';

const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

class FakeMqttClient extends EventEmitter {
  end = vi.fn((_force: boolean, _opts: object, cb?: () => void) => {
    cb?.();
  });
  // MqttConnection.subscribe() wraps mqtt.js's callback-style client.subscribe()
  // in a Promise — the callback (3rd arg) MUST be invoked or that Promise (and
  // therefore Station.connect(), which awaits it right after the connack) hangs
  // forever. Unlike a MqttConnection-level stub (see Station.connect.test.ts),
  // this fake sits UNDER a real MqttConnection, so it must speak the real
  // mqtt.js client shape.
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
      const err = Object.assign(new Error('unsupported protocol'), {
        code: 'ERR_SSL_UNSUPPORTED_PROTOCOL',
      });
      setImmediate(() => fc.emit('error', err));
    }
    // 'hang' — never emits 'connect' nor 'error'; exercises the timeout path.
    return fc;
  }),
}));

const { ScenarioRunner } = await import('../../scenarios/ScenarioRunner.js');

const target: TargetConfig = {
  mqttUrl: 'mqtts://x',
  apiBaseUrl: 'http://x',
} as TargetConfig;

function scenario(overrides: Partial<ScenarioDefinition>): ScenarioDefinition {
  return {
    name: 'TLS floor test scenario',
    station: { bayCount: 1, stationModel: 'M', stationVendor: 'V' },
    steps: [],
    ...overrides,
  } as ScenarioDefinition;
}

describe('ScenarioRunner — expect_connect_failure (C3 TLS-1.2-floor arc, S3/S4 shape)', () => {
  beforeEach(() => {
    behavior = 'success';
    connectCalls.length = 0;
  });

  it('reports FAILED when the connect unexpectedly SUCCEEDS (broker accepted what should have been rejected)', async () => {
    behavior = 'success';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ expect_connect_failure: true }),
      target,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/reject/i);
  });

  it('reports PASSED when the connect errors (e.g. TLS version below the broker floor)', async () => {
    behavior = 'error';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ expect_connect_failure: true }),
      target,
    );
    expect(result.status).toBe('passed');
  });

  it('reports PASSED when the connect just hangs within the timeout (treated as rejection)', async () => {
    behavior = 'hang';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ expect_connect_failure: true, expect_connect_failure_timeout_ms: 50 }),
      target,
    );
    expect(result.status).toBe('passed');
  }, 2000);

  it('layers scenario-level tls.min_version/max_version onto the connect options (S1 shape)', async () => {
    behavior = 'success';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ tls: { min_version: 'TLSv1.2', max_version: 'TLSv1.2' } }),
      target,
    );
    expect(result.status).toBe('passed');
    expect(connectCalls[0]?.opts.minVersion).toBe('TLSv1.2');
    expect(connectCalls[0]?.opts.maxVersion).toBe('TLSv1.2');
  });

  it('tls.no_client_cert strips key/cert from the resolved tls before connect() (S4 shape)', async () => {
    behavior = 'success';
    const runner = new ScenarioRunner();
    const targetWithCerts: TargetConfig = {
      mqttUrl: 'mqtts://x',
      tls: {
        key: 'certs/uat/{{stationId}}-key.pem',
        cert: 'certs/uat/{{stationId}}.pem',
      },
    } as TargetConfig;
    const result = await runner.runScenario(
      scenario({ tls: { no_client_cert: true } }),
      targetWithCerts,
    );
    expect(result.status).toBe('passed');
    expect(connectCalls[0]?.opts.key).toBeUndefined();
    expect(connectCalls[0]?.opts.cert).toBeUndefined();
  });
});
