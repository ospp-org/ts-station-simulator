import { describe, it, expect } from 'vitest';
import { OsppAction, MessageType } from '@ospp/protocol';
import {
  schemaKeyFor,
  availableSchemaKeys,
  resolveInboundSchemaMode,
  DEFAULT_INBOUND_SCHEMA_MODE,
  INBOUND_SCHEMA_ENV,
} from '../../mqtt/inboundSchema.js';

/**
 * The anti-blindness controls for the inbound gate.
 *
 * `validateInbound` treats an unresolvable key as "unmapped" and lets the
 * message through — the only safe thing it can do, since refusing every message
 * it has no schema for would break the wire on the first SDK that ships a new
 * action. The cost of that safety is that a RENAMED schema silently downgrades
 * the gate from checking to shrugging, and the log line is the only trace.
 *
 * So the mapping is pinned here as data instead. A rename, an added message, or
 * a change to the Event-suffix convention reds one of these rather than quietly
 * widening the hole.
 */
describe('inbound schema key mapping', () => {
  const actions = Object.values(OsppAction);
  const messageTypes = Object.values(MessageType);

  function mappedPairs(): { action: OsppAction; messageType: MessageType; key: string }[] {
    const keys = availableSchemaKeys();
    const out: { action: OsppAction; messageType: MessageType; key: string }[] = [];
    for (const action of actions) {
      for (const messageType of messageTypes) {
        const key = schemaKeyFor(action, messageType);
        if (key !== null && keys.has(key)) out.push({ action, messageType, key });
      }
    }
    return out;
  }

  it('reaches EVERY schema the SDK ships — no key is unreachable', () => {
    const reached = new Set(mappedPairs().map((p) => p.key));
    const unreachable = [...availableSchemaKeys()].filter((k) => !reached.has(k));
    expect(
      unreachable,
      'A schema the SDK ships that no (action, messageType) pair resolves to means the ' +
        'gate cannot check that message at all. Usually an SDK rename, or a new message ' +
        'whose Event-vs-Request keying differs from the convention in inboundSchema.ts.',
    ).toEqual([]);
  });

  it('maps exactly 47 (action, messageType) pairs — pinned so an SDK bump is visible', () => {
    // Not a magic number: it is |allKeys|, and the test above proves the two sets
    // coincide. Pinned as a literal so adding a message to @ospp/protocol without
    // teaching this simulator about it reds here instead of passing quietly.
    expect(availableSchemaKeys().size).toBe(47);
    expect(mappedPairs()).toHaveLength(47);
  });

  it('every mapped pair names a schema that actually exists', () => {
    for (const { action, messageType, key } of mappedPairs()) {
      expect(availableSchemaKeys().has(key), `${action} ${messageType} -> ${key}`).toBe(true);
    }
  });

  it('keys the two -event messages with the suffix and the other five bare', () => {
    // The split is the spec's. `security-event` already ends in the word, so
    // suffixing it would name a schema that does not exist — which is exactly
    // how this mapping would go blind if it were inferred rather than pinned.
    expect(schemaKeyFor(OsppAction.METER_VALUES, MessageType.EVENT)).toBe('meter-values-event');
    expect(schemaKeyFor(OsppAction.SESSION_ENDED, MessageType.EVENT)).toBe('session-ended-event');
    expect(schemaKeyFor(OsppAction.SECURITY_EVENT, MessageType.EVENT)).toBe('security-event');
    expect(schemaKeyFor(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT)).toBe(
      'status-notification',
    );
    expect(schemaKeyFor(OsppAction.CONNECTION_LOST, MessageType.EVENT)).toBe('connection-lost');
    expect(schemaKeyFor(OsppAction.FIRMWARE_STATUS_NOTIFICATION, MessageType.EVENT)).toBe(
      'firmware-status-notification',
    );
    expect(schemaKeyFor(OsppAction.DIAGNOSTICS_NOTIFICATION, MessageType.EVENT)).toBe(
      'diagnostics-notification',
    );
  });

  it('handles the multi-word actions the naive splitter gets wrong', () => {
    expect(schemaKeyFor(OsppAction.AUTHORIZE_OFFLINE_PASS, MessageType.RESPONSE)).toBe(
      'authorize-offline-pass-response',
    );
    expect(schemaKeyFor(OsppAction.TRIGGER_CERTIFICATE_RENEWAL, MessageType.REQUEST)).toBe(
      'trigger-certificate-renewal-request',
    );
    expect(schemaKeyFor(OsppAction.SET_MAINTENANCE_MODE, MessageType.REQUEST)).toBe(
      'set-maintenance-mode-request',
    );
  });

  it('returns null for a messageType that is not one of the three', () => {
    expect(schemaKeyFor(OsppAction.RESET, undefined)).toBeNull();
    expect(schemaKeyFor(OsppAction.RESET, 'Notification')).toBeNull();
  });
});

describe('resolveInboundSchemaMode', () => {
  it('defaults to strict when unset or empty', () => {
    expect(resolveInboundSchemaMode(undefined)).toBe('strict');
    expect(resolveInboundSchemaMode('')).toBe('strict');
    expect(DEFAULT_INBOUND_SCHEMA_MODE).toBe('strict');
  });

  it('accepts the three modes, case- and whitespace-insensitively', () => {
    expect(resolveInboundSchemaMode('off')).toBe('off');
    expect(resolveInboundSchemaMode('WARN')).toBe('warn');
    expect(resolveInboundSchemaMode('  strict ')).toBe('strict');
  });

  /**
   * The important one. A `?? default` fallback here would make
   * `OSPP_SIM_INBOUND_SCHEMA=stict` resolve silently to strict, so a run whose
   * entire purpose was to MEASURE in warn mode would instead refuse messages and
   * report a corpus of zero — a gate that a typo can retarget is not a gate.
   */
  it('THROWS on an unrecognised value rather than falling back', () => {
    expect(() => resolveInboundSchemaMode('stict')).toThrow(/not a valid inbound schema mode/);
    expect(() => resolveInboundSchemaMode('true')).toThrow(INBOUND_SCHEMA_ENV);
  });
});
