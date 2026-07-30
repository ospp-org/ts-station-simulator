import { type OsppEnvelope, type BootNotificationResponse, OsppAction, MessageType, type StatusNotificationPayload, isReportableBayStatus } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class BootNotificationHandler implements Handler {
  /**
   * @param autoReact When true (default — `connect` mode), the station
   *   auto-pilots after a successful boot: starts the heartbeat and emits a
   *   StatusNotification per bay. Scenario mode passes `false`: scenarios drive
   *   those messages explicitly (with the provisioned bayIds and empirically-
   *   tuned timing), so the handler only captures the essential boot state
   *   (sessionKey). Auto-firing in scenario mode would duplicate the scenario's
   *   StatusNotifications and emit them for the pre-provision (wrong) bayIds.
   */
  constructor(private readonly autoReact: boolean = true) {}

  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const response = envelope.payload as BootNotificationResponse;

    switch (response.status) {
      case 'Accepted': {
        console.log(
          '[BootNotification] Accepted. Heartbeat interval: %ds',
          response.heartbeatIntervalSec,
        );

        // Persist the session key from the response so the MessageSender can
        // HMAC-sign critical outbound messages (over the whole envelope).
        station.sessionKey = response.sessionKey ?? null;

        // Connect-mode auto-pilot only (see constructor). Scenario mode drives
        // heartbeat + StatusNotifications explicitly.
        if (this.autoReact) {
          // Start heartbeat at server-specified interval
          station.startHeartbeat(response.heartbeatIntervalSec);

          // Send StatusNotification for every bay (BOOT-012, SN-001).
          //
          // `previousStatus` is deliberately absent: this is the post-boot report,
          // and the state it leaves behind is `Unknown`, which the field cannot
          // carry. Its absence is what marks the message as the boot report
          // (status-notification.md §5 rule 2).
          for (const bay of station.config.bays) {
            const bayState = station.getBayState(bay.bayId);

            // The station reports what it resolved TO, never `Unknown` itself. Bays
            // are constructed AVAILABLE and nothing station-side moves them back —
            // the transitions INTO `Unknown` are the server's LWT bookkeeping, which
            // a station never observes. So this cannot fire; it is here because the
            // alternative is publishing a non-conforming message, and a loud local
            // failure beats a message the server will reject and drop entirely.
            if (!isReportableBayStatus(bayState)) {
              throw new Error(
                `[BootNotification] bay ${bay.bayId} is in state ${bayState}, which a station ` +
                  'must not report. Resolve the bay before reporting it (05-state-machines.md §1.2).',
              );
            }

            const statusPayload: StatusNotificationPayload = {
              bayId: bay.bayId,
              bayNumber: bay.bayNumber,
              status: bayState,
              services: bay.services.map(s => ({ serviceId: s.serviceId, available: s.available })),
            };
            await station.sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, statusPayload);
          }
        }

        // Clock sync from serverTime (HB-010 -- also done on boot)
        const serverTime = new Date(response.serverTime).getTime();
        const drift = Math.abs(serverTime - Date.now());
        if (drift > 300_000) {
          console.warn('[BootNotification] Clock drift exceeds 5 minutes (%dms). CLOCK_ERROR', drift);
        }

        break;
      }

      case 'Rejected': {
        const retryInterval = response.retryInterval;
        console.log('[BootNotification] Rejected. retryInterval: %ds', retryInterval);
        if (station.config.behavior.autoRetryBoot) {
          setTimeout(() => {
            station.retryBoot().catch((err: unknown) => {
              console.error('[BootNotification] Retry failed:', err instanceof Error ? err.message : String(err));
            });
          }, retryInterval * 1000);
        }
        break;
      }

      case 'Pending': {
        const retryInterval = response.retryInterval;
        console.log('[BootNotification] Pending. retryInterval: %ds', retryInterval);
        if (station.config.behavior.autoRetryBoot) {
          setTimeout(() => {
            station.retryBoot().catch((err: unknown) => {
              console.error('[BootNotification] Retry failed:', err instanceof Error ? err.message : String(err));
            });
          }, retryInterval * 1000);
        }
        break;
      }
    }
  }
}
