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
import { errorName } from './bayRefusal.js';
import { monotonicNowMs } from '../station/monotonicClock.js';

export class StopServiceHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as StopServiceRequest;
    const session = station.sessions.get(request.sessionId);

    if (!session) {
      const response: StopServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.SESSION_NOT_FOUND,
        errorText: errorName(OsppErrorCode.SESSION_NOT_FOUND),
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

    // MONOTONIC, not the wall clock. `stop-service.md:47` rule 5: the station
    // "MUST calculate actualDurationSeconds from the service start time to the
    // moment of deactivation, MUST measure that interval on a monotonic timer and
    // not the wall clock, and MUST round the result to the NEAREST second rather
    // than truncating it."
    //
    // This read `Date.now() - Date.parse(session.startedAt)`. Both ends came off
    // the wall clock, so an NTP step or a cellular NITZ correction landing
    // mid-wash went straight into the bill: +1h made a 40-second wash settle as
    // 3640 seconds and 6067 credits instead of 40 and 67, and -1h drove the
    // figure NEGATIVE — which `stop-service-response.schema.json` forbids
    // (`minimum: 0`), so the settlement frame itself became invalid and a
    // validating server drops it on ingest. Nothing downstream could have caught
    // the overcharge: the same schema gives the field no `maximum` and no
    // receiver rule cross-checks it against `startedAt`/`endedAt`
    // (`heartbeat.md:51` rule 6).
    //
    // `session.startedAt` is untouched and stays the wall-clock stamp — it is
    // what gets ORDERED. It is simply no longer what gets DIFFERENCED.
    //
    // The clamp is belt-and-braces on a monotonic source, which cannot run
    // backwards; it was the ONLY thing standing between a backwards wall-clock
    // step and a schema-invalid frame, and this site did not have it.
    const elapsedMs = monotonicNowMs() - session.startedAtMonotonicMs;
    const actualDurationSeconds = Math.max(0, Math.round(elapsedMs / 1000));
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
