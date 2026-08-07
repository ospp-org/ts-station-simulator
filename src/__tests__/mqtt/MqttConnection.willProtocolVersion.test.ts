import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Captures the IClientOptions argument passed to each mqtt.connect() call.
const connectCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];

class FakeMqttClient extends EventEmitter {
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
const { OSPP_PROTOCOL_VERSION } = await import('@ospp/protocol');

/**
 * The Last Will is the ONE envelope the station never publishes itself — it is
 * pre-configured at connect time and emitted by the broker on its behalf
 * (spec/03-messages.md:1251). That is exactly why it was missed: it does not go
 * through MessageSender, so it did not inherit the configured wire version and
 * silently used the SDK constant instead.
 *
 * Consequence, measured on UAT: 11 wills dead-lettered with
 * `Unsupported version: 0.2.1` against a server whose supported set was
 * `["0.3.0"]`. Negotiation is exact match, so the will is refused 1007 and
 * hard-failed — and ConnectionLost is the only trigger for orphaned-session
 * recovery, so the server never learns the station vanished.
 */
function willEnvelope(): Record<string, unknown> {
  const will = connectCalls[0]?.opts.will as { payload: string } | undefined;
  if (!will) throw new Error('no will configured on the connect options');
  return JSON.parse(will.payload) as Record<string, unknown>;
}

describe('MqttConnection — the Last Will carries the CONFIGURED wire protocolVersion', () => {
  const original = process.env.OSPP_PROTOCOL_VERSION;

  beforeEach(() => {
    connectCalls.length = 0;
    delete process.env.OSPP_PROTOCOL_VERSION;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OSPP_PROTOCOL_VERSION;
    else process.env.OSPP_PROTOCOL_VERSION = original;
  });

  it('uses OSPP_PROTOCOL_VERSION when set — the regression guard', () => {
    process.env.OSPP_PROTOCOL_VERSION = '0.3.0';
    new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' }).connect();

    // Before the fix this was the SDK constant regardless of the env.
    expect(willEnvelope().protocolVersion).toBe('0.3.0');
  });

  it('agrees with what MessageSender puts on a normal publish — one resolver, not two', async () => {
    process.env.OSPP_PROTOCOL_VERSION = '0.3.0';
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' });
    conn.connect();

    const { MessageSender } = await import('../../mqtt/MessageSender.js');
    let published: string | null = null;
    const sender = new MessageSender(
      { publish: async (_t: string, p: string) => { published = p; } } as never,
      'stn_abc',
      () => null,
      'None', // no key needed; this test is about the version, not the mac
    );
    const { OsppAction, MessageType } = await import('@ospp/protocol');
    await sender.send(OsppAction.HEARTBEAT, MessageType.REQUEST, {});

    const sent = JSON.parse(published as unknown as string) as Record<string, unknown>;
    expect(sent.protocolVersion).toBe(willEnvelope().protocolVersion);
  });

  it('falls back to the SDK default when the env is unset — unchanged prior behaviour', () => {
    new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' }).connect();
    expect(willEnvelope().protocolVersion).toBe(OSPP_PROTOCOL_VERSION);
  });

  it('still builds a conforming will otherwise — source, action and the lwt- id prefix', () => {
    process.env.OSPP_PROTOCOL_VERSION = '0.3.0';
    new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' }).connect();
    const env = willEnvelope();

    // Broker -> Server, published on the station's behalf, so `Server` is correct
    // per 03-messages.md:86 and the envelope schema's own note; `lwt-` prefix per :3076.
    expect(env.action).toBe('ConnectionLost');
    expect(env.messageType).toBe('Event');
    expect(env.source).toBe('Server');
    expect(env.messageId).toBe('lwt-stn_abc');
    expect(env.mac).toBeUndefined(); // structurally exempt
  });
});
