import {
  OsppAction,
  MessageType,
  isReportableBayStatus,
  type BayStatus,
  type StatusNotificationPayload,
} from '@ospp/protocol';
import type { StationContext } from '../handlers/Handler.js';

/**
 * REPORT A BAY - the one builder of every StatusNotification this station sends after its boot report
 * (BootNotificationHandler builds that one, which never carries previousStatus).
 *
 * Two callers: a transition the station performed - the start of a wash (Available or Reserved ->
 * Occupied), its end (Occupied -> Finishing -> Available), a reservation accepted, expired or
 * cancelled (Available <-> Reserved), maintenance on or off (Available or Faulted <-> Unavailable) -
 * and a report the server asked for (TriggerMessage StatusNotification). 05-state-machines.md §2: "The station MUST send a
 * StatusNotification on every state transition", within 1 s (status-notification.md §7 rule 3).
 *
 * `previousStatus` (status-notification.md §5 rule 2) is carried when `status` differs from the last
 * status reported for the bay, and omitted otherwise. Its value is the bay's status before this
 * transition: `previous` when the caller performed one - the holder's start says Reserved, the
 * reservation having been reported when it was accepted - and otherwise the last status reported. A context that
 * keeps no record of its reports (a handler test's) carries the transition's own `previous`.
 *
 * A report is regenerable (§7 rule 5): when the station cannot transmit it is dropped, not queued into
 * mqtt.js ahead of the BootNotification that must open the next connection, and that boot's report
 * carries the bay. The record of what was last reported moves only with a report that left.
 *
 * It replaces reportBayIfChanged, which compared the bay's state with the last report and so folded
 * Occupied -> Finishing -> Available into one Occupied -> Available report - an edge the table does
 * not have (05 §7.2) - and reported nothing at all for a wash whose start was never reported.
 *
 * Returns whether the report was published.
 */
export async function reportBayStatus(
  station: StationContext,
  bayId: string,
  status: BayStatus,
  previous?: BayStatus,
): Promise<boolean> {
  if (!isReportableBayStatus(status)) return false;
  if (station.canTransmit !== undefined && !station.canTransmit()) return false;
  const bay = station.config?.bays?.find((b) => b.bayId === bayId);
  if (bay === undefined) return false;

  const last = station.lastReportedBayStatus?.get(bayId);
  const prior = last !== undefined
    ? (status !== last ? (previous ?? last) : undefined)
    : (previous !== status ? previous : undefined);
  const report: StatusNotificationPayload = {
    bayId: bay.bayId,
    bayNumber: bay.bayNumber,
    status,
    ...(prior !== undefined && isReportableBayStatus(prior) ? { previousStatus: prior } : {}),
    // PROGRAMS, not services - status-notification.schema.json: every program this bay declared.
    programs: bay.programs.map((p) => ({ programNumber: p.programNumber, available: p.available })),
  };
  try {
    await station.sender.send<StatusNotificationPayload>(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, report);
  } catch (err) {
    console.log('[Station] bay %s could not be reported %s (%s)', bayId, status, err instanceof Error ? err.message : String(err));
    return false;
  }
  station.lastReportedBayStatus?.set(bayId, status);
  return true;
}
