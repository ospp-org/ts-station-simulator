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

/** Fields under this prefix read off the live connection, not a received message — see below. */
const CONNECTION_FIELD_PREFIX = 'connection.';

export class AssertStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const field = definition.field as string;
    if (!field) {
      throw new Error('AssertStep requires a "field" field');
    }

    // "connection.*" is a transport-level assertion (e.g. the negotiated TLS
    // protocol version — TLS-1.2-floor conformance scenarios S1/S2) with no
    // OSPP message to read it off; resolve it against the live Station
    // instead of context.receivedMessages.
    let subject: unknown;
    let subjectField: string;
    if (field.startsWith(CONNECTION_FIELD_PREFIX)) {
      subject = { tlsProtocol: station.getNegotiatedTlsProtocol() };
      subjectField = field.slice(CONNECTION_FIELD_PREFIX.length);
    } else {
      const lastMessage = context.receivedMessages[context.receivedMessages.length - 1];
      if (!lastMessage) {
        throw new Error('AssertStep: no received messages to assert against');
      }
      subject = lastMessage;
      subjectField = field;
    }

    const actual = getNestedValue(subject, subjectField);

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
