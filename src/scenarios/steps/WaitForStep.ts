import { OsppAction, type OsppEnvelope, type MessageType } from '@ospp/protocol';
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
    const timeoutMs = (definition.timeout_ms as number) ?? 5000;

    const envelope = await new Promise<OsppEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        station.router.offAction(action, handler);
        reject(
          new Error(
            `Timeout waiting for ${messageName}${messageType ? ` ${messageType}` : ''} after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const handler = (env: OsppEnvelope): void => {
        if (!messageType || env.messageType === (messageType as MessageType)) {
          clearTimeout(timer);
          station.router.offAction(action, handler);
          station.router.drainBuffered(action, messageType as MessageType | undefined);
          resolve(env);
        }
      };

      // Check buffer for messages that arrived before this listener was registered
      const buffered = station.router.drainBuffered(action, messageType as MessageType | undefined);
      const match = buffered[0];
      if (match) {
        clearTimeout(timer);
        resolve(match);
        return;
      }

      station.router.onAction(action, handler);
    });

    context.receivedMessages.push(envelope);

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
