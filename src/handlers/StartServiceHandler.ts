import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  type OsppEnvelope,
  type StartServiceRequest,
  type StartServiceResponse,
  BayStatus,
} from '@ospp/protocol';
import type { Handler, SessionInfo, StationContext } from './Handler.js';
import { bayRefusalCode, errorName } from './bayRefusal.js';
import { SequenceCounter } from '../station/SequenceCounter.js';
import { monotonicNowMs } from '../station/monotonicClock.js';
import { armWashTimer } from '../station/sessionEnd.js';
import { armMeterTimer } from '../station/sessionMeter.js';
import { reportBayStatus } from '../station/bayReport.js';

export class StartServiceHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as StartServiceRequest;

    // Validate bayId exists
    let bayState: ReturnType<typeof station.getBayState>;
    try {
      bayState = station.getBayState(request.bayId);
    } catch {
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.BAY_NOT_FOUND,
        errorText: errorName(OsppErrorCode.BAY_NOT_FOUND),
        // The rejection names the ordinal it refused, so an operator need not
        // correlate against the request to find out which one was wrong
        // (start-service-response.schema.json:30, REQUIRED when Rejected).
        programNumber: request.programNumber,
        };
      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE, MessageType.RESPONSE, response, envelope.messageId,
      );
      console.log('[StartService] Rejected session %s — BAY_NOT_FOUND (%s)', request.sessionId, request.bayId);
      return;
    }

    // Validate serviceId exists in bay's service catalog
    const bay = station.config.bays.find(b => b.bayId === request.bayId);
    if (!bay || !bay.services.some(s => s.serviceId === request.serviceId)) {
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.INVALID_SERVICE,
        errorText: errorName(OsppErrorCode.INVALID_SERVICE),
        // The rejection names the ordinal it refused, so an operator need not
        // correlate against the request to find out which one was wrong
        // (start-service-response.schema.json:30, REQUIRED when Rejected).
        programNumber: request.programNumber,
        };
      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE, MessageType.RESPONSE, response, envelope.messageId,
      );
      console.log('[StartService] Rejected session %s — INVALID_SERVICE (%s)', request.sessionId, request.serviceId);
      return;
    }

    // The ordinal MUST be one THIS bay declared.
    //
    // spec v0.11.0 start-service-request.schema.json, `programNumber`: "The
    // station MUST verify the ordinal was declared for that bay and, if it was
    // not, MUST reject with 3017 PROGRAM_NOT_DECLARED — never accept and do
    // nothing, which is a customer who paid and got no wash."
    //
    // Per BAY, not against the union of the station: a station-wide "does any bay
    // have this program" check would start the wrong hardware here. And a
    // MISSING ordinal is refused rather than defaulted — defaulting to 1 runs
    // whatever program 1 happens to be, which is the "charges for one thing and
    // delivers another" that 3017's recommended action rules out in terms.
    //
    // Availability is deliberately NOT consulted: 3017 means "this bay does not
    // have that program". A program that is present-but-broken is a different
    // fault with a different remedy, and conflating them sends an operator to
    // correct a binding that is correct.
    if (
      typeof request.programNumber !== 'number' ||
      !bay.programs.some(p => p.programNumber === request.programNumber)
    ) {
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.PROGRAM_NOT_DECLARED,
        errorText: errorName(OsppErrorCode.PROGRAM_NOT_DECLARED),
        programNumber: request.programNumber,
      };
      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE, MessageType.RESPONSE, response, envelope.messageId,
      );
      console.log(
        '[StartService] Rejected session %s — PROGRAM_NOT_DECLARED (bay %s has no program %s)',
        request.sessionId, request.bayId, String(request.programNumber),
      );
      return;
    }

    // Validate durationSeconds > 0
    if (request.durationSeconds <= 0) {
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.DURATION_INVALID,
        errorText: errorName(OsppErrorCode.DURATION_INVALID),
        // The rejection names the ordinal it refused, so an operator need not
        // correlate against the request to find out which one was wrong
        // (start-service-response.schema.json:30, REQUIRED when Rejected).
        programNumber: request.programNumber,
        };
      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE, MessageType.RESPONSE, response, envelope.messageId,
      );
      console.log('[StartService] Rejected session %s — DURATION_INVALID (%d)', request.sessionId, request.durationSeconds);
      return;
    }

    const canStart = bayState === BayStatus.AVAILABLE || bayState === BayStatus.RESERVED;
    const accept = canStart && Math.random() < station.config.behavior.acceptRate;

    if (accept) {
      // If bay is Reserved, validate the reservation
      if (bayState === BayStatus.RESERVED) {
        const reservation = station.reservations.get(request.bayId);

        if (reservation && reservation.reservationId !== request.reservationId) {
          // Reservation exists but reservationId doesn't match — reject
          const response: StartServiceResponse = {
            status: 'Rejected',
            errorCode: OsppErrorCode.BAY_RESERVED,
            errorText: errorName(OsppErrorCode.BAY_RESERVED),
            // The rejection names the ordinal it refused, so an operator need not
            // correlate against the request to find out which one was wrong
            // (start-service-response.schema.json:30, REQUIRED when Rejected).
            programNumber: request.programNumber,
            };

          await station.sender.send<StartServiceResponse>(
            OsppAction.START_SERVICE,
            MessageType.RESPONSE,
            response,
            envelope.messageId,
          );

          console.log(
            '[StartService] Rejected session %s on bay %s — BAY_RESERVED (reservation mismatch)',
            request.sessionId,
            request.bayId,
          );
          return;
        }
        // A matching reservation (or one already consumed) is consumed below, once the record is written.
      }

      const session: SessionInfo = {
        sessionId: request.sessionId,
        bayId: request.bayId,
        serviceId: request.serviceId,
        // TWO clocks, read in the same breath, for two different jobs
        // (`heartbeat.md §6 Clock Synchronization` rule 6). The wall clock STAMPS: `startedAt` is an
        // instant that gets ordered against server-side rows and is what a
        // receiver settles against when no duration ever arrives. The monotonic
        // clock MEASURES: it is the origin the session's elapsed time is
        // differenced from, and a correction landing mid-wash moves the first and
        // not the second.
        startedAt: new Date().toISOString(),
        startedAtMonotonicMs: monotonicNowMs(),
        durationSeconds: request.durationSeconds,
        seq: new SequenceCounter(),
        priceCreditsPerMinute: 100,
        programNumber: request.programNumber,
        startMessageId: envelope.messageId,
      };
      station.sessions.set(request.sessionId, session);

      // THE RECORD BEFORE ANYTHING IS ENERGISED. start-service.md §6 rule 9: "before energising
      // anything, the station MUST durably record the command - at minimum the envelope messageId,
      // the sessionId, the bayId and the programNumber - to non-volatile storage. If it cannot, it
      // MUST refuse with 5103 STORAGE_ERROR and MUST NOT activate." It is also what lets a restart
      // report this session (session-end rule S2): a wash the station does not remember is one it can
      // send no end record for. Before the reservation is consumed and the bay taken, so a refusal
      // leaves both as they were. A context with no store (a handler test) records nothing.
      try {
        await station.persistSessions?.();
      } catch (err) {
        station.sessions.delete(request.sessionId);
        const refused: StartServiceResponse = {
          status: 'Rejected',
          errorCode: OsppErrorCode.STORAGE_ERROR,
          errorText: errorName(OsppErrorCode.STORAGE_ERROR),
          programNumber: request.programNumber,
        };
        await station.sender.send<StartServiceResponse>(
          OsppAction.START_SERVICE, MessageType.RESPONSE, refused, envelope.messageId,
        );
        console.log(
          '[StartService] Rejected session %s — STORAGE_ERROR, the record could not be written (%s)',
          request.sessionId, err instanceof Error ? err.message : String(err),
        );
        return;
      }

      // Reservation matches (or was already consumed) — consume it
      const reservation = bayState === BayStatus.RESERVED ? station.reservations.get(request.bayId) : undefined;
      if (reservation) {
        clearTimeout(reservation.timer);
        station.reservations.delete(request.bayId);
        // RETAINED so cancel-reservation.md r6 can answer 3012 rather than a
        // misleading Accepted: the reservation is gone, but it did exist.
        station.terminalReservations.set(reservation.reservationId, {
          bayId: request.bayId, outcome: 'consumed',
        });
        console.log(
          '[StartService] Consumed reservation %s on bay %s',
          reservation.reservationId,
          request.bayId,
        );
      }

      station.setBayState(request.bayId, BayStatus.OCCUPIED);

      const response: StartServiceResponse = { status: 'Accepted' };

      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      // THE WASH ENDS ON ITS OWN. At its booked duration the station stops it and sends SessionEnded
      // TimerExpired - the end it decides most often, and the one connect mode never sent: it armed
      // nothing, and every session it accepted was left for the server's sweep to close as one with
      // no end record, charged in full with the anomaly mark (session-end rule S1). A stop, a forced
      // Reset or a restart clears the timer; their own record is the end.
      armWashTimer(station, session);
      // AND IT IS METERED WHILE IT RUNS: the first MeterValues within MeterValuesInterval of the
      // activation, then one every interval until the end, which sends the last (sessionMeter.ts;
      // meter-values.md §5.1). The boot declares meterValuesSupported, and none was ever sent.
      armMeterTimer(station, session);

      // THE BAY CHANGE, REPORTED - after the RESPONSE (04-flows.md §3 steps 7-8) and within 1 s of it
      // (status-notification.md §7 rule 3): Occupied, previousStatus Available, or Reserved for the
      // holder's start (05-state-machines.md §2.3). The bay used to move in the station's own state
      // machine only, so the server's stayed `available` for the whole wash - it writes bays.status
      // from StatusNotification alone. Dropped while the link is down: the next boot report carries it.
      await reportBayStatus(station, request.bayId, BayStatus.OCCUPIED, bayState);

      console.log(
        '[StartService] Accepted session %s on bay %s (service: %s, duration: %ds)',
        request.sessionId,
        request.bayId,
        request.serviceId,
        request.durationSeconds,
      );
    } else {
      const code = canStart ? OsppErrorCode.BAY_NOT_READY : bayRefusalCode(bayState);
      console.log(
        '[StartService] Rejected session %s on bay %s — %s (bay state: %s%s)',
        request.sessionId,
        request.bayId,
        errorName(code),
        bayState,
        canStart ? ', refused by acceptRate' : '',
      );
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: code,
        errorText: errorName(code),
        // REQUIRED when Rejected — start-service-response.schema.json:30.
        programNumber: request.programNumber,
      };

      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[StartService] Rejected session %s on bay %s — %s',
        request.sessionId,
        request.bayId,
        // `errorText` is absent from the Accepted variant, so it is only readable
        // inside this branch where the response is narrowed to Rejected.
        response.status === 'Rejected' ? response.errorText : 'accepted',
      );
    }
  }
}
