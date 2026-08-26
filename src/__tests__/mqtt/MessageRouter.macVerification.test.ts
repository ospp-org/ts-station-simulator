import { describe, it, expect, vi } from 'vitest';
import { MessageType, MessageSource, OsppAction, computeMac } from '@ospp/protocol';
import { MessageRouter } from '../../mqtt/MessageRouter.js';
import { conformantPayloadFor } from '../helpers/conformantPayloads.js';

// ---------------------------------------------------------------------------
// spec v0.11.0 §06-security.md:852 — "The signing path and the verification path
// MUST both fail closed. Neither peer may substitute an unsigned message for a
// signed one, and neither may accept an unverified message in place of a
// verified one."
//
// §06-security.md:858, receiving:
//   | `mac` missing on a non-exempt message | 1013 MAC_MISSING | Reject, do not
//     process it |
//   | verification fails                    | 1012             | Reject |
//   | No session key held for the peer      | 1013             | Reject. "A
//     receiver that holds no key cannot verify, and cannot therefore accept" |
//
// MessageRouter.route() parsed the envelope and emitted it. There was no MAC
// check of any kind — the simulator accepted anything that was valid JSON with
// an `action` field. That makes it useless as a conformance instrument for the
// one property the whole signing arc exists to establish: a forged command from
// anyone who can reach the broker would have been executed.
// ---------------------------------------------------------------------------

const SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'msg_00000000-0000-4000-8000-000000000001',
    messageType: MessageType.REQUEST,
    action: OsppAction.START_SERVICE,
    timestamp: new Date().toISOString(),
    source: MessageSource.CSMS,
    protocolVersion: '0.2.1',
    // A schema-conformant StartService payload: the router validates inbound
    // payloads now, and `{sessionId, bayId}` alone is missing four required
    // members, so the MAC verdict under test would have been masked by a
    // schema refusal.
    payload: conformantPayloadFor(OsppAction.START_SERVICE, MessageType.REQUEST),
    ...overrides,
  };
}

function signed(env: Record<string, unknown>, key = SESSION_KEY): Record<string, unknown> {
  return { ...env, mac: computeMac(key, env) };
}

function routerWith(key: string | null): { router: MessageRouter; seen: string[] } {
  const seen: string[] = [];
  const router = new MessageRouter(() => key);
  router.onAction(OsppAction.START_SERVICE, e => seen.push(e.messageId));

  return { router, seen };
}

describe('MessageRouter — inbound MAC verification', () => {
  it('accepts a correctly signed command', () => {
    const { router, seen } = routerWith(SESSION_KEY);

    router.route('t', Buffer.from(JSON.stringify(signed(envelope()))));

    expect(seen).toHaveLength(1);
  });

  it('REJECTS a command with no mac', () => {
    // 1013 MAC_MISSING. The station used to execute this.
    const { router, seen } = routerWith(SESSION_KEY);

    router.route('t', Buffer.from(JSON.stringify(envelope())));

    expect(seen).toHaveLength(0);
  });

  it('REJECTS a command whose mac does not verify', () => {
    // 1012 MAC_VERIFICATION_FAILED — a forgery, or a tampered payload.
    const { router, seen } = routerWith(SESSION_KEY);
    const forged = { ...signed(envelope()), payload: { sessionId: 'sess_EVIL', bayId: 'bay_1' } };

    router.route('t', Buffer.from(JSON.stringify(forged)));

    expect(seen).toHaveLength(0);
  });

  it('REJECTS a command signed with the wrong key', () => {
    const { router, seen } = routerWith(SESSION_KEY);
    const otherKey = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');

    router.route('t', Buffer.from(JSON.stringify(signed(envelope(), otherKey))));

    expect(seen).toHaveLength(0);
  });

  it('REJECTS everything when it holds no session key', () => {
    // "A receiver that holds no key cannot verify, and cannot therefore accept."
    const { router, seen } = routerWith(null);

    router.route('t', Buffer.from(JSON.stringify(signed(envelope()))));

    expect(seen).toHaveLength(0);
  });

  it('accepts the BootNotification RESPONSE unsigned — it CARRIES the key', () => {
    // §06-security.md:827, a structural exemption: "A MAC computed with the key
    // delivered inside the same message is cryptographically void." Rejecting it
    // would make the message that delivers the key unusable, so no station could
    // ever obtain one.
    const seen: string[] = [];
    const router = new MessageRouter(() => null);
    router.onAction(OsppAction.BOOT_NOTIFICATION, e => seen.push(e.messageId));

    router.route('t', Buffer.from(JSON.stringify(envelope({
      action: OsppAction.BOOT_NOTIFICATION,
      messageType: MessageType.RESPONSE,
      // The payload must match the ACTION being overridden — the default is a
      // StartService one. A BootNotification Response carrying StartService
      // fields is refused by the schema gate, which would have masked the MAC
      // exemption this test is about behind an unrelated refusal.
      payload: conformantPayloadFor(OsppAction.BOOT_NOTIFICATION, MessageType.RESPONSE),
    }))));

    expect(seen).toHaveLength(1);
  });

  it('a rejected message is not buffered either', () => {
    // drainBuffered() is what scenario wait_for steps read. A message that failed
    // verification must not be visible there — otherwise a scenario could assert
    // on a forgery and pass.
    const { router } = routerWith(SESSION_KEY);

    router.route('t', Buffer.from(JSON.stringify(envelope())));

    expect(router.drainBuffered(OsppAction.START_SERVICE)).toHaveLength(0);
  });

  it('logs the refusal rather than dropping it silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { router } = routerWith(SESSION_KEY);

    router.route('t', Buffer.from(JSON.stringify(envelope())));

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
