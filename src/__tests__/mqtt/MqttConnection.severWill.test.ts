import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/**
 * The teardown that leaves the broker's Last Will armed — and the arithmetic
 * that makes it necessary ON A PERSISTENT SESSION.
 *
 * THIS HEADER USED TO SAY "BOTH DOORS WERE SHUT", AND THAT WAS MEASURED FALSE.
 * The old text: every liveness scenario that wanted a ConnectionLost used
 * `fault: disconnect` and none of them could, because `willDelayInterval: 10`
 * against `LIVE_RECONNECT_PERIOD_MS = 5000` brings the session back inside the
 * delay and MQTT 5 §3.1.3.2.2 requires the broker to discard the will. The
 * subtraction is right; the conclusion was not. §3.1.3.2.2 suppresses the will
 * only for a new Network Connection to THIS Session. Scenarios default to
 * `clean_session: true` (ScenarioRunner.ts:820), where Clean Start 1 DISCARDS the
 * old session instead of resuming it — and the same clause publishes the will
 * when the session ends OR the delay elapses, whichever is first. Ending it is
 * what the reconnect does. So under the corpus default `fault: disconnect`
 * PUBLISHES the will at ~5s. Measured on UAT 2026-08-14;
 * core/reconnect-recovery.yaml's middle read now depends on it.
 *
 * The claim survives with its qualifier restored: on `clean_session: false` the
 * reconnect really is "to this Session", the suppression really does apply, and
 * `sever` really is the only teardown that fires the will. That is one file —
 * core/connection-lost-lwt.yaml — and the last test below pins it there, because
 * the inequality alone does not.
 *
 * The other exit, disconnect(), sends a clean DISCONNECT, and §3.14.4 discards
 * the will on those unconditionally. That door genuinely is shut.
 *
 * These tests pin the DISCRIMINATION between the two faults (forced end vs bare
 * stream destroy), the numeric relationship that is the reason there are two, and
 * the scenario-side session setting without which the relationship is inert.
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
   * IT IS ONLY HALF THE TRIPWIRE, WHICH IS WHY THE NEXT TEST EXISTS. This
   * inequality is inert unless the session persists. What keeps
   * connection-lost-lwt.yaml's falsification arm discriminating is the
   * `clean_session: false` line in that file — delete it and `disconnect` starts
   * publishing the will, the arm stops inverting, and this assertion goes on
   * passing throughout. The two operands are pinned together below.
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

  /**
   * THE SECOND OPERAND, READ OFF THE COMMITTED FILE.
   *
   * The inequality above only suppresses a will for a reconnect to THIS session,
   * so `clean_session: false` is what makes `sever` and `disconnect` separate
   * outcomes at all. Under the runner default (`true`, ScenarioRunner.ts:820)
   * both faults publish the will and the swap-one-word falsification stops
   * inverting — silently, because the scenario would still pass.
   *
   * Read from the real file rather than restated, for the same reason the TLS
   * floor tests load theirs: a constant copied into a test proves the copy.
   *
   * The `sever` step is pinned beside it because the arm needs both halves — a
   * file that kept `clean_session: false` but had been edited to
   * `fault: disconnect` has no falsification left either. Existence, not
   * position: the step's index is not this test's business.
   */
  it('connection-lost-lwt.yaml pins clean_session false and fault sever — the arm rests on these, not on the delay', async () => {
    const { ScenarioRunner } = await import('../../scenarios/ScenarioRunner.js');
    const runner = new ScenarioRunner();
    const def = await runner.loadScenario(
      path.resolve(process.cwd(), 'scenarios', 'core', 'connection-lost-lwt.yaml'),
    );

    expect(def.clean_session).toBe(false);
    expect(def.steps).toContainEqual(expect.objectContaining({ action: 'fault', type: 'sever' }));
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
