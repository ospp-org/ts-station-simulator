/**
 * Schema conformance for messages the station RECEIVES.
 *
 * The router used to accept any inbound message that was valid JSON and carried
 * an `action` field. Everything past that point was a TypeScript cast — a
 * compile-time claim about bytes that arrive at run time — so a server→station
 * message that was subtly non-conformant executed exactly like a conformant one,
 * and a scenario passed as long as the ONE field it asserted happened to be
 * right.
 *
 * That is not hypothetical. csms-server shipped `"payload":[]` for a
 * GetConfiguration with no keys for months (`abebd749`): PHP cannot express an
 * empty JSON object as an array, and the line meant to fix it rewrote the value
 * handed to the VALIDATOR while `publish()` went on serialising the untouched
 * array. It was caught by a new gate on the server, on the published bytes —
 * never by this suite, which is the instrument that exists to catch it before
 * real firmware does. See MessageRouter.inboundSchema.test.ts, which pins that
 * exact payload as the canary.
 *
 * Nothing here is new machinery. `SchemaValidator` and all 47 message schemas
 * ship vendored inside `@ospp/protocol`, and PayloadSchemaCheck already runs the
 * same validator over OUTBOUND payloads at lint time. This wires the inbound
 * half to the same schemas.
 */
import { OsppAction, MessageType, type OsppEnvelope } from '@ospp/protocol';
import { SchemaValidator } from '@ospp/protocol/server';

/**
 * What the router does with a message whose payload does not match its schema.
 *
 * `strict` is the default and fails closed, matching the inbound MAC gate three
 * lines above it in the router: a message that cannot be shown to conform is not
 * emitted and not buffered, so no `wait_for` can assert on it and pass.
 *
 * `warn` exists for ONE purpose — measuring a corpus before arming the gate on
 * it — and is a known-degraded mode, not a resting state. A run mode that turns
 * a mismatch into a console line is the exact shape that left 37 `expect_status`
 * assertions unable to fire; it is spelled out here so nobody adopts it by
 * default without noticing that is what they are doing.
 */
export type InboundSchemaMode = 'off' | 'warn' | 'strict';

export const DEFAULT_INBOUND_SCHEMA_MODE: InboundSchemaMode = 'strict';

/** Environment override, read by the CLI and by Station construction. */
export const INBOUND_SCHEMA_ENV = 'OSPP_SIM_INBOUND_SCHEMA';

const MODES: readonly InboundSchemaMode[] = ['off', 'warn', 'strict'];

/**
 * Parse the mode, THROWING on anything unrecognised.
 *
 * Deliberately not a `?? default` fallback: an unrecognised value there would
 * silently resolve to the default, so `OSPP_SIM_INBOUND_SCHEMA=stict` would
 * disable nothing and report nothing, and a run whose whole purpose was to
 * measure in `warn` would quietly measure in `strict` instead. A gate that can
 * be turned off by a typo is not a gate.
 */
export function resolveInboundSchemaMode(
  raw: string | undefined = process.env[INBOUND_SCHEMA_ENV],
): InboundSchemaMode {
  if (raw === undefined || raw === '') return DEFAULT_INBOUND_SCHEMA_MODE;
  const normalised = raw.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(normalised)) {
    return normalised as InboundSchemaMode;
  }
  throw new Error(
    `${INBOUND_SCHEMA_ENV}="${raw}" is not a valid inbound schema mode. ` +
      `Expected one of: ${MODES.join(', ')}.`,
  );
}

/**
 * Actions whose Event form is keyed with an `-event` suffix. Every other event
 * is keyed by its bare kebab name (`status-notification`, `security-event`,
 * `connection-lost`, `firmware-status-notification`, `diagnostics-notification`).
 *
 * This split is the spec's, not a convention worth inferring: `security-event`
 * already ends in the word, and suffixing it would produce a key that does not
 * exist. Mirrors PayloadSchemaCheck.toSchemaKey, which maps the outbound half.
 */
const EVENT_SUFFIX_ACTIONS: ReadonlySet<OsppAction> = new Set([
  OsppAction.METER_VALUES,
  OsppAction.SESSION_ENDED,
]);

