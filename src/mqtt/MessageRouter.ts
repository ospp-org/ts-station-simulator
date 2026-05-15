import { EventEmitter } from 'node:events';
import { type OsppEnvelope, OsppAction, type MessageType } from '@ospp/protocol';

type ActionHandler = (envelope: OsppEnvelope) => void;

export class MessageRouter extends EventEmitter {
  private readonly recentMessages: OsppEnvelope[] = [];
  private static readonly MAX_BUFFER = 50;

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

    this.recentMessages.push(envelope);
    if (this.recentMessages.length > MessageRouter.MAX_BUFFER) {
      this.recentMessages.shift();
    }
    this.emit(envelope.action, envelope);
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
