import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * The teardown that leaves the broker's Last Will armed — and the arithmetic
 * that makes it necessary.
 *
 * Every liveness scenario in the corpus that wanted to observe a ConnectionLost
 * used `fault: disconnect`, and none of them could. The reason is not a race and
 * not broker flakiness, it is subtraction: the will carries
 * `willDelayInterval: 10` and the live client carries
 * `LIVE_RECONNECT_PERIOD_MS = 5000`, so destroyConnection() brings the same
 * session back at t+5s — inside the delay — and MQTT 5 §3.1.3.2.2 requires the
 * broker to discard the will. The other exit, disconnect(), sends a clean
 * DISCONNECT, and §3.14.4 discards the will on those too. Both doors were shut.
 *
 * These tests pin the DISCRIMINATION between the two faults (forced end vs bare
 * stream destroy) and the numeric relationship that is the reason there are two.
 * They are the sim-side prerequisite for a scenario that asserts a broker-driven
 * offline transition.
 */

interface EndCall {
  force: boolean;
  opts: Record<string, unknown> | undefined;
}

class FakeMqttClient extends EventEmitter {
  endCalls: EndCall[] = [];
  end = vi.fn((force?: boolean, opts?: object, cb?: () => void) => {
    this.endCalls.push({ force: force === true, opts: opts as Record<string, unknown> | undefined });
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
  stream = { destroy: vi.fn() };
}

const fakeClients: FakeMqttClient[] = [];
const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    fakeClients.push(fc);
    connectCalls.push({ url, opts });
    return fc;
  }),
}));

const { MqttConnection, LIVE_RECONNECT_PERIOD_MS } = await import('../../mqtt/MqttConnection.js');

/** Unique stationId per test — RECONNECT_GUARD_MS state is module-level + keyed by it. */
let seq = 0;
const nextStationId = (): string => `stn_will${(seq += 1)}`;

beforeEach(() => {
  fakeClients.length = 0;
  connectCalls.length = 0;
});

describe('MqttConnection — severConnection() is the teardown that keeps the will armed', () => {
  it('force-ends the client: the forced path destroys the stream and sends NO DISCONNECT packet', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    conn.severConnection();

    // mqtt.js `_cleanUp(forced)`: force === true takes the `stream.destroy()`
    // branch; force === false builds and sends a `{cmd: 'disconnect'}` packet.
    // A DISCONNECT is precisely what makes the broker discard the will, so the
    // flag is the whole assertion.
    expect(fakeClients[0].endCalls).toHaveLength(1);
    expect(fakeClients[0].endCalls[0].force).toBe(true);
  });

  it('passes no sessionExpiryInterval override — the session must OUTLIVE the socket', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    conn.severConnection();

    // disconnect() deliberately sends `sessionExpiryInterval: 0` to flush broker
    // state. Doing that here would END the session at close — and MQTT 5 publishes
    // the will when the session ends OR the delay elapses, WHICHEVER IS EARLIER.
    // A zero expiry would therefore fire the will instantly, turning a test of the
    // broker's delayed-will behaviour into a test of session teardown.
    expect(fakeClients[0].endCalls[0].opts).toBeUndefined();
    expect(connectCalls[0].opts.properties).toMatchObject({ sessionExpiryInterval: 3600 });
  });

  it('attributes the cause as `severed`, and the close event does not overwrite it', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();
    const client = fakeClients[0];

    conn.severConnection();
    // The real client emits 'close' after a forced end; the handler's
    // `=== 'none'` guard must leave an already-attributed cause alone.
    client.emit('close');

    expect(conn.getSeverance().lastCloseCause).toBe('severed');
    expect(conn.getSeverance().kicked).toBe(false);
  });

  it('is idempotent and leaves disconnect() a no-op — nothing tries to close an ended client', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    conn.severConnection();
    conn.severConnection();
    // The runner's `finally` calls this on every scenario, severed or not.
    await conn.disconnect();

    expect(fakeClients[0].endCalls).toHaveLength(1);
    expect(conn.getSeverance().lastCloseCause).toBe('severed');
  });
});

