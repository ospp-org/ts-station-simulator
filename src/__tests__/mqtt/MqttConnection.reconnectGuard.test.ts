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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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

  it('guard is per-stationId — distinct stations never block each other', async () => {
    vi.useFakeTimers();
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
