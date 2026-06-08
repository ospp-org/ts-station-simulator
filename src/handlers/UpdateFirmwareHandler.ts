import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  type OsppEnvelope,
  type UpdateFirmwareRequest,
  type UpdateFirmwareResponse,
  type FirmwareStatusNotificationPayload,
  type FirmwareNotificationStatus,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class UpdateFirmwareHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as UpdateFirmwareRequest;

    // Check if firmware version matches current version
    if (request.firmwareVersion === station.config.firmwareVersion) {
      const rejected: UpdateFirmwareResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.VERSION_ALREADY_INSTALLED,
        errorText: 'VERSION_ALREADY_INSTALLED',
      };
      await station.sender.send<UpdateFirmwareResponse>(
        OsppAction.UPDATE_FIRMWARE, MessageType.RESPONSE, rejected, envelope.messageId,
      );
      console.log('[UpdateFirmware] Rejected — version %s already installed', request.firmwareVersion);
      return;
    }

    // Check for active sessions
    if (station.sessions.size > 0) {
      const rejected: UpdateFirmwareResponse = {
        status: 'Rejected',
        errorCode: OsppErrorCode.ACTIVE_SESSIONS_PRESENT,
        errorText: 'ACTIVE_SESSIONS_PRESENT',
      };
      await station.sender.send<UpdateFirmwareResponse>(
        OsppAction.UPDATE_FIRMWARE, MessageType.RESPONSE, rejected, envelope.messageId,
      );
      console.log('[UpdateFirmware] Rejected — %d active sessions', station.sessions.size);
      return;
    }

    // Respond Accepted
    const response: UpdateFirmwareResponse = { status: 'Accepted' };

    await station.sender.send<UpdateFirmwareResponse>(
      OsppAction.UPDATE_FIRMWARE,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[UpdateFirmware] Accepted — firmware %s from %s',
      request.firmwareVersion,
      request.firmwareUrl,
    );

    // Simulate firmware update lifecycle with delays
    const stages: FirmwareNotificationStatus[] = [
      'Downloading',
      'Downloaded',
      'Installing',
      'Installed',
    ];

    for (const status of stages) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000));

      const notification: FirmwareStatusNotificationPayload = {
        status,
        firmwareVersion: request.firmwareVersion,
      };

      await station.sender.send<FirmwareStatusNotificationPayload>(
        OsppAction.FIRMWARE_STATUS_NOTIFICATION,
        MessageType.EVENT,
        notification,
      );

      console.log(
        '[UpdateFirmware] FirmwareStatusNotification: %s (version: %s)',
        status,
        request.firmwareVersion,
      );
    }
  }
}
