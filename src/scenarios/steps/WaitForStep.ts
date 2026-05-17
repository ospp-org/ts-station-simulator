import { OsppAction, MessageType, type OsppEnvelope } from '@ospp/protocol';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

const ACTION_MAP: ReadonlyMap<string, OsppAction> = new Map(
  Object.entries(OsppAction).map(([, value]) => [value, value]),
);

function mapToOsppAction(name: string): OsppAction {
  const action = ACTION_MAP.get(name);
  if (!action) {
    throw new Error(`Unknown OSPP action: ${name}`);
  }
  return action;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Pick the OSPP messageId this WaitForStep should match against, per
 * Drift 7-E. OSPP correlates a Response to its Request via messageId
 * equality (envelope has no separate correlationId field).
 *
 * Order of precedence:
 *  1. Explicit `correlationId` on the YAML step → use as-is.
 *  2. `messageType === Response` → FIFO scan of `context.sentMessages`
 *     for the first Request of the same action whose messageId hasn't
 *     yet been claimed by an earlier WaitForStep.
 *  3. Otherwise undefined — fall back to first-match-wins on action+type
 *     (Request waits are server-initiated; no outbound to correlate to).
 */
function pickExpectedMessageId(
  context: ScenarioContext,
  action: OsppAction,
  messageType: string | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit) return explicit;
  if (messageType !== MessageType.RESPONSE) return undefined;
  for (const sent of context.sentMessages) {
    if (
      sent.action === action &&
      sent.messageType === MessageType.REQUEST &&
      !context.consumedSentMessageIds.has(sent.messageId)
    ) {
      return sent.messageId;
    }
  }
  return undefined;
}

export class WaitForStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const messageName = definition.message as string;
    if (!messageName) {
      throw new Error('WaitForStep requires a "message" field');
    }

    const action = mapToOsppAction(messageName);
    const messageType = definition.messageType as string | undefined;
    // 15s default gives ~30-50x headroom over typical ~300ms round-trip post-bridge-fix
    // (commit 44f81d1 in csms-mqtt-bridge). Scenarios needing tighter assertion
    // should set timeout_ms explicitly in YAML.
    const timeoutMs = (definition.timeout_ms as number) ?? 15000;
    const explicitCorrelation = definition.correlationId as string | undefined;

    const expectedMessageId = pickExpectedMessageId(
      context,
      action,
      messageType,
      explicitCorrelation,
    );

    const matches = (env: OsppEnvelope): boolean => {
      if (messageType && env.messageType !== (messageType as MessageType)) {
        return false;
      }
      if (expectedMessageId && env.messageId !== expectedMessageId) {
        return false;
      }
      return true;
    };

    const envelope = await new Promise<OsppEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        station.router.offAction(action, handler);
        const corrSuffix = expectedMessageId
          ? ` (correlationId=${expectedMessageId})`
          : '';
        reject(
          new Error(
            `Timeout waiting for ${messageName}${messageType ? ` ${messageType}` : ''}${corrSuffix} after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const handler = (env: OsppEnvelope): void => {
        if (!matches(env)) return;
        clearTimeout(timer);
        station.router.offAction(action, handler);
        // Drain any other correlated duplicates so they don't linger.
        // Non-correlated buffered envelopes remain available for future
        // WaitForSteps awaiting their own correlationId.
        station.router.drainBuffered(
          action,
          messageType as MessageType | undefined,
          expectedMessageId,
        );
        resolve(env);
      };

      const buffered = station.router.drainBuffered(
        action,
        messageType as MessageType | undefined,
        expectedMessageId,
      );
      const match = buffered[0];
      if (match) {
        clearTimeout(timer);
        resolve(match);
        return;
      }

      station.router.onAction(action, handler);
    });

    context.receivedMessages.push(envelope);
    if (expectedMessageId && !explicitCorrelation) {
      context.consumedSentMessageIds.add(expectedMessageId);
    }

    if (definition.capture && typeof definition.capture === 'object') {
      for (const [varName, path] of Object.entries(
        definition.capture as Record<string, string>,
      )) {
        const value = getNestedValue(envelope, path);
        context.captured.set(varName, value);
      }
    }
  }
}
