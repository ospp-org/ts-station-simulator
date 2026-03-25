import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

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

export class AssertStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    _station: Station,
  ): Promise<void> {
    const field = definition.field as string;
    if (!field) {
      throw new Error('AssertStep requires a "field" field');
    }

    const lastMessage = context.receivedMessages[context.receivedMessages.length - 1];
    if (!lastMessage) {
      throw new Error('AssertStep: no received messages to assert against');
    }

    const actual = getNestedValue(lastMessage, field);

    if (definition.exists !== undefined) {
      const shouldExist = definition.exists as boolean;
      const doesExist = actual !== undefined && actual !== null;
      if (shouldExist && !doesExist) {
        throw new Error(
          `Assertion failed: expected field "${field}" to exist, but it is ${String(actual)}`,
        );
      }
      if (!shouldExist && doesExist) {
        throw new Error(
          `Assertion failed: expected field "${field}" to not exist, but got ${JSON.stringify(actual)}`,
        );
      }
    }

    if (definition.equals !== undefined) {
      const expected = definition.equals;
      if (!deepEqual(actual, expected)) {
        throw new Error(
          `Assertion failed: expected "${field}" to equal ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`,
        );
      }
    }

    if (definition.contains !== undefined) {
      const expected = definition.contains as string;
      const actualStr = String(actual);
      if (!actualStr.includes(expected)) {
        throw new Error(
          `Assertion failed: expected "${field}" to contain "${expected}", but got "${actualStr}"`,
        );
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
