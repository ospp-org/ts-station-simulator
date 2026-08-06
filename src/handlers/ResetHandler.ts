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

    // One reboot operation; `force` is its only choice (reset.md:9). Hard/Soft
    // are deleted and force is NOT a rename of Hard — Hard meant a credential
    // wipe the protocol no longer has (§5.1), force means "settle the running
    // session first, then reboot".
    const forced = request.force === true;
    console.log('[Reset] Accepted — forced: %s', forced);

    station.stopHeartbeat();
    const delay = forced ? 2000 : 1000;
    console.log('[Reset] reboot (forced=%s) — destroying connection in %dms', forced, delay);
    await new Promise<void>(resolve => setTimeout(resolve, delay));
    station.destroyConnection();
  }
}
