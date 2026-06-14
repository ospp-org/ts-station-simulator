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

  const sender = new MessageSender(fakeConnection, 'stn_simtest01', () => sessionKey, 'Critical');

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

  it('does NOT sign before a session key has been acquired', async () => {
    const { sender, published } = makeSender(null);

    await sender.send(OsppAction.SESSION_ENDED, MessageType.EVENT, { sessionId: 'sess_1' });

    const envelope = JSON.parse(published() as string) as Record<string, unknown>;
    expect(envelope.mac).toBeUndefined();
  });
});
