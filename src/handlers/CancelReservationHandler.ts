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
import { errorName, resolveBayOrRefuse } from './bayRefusal.js';

export class CancelReservationHandler implements Handler {
  /** One refusal shape, so the four rules above cannot drift apart in wording. */
  private async reject(
    station: StationContext, envelope: OsppEnvelope, code: OsppErrorCode, why: string,
  ): Promise<void> {
    const response: CancelReservationResponse = {
      status: 'Rejected',
      errorCode: code,
      errorText: errorName(code),
    };
    await station.sender.send<CancelReservationResponse>(
      OsppAction.CANCEL_RESERVATION, MessageType.RESPONSE, response, envelope.messageId,
    );
    console.log('[CancelReservation] Rejected %s — %s', errorName(code), why);
  }

  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as CancelReservationRequest;

    // r1 — an unknown bay is 3005, not an exception.
    const bayState = await resolveBayOrRefuse(
      station, request.bayId, OsppAction.CANCEL_RESERVATION, envelope.messageId, 'CancelReservation',
    );
    if (bayState === null) {
      return;
    }

    const reservation = station.reservations.get(request.bayId);

    // THE THREE TERMINAL ANSWERS, AND THEY ARE DIFFERENT. Rules 2, 3 and 6 demand
    // `Accepted`, `3013` and `3012` for three states this handler used to collapse into a
    // single idempotent `Accepted`. That was not a missing check: it was a wrong statement
    // on the wire, which is worse, because a server reading `Accepted` stops asking.
    // Retention (`reserve-bay.md` §5.2) is what makes them separable at all.
    if (!reservation) {
      const terminal = station.terminalReservations.get(request.reservationId);

      // r3 — expired: the timer auto-released it, and the record outlived the release.
      if (terminal?.outcome === 'expired') {
        await this.reject(station, envelope, OsppErrorCode.RESERVATION_EXPIRED,
          `reservation ${request.reservationId} on bay ${request.bayId} had already expired`);
        return;
      }

      // r6 — consumed by a StartService: it no longer exists AS A RESERVATION.
      if (terminal?.outcome === 'consumed') {
        await this.reject(station, envelope, OsppErrorCode.RESERVATION_NOT_FOUND,
          `reservation ${request.reservationId} was already consumed by a session`);
        return;
      }

      // r2, second half — no reservation with that id has EVER existed here.
      if (terminal === undefined) {
        await this.reject(station, envelope, OsppErrorCode.RESERVATION_NOT_FOUND,
          `no reservation ${request.reservationId} has ever existed on bay ${request.bayId}`);
        return;
      }
      // r2, first half — previously cancelled: idempotent success, and it falls through
      // to the `Accepted` arm below.
    }

    // r2 — the id has to MATCH. Cancelling a live reservation by naming the wrong id used
    // to succeed, because the handler never compared the two.
    if (reservation && reservation.reservationId !== request.reservationId) {
      await this.reject(station, envelope, OsppErrorCode.RESERVATION_NOT_FOUND,
        `bay ${request.bayId} holds ${reservation.reservationId}, not ${request.reservationId}`);
      return;
    }

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
      station.terminalReservations.set(request.reservationId, {
        bayId: request.bayId, outcome: 'cancelled',
      });
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
        errorCode: OsppErrorCode.RESERVATION_NOT_FOUND,
        errorText: errorName(OsppErrorCode.RESERVATION_NOT_FOUND),
      };

      console.log(
        '[CancelReservation] Rejected — bay %s is Reserved but tracks no reservation',
        request.bayId,
      );

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
