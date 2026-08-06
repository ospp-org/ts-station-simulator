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

    // `force` is read HERE, before the refusal, because the refusal is exactly
    // what it governs. reset-request.schema.json: "Omitted or false: the station
    // REFUSES if any bay has an active session, answering 3016
    // ACTIVE_SESSIONS_PRESENT … True: the station settles every active session
    // under the operator-disable policy FIRST … and only then reboots."
    //
    // It used to be read after this block, on a path a running session can never
    // reach, so `force: true` did nothing in the one situation it exists for and
    // the only thing it changed was a reboot delay.
    const forced = request.force === true;

    // Check for active sessions
    if (!forced && station.sessions.size > 0) {
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

    // "Force is not a licence to drop a session on the floor; it is a licence to
    // end it without waiting." So a forced reset SETTLES every running session as
    // an operator-initiated stop — billed for what the customer received —
    // BEFORE the reboot, rather than letting the reboot abandon it.
    //
    // One reboot operation; `force` is its only choice (reset.md:9). Hard/Soft
    // are deleted and force is NOT a rename of Hard — Hard meant a credential
    // wipe the protocol no longer has (§5.1).
    if (forced) {
      for (const sessionId of [...station.sessions.keys()]) {
        await station.settleSessionAsOperatorStop(sessionId);
      }
    }
    console.log('[Reset] Accepted — forced: %s', forced);

    station.stopHeartbeat();
    const delay = forced ? 2000 : 1000;
    console.log('[Reset] reboot (forced=%s) — destroying connection in %dms', forced, delay);
    await new Promise<void>(resolve => setTimeout(resolve, delay));
    station.destroyConnection();
  }
}