describe('MqttConnection — destroyConnection() is the OPPOSITE outcome, not a milder one', () => {
  it('destroys the stream and never ends the client, so reconnectPeriod still fires', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    conn.destroyConnection();

    expect(fakeClients[0].stream.destroy).toHaveBeenCalledTimes(1);
    // Not ended => mqtt.js `disconnecting` stays false => it comes back at
    // LIVE_RECONNECT_PERIOD_MS, which is what cancels the will.
    expect(fakeClients[0].endCalls).toHaveLength(0);
    expect(conn.getSeverance().lastCloseCause).toBe('network');
  });

  it('the two faults are distinguishable by cause — a scenario can tell which one it asked for', () => {
    const a = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    a.connect();
    a.destroyConnection();

    const b = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    b.connect();
    b.severConnection();

    expect(a.getSeverance().lastCloseCause).toBe('network');
    expect(b.getSeverance().lastCloseCause).toBe('severed');
  });
});

describe('MqttConnection — the will delay must outlast the reconnect period', () => {
  /**
   * THE TRIPWIRE. This is the arithmetic that makes `sever` a separate fault
   * rather than a synonym for `disconnect`, and both operands live in this file
   * where either could be changed without anyone connecting them.
   *
   * If willDelayInterval ever drops at or below the reconnect period, then ON A
   * PERSISTENT SESSION the auto-reconnect stops landing inside the delay window,
   * 3.1.3.2.2 no longer suppresses the will, and the falsification arm of
   * core/connection-lost-lwt.yaml (swap `sever` for `disconnect`, watch it go
   * red) quietly stops discriminating — the test would still pass while having
   * stopped proving anything.
   *
   * SCOPED TO THE PERSISTENT SESSION ON PURPOSE. An earlier version of this
   * comment claimed the inequality kept the drop "invisible" for every scenario.
   * It does not. Scenarios default to `clean_session: true`
   * (ScenarioRunner.ts:820); Clean Start 1 ENDS the old session at the reconnect
   * and 3.1.3.2.2 publishes the will on session end regardless of the delay. So
   * under the default `fault: disconnect` already produces a ConnectionLost —
   * measured on UAT 2026-08-14, and core/reconnect-recovery.yaml's middle read
   * now depends on it.
   *
   * WHICH MEANS THIS TRIPWIRE DOES NOT GUARD THE THING IT PROTECTS. What keeps
   * connection-lost-lwt.yaml's falsification arm discriminating is the
   * `clean_session: false` line in that file, not this inequality. Delete that
   * line and this test still passes while the arm goes dead. No assertion pins
   * it yet.
   */
  it('willDelayInterval is strictly greater than LIVE_RECONNECT_PERIOD_MS', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    const will = connectCalls[0].opts.will as {
      properties: { willDelayInterval: number };
    };
    const willDelayMs = will.properties.willDelayInterval * 1000;

    expect(willDelayMs).toBeGreaterThan(LIVE_RECONNECT_PERIOD_MS);
  });

  it('the armed will is still a ConnectionLost after a sever — severing does not rewrite it', () => {
    const stationId = nextStationId();
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId });
    conn.connect();
    conn.severConnection();

    // The will is fixed at CONNECT time; this is what the broker holds and will
    // publish on the station's behalf once the delay elapses.
    const will = connectCalls[0].opts.will as { payload: string; qos: number; retain: boolean };
    const envelope = JSON.parse(will.payload) as Record<string, unknown>;

    expect(envelope.action).toBe('ConnectionLost');
    expect(envelope.messageType).toBe('Event');
    expect(envelope.messageId).toBe(`lwt-${stationId}`);
    expect(will.qos).toBe(1);
    expect(will.retain).toBe(false);
  });
});