function toKebab(action: string): string {
  return action.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The schema key for an (action, messageType) pair, or null when the pair names
 * no schema in the SDK.
 *
 * Null is NOT "conformant" — see `validateInbound`, which reports it as
 * `unmapped` so an unroutable combination stays visible instead of becoming a
 * silent hole in the gate.
 */
export function schemaKeyFor(
  action: OsppAction | string,
  messageType: MessageType | string | undefined,
): string | null {
  const kebab = toKebab(String(action));
  switch (messageType) {
    case MessageType.REQUEST:
      return `${kebab}-request`;
    case MessageType.RESPONSE:
      return `${kebab}-response`;
    case MessageType.EVENT:
      return EVENT_SUFFIX_ACTIONS.has(action as OsppAction)
        ? `${kebab}-event`
        : kebab;
    default:
      return null;
  }
}

/**
 * THE DENOMINATOR.
 *
 * The router logs only when something is wrong, so a run with a clean corpus
 * produces no output from this gate at all — which is byte-for-byte what a gate
 * that never executed produces. Reporting "zero non-conformant messages" off
 * that silence would be an unfalsifiable claim, and this repo has already paid
 * for the sibling mistake once: MessageRouter's MAC verification was built with
 * a `getSessionKey` parameter that Station never passed, and the resulting
 * refuse-everything behaviour read exactly like correct fail-closed behaviour
 * (see Station.routerWiring.test.ts).
 *
 * So the gate counts what it CHECKED, not only what it rejected. A zero next to
 * a five-figure `checked` is a measurement; a zero next to `checked: 0` is a
 * gate with no caller.
 */
const stats = { checked: 0, violations: 0, unmapped: 0 };

export interface InboundSchemaStats {
  checked: number;
  violations: number;
  unmapped: number;
}

export function inboundSchemaStats(): InboundSchemaStats {
  return { ...stats };
}

/** Test-only: reset the process-wide counters between cases. */
export function resetInboundSchemaStats(): void {
  stats.checked = 0;
  stats.violations = 0;
  stats.unmapped = 0;
}

export type InboundSchemaVerdict =
  | { kind: 'conformant'; schemaKey: string }
  | { kind: 'violation'; schemaKey: string; errors: string[] }
  | { kind: 'unmapped'; reason: string };

let cached: SchemaValidator | null = null;
let cachedKeys: ReadonlySet<string> | null = null;

/**
 * One validator per process. `SchemaValidator` reads every common schema off
 * disk in its constructor and compiles each message schema on first use, so a
 * per-station or per-message instance would repeat that work for all 5 pooled
 * stations of a suite run.
 */
function validator(): SchemaValidator {
  if (cached === null) {
    cached = new SchemaValidator();
    cachedKeys = new Set(cached.allKeys);
  }
  return cached;
}

/** The schema keys the vendored SDK actually ships. */
export function availableSchemaKeys(): ReadonlySet<string> {
  validator();
  return cachedKeys as ReadonlySet<string>;
}

function formatError(err: {
  instancePath?: string;
  message?: string;
  params?: Record<string, unknown>;
}): string {
  const where = err.instancePath && err.instancePath !== '' ? err.instancePath : '/';
  const what = err.message ?? 'unknown error';
  const allowed = err.params?.allowedValues;
  const suffix = Array.isArray(allowed) ? ` (allowed: ${allowed.join(', ')})` : '';
  return `${where} ${what}${suffix}`;
}

/**
 * Validate an inbound envelope's PAYLOAD against its message schema.
 *
 * The payload, not the envelope: `SchemaValidator.validate` is keyed on the
 * message schemas, which describe the payload. The envelope's own schema
 * (common/mqtt-envelope.schema.json) is registered in Ajv by `$id` for `$ref`
 * resolution and is not addressable by key, so envelope-level conformance is a
 * separate question and deliberately out of scope here.
 */
export function validateInbound(envelope: OsppEnvelope): InboundSchemaVerdict {
  const schemaKey = schemaKeyFor(envelope.action, envelope.messageType);
  if (schemaKey === null) {
    stats.unmapped += 1;
    return {
      kind: 'unmapped',
      reason: `messageType "${String(envelope.messageType)}" is not Request, Response or Event`,
    };
  }
  if (!availableSchemaKeys().has(schemaKey)) {
    stats.unmapped += 1;
    return {
      kind: 'unmapped',
      reason: `no schema "${schemaKey}" in @ospp/protocol for ${String(envelope.action)} ${String(envelope.messageType)}`,
    };
  }

  const result = validator().validate(schemaKey, envelope.payload);
  stats.checked += 1;
  if (result.valid) {
    return { kind: 'conformant', schemaKey };
  }
  stats.violations += 1;
  return {
    kind: 'violation',
    schemaKey,
    errors: (result.errors ?? []).map(formatError),
  };
}

/** A refusal (or warning) the router recorded, kept for failure attribution. */
export interface InboundSchemaViolation {
  topic: string;
  action: string;
  messageType: string;
  messageId: string;
  schemaKey: string;
  errors: string[];
  payload: unknown;
  /**
   * Whether the message was actually withheld, or only recorded.
   *
   * The two differ exactly by mode, and the distinction has to survive into the
   * failure text: in `warn` the message WAS delivered, so a step that reported
   * it as "refused" would send the reader looking for a refusal that never
   * happened — the same class of wrong-culprit reporting this whole change
   * exists to remove.
   */
  refused: boolean;
}

const PAYLOAD_ECHO_LIMIT = 2000;

/**
 * The offending payload, as bytes an operator can paste into a bug report.
 *
 * Truncation is ANNOUNCED rather than silent: a clipped payload that reads as
 * complete is how a report gets filed against the wrong field.
 */
export function echoPayload(payload: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? String(payload);
  } catch {
    return '<unserialisable payload>';
  }
  if (json.length <= PAYLOAD_ECHO_LIMIT) return json;
  return `${json.slice(0, PAYLOAD_ECHO_LIMIT)}…(truncated, ${json.length} chars total)`;
}
