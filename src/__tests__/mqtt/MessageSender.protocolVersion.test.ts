import { afterEach, describe, expect, it } from 'vitest';
import { MessageType, OSPP_PROTOCOL_VERSION, OsppAction } from '@ospp/protocol';
import { MessageSender } from '../../mqtt/MessageSender.js';
import type { MqttConnection } from '../../mqtt/MqttConnection.js';

/*
 * The wire protocolVersion must be OVERRIDABLE, never hardcoded: a local-HEAD cascade negotiates on the
 * SDK default (OSPP_PROTOCOL_VERSION, MAJOR-0, matches dev/testing/prod-example), but the SAME build must
 * be able to target a server pinned to a different MAJOR (e.g. UAT 1.x) via OSPP_PROTOCOL_VERSION — else
 * every message is rejected 1007. These pin all three: default → SDK, explicit override → wire, env → wire.
 */

function makeSender(protocolVersion?: string): { sender: MessageSender; published: () => string | null } {
  let payload: string | null = null;
  const fakeConnection = {
    publish: async (_topic: string, p: string, _qos: number): Promise<void> => {
      payload = p;
    },
  } as unknown as MqttConnection;
  const sender = new MessageSender(fakeConnection, 'stn_simtest01', () => null, 'Critical', protocolVersion);
  return { sender, published: () => payload };
}

async function versionOnWire(sender: MessageSender, published: () => string | null): Promise<unknown> {
  await sender.send(OsppAction.BOOT_NOTIFICATION, MessageType.REQUEST, { stationId: 'stn_simtest01' });
  return (JSON.parse(published() as string) as Record<string, unknown>).protocolVersion;
}

describe('MessageSender protocolVersion (overridable, not hardcoded)', () => {
  const previous = process.env.OSPP_PROTOCOL_VERSION;
  afterEach(() => {
    if (previous === undefined) delete process.env.OSPP_PROTOCOL_VERSION;
    else process.env.OSPP_PROTOCOL_VERSION = previous;
  });

  it('defaults to the SDK OSPP_PROTOCOL_VERSION when nothing overrides it (a local-HEAD cascade negotiates)', async () => {
    delete process.env.OSPP_PROTOCOL_VERSION;
    const { sender, published } = makeSender(undefined);
    expect(await versionOnWire(sender, published)).toBe(OSPP_PROTOCOL_VERSION);
  });

  it('emits an explicit override on the wire (target a server pinned to a different MAJOR, e.g. UAT 1.x)', async () => {
    const { sender, published } = makeSender('1.0.0');
    expect(await versionOnWire(sender, published)).toBe('1.0.0');
  });

  it('picks up the OSPP_PROTOCOL_VERSION env var when no explicit override is passed', async () => {
    process.env.OSPP_PROTOCOL_VERSION = '0.9.9';
    const { sender, published } = makeSender(undefined);
    expect(await versionOnWire(sender, published)).toBe('0.9.9');
  });
});
