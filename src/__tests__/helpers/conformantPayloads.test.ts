import { describe, it, expect } from 'vitest';
import { MessageType, MessageSource, OSPP_PROTOCOL_VERSION, type OsppEnvelope } from '@ospp/protocol';
import { CONFORMANT_PAYLOADS, conformantPayloadFor } from './conformantPayloads.js';
import { validateInbound } from '../../mqtt/inboundSchema.js';

/**
 * The guard on the guard. Every fixture that calls itself conformant is checked
 * against the SDK schema it names, through the SAME function the router uses —
 * not a re-implementation of it, which could agree with the fixtures and disagree
 * with the wire.
 */
describe('conformant test payloads', () => {
  it.each(CONFORMANT_PAYLOADS.map((e) => [`${e.action} ${e.messageType}`, e] as const))(
    '%s validates against its schema',
    (_label, entry) => {
      const envelope = {
        messageId: 'msg-fixture',
        messageType: entry.messageType,
        action: entry.action,
        timestamp: '2026-08-26T12:00:00.000Z',
        source: MessageSource.SERVER,
        protocolVersion: OSPP_PROTOCOL_VERSION,
        payload: entry.payload,
      } as unknown as OsppEnvelope;

      const verdict = validateInbound(envelope);
      expect(
        verdict,
        `errors: ${verdict.kind === 'violation' ? verdict.errors.join('; ') : ''}`,
      ).toMatchObject({ kind: 'conformant' });
    },
  );

  it('throws rather than substituting an empty object for an unregistered pair', () => {
    expect(() =>
      conformantPayloadFor(CONFORMANT_PAYLOADS[0].action, MessageType.EVENT),
    ).toThrow(/No conformant fixture/);
  });

  it('hands back a copy, so one test mutating a payload cannot poison the next', () => {
    const first = conformantPayloadFor(
      CONFORMANT_PAYLOADS[0].action,
      CONFORMANT_PAYLOADS[0].messageType,
    );
    first.stationId = 'mutated';
    const second = conformantPayloadFor(
      CONFORMANT_PAYLOADS[0].action,
      CONFORMANT_PAYLOADS[0].messageType,
    );
    expect(second.stationId).not.toBe('mutated');
  });
});
