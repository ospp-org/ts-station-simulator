import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  BayStatus,
  type OsppEnvelope,
  type StopServiceRequest,
  type StopServiceResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class StopServiceHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as StopServiceRequest;
    const session = station.sessions.get(request.sessionId);

    if (!session) {
      const response: StopServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.MQTT_PUBLISH_FAILED,
        errorText: `Session ${request.sessionId} not found`,
      };

      await station.sender.send<StopServiceResponse>(
        OsppAction.STOP_SERVICE,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[StopService] Rejected — session %s not found',
        request.sessionId,
      );
      return;
    }

    // Transition bay: Occupied -> Finishing -> Available
    station.setBayState(session.bayId, BayStatus.FINISHING);

    const startedAt = new Date(session.startedAt).getTime();
    const actualDurationSeconds = Math.round((Date.now() - startedAt) / 1000);
    const creditsCharged = Math.ceil(
      (actualDurationSeconds / 60) * session.priceCreditsPerMinute,
    );

    const response: StopServiceResponse = {
      status: 'Accepted',
      actualDurationSeconds,
      creditsCharged,
      finalSeqNo: session.seq.peek(),
    };

    await station.sender.send<StopServiceResponse>(
      OsppAction.STOP_SERVICE,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[StopService] Accepted — session %s stopped. Duration: %ds, credits: %d',
      request.sessionId,
      actualDurationSeconds,
      creditsCharged,
    );

    // Remove session and transition bay to Available.
    //
    // And STOP. No SessionEnded follows: session-ended.md:57 is a MUST NOT for a
    // session "that terminates with" a StopService command, and the RESPONSE just
    // sent is the settlement carrier — its schema REQUIRES actualDurationSeconds and
    // creditsCharged for status=Accepted, precisely so a second message is not needed.
    // 03-messages.md:1195 records the consequence the rule exists to prevent: there is
    // deliberately no `Remote` reason value, because "emitting both StopService RESPONSE
    // and SessionEnded for the same stop would force double-emission ambiguity."
    //
    // On the csms server that ambiguity is money. The RESPONSE settles as
    // TerminalReason::VoluntaryStop → pro-rata on delivered time; a SessionEnded settles
    // as its own reason — TimerExpired → fullCharge of the entire pre-authorization
    // (UserDurationStrategy:38-53). The two disagree, whichever lands first wins, and the
    // one that lands second is silently swallowed by a terminal-session guard. There is no
    // reason value that makes sending both correct, which is why the fix is to send one.
    station.sessions.delete(request.sessionId);
    station.setBayState(session.bayId, BayStatus.AVAILABLE);
  }
}
