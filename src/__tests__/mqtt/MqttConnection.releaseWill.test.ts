import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * THE RELEASE GAP — the third exit, and the one MQTT reason code that closes it.
 *
 * A pool station at release does neither of the two things a real station does.
 * A real one that stops either loses its socket (the broker publishes the will)
 * or says nothing and lets its keepalive expire. The runner's teardown does a
 * THIRD thing: a clean DISCONNECT, which §3.14.4 makes the broker DISCARD the
 * will, while stopHeartbeat() removes the only thing that was keeping the row
 * alive. The server is told nothing either way, so `stations.is_online` stays
 * true over a socket that is gone — until CheckStationHeartbeatsCommand deduces
 * it at ceil(30 x 3.5) = 105s and writes `heartbeat_timeout`, a cause that is
 * false about a station which departed cleanly, at a time that belongs to
 * whichever scenario has since leased the id. Measured on UAT 2026-09-07: four
 * such rows in one run, each `station_booted` immediately followed by
 * `station_offline / no heartbeat`, one of them landing after the run had
 * finished with the station.
 *
 * THE FIX IS A FIELD ADDED AND A FIELD REMOVED, AND THE REMOVAL WAS MEASURED,
 * NOT DERIVED. The first version of this file asserted the opposite and was
 * falsified on the wire. The reasoning was: §3.14.4 discards the will on reason
 * code 0x00, so send 0x04; and §3.1.3.2.2 delays the will by the Will Delay
 * Interval OR until the Session ends, whichever is FIRST, so the
 * `sessionExpiryInterval: 0` disconnect() already sent would end the session and
 * fire the will EARLIER. Both halves needed, only one of them new.
 *
 * Six DISCONNECT shapes, one UAT station, EMQX 5.8, 2026-09-07, each scored by
 * whether a `broker_will` row appeared in `station_journal`:
 *
 *   forced close, no DISCONNECT (`fault: sever`)      -> will at +10s  [control]
 *   sessionExpiryInterval 0             (the old code) -> NO WILL
 *   reasonCode 4 + sessionExpiryInterval 0             -> NO WILL
 *   reasonCode 4 + sessionExpiryInterval 0, delay 0    -> NO WILL
 *   reasonCode 4                                       -> will at +10s
 *   reasonCode 4, willDelayInterval 0                  -> will IMMEDIATELY
 *
 * The expiry override SUPPRESSES the will on this broker, whatever the reason
 * code says. EMQX logs `unclean_terminate` / `exception: error` from inside
 * `emqx_channel:maybe_publish_will_msg/2`, where `is_durable_session/1` meets a
 * session that the zero expiry has already torn down. Nothing is published.
 *
 * So the release path sends the reason code INSTEAD of the expiry override, and
 * arms `willDelayInterval: 0` at CONNECT. The zero delay is not a nicety: at the
 * armed default of 10s the marking lands about seven seconds INTO the next
 * scenario's lease of the same id — the cross-scenario marking this change
 * exists to remove, only faster.
 *
 * WHY NOT severConnection(). It keeps the will armed, but by NOT sending a
 * DISCONNECT at all — so the session lives its full 3600s expiry and the will
 * waits out the whole Will Delay Interval. That is the right shape for
 * simulating lost power and the wrong one for a release: 10s x ~136 releases,
 * and broker session state left behind on every pool id.
 *
 * WHY NOT a station-published ConnectionLost. Measured in csms-server: it would
 * work — the will topic is byte-identical to the station's own to-server topic
 * (TopicResolver.php:92), ConnectionLost is 1 of only 3 message types exempt
 * from signing, `envelope.source` is never read for any decision, and the
 * action is dedup-exempt. Nothing distinguishes a broker-published will from a
 * station publishing one about itself. That is a server-side hole, not a
 * transport this simulator should be built on: the message's own schema calls
 * it "published by the broker", the envelope schema requires source `Server`,
 * and a corpus whose every teardown depended on that hole would break the day
 * the server closes it. Here the BROKER publishes the will, because the broker
 * is the one that was asked to.
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

const {
  MqttConnection,
  DISCONNECT_WITH_WILL_REASON_CODE,
  DEFAULT_WILL_DELAY_INTERVAL_SECONDS,
  LIVE_RECONNECT_PERIOD_MS,
} = await import('../../mqtt/MqttConnection.js');

/** Unique stationId per test — RECONNECT_GUARD_MS state is module-level + keyed by it. */
let seq = 0;
const nextStationId = (): string => `stn_rel${(seq += 1)}`;

beforeEach(() => {
  fakeClients.length = 0;
  connectCalls.length = 0;
});

