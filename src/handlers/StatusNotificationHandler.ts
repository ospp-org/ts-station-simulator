import type { OsppEnvelope, StatusNotificationPayload } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

/**
 * StatusNotification is an EVENT sent by the station.
 * Events do not receive responses, so this handler is a no-op.
 */
export class StatusNotificationHandler implements Handler {
  async handle(envelope: OsppEnvelope, _station: StationContext): Promise<void> {
    const payload = envelope.payload as StatusNotificationPayload;

    console.log(
      '[StatusNotification] Sent for bay %s — status: %s',
      payload.bayId,
      payload.status,
    );
  }
}
