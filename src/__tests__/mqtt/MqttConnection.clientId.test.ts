import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Captures the IClientOptions argument passed to each mqtt.connect() call.
const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

class FakeMqttClient extends EventEmitter {
  // mqtt.end(force, opts, cb)
  end = vi.fn((force: boolean, _opts: object, cb?: () => void) => {
    cb?.();
  });
  subscribe = vi.fn();
  publish = vi.fn();
}

vi.mock('mqtt', () => ({
  connect: vi.fn((url: string, opts: Record<string, unknown>) => {
    connectCalls.push({ url, opts });
    return new FakeMqttClient();
  }),
}));

const { MqttConnection } = await import('../../mqtt/MqttConnection.js');

describe('MqttConnection — clientId uniqueness (V4 Finding #6 fix)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('mints a fresh clientId per connect() call', () => {
    const a = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' });
    a.connect();
    const firstClientId = a.getClientId();

    const b = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' });
    b.connect();
    const secondClientId = b.getClientId();

    expect(firstClientId).not.toBeNull();
    expect(secondClientId).not.toBeNull();
    expect(firstClientId).not.toBe(secondClientId);
  });

  it('uses the stationId-uuid pattern that the broker can grep for', () => {
    const c = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_grep' });
    c.connect();
    const id = c.getClientId();
    expect(id).toMatch(/^stn_grep-[0-9a-f-]{36}$/);
  });

  it('passes the per-connect clientId through to mqtt.connect opts', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_opt' });
    conn.connect();
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].opts.clientId).toBe(conn.getClientId());
    expect(String(connectCalls[0].opts.clientId)).toMatch(/^stn_opt-[0-9a-f-]{36}$/);
  });

  it('re-mints clientId on a subsequent connect after disconnect', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_reconn' });
    conn.connect();
    const before = conn.getClientId();
    await conn.disconnect();
    expect(conn.getClientId()).toBeNull();
    conn.connect();
    const after = conn.getClientId();
    expect(after).not.toBe(before);
  });
});
