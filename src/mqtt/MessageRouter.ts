import { EventEmitter } from 'node:events';
import {
  type OsppEnvelope,
  OsppAction,
  type MessageType,
  requiresMac,
  verifyMac,
} from '@ospp/protocol';
import {
  DEFAULT_INBOUND_SCHEMA_MODE,
  echoPayload,
  type InboundSchemaMode,
  type InboundSchemaViolation,
  validateInbound,
} from './inboundSchema.js';

type ActionHandler = (envelope: OsppEnvelope) => void;

export interface MessageRouterOptions {
  /** See InboundSchemaMode. Defaults to `strict` — fail closed, like the MAC gate. */
  schemaMode?: InboundSchemaMode;
}

export class MessageRouter extends EventEmitter {
  private readonly recentMessages: OsppEnvelope[] = [];
  private static readonly MAX_BUFFER = 50;

  /**
   * Every inbound message this router refused (or, in `warn` mode, would have
   * refused) for not matching its schema.
   *
   * Kept rather than only logged because a refusal is invisible at the step
   * level: the message is not emitted, so the `wait_for` expecting it simply
   * times out, and "Timeout waiting for GetConfiguration Request" names the
   * wrong culprit. WaitForStep reads this list on timeout and reports the schema
   * errors instead — the difference between a scenario that says the server is
   * slow and one that says the server sent `payload: []`.
   */
  private readonly schemaViolationLog: InboundSchemaViolation[] = [];

  private readonly schemaMode: InboundSchemaMode;

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

  constructor(
    getSessionKey: () => string | null = () => null,
    options: MessageRouterOptions = {},
  ) {
    super();
    this.getSessionKey = getSessionKey;
    this.schemaMode = options.schemaMode ?? DEFAULT_INBOUND_SCHEMA_MODE;
  }

  /** Refusals recorded so far, oldest first. */
  get schemaViolations(): readonly InboundSchemaViolation[] {
    return this.schemaViolationLog;
  }

  /** The violations recorded for one action, for step-level attribution. */
  violationsFor(action: OsppAction, messageType?: MessageType): InboundSchemaViolation[] {
    return this.schemaViolationLog.filter(
      (v) => v.action === action && (!messageType || v.messageType === messageType),
    );
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

    // AFTER the MAC gate, deliberately. A forgery is already refused above, and
    // schema-reporting one would file a server defect against bytes the server
    // never sent. What reaches here is what this station accepts as authentic —
    // so a violation found here IS a conformance defect in the peer.
    if (!this.conformant(topic, envelope)) {
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

  /**
   * Validate the payload against the schema its own (action, messageType) names.
   *
   * Returns false only in `strict` mode: a non-conformant message is then
   * neither emitted NOR buffered, for the same reason a failed MAC is not —
   * `drainBuffered()` is what `wait_for` reads, so leaving it there would let a
   * scenario assert on a malformed message and pass, which is the whole defect
   * this closes.
   *
   * An UNMAPPED pair is reported and let through. It is not evidence of
   * non-conformance — it is evidence this router has no schema to judge by — and
   * silently treating "I cannot check" as "it checks out" is how a gate goes
   * blind across an SDK rename. inboundSchema.keys.test.ts pins the mapping so
   * that rename reds a test instead.
   */
  private conformant(topic: string, envelope: OsppEnvelope): boolean {
    if (this.schemaMode === 'off') return true;

    const verdict = validateInbound(envelope);
    if (verdict.kind === 'conformant') return true;

    if (verdict.kind === 'unmapped') {
      console.warn(
        '[MessageRouter] UNMAPPED %s %s on %s: %s — payload NOT schema-checked',
        String(envelope.action),
        String(envelope.messageType),
        topic,
        verdict.reason,
      );
      return true;
    }

    const refused = this.schemaMode === 'strict';
    this.schemaViolationLog.push({
      topic,
      action: String(envelope.action),
      messageType: String(envelope.messageType),
      messageId: String(envelope.messageId),
      schemaKey: verdict.schemaKey,
      errors: verdict.errors,
      payload: envelope.payload,
      refused,
    });

    const verb = refused ? 'REFUSED' : 'NONCONFORMANT (warn mode, delivered anyway)';
    console.warn(
      '[MessageRouter] %s %s %s on %s: payload violates %s — %s | payload=%s',
      verb,
      String(envelope.action),
      String(envelope.messageType),
      topic,
      verdict.schemaKey,
      verdict.errors.join('; '),
      echoPayload(envelope.payload),
    );

    return !refused;
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
