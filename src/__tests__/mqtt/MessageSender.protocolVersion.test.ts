import { afterEach, describe, expect, it } from 'vitest';
import { MessageType, OSPP_PROTOCOL_VERSION, OsppAction } from '@ospp/protocol';
import { MessageSender } from '../../mqtt/MessageSender.js';
import type { MqttConnection } from '../../mqtt/MqttConnection.js';
import { WIRE_PROTOCOL_VERSION } from '../../mqtt/protocolVersion.js';

/*
 * The wire protocolVersion must be OVERRIDABLE, and its DEFAULT must be conformant.
 *
 * The comment this replaces said an unset env "negotiates on the SDK default
 * (OSPP_PROTOCOL_VERSION, MAJOR-0, matches dev/testing/prod-example)". That is the same
 * false claim MessageSender.ts already documents: negotiation is EXACT MATCH against a set
 * (VERSIONING.md:25), the SDK's MAJOR gate isCompatibleWith() was deleted in 0.12.0, and
 * csms-server's VersionNegotiator never called it. A shared MAJOR has never made 0.2.1
 * acceptable to a server configured for anything else.
 *
 * Leaving the default at the SDK constant is what kept the Last-Will defect alive after it
 * was "fixed" — nothing in this repo or the e2e env file sets OSPP_PROTOCOL_VERSION, so the
 * unset path is the only path that runs, and it put 0.2.1 on the wire. Proven against UAT
 * on 2026-08-10. These pin all three: default → spec wire version, explicit override → wire,
 * env → wire.
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

  it('defaults to the SPEC wire version when nothing overrides it — not the SDK constant', async () => {
    delete process.env.OSPP_PROTOCOL_VERSION;
    const { sender, published } = makeSender(undefined);
    expect(await versionOnWire(sender, published)).toBe(WIRE_PROTOCOL_VERSION);
    // The SDK constant is still 0.2.1 and is NOT conformant on the wire; if this
    // ever coincides, the SDK default was corrected and WIRE_PROTOCOL_VERSION can go.
    expect(await versionOnWire(sender, published)).not.toBe(OSPP_PROTOCOL_VERSION);
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
