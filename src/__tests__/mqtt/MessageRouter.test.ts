import { describe, it, expect, vi } from 'vitest';
import { MessageRouter } from '../../mqtt/MessageRouter.js';
import { computeMac, OsppAction, MessageType, MessageSource, OSPP_PROTOCOL_VERSION } from '@ospp/protocol';
import type { OsppEnvelope } from '@ospp/protocol';

// The router verifies inbound MACs now and fails closed, so these routing tests
// sign their envelopes rather than bypass the check. Signing here is not the
// subject — routing and correlation are — but an unsigned envelope is no longer
// routable at all, which is the point of the change.
const TEST_SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function makeEnvelope(
  action: OsppAction,
  overrides: Partial<OsppEnvelope> = {},
): OsppEnvelope {
  return {
    messageId: 'msg-001',
    messageType: MessageType.REQUEST,
    action,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {},
    ...overrides,
  };
}

describe('MessageRouter', () => {
  it('parses valid JSON buffer and emits action event', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY);
    const envelope = makeEnvelope(OsppAction.HEARTBEAT);
    const handler = vi.fn();
    router.on(OsppAction.HEARTBEAT, handler);

    router.route('test/topic', Buffer.from(JSON.stringify({ ...envelope, mac: computeMac(TEST_SESSION_KEY, envelope) })));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ action: OsppAction.HEARTBEAT }));
  });

  it('handles invalid JSON gracefully (no throw)', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY);
    expect(() => {
      router.route('test/topic', Buffer.from('not json'));
    }).not.toThrow();
  });

  it('handles missing action field gracefully', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY);
    const payload = { messageId: 'msg-001', payload: {} };
    expect(() => {
      router.route('test/topic', Buffer.from(JSON.stringify({ ...payload, mac: computeMac(TEST_SESSION_KEY, payload) })));
    }).not.toThrow();
  });

  it('onAction() registers typed listener', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY);
    const handler = vi.fn();
    router.onAction(OsppAction.BOOT_NOTIFICATION, handler);

    const envelope = makeEnvelope(OsppAction.BOOT_NOTIFICATION);
    router.route('test/topic', Buffer.from(JSON.stringify({ ...envelope, mac: computeMac(TEST_SESSION_KEY, envelope) })));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ action: OsppAction.BOOT_NOTIFICATION }));
  });

  it('onceAction() fires listener only once', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY);
    const handler = vi.fn();
    router.onceAction(OsppAction.RESET, handler);

    const envelope = makeEnvelope(OsppAction.RESET);
    const buf = Buffer.from(JSON.stringify({ ...envelope, mac: computeMac(TEST_SESSION_KEY, envelope) }));

    router.route('test/topic', buf);
    router.route('test/topic', buf);

    expect(handler).toHaveBeenCalledOnce();
  });

  describe('drainBuffered — Drift 7-E messageId filter', () => {
    it('returns only envelopes matching the given messageId; leaves non-matches buffered', () => {
      const router = new MessageRouter(() => TEST_SESSION_KEY);
      const a = makeEnvelope(OsppAction.BOOT_NOTIFICATION, {
        messageId: 'req-A',
        messageType: MessageType.RESPONSE,
      });
      const b = makeEnvelope(OsppAction.BOOT_NOTIFICATION, {
        messageId: 'req-B',
        messageType: MessageType.RESPONSE,
      });
      router.route('test/topic', Buffer.from(JSON.stringify({ ...a, mac: computeMac(TEST_SESSION_KEY, a) })));
      router.route('test/topic', Buffer.from(JSON.stringify({ ...b, mac: computeMac(TEST_SESSION_KEY, b) })));

      const drainedA = router.drainBuffered(
        OsppAction.BOOT_NOTIFICATION,
        MessageType.RESPONSE,
        'req-A',
      );
      expect(drainedA).toHaveLength(1);
      expect(drainedA[0].messageId).toBe('req-A');

      // B should remain in the buffer for a later wait.
      const drainedB = router.drainBuffered(
        OsppAction.BOOT_NOTIFICATION,
        MessageType.RESPONSE,
        'req-B',
      );
      expect(drainedB).toHaveLength(1);
      expect(drainedB[0].messageId).toBe('req-B');
    });

    it('without messageId filter, drains all matches (back-compat)', () => {
      const router = new MessageRouter(() => TEST_SESSION_KEY);
      const a = makeEnvelope(OsppAction.HEARTBEAT, { messageId: 'x' });
      const b = makeEnvelope(OsppAction.HEARTBEAT, { messageId: 'y' });
      router.route('test/topic', Buffer.from(JSON.stringify({ ...a, mac: computeMac(TEST_SESSION_KEY, a) })));
      router.route('test/topic', Buffer.from(JSON.stringify({ ...b, mac: computeMac(TEST_SESSION_KEY, b) })));

      const drained = router.drainBuffered(OsppAction.HEARTBEAT);
      expect(drained).toHaveLength(2);
      // buffer is now empty
      expect(router.drainBuffered(OsppAction.HEARTBEAT)).toHaveLength(0);
    });
  });
});
