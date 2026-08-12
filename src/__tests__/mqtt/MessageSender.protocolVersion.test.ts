import { afterEach, describe, expect, it } from 'vitest';
import { MessageType, OSPP_PROTOCOL_VERSION, OsppAction } from '@ospp/protocol';
import { MessageSender } from '../../mqtt/MessageSender.js';

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
 *
 * WHAT CHANGED AT @ospp/protocol 0.15.0. The default assertion used to read
 * `.toBe(WIRE_PROTOCOL_VERSION)` and `.not.toBe(OSPP_PROTOCOL_VERSION)` — this repo carried
 * a local constant precisely BECAUSE the SDK's was non-conformant, and that second assertion
 * was the tripwire: "if this ever coincides, the SDK default was corrected and
 * WIRE_PROTOCOL_VERSION can go." It coincided (`expected '0.3.0' not to be '0.3.0'`), the
 * constant is gone, and the assertion is now against the literal the spec mandates.
 *
 * It is deliberately a LITERAL and not `OSPP_PROTOCOL_VERSION`. Asserting the wire value
 * against the same constant the code puts on the wire is a tautology that passes for any
 * value the SDK ever ships — including the next wrong one. This file exists because a wrong
 * SDK default reached UAT, so the one thing it must not do is re-derive its expectation from
 * the SDK. `0.3.0` is transcribed from spec Chapter 08. When the spec moves, this fails, and
 * failing is the correct behaviour: the spec moving is exactly the event a station operator
 * needs to be told about.
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

  it('defaults to the SPEC wire version when nothing overrides it', async () => {
    delete process.env.OSPP_PROTOCOL_VERSION;
    const { sender, published } = makeSender(undefined);
    // Literal, transcribed from spec Chapter 08 — NOT OSPP_PROTOCOL_VERSION. See header.
    expect(await versionOnWire(sender, published)).toBe('0.3.0');
  });

  it('and the SDK constant now agrees with the spec, which is why the local override is gone', () => {
    // The former WIRE_PROTOCOL_VERSION existed only to paper over a non-conformant SDK
    // default. This asserts the condition that retired it, so a regression in the SDK is
    // reported HERE — as "the SDK drifted" — rather than as a mysterious 1007 on UAT.
    expect(OSPP_PROTOCOL_VERSION).toBe('0.3.0');
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
