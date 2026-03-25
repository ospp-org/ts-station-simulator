import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type CertificateInstallRequest,
  type CertificateInstallResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class CertificateInstallHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as CertificateInstallRequest;

    // Simulated: always accept certificate installation
    const response: CertificateInstallResponse = {
      status: 'Accepted',
      certificateSerialNumber: `SN-${Date.now()}`,
    };

    await station.sender.send<CertificateInstallResponse>(
      OsppAction.CERTIFICATE_INSTALL,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[CertificateInstall] Accepted — type: %s, serial: %s',
      request.certificateType,
      response.certificateSerialNumber,
    );
  }
}
