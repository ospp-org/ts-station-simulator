import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouter } from '../../mqtt/MessageRouter.js';
import {
  computeMac,
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
} from '@ospp/protocol';
import type { OsppEnvelope } from '@ospp/protocol';

const TEST_SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function envelopeOf(
  action: OsppAction,
  messageType: MessageType,
  payload: unknown,
  messageId = 'msg-001',
): OsppEnvelope {
  return {
    messageId,
    messageType,
    action,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload,
  } as OsppEnvelope;
}

function wire(envelope: OsppEnvelope): Buffer {
  return Buffer.from(
    JSON.stringify({ ...envelope, mac: computeMac(TEST_SESSION_KEY, envelope) }),
  );
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('MessageRouter — inbound schema conformance', () => {
  /**
   * THE CANARY, and it is not invented.
   *
   * csms-server shipped exactly these bytes for months. PHP has one array type,
   * so `json_encode([])` is `[]`; a GetConfiguration with no keys serialised its
   * empty payload as a JSON ARRAY where every payload schema says `"type":
   * "object"`. The line meant to prevent it (MqttStationGateway:172,
   * `$envelope->payload === [] ? '{}' : $envelope->payload`) rewrote only the
   * value handed to the validator, while `publish()` serialised the untouched
   * array — so the server's own gate went green on bytes it never inspected.
   * Fixed server-side in `abebd749`, found by a NEW gate there, on the published
   * bytes.
   *
   * This suite is the instrument that is supposed to catch that before real
   * firmware meets it, and it could not: the router cast the JSON to
   * `OsppEnvelope` and emitted it, and the scenario asserted one field that
   * happened to be fine. This test is the proof that it now can.
   */
  it('CANARY: refuses the real GetConfiguration `payload: []` that shipped for months', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'strict' });
    const handler = vi.fn();
    router.onAction(OsppAction.GET_CONFIGURATION, handler);

    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, [])),
    );

    expect(handler).not.toHaveBeenCalled();
    // Not buffered either: `drainBuffered` is what wait_for reads, so a refused
    // message left there would still let a scenario assert on it and pass.
    expect(router.drainBuffered(OsppAction.GET_CONFIGURATION)).toHaveLength(0);

    expect(router.schemaViolations).toHaveLength(1);
    const v = router.schemaViolations[0];
    expect(v.schemaKey).toBe('get-configuration-request');
    expect(v.errors.join(' ')).toContain('must be object');
    expect(v.payload).toEqual([]);
  });

  /**
   * The CONFORMANT control. Without it the canary above proves only that this
   * router refuses things, not that it discriminates — a matcher that refused
   * every GetConfiguration would pass that test and be worthless.
   */
  it('CONTROL: accepts the same message with the conforming empty object', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'strict' });
    const handler = vi.fn();
    router.onAction(OsppAction.GET_CONFIGURATION, handler);

    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, {})),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(router.schemaViolations).toHaveLength(0);
  });

  /**
   * The VOCABULARY control. `[]` vs `{}` is one shape; an instrument keyed only
   * to that shape would be blind to every other way a payload goes wrong. This
   * pins a violation of a different kind — wrong member type — and a third of a
   * third kind below (unknown member).
   */
  it('CONTROL: refuses a wrong member TYPE, not just the wrong container shape', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'strict' });
    const handler = vi.fn();
    router.onAction(OsppAction.GET_CONFIGURATION, handler);

    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, { keys: 'all' })),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(router.schemaViolations[0].errors.join(' ')).toContain('must be array');
  });

  it('CONTROL: refuses an unknown member (additionalProperties: false)', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'strict' });
    const handler = vi.fn();
    router.onAction(OsppAction.RESET, handler);

    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.RESET, MessageType.REQUEST, { force: true, mode: 'Hard' })),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(router.schemaViolations[0].schemaKey).toBe('reset-request');
    expect(router.schemaViolations[0].errors.join(' ')).toContain('additional properties');
  });

  it('CONTROL: refuses a missing REQUIRED member on a response', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'strict' });
    const handler = vi.fn();
    router.onAction(OsppAction.BOOT_NOTIFICATION, handler);

    // BootNotification Response is MAC-exempt (it carries the key), so this also
    // proves the schema gate is independent of the MAC gate rather than riding on it.
    router.route(
      'to-station',
      Buffer.from(
        JSON.stringify(
          envelopeOf(OsppAction.BOOT_NOTIFICATION, MessageType.RESPONSE, {
            status: 'Accepted',
            serverTime: new Date().toISOString(),
            // heartbeatIntervalSec and sessionKey both omitted
          }),
        ),
      ),
    );

    expect(handler).not.toHaveBeenCalled();
    const errors = router.schemaViolations[0].errors.join(' ');
    expect(errors).toContain('heartbeatIntervalSec');
    expect(errors).toContain('sessionKey');
  });

  describe('modes', () => {
    it('warn: records the violation AND delivers the message', () => {
      const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'warn' });
      const handler = vi.fn();
      router.onAction(OsppAction.GET_CONFIGURATION, handler);

      router.route(
        'to-station',
        wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, [])),
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(router.schemaViolations).toHaveLength(1);
    });

    it('off: neither records nor refuses — the pre-change behaviour, kept reachable', () => {
      const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'off' });
      const handler = vi.fn();
      router.onAction(OsppAction.GET_CONFIGURATION, handler);

      router.route(
        'to-station',
        wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, [])),
      );

      expect(handler).toHaveBeenCalledOnce();
      expect(router.schemaViolations).toHaveLength(0);
    });

    it('defaults to strict when no mode is passed', () => {
      const router = new MessageRouter(() => TEST_SESSION_KEY);
      const handler = vi.fn();
      router.onAction(OsppAction.GET_CONFIGURATION, handler);

      router.route(
        'to-station',
        wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, [])),
      );

      expect(handler).not.toHaveBeenCalled();
    });
  });

  /**
   * "I cannot check this" must not read as "this checks out". An unmapped pair
   * is delivered — refusing it would break messages the SDK simply has no schema
   * for — but it is announced, so a hole in the gate is visible in the log
   * rather than inferred from a suspiciously quiet run.
   */
  it('an unmapped (action, messageType) is delivered, announced, and NOT counted as a violation', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'strict' });
    const handler = vi.fn();
    router.onAction(OsppAction.HEARTBEAT, handler);

    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.HEARTBEAT, MessageType.EVENT, { anything: 1 })),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(router.schemaViolations).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('UNMAPPED'),
      ...Array(4).fill(expect.anything()),
    );
  });

  it('violationsFor() filters by action and messageType', () => {
    const router = new MessageRouter(() => TEST_SESSION_KEY, { schemaMode: 'warn' });
    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.GET_CONFIGURATION, MessageType.REQUEST, [], 'a')),
    );
    router.route(
      'to-station',
      wire(envelopeOf(OsppAction.RESET, MessageType.REQUEST, { nope: 1 }, 'b')),
    );

    expect(router.violationsFor(OsppAction.GET_CONFIGURATION)).toHaveLength(1);
    expect(router.violationsFor(OsppAction.RESET, MessageType.REQUEST)).toHaveLength(1);
    expect(router.violationsFor(OsppAction.RESET, MessageType.RESPONSE)).toHaveLength(0);
  });
});
