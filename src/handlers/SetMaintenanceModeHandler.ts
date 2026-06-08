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

export class SetMaintenanceModeHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as SetMaintenanceModeRequest;

    // Check if target bay(s) are Occupied before enabling maintenance
    if (request.enabled) {
      if (request.bayId) {
        const bayState = station.getBayState(request.bayId);
        if (bayState === BayStatus.OCCUPIED) {
          const rejected: SetMaintenanceModeResponse = {
            status: 'Rejected',
            errorCode: OsppErrorCode.BAY_BUSY,
            errorText: 'BAY_BUSY',
          };
          await station.sender.send<SetMaintenanceModeResponse>(
            OsppAction.SET_MAINTENANCE_MODE, MessageType.RESPONSE, rejected, envelope.messageId,
          );
          console.log('[SetMaintenanceMode] Rejected — bay %s is Occupied', request.bayId);
          return;
        }
      } else {
        const occupiedBay = station.config.bays.find(b => station.getBayState(b.bayId) === BayStatus.OCCUPIED);
        if (occupiedBay) {
          const rejected: SetMaintenanceModeResponse = {
            status: 'Rejected',
            errorCode: OsppErrorCode.BAY_BUSY,
            errorText: 'BAY_BUSY',
          };
          await station.sender.send<SetMaintenanceModeResponse>(
            OsppAction.SET_MAINTENANCE_MODE, MessageType.RESPONSE, rejected, envelope.messageId,
          );
          console.log('[SetMaintenanceMode] Rejected — bay %s is Occupied', occupiedBay.bayId);
          return;
        }
      }
    }

    if (request.bayId) {
      // Target a specific bay
      const targetStatus = request.enabled ? BayStatus.UNAVAILABLE : BayStatus.AVAILABLE;
      station.setBayState(request.bayId, targetStatus);

      console.log(
        '[SetMaintenanceMode] Bay %s set to %s (reason: %s)',
        request.bayId,
        targetStatus,
        request.reason ?? 'none',
      );
    } else {
      // Target all bays
      const targetStatus = request.enabled ? BayStatus.UNAVAILABLE : BayStatus.AVAILABLE;
      for (const bay of station.config.bays) {
        station.setBayState(bay.bayId, targetStatus);
      }

      console.log(
        '[SetMaintenanceMode] All %d bays set to %s (reason: %s)',
        station.config.bays.length,
        targetStatus,
        request.reason ?? 'none',
      );
    }

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
  }
}