describe('MqttConnection.disconnect({ publishWill: true }) — the release exit', () => {
  it('sends the DISCONNECT with reason code 0x04, so the broker publishes the will', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    await conn.disconnect({ publishWill: true });

    expect(fakeClients[0].endCalls).toHaveLength(1);
    // force MUST stay false: mqtt.js `_cleanUp(forced)` sends a DISCONNECT packet
    // only on the unforced path. Forcing it destroys the stream and the reason
    // code is never written to the wire — the option would be silently inert.
    expect(fakeClients[0].endCalls[0].force).toBe(false);
    expect(fakeClients[0].endCalls[0].opts).toMatchObject({
      reasonCode: DISCONNECT_WITH_WILL_REASON_CODE,
    });
  });

  it('sends NO sessionExpiryInterval — on this broker that override is what kills the will', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    await conn.disconnect({ publishWill: true });

    // The falsified premise, pinned as its negation so it cannot come back as a
    // tidy-up ("the other branch sends it, why not this one"). Measured: with the
    // expiry override present, reason code 4 publishes NOTHING.
    expect(fakeClients[0].endCalls[0].opts).not.toHaveProperty('properties');
  });

  it('arms willDelayInterval 0 when asked, so the will fires now and not into the next lease', async () => {
    const conn = new MqttConnection({
      mqttUrl: 'mqtts://x',
      stationId: nextStationId(),
      willDelayIntervalSeconds: 0,
    });
    conn.connect();

    const will = connectCalls[0].opts.will as { properties: { willDelayInterval: number } };
    expect(will.properties.willDelayInterval).toBe(0);
  });

  it('the DEFAULT delay is unchanged and still above the reconnect period', async () => {
    // The tripwire severWill.test.ts rests on: a connection that did NOT ask for
    // the release behaviour must keep the window that suppresses the will for a
    // reconnect to a persistent session.
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    const will = connectCalls[0].opts.will as { properties: { willDelayInterval: number } };
    expect(will.properties.willDelayInterval).toBe(DEFAULT_WILL_DELAY_INTERVAL_SECONDS);
    expect(DEFAULT_WILL_DELAY_INTERVAL_SECONDS * 1000).toBeGreaterThan(LIVE_RECONNECT_PERIOD_MS);
  });

  it('the will the broker is asked to publish is still the ConnectionLost the server handles', async () => {
    const stationId = nextStationId();
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId });
    conn.connect();

    await conn.disconnect({ publishWill: true });

    // Asking for the will to be published is worth nothing if the armed will is
    // not the message ConnectionLostHandler routes on. Read off the CONNECT that
    // actually happened, not restated.
    const will = connectCalls[0].opts.will as { payload: string; qos: number };
    const envelope = JSON.parse(will.payload) as Record<string, unknown>;
    expect(envelope.action).toBe('ConnectionLost');
    expect(envelope.messageType).toBe('Event');
    expect(will.qos).toBe(1);
  });
});

describe('MqttConnection.disconnect() — the ordinary exit is UNCHANGED', () => {
  /**
   * THE CONTROL, AND THE REASON THIS FILE IS NOT VACUOUS.
   *
   * Every assertion above would also pass if the reason code were attached to
   * EVERY disconnect. That would arm the will on all ~148 end-of-scenario
   * teardowns and on `fault: disconnect`, whose entire purpose in
   * core/connection-lost-lwt.yaml is to be the arm that does NOT publish one.
   * The discrimination is the property under test, so it is asserted directly.
   */
  it('sends NO reason code when publishWill is not asked for', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    await conn.disconnect();

    expect(fakeClients[0].endCalls[0].opts).not.toHaveProperty('reasonCode');
    // and the pre-existing behaviour is untouched — the expiry override stays on
    // the ordinary exit, where flushing broker state is all it was ever for.
    expect(fakeClients[0].endCalls[0].opts).toMatchObject({
      properties: { sessionExpiryInterval: 0 },
    });
  });

  it('an explicit publishWill:false is the same packet as no argument at all', async () => {
    const a = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    a.connect();
    await a.disconnect();

    const b = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    b.connect();
    await b.disconnect({ publishWill: false });

    expect(fakeClients[1].endCalls[0].opts).toEqual(fakeClients[0].endCalls[0].opts);
  });

  it('the close is still attributed to `self` — a release is not a severance', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    await conn.disconnect({ publishWill: true });

    // The socket went down because WE closed it. `severed` and `network` describe
    // sockets that died; reusing either here would make getSeverance() lie to any
    // scenario that reads it, for a teardown no scenario asked for.
    expect(conn.getSeverance().lastCloseCause).toBe('self');
    expect(conn.getSeverance().kicked).toBe(false);
  });

  it('is a no-op on an already-severed connection, publishWill or not', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: nextStationId() });
    conn.connect();

    conn.severConnection();
    // The runner's `finally` calls this on every scenario, severed or not — and
    // now calls it with publishWill on every POOLED one, which includes every
    // `fault: sever` file. It must not resurrect a client that is already gone.
    await conn.disconnect({ publishWill: true });

    expect(fakeClients[0].endCalls).toHaveLength(1);
    expect(fakeClients[0].endCalls[0].force).toBe(true);
    expect(conn.getSeverance().lastCloseCause).toBe('severed');
  });
});

describe('the reason code is the spec one, not a number someone liked', () => {
  it('DISCONNECT_WITH_WILL_REASON_CODE is 0x04', () => {
    // MQTT 5.0 Table 3-10, "Disconnect Reason Code": 0x04 = Disconnect with
    // Will Message. 0x00 is Normal disconnection, which is the value that
    // DISCARDS the will and is what this whole file exists to stop sending.
    expect(DISCONNECT_WITH_WILL_REASON_CODE).toBe(0x04);
  });
});
