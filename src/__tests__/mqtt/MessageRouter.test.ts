import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../mqtt/MessageRouter.js';
import { OsppAction, MessageType, MessageSource, OSPP_PROTOCOL_VERSION } from '@ospp/protocol';
import type { OsppEnvelope } from '@ospp/protocol';

function makeEnvelope(action: OsppAction): OsppEnvelope {
  return {
    messageId: 'msg-001',
    messageType: MessageType.REQUEST,
    action,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {},
  };
}

describe('MessageRouter', () => {
  it('parses valid JSON buffer and emits action event', () => {
    const router = new MessageRouter();
    const envelope = makeEnvelope(OsppAction.HEARTBEAT);
    const handler = vi.fn();
    router.on(OsppAction.HEARTBEAT, handler);

    router.route('test/topic', Buffer.from(JSON.stringify(envelope)));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ action: OsppAction.HEARTBEAT }));
  });

  it('handles invalid JSON gracefully (no throw)', () => {
    const router = new MessageRouter();
    expect(() => {
      router.route('test/topic', Buffer.from('not json'));
    }).not.toThrow();
  });

  it('handles missing action field gracefully', () => {
    const router = new MessageRouter();
    const payload = { messageId: 'msg-001', payload: {} };
    expect(() => {
      router.route('test/topic', Buffer.from(JSON.stringify(payload)));
    }).not.toThrow();
  });

  it('onAction() registers typed listener', () => {
    const router = new MessageRouter();
    const handler = vi.fn();
    router.onAction(OsppAction.BOOT_NOTIFICATION, handler);

    const envelope = makeEnvelope(OsppAction.BOOT_NOTIFICATION);
    router.route('test/topic', Buffer.from(JSON.stringify(envelope)));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ action: OsppAction.BOOT_NOTIFICATION }));
  });

  it('onceAction() fires listener only once', () => {
    const router = new MessageRouter();
    const handler = vi.fn();
    router.onceAction(OsppAction.RESET, handler);

    const envelope = makeEnvelope(OsppAction.RESET);
    const buf = Buffer.from(JSON.stringify(envelope));

    router.route('test/topic', buf);
    router.route('test/topic', buf);

    expect(handler).toHaveBeenCalledOnce();
  });
});
