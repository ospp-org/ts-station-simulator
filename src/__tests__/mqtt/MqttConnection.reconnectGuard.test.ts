import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Captures each mqtt.connect() call so the test can assert ordering.
const connectCalls: Array<{ url: string; opts: Record<string, unknown>; t: number }> = [];

class FakeMqttClient extends EventEmitter {
  // Captures opts of every client.end() call for assertions on
  // sessionExpiryInterval=0 in the DISCONNECT properties.
  endCalls: Array<{ force: boolean; opts: Record<string, unknown> }> = [];
  end = vi.fn((force: boolean, opts: object, cb?: () => void) => {
    this.endCalls.push({ force, opts: opts as Record<string, unknown> });
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
}

const fakeClients: FakeMqttClient[] = [];

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    fakeClients.push(fc);
    connectCalls.push({ url, opts, t: Date.now() });
    return fc;
  }),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

/**
 * The reconnect guard is measured on the MONOTONIC clock, so a fake-timer setup
 * must fake `performance` too — vitest's DEFAULT `toFake` list does NOT include
 * it, and with the default list `advanceTimersByTime` moves `Date.now()` while
 * `performance.now()` keeps ticking in real time. Measured: default list gives
 * dWall=600 / dMono=0.04 for `advanceTimersByTime(600)`. With `'performance'`
 * added, `advanceTimersByTime` moves both by 600 and `setSystemTime` moves the
 * wall clock alone — which is precisely what lets a clock CORRECTION be planted
 * without real time passing.
 */
const FAKE_CLOCKS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance',
] as const;

