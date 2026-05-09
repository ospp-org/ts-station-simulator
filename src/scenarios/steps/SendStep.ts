import crypto from 'node:crypto';
import { OsppAction, MessageType } from '@ospp/protocol';
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

function mapToMessageType(name: string | undefined): MessageType {
  if (!name) return MessageType.REQUEST;
  const upper = name as MessageType;
  if (Object.values(MessageType).includes(upper)) {
    return upper;
  }
  throw new Error(`Unknown message type: ${name}`);
}

function substituteTemplateValue(
  value: string,
  context: ScenarioContext,
): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const trimmed = varName.trim();
    if (trimmed.startsWith('captured.')) {
      const captureKey = trimmed.slice('captured.'.length);
      const captured = context.captured.get(captureKey);
      if (captured === undefined) {
        throw new Error(`Captured variable not found: ${captureKey}`);
      }
      return String(captured);
    }
    const variable = context.variables.get(trimmed);
    if (variable === undefined) {
      throw new Error(`Template variable not found: ${trimmed}`);
    }
    return variable;
  });
}

function substituteTemplates(
  value: unknown,
  context: ScenarioContext,
): unknown {
  if (typeof value === 'string') {
    return substituteTemplateValue(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplates(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteTemplates(val, context);
    }
    return result;
  }
  return value;
}

/**
 * v0.4.0 ordering-field auto-injection.
 *
 * - MeterValues Event: stamp seqNo from session counter (if YAML omits), then advance counter.
 * - SessionEnded Event: stamp seqNo + finalSeqNo from session counter (if YAML omits).
 * - StopService Accepted Response: stamp finalSeqNo from session counter (if YAML omits).
 *
 * Explicit YAML values always win — needed for negative tests that emit late
 * MeterValues with seqNo > finalSeqNo.
 */
function injectSeqNoFields(
  action: OsppAction,
  msgType: MessageType,
  payload: Record<string, unknown>,
  station: Station,
): void {
  const sessionId = payload.sessionId;
  if (typeof sessionId !== 'string') return;
  const session = station.sessions.get(sessionId);
  if (!session) return;

  if (action === OsppAction.METER_VALUES && msgType === MessageType.EVENT) {
    if (payload.seqNo === undefined) payload.seqNo = session.seqNo;
    const used = payload.seqNo as number;
    session.seqNo = used + 1;
    return;
  }
  if (action === OsppAction.SESSION_ENDED && msgType === MessageType.EVENT) {
    if (payload.seqNo === undefined) payload.seqNo = session.seqNo;
    if (payload.finalSeqNo === undefined) payload.finalSeqNo = session.seqNo;
    return;
  }
  if (action === OsppAction.STOP_SERVICE && msgType === MessageType.RESPONSE) {
    if (payload.status === 'Accepted' && payload.finalSeqNo === undefined) {
      payload.finalSeqNo = session.seqNo;
    }
  }
}

export class SendStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const messageName = definition.message as string;
    if (!messageName) {
      throw new Error('SendStep requires a "message" field');
    }

    const action = mapToOsppAction(messageName);
    const messageType = mapToMessageType(definition.messageType as string | undefined);
    const rawPayload = (definition.payload as Record<string, unknown>) ?? {};
    const payload = substituteTemplates(rawPayload, context) as Record<string, unknown>;

    injectSeqNoFields(action, messageType, payload, station);

    const envelope = await station.sender.send(
      action,
      messageType,
      payload,
      (definition.correlationId as string | undefined) ?? crypto.randomUUID(),
    );

    context.sentMessages.push(envelope);
  }
}
