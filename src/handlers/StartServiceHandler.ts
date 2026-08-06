import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  type OsppEnvelope,
  type StartServiceRequest,
  type StartServiceResponse,
  BayStatus,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';
import { SequenceCounter } from '../station/SequenceCounter.js';

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
        errorText: 'BAY_NOT_FOUND',
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
        errorText: 'INVALID_SERVICE',
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
        errorText: 'PROGRAM_NOT_DECLARED',
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
        errorText: 'DURATION_INVALID',
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
            errorText: `Bay ${request.bayId} is reserved under a different reservation`,
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

        // Reservation matches (or was already consumed) — consume it
        if (reservation) {
          clearTimeout(reservation.timer);
          station.reservations.delete(request.bayId);
          console.log(
            '[StartService] Consumed reservation %s on bay %s',
            reservation.reservationId,
            request.bayId,
          );
        }
      }

      station.setBayState(request.bayId, BayStatus.OCCUPIED);

      station.sessions.set(request.sessionId, {
        sessionId: request.sessionId,
        bayId: request.bayId,
        serviceId: request.serviceId,
        startedAt: new Date().toISOString(),
        durationSeconds: request.durationSeconds,
        seq: new SequenceCounter(),
        priceCreditsPerMinute: 100,
      });

      const response: StartServiceResponse = { status: 'Accepted' };

      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[StartService] Accepted session %s on bay %s (service: %s, duration: %ds)',
        request.sessionId,
        request.bayId,
        request.serviceId,
        request.durationSeconds,
      );
    } else {
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.MQTT_CONNECTION_LOST,
        errorText: canStart
          ? 'Randomly rejected by simulator'
          : `Bay ${request.bayId} is in state ${bayState}, cannot start service`,
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
