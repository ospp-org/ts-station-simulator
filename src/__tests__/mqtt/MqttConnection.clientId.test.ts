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

describe('MqttConnection — clientId equals cert CN (alignment v0.4.0 G-EMQX-CLIENTID)', () => {
  beforeEach(() => {
    connectCalls.length = 0;
  });

  it('uses the stationId exactly as the MQTT clientId (= cert CN per spec)', () => {
    const a = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' });
    a.connect();
    expect(a.getClientId()).toBe('stn_abc');
  });

  it('clientId is exactly stationId on every fresh instance — no per-call randomness', () => {
    // Distinct instances with the same stationId always derive the same
    // clientId. Re-cycling the SAME instance is covered by the reconnect-
    // guard test (the second connect is intentionally deferred via
    // setTimeout, so timing-aware assertions live there).
    const a = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_stable' });
    a.connect();
    const b = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_stable' });
    b.connect();
    expect(a.getClientId()).toBe('stn_stable');
    expect(b.getClientId()).toBe('stn_stable');
    expect(a.getClientId()).toBe(b.getClientId());
  });

  it('distinct stationIds produce distinct clientIds', () => {
    const a = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_A' });
    a.connect();
    const b = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_B' });
    b.connect();
    expect(a.getClientId()).toBe('stn_A');
    expect(b.getClientId()).toBe('stn_B');
    expect(a.getClientId()).not.toBe(b.getClientId());
  });

  it('passes the clientId through to mqtt.connect opts unchanged', () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_opt' });
    conn.connect();
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].opts.clientId).toBe('stn_opt');
  });
});
