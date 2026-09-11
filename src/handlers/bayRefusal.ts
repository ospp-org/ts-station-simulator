import { BayStatus, OsppErrorCode, OsppAction, MessageType } from '@ospp/protocol';

/**
 * Why a bay cannot take a reservation or a session, as OSPP names it.
 *
 * `reserve-bay.md` §5 rules 3--5 give the mapping and it is not a matter of taste:
 * `Occupied`/`Finishing` are `3001 BAY_BUSY`, `Reserved` is `3014 BAY_RESERVED`,
 * `Unavailable` (maintenance) is `3011 BAY_MAINTENANCE`, and `Unknown`/`Faulted`/
 * transitioning are `3002 BAY_NOT_READY`. Every one of those is in the roster
 * `07-errors.md` §4.2 permits for both ReserveBay and StartService, so one function
 * serves both refusals.
 *
 * The simulator previously answered these with `1003 TLS_HANDSHAKE_FAILED` and
 * `1001 MQTT_CONNECTION_LOST` — transport codes, on a bay-state refusal, in the
 * `errorCode` field an integrator reads to build their own handling.
 */
export function bayRefusalCode(state: BayStatus): OsppErrorCode {
  switch (state) {
    case BayStatus.OCCUPIED:
    case BayStatus.FINISHING:
      return OsppErrorCode.BAY_BUSY;
    case BayStatus.RESERVED:
      return OsppErrorCode.BAY_RESERVED;
    case BayStatus.UNAVAILABLE:
      return OsppErrorCode.BAY_MAINTENANCE;
    default:
      // Unknown, Faulted, and anything transitioning.
      return OsppErrorCode.BAY_NOT_READY;
  }
}

/**
 * The wire name of a code — what `errorText` carries.
 *
 * `errorText` is `^[A-Z][A-Z0-9_]+$` on the eighteen schemas that constrain it, and
 * both its descriptions call it a *"machine-readable error name in UPPER_SNAKE_CASE"*.
 * It is not a sentence field: these response schemas have no `errorDescription` and are
 * `additionalProperties: false`, so prose has nowhere legal to go and belongs in the log.
 */
/**
 * The outcome a reservation reached, retained after it left the live map.
 *
 * `reserve-bay.md` §5.2 requires the retention: without it an expired reservation is
 * indistinguishable from one that never existed, and `cancel-reservation.md` rules 2, 3
 * and 6 each demand a DIFFERENT answer for those cases (`Accepted`, `3013`, `3012`).
 * The simulator used to answer all three `Accepted`, which is not a gap but a wrong
 * statement on the wire.
 */
export type ReservationOutcome = 'expired' | 'consumed' | 'cancelled';

export interface TerminalReservation {
  bayId: string;
  outcome: ReservationOutcome;
}

/**
 * Resolve a `bayId` or refuse with `3005 BAY_NOT_FOUND` — for the three doors that
 * previously let `getBayState` THROW.
 *
 * `reserve-bay.md` §6 r1, `cancel-reservation.md` r1 and `set-maintenance-mode.md` r1 all
 * say the same thing in the same words, and all three handlers reached `getBayState`
 * unguarded. `Station.getBayState` throws for an unknown bay, so the server received NO
 * FRAME AT ALL — a timeout where the protocol defines a refusal, which is the one outcome
 * that teaches an integrator nothing.
 *
 * Returns `null` when it has already answered, so the caller returns immediately.
 */
export async function resolveBayOrRefuse(
  station: import('./Handler.js').StationContext,
  bayId: string,
  action: OsppAction,
  messageId: string,
  label: string,
): Promise<BayStatus | null> {
  try {
    return station.getBayState(bayId);
  } catch {
    await station.sender.send(action, MessageType.RESPONSE, {
      status: 'Rejected',
      errorCode: OsppErrorCode.BAY_NOT_FOUND,
      errorText: errorName(OsppErrorCode.BAY_NOT_FOUND),
    }, messageId);
    console.log('[%s] Rejected — bay %s does not exist', label, bayId);
    return null;
  }
}

export function errorName(code: OsppErrorCode): string {
  const name = OsppErrorCode[code];
  /* c8 ignore next 3 -- unreachable for enum members; guards a future non-member caller */
  if (name === undefined) {
    throw new Error(`no name for OsppErrorCode ${code}`);
  }
  return name;
}