describe('MqttConnection — clean disconnect + reconnect guard (alignment v0.4.0 Phase 3C)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
    fakeClients.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disconnect() sends MQTT 5 DISCONNECT with sessionExpiryInterval=0', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_se0' });
    conn.connect();
    expect(fakeClients).toHaveLength(1);

    await conn.disconnect();

    const fc = fakeClients[0];
    expect(fc.endCalls.length).toBeGreaterThanOrEqual(1);
    const gracefulCall = fc.endCalls.find((c) => c.force === false);
    expect(gracefulCall).toBeDefined();
    expect(gracefulCall!.opts).toEqual({ properties: { sessionExpiryInterval: 0 } });
  });

  it('first connect for a stationId runs synchronously (no prior disconnect)', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_synced' });
    conn.connect();
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].opts.clientId).toBe('stn_synced');
  });

  it('reconnect within 500ms of disconnect is deferred via setTimeout, NOT issued immediately', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_guard' });
    conn.connect();
    expect(connectCalls).toHaveLength(1);

    await conn.disconnect();
    expect(connectCalls).toHaveLength(1);

    // Advance only 100ms (under the 500ms guard) before second connect.
    vi.advanceTimersByTime(100);
    conn.connect();

    // The deferred connect has NOT fired yet — still only 1 connectCall.
    expect(connectCalls).toHaveLength(1);

    // Advance another 400ms — total elapsed since disconnect = 500ms, guard expires.
    vi.advanceTimersByTime(400);
    expect(connectCalls).toHaveLength(2);
    expect(connectCalls[1].opts.clientId).toBe('stn_guard');
  });

  it('reconnect after 500ms of disconnect runs synchronously', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_postguard' });
    conn.connect();
    await conn.disconnect();
    expect(connectCalls).toHaveLength(1);

    // Past the 500ms guard — synchronous reconnect expected.
    vi.advanceTimersByTime(600);
    conn.connect();
    expect(connectCalls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // The guard is a DIFFERENCED duration — "how long since this stationId last
  // disconnected" — so it belongs on the monotonic clock for the same reason
  // session duration does (spec/profiles/core/heartbeat.md:44 rule 5 states the
  // rule for the field that bills; the class is the same wherever an interval is
  // subtracted). On the wall clock a correction did not merely mis-measure it: a
  // backwards step made `elapsed` NEGATIVE, so `RECONNECT_GUARD_MS - elapsed`
  // became larger than the guard by the size of the correction, and a 500ms wait
  // turned into an hour-long one.
  // -------------------------------------------------------------------------
  it('INSTRUMENT CONTROL: advanceTimersByTime moves both clocks; setSystemTime moves only the wall clock', () => {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));
    const wall0 = Date.now();
    const mono0 = performance.now();

    vi.advanceTimersByTime(600);
    expect(Date.now() - wall0).toBe(600);
    expect(performance.now() - mono0).toBe(600);

    const wall1 = Date.now();
    const mono1 = performance.now();
    vi.setSystemTime(Date.now() - 3_600_000);
    expect(Date.now() - wall1).toBe(-3_600_000);
    expect(performance.now() - mono1).toBe(0);
  });

  it('a BACKWARDS wall-clock correction does not strand a reconnect whose guard has already expired', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_backstep' });
    conn.connect();
    await conn.disconnect();
    expect(connectCalls).toHaveLength(1);

    // 600ms of REAL time pass — the 500ms guard has expired...
    vi.advanceTimersByTime(600);
    // ...and only then does an NTP/NITZ fix set the clock back an hour.
    vi.setSystemTime(Date.now() - 3_600_000);

    conn.connect();

    // Nothing about the broker's bookkeeping changed, so the reconnect is due
    // now. On the wall clock `elapsed` was -3_599_400 and this deferred the
    // connect by 3_599_900ms — an hour of silence caused by a clock, on a
    // station that was ready to reconnect.
    expect(connectCalls).toHaveLength(2);
    expect(connectCalls[1].opts.clientId).toBe('stn_backstep');
  });

  it('INVERSE CONTROL: a FORWARD correction does not skip a guard that has NOT expired', async () => {
    // The other direction of the same defect, and the one that would let a
    // reconnect through early — the guard exists because the broker needs the
    // beat. A monotonic reading ignores the correction in both directions.
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_fwdstep' });
    conn.connect();
    await conn.disconnect();
    expect(connectCalls).toHaveLength(1);

    // 100ms of real time — well inside the guard — then the clock jumps forward.
    vi.advanceTimersByTime(100);
    vi.setSystemTime(Date.now() + 3_600_000);

    conn.connect();
    expect(connectCalls).toHaveLength(1);

    // Still deferred, and still by the REAL remainder: 400ms, not 400ms minus an
    // hour and not an hour.
    vi.advanceTimersByTime(400);
    expect(connectCalls).toHaveLength(2);
  });

  it('a disconnect recorded at monotonic 0 is still a disconnect — absence is the only sentinel', async () => {
    // The map stored `Date.now()` and read it back with `?? 0` plus an explicit
    // `last !== 0` test. On a wall clock 0 meant 1970 and no station reported it.
    // On a monotonic clock 0 is the ORIGIN — which is exactly what a fresh fake
    // timer reads — so the first disconnect of a young process recorded 0 and was
    // read back as "never disconnected", skipping the guard entirely.
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));
    expect(performance.now()).toBe(0); // the origin the sentinel collided with

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_zeroorigin' });
    conn.connect();
    await conn.disconnect(); // recorded at monotonic 0
    expect(connectCalls).toHaveLength(1);

    conn.connect();
    expect(connectCalls).toHaveLength(1); // deferred, not waved through

    vi.advanceTimersByTime(500);
    expect(connectCalls).toHaveLength(2);
  });

  it('guard is per-stationId — distinct stations never block each other', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));

    const a = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_AA' });
    a.connect();
    await a.disconnect();
    expect(connectCalls).toHaveLength(1);

    // Immediately spin up a SECOND connection on a DIFFERENT stationId,
    // still within stn_AA's guard window. Must NOT be deferred.
    vi.advanceTimersByTime(50);
    const b = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_BB' });
    b.connect();
    expect(connectCalls).toHaveLength(2);
    expect(connectCalls[1].opts.clientId).toBe('stn_BB');
  });
});

describe('MqttConnection — error re-emit guard (reconnect churn / sub-floor TLS pin)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
    fakeClients.length = 0;
  });

  it('swallows a repeat client error once the one-shot listener is gone (no unhandled crash)', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: 'stn_reemit' });
    conn.connect();
    const fc = fakeClients[0];

    // Model Station.connect(): a single `.once('error')` consumer.
    const seen: Error[] = [];
    conn.once('error', (e: Error) => {
      seen.push(e);
    });

    const fatal = Object.assign(new Error('no protocols available'), {
      code: 'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
    });

    // 1st reconnect attempt: forwarded to the once-listener.
    expect(() => fc.emit('error', fatal)).not.toThrow();
    expect(seen).toHaveLength(1);

    // once-listener consumed → zero 'error' listeners. A client with
    // reconnectPeriod > 0 re-fires the SAME fatal error; this must NOT throw an
    // unhandled 'error' (which would crash the process — the S3 TLS-1.1-pin
    // symptom: OpenSSL aborts every attempt with ERR_SSL_NO_PROTOCOLS_AVAILABLE).
    expect(() => fc.emit('error', fatal)).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('still forwards every error while a listener stays attached', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtts://x', stationId: 'stn_fwd' });
    conn.connect();
    const fc = fakeClients[0];
    const seen: string[] = [];
    conn.on('error', (e: Error) => {
      seen.push(e.message);
    });
    fc.emit('error', new Error('boom'));
    fc.emit('error', new Error('boom2'));
    expect(seen).toEqual(['boom', 'boom2']);
  });
});
