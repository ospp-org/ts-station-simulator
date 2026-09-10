import { getNestedValue } from './ApiCallStep.js';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * `getNestedValue` is IMPORTED rather than kept local, and the difference is a capability,
 * not a tidy-up.
 *
 * This file carried its own copy: `path.split('.')` and plain key indexing, with no array
 * selector. So an `assert` could only reach into an array BY POSITION — `payload.services.0`
 * — which pins whichever element the server happened to order first. The api_call side had
 * already learned that lesson the expensive way (see the comment on ARRAY_SELECTOR_RE: three
 * consecutive reads of `data.bays` came back [2,3,4,1], [2,3,4,1], [3,4,1,2]) and grew
 * `name[field=value]` plus a splitter that does not tear a selector apart on a dotted VALUE.
 *
 * Two resolvers for one path syntax meant an assertion's power depended on which step it was
 * written in, which nothing in the YAML makes visible. The imported one is a strict superset
 * — identical null/non-object guards, identical plain-key indexing — so every existing
 * `field:` keeps resolving exactly as before, and `field: payload.services[serviceId=svc_dry]`
 * now resolves at all.
 */

/**
 * The fields a peer uses to say WHY it refused, in the order a reader wants them.
 *
 * A refusal is reported on `payload.status`, but the reason lives in siblings the assertion
 * never compared. `security/offline-pass-authorize` failed in 4 of 6 full runs with nothing but
 * `expected "payload.status" to equal "Accepted", but got "Rejected"` — while the frame in hand
 * carried `payload.reason`, one string per check in the server's PassValidator. Six runs
 * produced no attribution because the explanation was discarded at the moment of failure.
 */
const REFUSAL_FIELDS = ['reason', 'errorCode', 'errorText'] as const;

/**
 * `reason=... errorCode=...` for whatever the frame actually carries, or '' for a frame that
 * carries none.
 *
 * The empty case matters as much as the populated one: appending a placeholder to every ordinary
 * assertion failure would bury the signal this exists to surface, so absence stays silent.
 */
function refusalContext(subject: unknown): string {
  if (subject === null || typeof subject !== 'object') return '';
  const payload = (subject as Record<string, unknown>).payload;
  if (payload === null || typeof payload !== 'object') return '';

  const parts: string[] = [];
  for (const key of REFUSAL_FIELDS) {
    const value = (payload as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) parts.push(`${key}=${JSON.stringify(value)}`);
  }

  return parts.length === 0 ? '' : ` — the peer said: ${parts.join(' ')}`;
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
      // Transport-level facts with no OSPP message behind them: the negotiated
      // TLS version (TLS-1.2-floor arc) and the severance state (ADR-0004
      // TIER 1 — kicked / banned / un-banned).
      subject = {
        tlsProtocol: station.getNegotiatedTlsProtocol(),
        ...station.getSeverance(),
      };
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
          `Assertion failed: expected field "${field}" to exist, but it is ${String(actual)}` +
            refusalContext(subject),
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
          `Assertion failed: expected "${field}" to equal ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}` +
            refusalContext(subject),
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
