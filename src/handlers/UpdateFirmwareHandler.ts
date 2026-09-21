import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  OSPP_ERROR_REGISTRY,
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
        // `OSPP_ERROR_REGISTRY[...].text` rather than `errorName()`, and the reason is a
        // ceiling rather than a preference: `FirmwareIntegrityCeiling.test.ts` asserts this
        // file's imports are EXACTLY `['./Handler.js', '@ospp/protocol']`, because a new
        // dependency is how I/O arrives here. `errorName` lives in `./bayRefusal.js` and
        // importing it would red that guard. The registry is on the SDK this file already
        // imports, so the text is still derived and nothing is transcribed — measured
        // 2026-09-21, `OSPP_ERROR_REGISTRY[c].text === OsppErrorCode[c]` for 120 of 120
        // codes, so the two spellings are one source, not two.
        errorText: OSPP_ERROR_REGISTRY[OsppErrorCode.VERSION_ALREADY_INSTALLED].text,
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
        // Same ceiling as above.
        errorText: OSPP_ERROR_REGISTRY[OsppErrorCode.ACTIVE_SESSIONS_PRESENT].text,
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
