import type { OsppEnvelope, MeterValuesPayload } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

/**
 * MeterValues is an EVENT sent by the station.
 * Events do not receive responses, so this handler is a no-op.
 */
export class MeterValuesHandler implements Handler {
  async handle(envelope: OsppEnvelope, _station: StationContext): Promise<void> {
    const payload = envelope.payload as MeterValuesPayload;

    console.log(
      '[MeterValues] Sent for bay %s, session %s',
      payload.bayId,
      payload.sessionId,
    );
  }
}
