import { describe, it, expect } from 'vitest';
import { OsppAction, MessageType } from '@ospp/protocol';
import { verifyMac } from '@ospp/protocol/server';
import { MessageSender } from '../../mqtt/MessageSender.js';
import type { MqttConnection } from '../../mqtt/MqttConnection.js';

/*
 * The station signs the WHOLE envelope (signMessage(sessionKey, envelope)), NOT
 * envelope.payload. verifyMac() recomputes the MAC over the whole envelope minus
 * mac, so it only accepts if the station signed the whole envelope — a payload-only
 * signature would make verifyMac() return false. This is the load-bearing assertion.
 */

// Deterministic 32-byte base64 session key.
const SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function makeSender(sessionKey: string | null): {
  sender: MessageSender;
  published: () => string | null;
} {
  let payload: string | null = null;
  const fakeConnection = {
    publish: async (_topic: string, p: string, _qos: number): Promise<void> => {
      payload = p;
    },
  } as unknown as MqttConnection;

  // 'All' — 'Critical' is deleted from the SDK; with everything signed it
  // selected nothing. Everything except the three structural exemptions carries
  // a MAC now.
  const sender = new MessageSender(fakeConnection, 'stn_simtest01', () => sessionKey, 'All');

  return { sender, published: () => payload };
}

describe('MessageSender HMAC signing', () => {
  it('signs a critical message (SessionEnded EVENT) over the whole envelope, verifiable by verifyMac', async () => {
    const { sender, published } = makeSender(SESSION_KEY);

    await sender.send(OsppAction.SESSION_ENDED, MessageType.EVENT, {
      sessionId: 'sess_1',
      reason: 'Completed',
    });

    const envelope = JSON.parse(published() as string) as Record<string, unknown>;

    expect(typeof envelope.mac).toBe('string');
    // Whole-envelope signature: verifyMac canonicalizes the whole envelope (minus mac).
    expect(verifyMac(SESSION_KEY, envelope)).toBe(true);
  });

  it('does NOT sign an exempt message (BootNotification REQUEST)', async () => {
    const { sender, published } = makeSender(SESSION_KEY);

    await sender.send(OsppAction.BOOT_NOTIFICATION, MessageType.REQUEST, {
      stationId: 'stn_simtest01',
    });

    const envelope = JSON.parse(published() as string) as Record<string, unknown>;
    expect(envelope.mac).toBeUndefined();
  });

  /*
   * This case previously asserted the opposite — "does NOT sign before a session
   * key has been acquired", passing because the envelope reached the wire with
   * `mac` undefined. That is the fail-OPEN branch 06-security.md:869-873 forbids
   * in terms: "No session key held for the peer -> Refuse to send. The sender
   * MUST NOT publish the message unsigned." MessageRouter::verified() already
   * failed CLOSED on the identical condition, so the two halves of §5.7
   * disagreed inside one repo. The assertion is inverted deliberately.
   */
  it('REFUSES to publish a MAC-requiring message before a session key has been acquired', async () => {
    const { sender, published } = makeSender(null);

    await expect(
      sender.send(OsppAction.SESSION_ENDED, MessageType.EVENT, { sessionId: 'sess_1' }),
    ).rejects.toThrow(/refusing to publish SessionEnded Event unsigned/);

    // Fail CLOSED means nothing reached the wire at all — not "reached it
    // without a mac", which is what the old expectation accepted.
    expect(published()).toBeNull();
  });

  it('still publishes an EXEMPT message with no key — the boot Request precedes the key', async () => {
    const { sender, published } = makeSender(null);

    await sender.send(OsppAction.BOOT_NOTIFICATION, MessageType.REQUEST, {
      stationId: 'stn_simtest01',
    });

    // The guard must not swallow the three structural exemptions: refusing the
    // message that FETCHES the key would deadlock every boot.
    const envelope = JSON.parse(published() as string) as Record<string, unknown>;
    expect(envelope.mac).toBeUndefined();
  });

  it('still publishes unsigned under signingMode None, key or no key', async () => {
    let payload: string | null = null;
    const fakeConnection = {
      publish: async (_t: string, p: string, _q: number): Promise<void> => {
        payload = p;
      },
    } as unknown as MqttConnection;
    // 'None' is development-only, and requiresMac() returns false for every
    // action under it — so the guard must not fire.
    const sender = new MessageSender(fakeConnection, 'stn_simtest01', () => null, 'None');

    await sender.send(OsppAction.SESSION_ENDED, MessageType.EVENT, { sessionId: 'sess_1' });

    expect(JSON.parse(payload as unknown as string).mac).toBeUndefined();
  });
});
