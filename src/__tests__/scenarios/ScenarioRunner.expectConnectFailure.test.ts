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

type ConnectBehavior = 'success' | 'error' | 'hang' | 'success-no-puback';
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
  // Models mqtt.js honestly on BOTH sides of the connected/offline split, because
  // the whole defect lives in that split:
  //
  //   connected  -> the callback fires, the publish resolves. (`connected` is set
  //                 by the 'connect' emit below, the same flag mqtt.js exposes.)
  //   offline    -> the message is BUFFERED and the callback waits for a connection
  //                 that is not coming. The promise never settles.
  //
  // A fake that always called back would hide the defect; one that never called
  // back would hang the honest cases and prove nothing about either.
  connected = false;
  publish = vi.fn(
    (topic: string, _payload: string | Buffer, _opts: object, cb?: (err?: Error) => void) => {
      publishedTopics.push(String(topic));
      if (this.connected) cb?.();
    },
  );
}

const publishedTopics: string[] = [];
function publishedFrames(): string[] {
  return publishedTopics;
}

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    connectCalls.push({ url, opts });
    const fc = new FakeMqttClient();
    if (behavior === 'success' || behavior === 'success-no-puback') {
      setImmediate(() => {
        // 'success-no-puback' connects but never acknowledges a QoS-1 publish —
        // a broker that accepts the session and then goes quiet. `connected`
        // stays false so the fake's publish callback never fires, while the
        // CONNECT itself succeeds.
        fc.connected = behavior === 'success';
        fc.emit('connect', {});
      });
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
    publishedTopics.length = 0;
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

  /*
   * THE FOUR THAT GAVE UP. On UAT 2026-09-08 the S3/S4/S5/S5b scenarios each
   * recorded `connect rejected as expected` with the right refusal reason — the
   * assertion PASSED — and were then reported FAILED at exactly 90000ms by the
   * runner's own budget, with its own words: "This is the RUNNER giving up, not
   * an assertion failing."
   *
   * The cause is in the TEARDOWN, not the assertion. `expect_connect_failure`
   * returns `passed` immediately, but the `finally` still calls
   * `station.disconnect({ announceDeparture })`, and for a POOL-leased station
   * that argument is true. announcePlannedShutdown() then publishes
   * ConnectionLost — over a connection that was never established. mqtt.js keeps
   * the client object after a failed handshake and BUFFERS a QoS-1 publish while
   * offline, so its callback never fires, MqttConnection.publish()'s promise never
   * settles, and the teardown hangs until the budget kills the scenario.
   *
   * The existing cases above cannot see it: none of them leases a pool station, so
   * `releaseWithWill` is false and the announce never runs. This one leases one,
   * which is the only difference.
   *
   * THE RED LANDS ON THE VERDICT, not on the duration — a scenario that proved
   * what it tests must be reported `passed`.
   */
  it('a POOL-leased scenario that proved its refusal is reported PASSED, not abandoned in teardown', async () => {
    behavior = 'error';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ expect_connect_failure: true }),
      { ...target, stationPool: ['stn_tlsfloor1'] } as TargetConfig,
    );

    expect(result.status).toBe('passed');
  }, 5000);

  it('the pooled refusal still publishes NOTHING — there was never a connection to announce on', async () => {
    // The control on the fix: it must work by not attempting the publish, not by
    // swallowing a publish that hangs. A station that never came online has nothing
    // to say and no channel to say it on, so the wire must stay empty.
    behavior = 'error';
    const runner = new ScenarioRunner();
    await runner.runScenario(
      scenario({ expect_connect_failure: true }),
      { ...target, stationPool: ['stn_tlsfloor2'] } as TargetConfig,
    );

    const published = publishedFrames();
    expect(published).toEqual([]);
  }, 5000);

  /*
   * THE CONTROLS ON THE GUARD. A mechanism that ends a scenario early is one
   * mutation away from ending every scenario early, so both directions are pinned
   * on the SAME pooled path the fix touches.
   */
  it('CONTROL — a pooled scenario that genuinely fails still FAILS', async () => {
    // Planted failure, in the shape the guard could plausibly mask: the connect
    // SUCCEEDS where the file demanded a refusal. If the teardown guard ever turns
    // this green, the fix has destroyed the thing the suite is for.
    behavior = 'success';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ expect_connect_failure: true }),
      { ...target, stationPool: ['stn_tlsfloor3'] } as TargetConfig,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/reject/i);
  }, 5000);

  it('CONTROL — the publish recorder is live, so "published nothing" is not vacuous', async () => {
    // The anti-vacuity control for the assertion above it. A pooled station that
    // DOES come online announces its departure on teardown, so the recorder must
    // see traffic here. Without this, `toEqual([])` would pass just as well against
    // a recorder that was never wired to anything.
    behavior = 'success';
    const runner = new ScenarioRunner();
    await runner.runScenario(
      scenario({}),
      { ...target, stationPool: ['stn_tlsfloor4'] } as TargetConfig,
    );

    expect(publishedFrames().length).toBeGreaterThan(0);
  }, 5000);

  it('a broker that accepts the session and never PUBACKs does not block the teardown', async () => {
    // connection-lost.md §4.3 rule 3, in its own words: the station SHOULD wait for
    // the QoS 1 PUBACK, and "if the PUBACK does not arrive within a bounded time the
    // station MAY disconnect anyway — the heartbeat timeout of §4.2 remains the
    // backstop, and a shutdown MUST NOT be blocked by an unreachable server."
    //
    // The lifecycle guard above does not cover this: here the station DID come
    // online, so the announcement is correct to attempt. What must be bounded is
    // the WAIT. Without it a silent broker hangs every pooled teardown, which is
    // the same 90 s shape arriving through a different door.
    behavior = 'success-no-puback';
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({}),
      { ...target, stationPool: ['stn_tlsfloor5'] } as TargetConfig,
    );

    // The verdict is the scenario's own, reached and returned — not a budget kill.
    expect(result.status).toBe('passed');
    // And it did TRY: the frame reached the client, it was simply never acknowledged.
    expect(publishedFrames().length).toBeGreaterThan(0);
  }, 8000);

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
