import type { OsppEnvelope, SecurityEventPayload } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

/**
 * SecurityEvent is an EVENT sent by the station.
 * Events do not receive responses, so this handler is a no-op.
 */
export class SecurityEventHandler implements Handler {
  async handle(envelope: OsppEnvelope, _station: StationContext): Promise<void> {
    const payload = envelope.payload as SecurityEventPayload;

    console.log(
      '[SecurityEvent] Sent — type: %s, severity: %s, eventId: %s',
      payload.type,
      payload.severity,
      payload.eventId,
    );
  }
}
