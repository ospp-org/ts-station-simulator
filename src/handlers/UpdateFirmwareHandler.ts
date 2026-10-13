import {
  OsppAction,
  MessageType,
  OsppErrorCode,
  OSPP_ERROR_REGISTRY,
  BootReason,
  type OsppEnvelope,
  type UpdateFirmwareRequest,
  type UpdateFirmwareResponse,
  type FirmwareStatusNotificationPayload,
  type FirmwareNotificationStatus,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

/** How often the install gate looks again at the sessions it waits for. */
const INSTALL_GATE_POLL_MS = 1000;

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

    // NO REFUSAL FOR A RUNNING SESSION. This answered 3016 while any session ran, contrary to
    // update-firmware.md §5 rule 1 ("respond with `Accepted` and begin the download immediately - the
    // download is not deferred by `scheduledAt` and is not gated on bay state") and rule 7, which
    // gates the INSTALL only, and says it is "the only one". A firmware update has no end record of
    // its own: it waits, and each session ends first with its own (session-end rule, table 1).

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

    // The download, at once and whatever the bays are doing. Simulated: nothing here touches the
    // network, a hash or a partition - see FirmwareIntegrityCeiling.test.ts for why that is pinned.
    await this.stages(station, request.firmwareVersion, ['Downloading', 'Downloaded']);

    // THE INSTALL GATE (rule 7): "The station MUST NOT begin installation while active sessions are
    // in progress. It MUST wait for sessions to complete". A wash ends on its own at its booked
    // duration (its timer's SessionEnded), so the wait ends. And each session ends FIRST WITH ITS OWN
    // RECORD (session-end rule, table 1): while the station can transmit, it also waits for the end
    // records it holds to leave. One it cannot send now is on disk and goes after the new image's
    // boot - the wait is for the sessions, never for the link.
    const waiting = (): boolean => station.sessions.size > 0
      || ((station.heldSessionEnded?.length ?? 0) > 0 && (station.canTransmit?.() ?? true));
    if (waiting()) {
      console.log('[UpdateFirmware] %s downloaded — waiting for %d session(s) to end before installing', request.firmwareVersion, station.sessions.size);
    }
    while (waiting()) {
      await new Promise<void>(resolve => setTimeout(resolve, INSTALL_GATE_POLL_MS));
    }

    await this.stages(station, request.firmwareVersion, ['Installing', 'Installed']);

    // Installed, then the reboot into the new image (update-firmware.md §6 stage 4): the next
    // BootNotification carries the new `firmwareVersion` and `bootReason: "FirmwareUpdate"`. It used
    // to stop at Installed - no reboot, no boot, the old version reported for ever.
    station.config.firmwareVersion = request.firmwareVersion;
    await station.restart(BootReason.FIRMWARE_UPDATE);
  }

  /** One FirmwareStatusNotification per stage, a second apart. */
  private async stages(
    station: StationContext,
    firmwareVersion: string,
    stages: FirmwareNotificationStatus[],
  ): Promise<void> {
    for (const status of stages) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000));

      const notification: FirmwareStatusNotificationPayload = {
        status,
        firmwareVersion,
      };

      await station.sender.send<FirmwareStatusNotificationPayload>(
        OsppAction.FIRMWARE_STATUS_NOTIFICATION,
        MessageType.EVENT,
        notification,
      );

      console.log(
        '[UpdateFirmware] FirmwareStatusNotification: %s (version: %s)',
        status,
        firmwareVersion,
      );
    }
  }
}
