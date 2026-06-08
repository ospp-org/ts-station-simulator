import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  BayStatus,
  type OsppEnvelope,
  type ReserveBayRequest,
  type ReserveBayResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class ReserveBayHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as ReserveBayRequest;
    const bayState = station.getBayState(request.bayId);

    const canReserve = bayState === BayStatus.AVAILABLE;
    const accept = canReserve && Math.random() < station.config.behavior.acceptRate;

    if (accept) {
      station.setBayState(request.bayId, BayStatus.RESERVED);

      // Calculate TTL from expirationTime ISO 8601 string
      const expiresAt = new Date(request.expirationTime).getTime();
      const ttlMs = Math.max(expiresAt - Date.now(), 0);

      // Start expiry timer — auto-release bay when reservation expires
      const timer = setTimeout(() => {
        const reservation = station.reservations.get(request.bayId);
        if (reservation) {
          station.reservations.delete(request.bayId);
          try {
            station.setBayState(request.bayId, BayStatus.AVAILABLE);
          } catch {
            // Bay may already have transitioned
          }
          console.log(
            '[ReserveBay] Reservation %s on bay %s expired — bay released',
            request.reservationId,
            request.bayId,
          );
        }
      }, ttlMs);

      // Store reservation in map (keyed by bayId — one reservation per bay)
      station.reservations.set(request.bayId, {
        reservationId: request.reservationId,
        bayId: request.bayId,
        expirationTime: request.expirationTime,
        timer,
      });

      const response: ReserveBayResponse = { status: 'Accepted' };

      await station.sender.send<ReserveBayResponse>(
        OsppAction.RESERVE_BAY,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[ReserveBay] Accepted reservation %s for bay %s (expires: %s, ttl: %dms)',
        request.reservationId,
        request.bayId,
        request.expirationTime,
        ttlMs,
      );
    } else {
      const response: ReserveBayResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.TLS_HANDSHAKE_FAILED,
        errorText: canReserve
          ? 'Randomly rejected by simulator'
          : `Bay ${request.bayId} is in state ${bayState}, cannot reserve`,
      };

      await station.sender.send<ReserveBayResponse>(
        OsppAction.RESERVE_BAY,
        MessageType.RESPONSE,
        response,
        envelope.messageId,
      );

      console.log(
        '[ReserveBay] Rejected reservation %s for bay %s — %s',
        request.reservationId,
        request.bayId,
        response.errorText,
      );
    }
  }
}
