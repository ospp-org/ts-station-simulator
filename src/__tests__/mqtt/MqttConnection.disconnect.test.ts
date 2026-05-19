import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

interface EndCall {
  force: boolean;
  cb?: () => void;
}

class HangingFakeClient extends EventEmitter {
  endCalls: EndCall[] = [];
  // First call (force=false) intentionally never invokes its callback —
  // simulates a broker that ignores the graceful DISCONNECT. The force=true
  // fallback IS expected to call back.
  end = vi.fn((force: boolean, _opts: object, cb?: () => void) => {
    this.endCalls.push({ force, cb });
    if (force) {
      cb?.();
    }
  });
  subscribe = vi.fn();
  publish = vi.fn();
}

class CleanFakeClient extends EventEmitter {
  endCalls: EndCall[] = [];
  end = vi.fn((force: boolean, _opts: object, cb?: () => void) => {
    this.endCalls.push({ force, cb });
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
}

const lastFake: { instance: HangingFakeClient | CleanFakeClient | null } = {
  instance: null,
};

vi.mock('mqtt', () => ({
  connect: vi.fn(() => lastFake.instance),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

describe('MqttConnection.disconnect() — clean disconnect protocol (V4 Finding #6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves promptly when graceful end() calls its callback', async () => {
    const fake = new CleanFakeClient();
    lastFake.instance = fake;

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_clean' });
    conn.connect();
    const done = conn.disconnect();
    await vi.runAllTimersAsync();
    await done;

    expect(fake.endCalls).toHaveLength(1);
    expect(fake.endCalls[0].force).toBe(false);
    expect(conn.getClientId()).toBeNull();
  });

  it('forces end() after 3s when graceful disconnect stalls', async () => {
    const fake = new HangingFakeClient();
    lastFake.instance = fake;

    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_stuck' });
    conn.connect();
    const done = conn.disconnect();

    // Advance fake timers past the 3s timeout; the force-end (force=true)
    // callback should fire and resolve the promise.
    await vi.advanceTimersByTimeAsync(3000);
    await done;

    expect(fake.endCalls.length).toBeGreaterThanOrEqual(2);
    expect(fake.endCalls[0].force).toBe(false);
    expect(fake.endCalls[1].force).toBe(true);
    expect(conn.getClientId()).toBeNull();
  });

  it('resolves immediately when no client is attached', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_noclient' });
    await conn.disconnect();
    expect(conn.getClientId()).toBeNull();
  });
});
