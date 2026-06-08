import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  BayStatus,
  type OsppEnvelope,
  type CancelReservationRequest,
  type CancelReservationResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class CancelReservationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as CancelReservationRequest;
    const bayState = station.getBayState(request.bayId);
    const reservation = station.reservations.get(request.bayId);

    if (reservation) {
      // Check if reservation has already expired (CR-005)
      const now = Date.now();
      const expiresAt = new Date(reservation.expirationTime).getTime();

      if (expiresAt <= now) {
        // Reservation already expired and auto-released — accept idempotently
        clearTimeout(reservation.timer);
        station.reservations.delete(request.bayId);

        const response: CancelReservationResponse = { status: 'Accepted' };
        await station.sender.send<CancelReservationResponse>(
          OsppAction.CANCEL_RESERVATION,
          MessageType.RESPONSE,
          response,
          envelope.messageId,
        );

        console.log(
          '[CancelReservation] Accepted (expired) — reservation %s on bay %s already auto-released',
          request.reservationId,
          request.bayId,
        );
        return;
      }

      // Active reservation — cancel timer, release bay, delete from map
      clearTimeout(reservation.timer);
      station.reservations.delete(request.bayId);
      station.setBayState(request.bayId, BayStatus.AVAILABLE);

      const response: CancelReservationResponse = { status: 'Accepted' };
      await station.sender.send<CancelReservationResponse>(
        OsppAction.CANCEL_RESERVATION,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[CancelReservation] Accepted — reservation %s on bay %s cancelled',
        request.reservationId,
        request.bayId,
      );
    } else if (bayState !== BayStatus.RESERVED) {
      // No reservation tracked and bay is not Reserved — already cancelled (CR-003 idempotent)
      const response: CancelReservationResponse = { status: 'Accepted' };
      await station.sender.send<CancelReservationResponse>(
        OsppAction.CANCEL_RESERVATION,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[CancelReservation] Accepted (idempotent) — reservation %s on bay %s was already cancelled',
        request.reservationId,
        request.bayId,
      );
    } else {
      // Bay is Reserved but no reservation info tracked — should not happen, reject
      const response: CancelReservationResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.CERTIFICATE_ERROR,
        errorText: `Bay ${request.bayId} is Reserved but no matching reservation found`,
      };

      await station.sender.send<CancelReservationResponse>(
        OsppAction.CANCEL_RESERVATION,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[CancelReservation] Rejected — bay %s is Reserved but no reservation tracked',
        request.bayId,
      );
    }
  }
}
