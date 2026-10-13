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
import { clearWashTimer, deliveredSeconds, reportBayIfChanged } from '../station/sessionEnd.js';

export class StopServiceHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as StopServiceRequest;

    // RULE 10 BEFORE RULE 2. stop-service.md §6 rule 10: a stop this station answered `Accepted`
    // keeps its RESPONSE for the retention horizon, and "Duplicate StopService REQUESTs targeting the
    // same sessionId within the horizon MUST return the same cached RESPONSE without re-running the
    // stop logic"; rule 2 says it is evaluated first, and that answering 3006 here is "the failure
    // mode rule 10 exists to prevent". It is now the server's only recovery for a lost RESPONSE: it
    // no longer closes a stop on its own, it sends the StopService again and takes this answer as the
    // end record (session-end rule S4). This station used to delete the session and keep nothing, so
    // the repeat was refused 3006 - which, under that rule, leaves the stopped wash open until the
    // sweep charges it in full.
    const cached = station.stopAnswerFor?.(request.sessionId);
    if (cached !== undefined) {
      await station.sender.send<StopServiceResponse>(
        OsppAction.STOP_SERVICE, MessageType.RESPONSE, cached, envelope.messageId,
      );
      console.log(
        '[StopService] Repeated stop for session %s — answered with the cached RESPONSE (%ds, %d credits)',
        request.sessionId, cached.actualDurationSeconds, cached.creditsCharged,
      );
      return;
    }

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

    // r3 — the sessionId must name a session on THIS bay. A stop naming the right session
    // and the wrong bay used to be ACCEPTED, and it deactivated the hardware on the
    // session's own bay: the caller asked to stop bay B and bay A stopped. 3007 exists
    // precisely for "valid id, wrong place".
    if (session.bayId !== request.bayId) {
      const mismatch: StopServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.SESSION_MISMATCH,
        errorText: errorName(OsppErrorCode.SESSION_MISMATCH),
      };
      await station.sender.send<StopServiceResponse>(
        OsppAction.STOP_SERVICE, MessageType.RESPONSE, mismatch, envelope.messageId,
      );
      console.log(
        '[StopService] Rejected — session %s runs on bay %s, not %s',
        request.sessionId, session.bayId, request.bayId,
      );
      return;
    }

    // The wash stops here, so the timer that would have ended it at its booked duration goes: this
    // RESPONSE is the end record, and no SessionEnded may follow it.
    clearWashTimer(session);

    // Transition bay: Occupied -> Finishing -> Available
    station.setBayState(session.bayId, BayStatus.FINISHING);

    // MONOTONIC, not the wall clock. `stop-service.md §6 Processing Rules` rule 5: the station
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
    // (`heartbeat.md §6 Clock Synchronization` rule 6).
    //
    // `session.startedAt` is untouched and stays the wall-clock stamp — it is
    // what gets ORDERED. It is simply no longer what gets DIFFERENCED.
    //
    // The clamp is belt-and-braces on a monotonic source, which cannot run
    // backwards; it was the ONLY thing standing between a backwards wall-clock
    // step and a schema-invalid frame, and this site did not have it.
    //
    // Through deliveredSeconds() now, the same measure every end path uses: for a wash resumed
    // after a restart it adds the delivered seconds the restart carried in, since the monotonic
    // origin of this process is the instant the wash resumed, not the instant it started.
    const actualDurationSeconds = deliveredSeconds(session);
    const creditsCharged = Math.ceil(
      (actualDurationSeconds / 60) * session.priceCreditsPerMinute,
    );

    const response: Extract<StopServiceResponse, { status: 'Accepted' }> = {
      status: 'Accepted',
      actualDurationSeconds,
      creditsCharged,
      finalSeqNo: session.seq.peek(),
    };

    // Kept BEFORE it is sent: a repeat that races this answer gets the same one (rule 10).
    station.rememberStopAnswer?.(request.sessionId, session.bayId, response);

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
    // And STOP. No SessionEnded follows: session-ended.md §4 Reasons is a MUST NOT for a
    // session "that terminates with" a StopService command, and the RESPONSE just
    // sent is the settlement carrier — its schema REQUIRES actualDurationSeconds and
    // creditsCharged for status=Accepted, precisely so a second message is not needed.
    // 03-messages.md §5.4, "Payload" records the consequence the rule exists to prevent: there is
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

    // The session leaves the record and the answer stays in it, for a repeat after a restart too.
    try {
      await station.persistSessions?.();
    } catch (err) {
      console.error('[StopService] could not record the stop of %s on disk: %s', request.sessionId, err instanceof Error ? err.message : String(err));
    }

    // A wash resumed after a restart had its bay reported Occupied at the boot: report it again now
    // that it is idle, after the RESPONSE that ended it. An ordinary wash's bay was never reported
    // Occupied, so nothing is sent for it.
    await reportBayIfChanged(station, session.bayId);
  }
}
