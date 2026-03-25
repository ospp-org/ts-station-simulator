import {
  OsppAction,
  MessageType,
  SessionEndReason,
  BayStatus,
  type OsppEnvelope,
  type StopServiceRequest,
  type StopServiceResponse,
  type SessionEndedPayload,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class StopServiceHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as StopServiceRequest;
    const session = station.sessions.get(request.sessionId);

    if (!session) {
      const response: StopServiceResponse = {
        status: 'Rejected',
        errorCode: 1002,
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
    const creditsCharged = actualDurationSeconds * 100;

    const response: StopServiceResponse = {
      status: 'Accepted',
      actualDurationSeconds,
      creditsCharged,
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

    // Remove session and transition bay to Available
    station.sessions.delete(request.sessionId);
    station.setBayState(session.bayId, BayStatus.AVAILABLE);

    // Send SessionEnded event
    const sessionEndedPayload: SessionEndedPayload = {
      sessionId: session.sessionId,
      bayId: session.bayId,
      reason: SessionEndReason.TIMER_EXPIRED,
      actualDurationSeconds,
      creditsCharged,
    };

    await station.sender.send<SessionEndedPayload>(
      OsppAction.SESSION_ENDED,
      MessageType.EVENT,
      sessionEndedPayload,
    );

    console.log(
      '[StopService] SessionEnded event sent for session %s',
      request.sessionId,
    );
  }
}
