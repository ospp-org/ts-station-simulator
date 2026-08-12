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

/**
 * The version this file asserts, transcribed from spec Chapter 08 — deliberately a
 * LITERAL rather than an import of `OSPP_PROTOCOL_VERSION`.
 *
 * This file exists because a will went out carrying whatever the SDK happened to say,
 * and the SDK happened to say something the server refused. Asserting against the SDK
 * constant would restore precisely that coupling: the test would pass for any value the
 * SDK ever ships, including the next wrong one, and would have passed throughout the
 * incident it was written to prevent.
 *
 * Until @ospp/protocol 0.15.0 this repo carried a local `WIRE_PROTOCOL_VERSION` for the
 * same reason, plus a `.not.toBe(OSPP_PROTOCOL_VERSION)` tripwire that fired the moment
 * the SDK was corrected. The SDK is now right, so the local constant is deleted; the
 * independence it provided is kept here, in one line, where it costs nothing.
 */
const SPEC_WIRE_VERSION = '0.3.0';

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

  /**
   * This assertion used to read `toBe(OSPP_PROTOCOL_VERSION)` and was described as
   * "unchanged prior behaviour". That is what kept the defect alive: the first fix
   * routed the will through the resolver but left the unset-env path resolving to
   * the SDK's 0.2.1, and this test pinned it there. Nothing sets the env — not the
   * repo .env, not ~/.config/osp-e2e-secrets.env, not config/targets.yaml — so the
   * unset path is the ONLY path in practice. Re-proved on the wire against UAT on
   * 2026-08-10: lwt-stn_674b55ca, protocolVersion 0.2.1, dead-lettered.
   */
  it('emits the spec wire version when the env is unset — the path that actually runs', () => {
    new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' }).connect();
    expect(willEnvelope().protocolVersion).toBe(SPEC_WIRE_VERSION);
  });

  it('leaves no silent non-conformant path — both publishers agree with the env unset', async () => {
    const conn = new MqttConnection({ mqttUrl: 'mqtt://x', stationId: 'stn_abc' });
    conn.connect();

    const { MessageSender } = await import('../../mqtt/MessageSender.js');
    let published: string | null = null;
    const sender = new MessageSender(
      { publish: async (_t: string, p: string) => { published = p; } } as never,
      'stn_abc',
      () => null,
      'None',
    );
    const { OsppAction, MessageType } = await import('@ospp/protocol');
    await sender.send(OsppAction.HEARTBEAT, MessageType.REQUEST, {});

    const sent = JSON.parse(published as unknown as string) as Record<string, unknown>;
    expect(sent.protocolVersion).toBe(SPEC_WIRE_VERSION);
    expect(willEnvelope().protocolVersion).toBe(SPEC_WIRE_VERSION);
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
