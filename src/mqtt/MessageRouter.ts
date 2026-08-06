import { EventEmitter } from 'node:events';
import {
  type OsppEnvelope,
  OsppAction,
  type MessageType,
  requiresMac,
  verifyMac,
} from '@ospp/protocol';

type ActionHandler = (envelope: OsppEnvelope) => void;

export class MessageRouter extends EventEmitter {
  private readonly recentMessages: OsppEnvelope[] = [];
  private static readonly MAX_BUFFER = 50;

  /**
   * The session key the station currently holds, or null before boot.
   *
   * spec v0.11.0 §06-security.md:852 — "The signing path and the verification
   * path MUST both fail closed." This router used to parse an envelope and emit
   * it with no MAC check of any kind, so the simulator executed any command that
   * was valid JSON with an `action` field. As a conformance instrument that made
   * it useless for the one property the signing arc exists to establish.
   */
  private readonly getSessionKey: () => string | null;

  constructor(getSessionKey: () => string | null = () => null) {
    super();
    this.getSessionKey = getSessionKey;
  }

  /**
   * The key this router would verify with, right now.
   *
   * Exists so the WIRING can be asserted. The verification below was built with
   * a `getSessionKey` parameter and Station.ts constructed the router without
   * one, taking the `() => null` default — so the station stored its key and the
   * router could never see it. Every unit test passed, because they construct
   * this class directly WITH a getter; only a test that reads the key back
   * through the router itself can see the difference.
   */
  currentSessionKey(): string | null {
    return this.getSessionKey();
  }

  /**
   * Remove and return buffered messages matching action (and optionally
   * messageType and messageId). Non-matching envelopes remain in the
   * buffer so a later WaitForStep waiting on a different correlationId
   * can still find them. Pass `messageId` to filter by OSPP-wire
   * correlation (Response.messageId === Request.messageId).
   */
  drainBuffered(
    action: OsppAction,
    messageType?: MessageType,
    messageId?: string,
  ): OsppEnvelope[] {
    const matched: OsppEnvelope[] = [];
    for (let i = this.recentMessages.length - 1; i >= 0; i--) {
      const msg = this.recentMessages[i];
      if (
        msg.action === action &&
        (!messageType || msg.messageType === messageType) &&
        (!messageId || msg.messageId === messageId)
      ) {
        matched.push(...this.recentMessages.splice(i, 1));
      }
    }
    return matched;
  }

  route(topic: string, payload: Buffer): void {
    let envelope: OsppEnvelope;
    try {
      envelope = JSON.parse(payload.toString()) as OsppEnvelope;
    } catch (err) {
      console.warn(
        '[MessageRouter] Failed to parse inbound message on topic %s: %s',
        topic,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (!envelope.action) {
      console.warn(
        '[MessageRouter] Inbound message on topic %s has no action field',
        topic,
      );
      return;
    }

    if (!this.verified(topic, envelope)) {
      return;
    }

    this.recentMessages.push(envelope);
    if (this.recentMessages.length > MessageRouter.MAX_BUFFER) {
      this.recentMessages.shift();
    }
    this.emit(envelope.action, envelope);
  }

  /**
   * Fail closed, per §06-security.md:858. A refused message is neither emitted
   * NOR buffered — `drainBuffered()` is what scenario `wait_for` steps read, so
   * leaving a forgery there would let a scenario assert on it and pass.
   *
   * The refusal is logged rather than dropped silently: §5.7 forbids both
   * publishing unsigned and dropping without a record, and a station that goes
   * quiet for an unexplained reason is the failure mode operators cannot debug.
   */
  private verified(topic: string, envelope: OsppEnvelope): boolean {
    // The three structural exemptions cannot carry a verifiable MAC. The
    // BootNotification RESPONSE is the load-bearing one: it CARRIES the session
    // key, so a MAC computed with that key is cryptographically void — and
    // refusing it would make the message that delivers the key unusable.
    if (!requiresMac(envelope.action, envelope.messageType)) {
      return true;
    }

    const key = this.getSessionKey();
    if (key === null) {
      console.warn(
        '[MessageRouter] REFUSED %s on %s: no session key held, so it cannot be verified (1013 MAC_MISSING)',
        envelope.action,
        topic,
      );

      return false;
    }

    if (typeof envelope.mac !== 'string' || envelope.mac === '') {
      console.warn(
        '[MessageRouter] REFUSED %s on %s: mac field missing on a message that must carry one (1013 MAC_MISSING)',
        envelope.action,
        topic,
      );

      return false;
    }

    if (!verifyMac(key, envelope as unknown as Record<string, unknown>)) {
      console.warn(
        '[MessageRouter] REFUSED %s on %s: mac did not verify (1012 MAC_VERIFICATION_FAILED)',
        envelope.action,
        topic,
      );

      return false;
    }

    return true;
  }

  onAction(action: OsppAction, callback: ActionHandler): this {
    return super.on(action, callback as (...args: unknown[]) => void);
  }

  onceAction(action: OsppAction, callback: ActionHandler): this {
    return super.once(action, callback as (...args: unknown[]) => void);
  }

  offAction(action: OsppAction, callback: ActionHandler): this {
    return super.off(action, callback as (...args: unknown[]) => void);
  }
}
