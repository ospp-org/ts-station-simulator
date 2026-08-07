import { describe, it, expect } from 'vitest';
import { OsppAction, MessageType } from '@ospp/protocol';
import { verifyMac } from '@ospp/protocol/server';
import { MessageSender } from '../../mqtt/MessageSender.js';
import type { MqttConnection } from '../../mqtt/MqttConnection.js';

/*
 * `tamper_mac` exists to reach csms-server's inbound-verification branches in
 * app/Shared/Protocol/Middleware/VerifyIncomingMiddleware.php, which nothing in
 * scenario mode could provoke: send() always signed correctly with the real key.
 *
 * What these tests pin is the property that makes the resulting scenarios
 * ATTRIBUTABLE — the envelope must remain SCHEMA-VALID with only the mac wrong.
 * csms-server validates the schema before it verifies the mac
 * (MessageDispatcher.php:109 precedes :146), and a schema rejection answers a
 * REQUEST with a Rejected RESPONSE on the wire, which the MAC path never does.
 * A tamper that also broke the envelope would prove the wrong gate while looking
 * like the right one.
 */

const SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function makeSender(): {
  sender: MessageSender;
  published: () => Record<string, unknown> | null;
} {
  let raw: string | null = null;
  const fakeConnection = {
    publish: async (_topic: string, p: string, _qos: number): Promise<void> => {
      raw = p;
    },
  } as unknown as MqttConnection;

  const sender = new MessageSender(fakeConnection, 'stn_simtest01', () => SESSION_KEY, 'All');

  return {
    sender,
    published: () => (raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)),
  };
}

async function sendHeartbeat(
  sender: MessageSender,
  tamper?: 'corrupt' | 'wrong_key' | 'omit',
): Promise<void> {
  await sender.send(
    OsppAction.HEARTBEAT,
    MessageType.REQUEST,
    { stationId: 'stn_simtest01' },
    undefined,
    tamper,
  );
}

describe('MessageSender tamper_mac', () => {
  it('omit publishes the message with NO mac field at all — MAC_MISSING (:51)', async () => {
    const { sender, published } = makeSender();

    await sendHeartbeat(sender, 'omit');

    const envelope = published();
    expect(envelope).not.toBeNull();
    expect(envelope?.mac).toBeUndefined();
    // `mac` is OPTIONAL in common/mqtt-envelope.schema.json (absent from
    // `required`), so an omitted mac is schema-valid and reaches the MAC gate
    // rather than short-circuiting into the schema path.
    expect(envelope?.action).toBe(OsppAction.HEARTBEAT);
    expect(envelope?.payload).toEqual({ stationId: 'stn_simtest01' });
  });

  it('corrupt keeps a non-empty base64 mac of the same length — only the VALUE is wrong', async () => {
    const { sender, published } = makeSender();

    await sendHeartbeat(sender, 'corrupt');
    const tampered = published() as Record<string, unknown>;

    await sendHeartbeat(sender);
    const clean = published() as Record<string, unknown>;

    expect(typeof tampered.mac).toBe('string');
    // Schema: minLength 1 / maxLength 1024, and base64-decodable so the server's
    // MacSigner::verify() fails on the COMPARISON rather than on the decode.
    expect((tampered.mac as string).length).toBe((clean.mac as string).length);
    expect(Buffer.from(tampered.mac as string, 'base64').length).toBe(32);
    expect(tampered.mac).not.toBe(clean.mac);
    expect(verifyMac(SESSION_KEY, tampered)).toBe(false);
  });

  it('wrong_key produces a mac that is well-formed and verifies under NO key the server holds', async () => {
    const { sender, published } = makeSender();

    await sendHeartbeat(sender, 'wrong_key');
    const envelope = published() as Record<string, unknown>;

    expect(typeof envelope.mac).toBe('string');
    expect(Buffer.from(envelope.mac as string, 'base64').length).toBe(32);
    expect(verifyMac(SESSION_KEY, envelope)).toBe(false);
  });

  it('wrong_key and corrupt are DIFFERENT bytes but land on the SAME server branch', async () => {
    const { sender, published } = makeSender();

    await sendHeartbeat(sender, 'corrupt');
    const corrupted = published() as Record<string, unknown>;
    await sendHeartbeat(sender, 'wrong_key');
    const wrongKey = published() as Record<string, unknown>;

    // Distinct inputs...
    expect(corrupted.mac).not.toBe(wrongKey.mac);
    // ...and yet indistinguishable to the receiver: VerifyIncomingMiddleware.php:82
    // ends in a single hash_equals via MacSigner::verify(), so both are one
    // MAC_VERIFICATION_FAILED with one reason string. This is why the corpus
    // carries ONE scenario for the pair rather than two — a second scenario
    // would reach no additional branch.
    expect(verifyMac(SESSION_KEY, corrupted)).toBe(false);
    expect(verifyMac(SESSION_KEY, wrongKey)).toBe(false);
  });

  it('an untampered send is completely unaffected — the guard is opt-in', async () => {
    const { sender, published } = makeSender();

    await sendHeartbeat(sender);
    const envelope = published() as Record<string, unknown>;

    expect(verifyMac(SESSION_KEY, envelope)).toBe(true);
  });

  it('REFUSES to tamper a structurally-exempt message — the server never reads that mac', async () => {
    const { sender } = makeSender();

    // BootNotification REQUEST is one of the three structural exemptions, and
    // VerifyIncomingMiddleware.php returns skipped() at :45 BEFORE reading
    // envelope.mac at :49. A scenario built on this would assert nothing, so it
    // fails at authoring time instead of passing vacuously on the wire.
    await expect(
      sender.send(
        OsppAction.BOOT_NOTIFICATION,
        MessageType.REQUEST,
        { stationId: 'stn_simtest01' },
        undefined,
        'corrupt',
      ),
    ).rejects.toThrow(/structurally exempt from signing/);
  });

  it('omit does NOT become a back door around the fail-closed no-key guard', async () => {
    let published: string | null = null;
    const fakeConnection = {
      publish: async (_t: string, p: string, _q: number): Promise<void> => {
        published = p;
      },
    } as unknown as MqttConnection;
    const keyless = new MessageSender(fakeConnection, 'stn_simtest01', () => null, 'All');

    // A station with no key must still refuse to publish (06-security.md §5.7).
    // `omit` means "holds a key, withheld the mac" — the MAC_MISSING branch —
    // and must not be reusable as a way to publish unsigned before boot.
    await expect(
      keyless.send(
        OsppAction.HEARTBEAT,
        MessageType.REQUEST,
        { stationId: 'stn_simtest01' },
        undefined,
        'omit',
      ),
    ).rejects.toThrow(/refusing to publish/);
    expect(published).toBeNull();
  });
});
