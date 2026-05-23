import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type StartServiceRequest,
  type StartServiceResponse,
  BayStatus,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

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
        errorCode: 3005,
        errorText: 'BAY_NOT_FOUND',
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
        errorCode: 3004,
        errorText: 'INVALID_SERVICE',
      };
      await station.sender.send<StartServiceResponse>(
        OsppAction.START_SERVICE, MessageType.RESPONSE, response, envelope.messageId,
      );
      console.log('[StartService] Rejected session %s — INVALID_SERVICE (%s)', request.sessionId, request.serviceId);
      return;
    }

    // Validate durationSeconds > 0
    if (request.durationSeconds <= 0) {
      const response: StartServiceResponse = {
        status: 'Rejected',
        errorCode: 3008,
        errorText: 'DURATION_INVALID',
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
            errorCode: 3014,
            errorText: `Bay ${request.bayId} is reserved under a different reservation`,
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
        seqNo: 0,
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
        errorCode: 1001,
        errorText: canStart
          ? 'Randomly rejected by simulator'
          : `Bay ${request.bayId} is in state ${bayState}, cannot start service`,
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
        response.errorText,
      );
    }
  }
}
