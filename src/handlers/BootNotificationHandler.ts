import { type OsppEnvelope, type BootNotificationResponse, OsppAction, MessageType, type StatusNotificationPayload } from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class BootNotificationHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const response = envelope.payload as BootNotificationResponse;

    switch (response.status) {
      case 'Accepted': {
        console.log(
          '[BootNotification] Accepted. Heartbeat interval: %ds',
          response.heartbeatIntervalSec,
        );

        // Start heartbeat at server-specified interval
        station.startHeartbeat(response.heartbeatIntervalSec);

        // Send StatusNotification for every bay (BOOT-012, SN-001)
        for (const bay of station.config.bays) {
          const bayState = station.getBayState(bay.bayId);
          const statusPayload: StatusNotificationPayload = {
            bayId: bay.bayId,
            bayNumber: bay.bayNumber,
            status: bayState,
            services: bay.services.map(s => ({ serviceId: s.serviceId, available: s.available })),
          };
          await station.sender.send(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, statusPayload);
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
