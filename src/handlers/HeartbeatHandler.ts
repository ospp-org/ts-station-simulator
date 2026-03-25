import { type OsppEnvelope, type HeartbeatResponse } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class HeartbeatHandler implements Handler {
  async handle(envelope: OsppEnvelope, _station: StationContext): Promise<void> {
    const response = envelope.payload as HeartbeatResponse;

    console.log(
      '[Heartbeat] Server time: %s',
      response.serverTime,
    );

    // Clock drift check (HB-010)
    const serverTime = new Date(response.serverTime).getTime();
    const drift = Math.abs(serverTime - Date.now());
    if (drift > 300_000) {
      console.warn('[Heartbeat] Clock drift exceeds 5 minutes (%dms). CLOCK_ERROR', drift);
    }
  }
}
