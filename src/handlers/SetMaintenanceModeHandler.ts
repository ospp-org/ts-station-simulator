import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  BayStatus,
  type OsppEnvelope,
  type SetMaintenanceModeRequest,
  type SetMaintenanceModeResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';
import { bayRefusalCode, errorName, resolveBayOrRefuse } from './bayRefusal.js';
import { reportBayStatus } from '../station/bayReport.js';

export class SetMaintenanceModeHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as SetMaintenanceModeRequest;

    // set-maintenance-mode.md r1 — an unknown bay is 3005, not an exception. Checked for
    // BOTH directions and before anything else, because a bay that does not exist cannot
    // be taken out of maintenance either.
    if (request.bayId) {
      const exists = await resolveBayOrRefuse(
        station, request.bayId, OsppAction.SET_MAINTENANCE_MODE, envelope.messageId, 'SetMaintenanceMode',
      );
      if (exists === null) {
        return;
      }

      // §6 table: `Unknown` is refused in EITHER direction (3002) — the server and the
      // station do not agree on what the bay is doing, and maintenance is a claim about
      // a known state. `Reserved` + `enabled` is 3014: someone holds the bay.
      const refusal =
        exists === BayStatus.UNKNOWN ? bayRefusalCode(BayStatus.UNKNOWN)
        : (request.enabled && exists === BayStatus.RESERVED) ? bayRefusalCode(BayStatus.RESERVED)
        : (request.enabled && exists === BayStatus.FINISHING) ? bayRefusalCode(BayStatus.FINISHING)
        : null;

      if (refusal !== null) {
        const rejected: SetMaintenanceModeResponse = {
          status: 'Rejected',
          errorCode: refusal,
          errorText: errorName(refusal),
        };
        await station.sender.send<SetMaintenanceModeResponse>(
          OsppAction.SET_MAINTENANCE_MODE, MessageType.RESPONSE, rejected, envelope.messageId,
        );
        console.log('[SetMaintenanceMode] Rejected — bay %s is %s', request.bayId, exists);
        return;
      }
    }

    // THE §6 TABLE, BAY BY BAY. `enabled: true` moves Available and Faulted to Unavailable and leaves
    // an Unavailable bay as it is (rule 7); `enabled: false` moves only Unavailable to Available and
    // leaves every other bay as it is (rule 7). The refusals are the table's: an Occupied or
    // Finishing bay is 3001 (rule 2), and for the whole station the same row of every bay is asked,
    // so a Reserved one refuses it 3014 and an Unknown one 3002 - §2.3 has no edge from either to
    // Unavailable, which is why the table refuses them for one bay (the per-bay arms above).
    // Off moved every bay it targeted to Available, an Occupied or Faulted one included, and on threw
    // on a bay already in maintenance (Unavailable -> Unavailable) instead of answering Accepted.
    const targets = request.bayId ? [request.bayId] : station.config.bays.map((b) => b.bayId);
    const moves: Array<{ bayId: string; from: BayStatus; to: BayStatus }> = [];
    for (const bayId of targets) {
      const from = station.getBayState(bayId);
      if (request.enabled) {
        if (from === BayStatus.AVAILABLE || from === BayStatus.FAULTED) {
          moves.push({ bayId, from, to: BayStatus.UNAVAILABLE });
        } else if (from !== BayStatus.UNAVAILABLE) {
          const code = bayRefusalCode(from);
          const rejected: SetMaintenanceModeResponse = { status: 'Rejected', errorCode: code, errorText: errorName(code) };
          await station.sender.send<SetMaintenanceModeResponse>(
            OsppAction.SET_MAINTENANCE_MODE, MessageType.RESPONSE, rejected, envelope.messageId,
          );
          console.log('[SetMaintenanceMode] Rejected — bay %s is %s', bayId, from);
          return;
        }
      } else if (from === BayStatus.UNAVAILABLE) {
        moves.push({ bayId, from, to: BayStatus.AVAILABLE });
      }
    }

    for (const move of moves) {
      station.setBayState(move.bayId, move.to);
    }
    console.log(
      '[SetMaintenanceMode] maintenance %s on %s: %d bay(s) moved (reason: %s)',
      request.enabled ? 'enabled' : 'disabled',
      request.bayId ?? 'every bay',
      moves.length,
      request.reason ?? 'none',
    );

    const response: SetMaintenanceModeResponse = { status: 'Accepted' };

    await station.sender.send<SetMaintenanceModeResponse>(
      OsppAction.SET_MAINTENANCE_MODE,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[SetMaintenanceMode] Accepted — maintenance %s',
      request.enabled ? 'enabled' : 'disabled',
    );

    // §5 rule 4: a StatusNotification for each bay it moved, after the RESPONSE, as every other bay
    // change of this station is reported (05-state-machines.md §2).
    for (const move of moves) {
      await reportBayStatus(station, move.bayId, move.to, move.from);
    }
  }
}
