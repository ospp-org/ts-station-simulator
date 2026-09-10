import { describe, expect, it } from 'vitest';
import { MAX_ENVELOPE_BYTES, MessageType, OsppAction } from '@ospp/protocol';
import { MessageSender } from '../../mqtt/MessageSender.js';
import type { MqttConnection } from '../../mqtt/MqttConnection.js';

/*
 * THE ENVELOPE CAP MUST REFUSE ON THE PATH THAT ACTUALLY PUBLISHES.
 *
 * `spec/02-transport.md` §10.2.1 caps a serialised envelope at 64512 bytes and states the
 * obligation as an emitter MUST NOT. The emitter is the only party that can honour it —
 * it is the only one holding the bytes before they exist on the wire.
 *
 * WHY THIS FILE EXISTS. `@ospp/protocol` 0.37.0 shipped the cap as SEVEN exported
 * functions and wired NONE of them: measured 2026-09-10, `assertWithinEnvelopeCap` and
 * `serializeEnvelopeForWire` had zero callers anywhere outside the SDK's own tests, and
 * both publish sites here reached the wire through a bare `JSON.stringify`. The PHP SDK
 * does wire it — `MessageEnvelope::toJson()` asserts before returning bytes — so this was
 * a real asymmetry between the two SDKs and not a deliberate difference.
 *
 * WHERE THE RED LANDS. On the refusal to publish. `published()` must stay null for an
 * over-cap frame: a guard that logged and published anyway would satisfy a weaker
 * assertion and would be exactly the defect the cap exists to prevent, since the broker
 * advertises `maximumPacketSize` 65536 and silently drops what exceeds it.
 *
 * THE ANTI-VACUITY CONTROL is the first test. A guard that refused everything would pass
 * every over-cap assertion here, so an ordinary frame must still reach the wire — and be
 * a real frame, parsed and checked, not an empty string.
 */

function makeSender(): { sender: MessageSender; published: () => string | null } {
  let payload: string | null = null;
  const fakeConnection = {
    publish: async (_topic: string, p: string, _qos: number): Promise<void> => {
      payload = p;
    },
  } as unknown as MqttConnection;
  // 'Off' signing mode: this file is about SIZE, not MAC. A signing refusal would be a
  // second reason for `published()` to be null and would make every assertion ambiguous.
  const sender = new MessageSender(fakeConnection, 'stn_simtest01', () => null, 'Off');
  return { sender, published: () => payload };
}

/** A payload whose ENVELOPE serialises to exactly `target` bytes, derived by measurement. */
async function payloadForEnvelopeSize(target: number): Promise<{ blob: string }> {
  const { sender, published } = makeSender();
  await sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, { blob: '' });
  const overhead = new TextEncoder().encode(published() as string).length;
  return { blob: 'x'.repeat(target - overhead) };
}

describe('MessageSender — the envelope cap is enforced where it publishes', () => {
  it('CONTROL — an ordinary frame still reaches the wire, and is a real frame', async () => {
    const { sender, published } = makeSender();

    await sender.send(OsppAction.BOOT_NOTIFICATION, MessageType.REQUEST, { stationId: 'stn_simtest01' });

    const wire = published();
    expect(wire).not.toBeNull();
    expect(new TextEncoder().encode(wire as string).length).toBeLessThan(MAX_ENVELOPE_BYTES);
    expect((JSON.parse(wire as string) as Record<string, unknown>).action).toBe(OsppAction.BOOT_NOTIFICATION);
  });

  it('CONTROL — a frame at EXACTLY the cap is published, so the bound is not off by one', async () => {
    const { blob } = await payloadForEnvelopeSize(MAX_ENVELOPE_BYTES);
    const { sender, published } = makeSender();

    await sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, { blob });

    expect(published()).not.toBeNull();
    expect(new TextEncoder().encode(published() as string).length).toBe(MAX_ENVELOPE_BYTES);
  });

  it('REFUSES to publish a frame one byte over the cap — and publishes NOTHING', async () => {
    const { blob } = await payloadForEnvelopeSize(MAX_ENVELOPE_BYTES + 1);
    const { sender, published } = makeSender();

    await expect(
      sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, { blob }),
    ).rejects.toThrow(RangeError);

    // The refusal is the point. A logged warning with the frame still on the wire is the
    // defect, not the fix.
    expect(published()).toBeNull();
  });

  it('names the action and the overage, so the operator need not measure it again', async () => {
    const { blob } = await payloadForEnvelopeSize(MAX_ENVELOPE_BYTES + 100);
    const { sender } = makeSender();

    await expect(
      sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, { blob }),
    ).rejects.toThrow(/StatusNotification[\s\S]*64512/);
  });

  it('the second publish site — sendEnvelope — is guarded too', async () => {
    // Currently uncalled, but a published surface. MessageSender.ts documents that if it
    // ever acquires a caller the send() guards belong here; the cap is one of them.
    const { blob } = await payloadForEnvelopeSize(MAX_ENVELOPE_BYTES + 1);
    const { sender, published } = makeSender();

    // Build the over-cap envelope without publishing it, by reusing send()'s shape.
    const envelope = {
      messageId: crypto.randomUUID(),
      messageType: MessageType.EVENT,
      action: OsppAction.STATUS_NOTIFICATION,
      timestamp: '2026-09-10T10:00:00.000Z',
      source: 'Station',
      protocolVersion: '0.3.0',
      payload: { blob },
    };

    await expect(sender.sendEnvelope(envelope)).rejects.toThrow(RangeError);
    expect(published()).toBeNull();
  });
});
