import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type GetDiagnosticsRequest,
  type GetDiagnosticsResponse,
  type DiagnosticsNotificationPayload,
  type DiagnosticsNotificationStatus,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class GetDiagnosticsHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as GetDiagnosticsRequest;

    const fileName = `diagnostics_${station.config.stationId}_${Date.now()}.tar.gz`;

    // Respond Accepted with filename
    const response: GetDiagnosticsResponse = {
      status: 'Accepted',
      fileName,
    };

    await station.sender.send<GetDiagnosticsResponse>(
      OsppAction.GET_DIAGNOSTICS,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[GetDiagnostics] Accepted — upload to %s, file: %s',
      request.uploadUrl,
      fileName,
    );

    // Simulate diagnostics collection lifecycle with delays
    const stages: DiagnosticsNotificationStatus[] = [
      'Collecting',
      'Uploading',
      'Uploaded',
    ];

    for (const status of stages) {
      await new Promise<void>(resolve => setTimeout(resolve, 1000));

      const notification: DiagnosticsNotificationPayload = {
        status,
        fileName,
      };

      await station.sender.send<DiagnosticsNotificationPayload>(
        OsppAction.DIAGNOSTICS_NOTIFICATION,
        MessageType.EVENT,
        notification,
      );

      console.log(
        '[GetDiagnostics] DiagnosticsNotification: %s (file: %s)',
        status,
        fileName,
      );
    }
  }
}
