import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  type OsppEnvelope,
  type ResetRequest,
  type ResetResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class ResetHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as ResetRequest;

    // Check for active sessions
    if (station.sessions.size > 0) {
      const rejected: ResetResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.ACTIVE_SESSIONS_PRESENT,
        errorText: 'ACTIVE_SESSIONS_PRESENT',
      };

      await station.sender.send<ResetResponse>(
        OsppAction.RESET,
        MessageType.RESPONSE,
        rejected,
        envelope.messageId,
      );

      console.log('[Reset] Rejected — %d active sessions', station.sessions.size);
      return;
    }

    // Respond Accepted
    const response: ResetResponse = { status: 'Accepted' };

    await station.sender.send<ResetResponse>(
      OsppAction.RESET,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log('[Reset] Accepted — type: %s', request.type);

    station.stopHeartbeat();
    const delay = request.type === 'Hard' ? 2000 : 1000;
    console.log('[Reset] %s reset — destroying connection in %dms', request.type, delay);
    await new Promise<void>(resolve => setTimeout(resolve, delay));
    station.destroyConnection();
  }
}
