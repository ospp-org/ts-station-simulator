import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type TriggerCertificateRenewalRequest,
  type TriggerCertificateRenewalResponse,
  type SignCertificateRequest,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

export class TriggerCertificateRenewalHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as TriggerCertificateRenewalRequest;

    // Respond Accepted
    const response: TriggerCertificateRenewalResponse = {
      status: 'Accepted',
    };

    await station.sender.send<TriggerCertificateRenewalResponse>(
      OsppAction.TRIGGER_CERTIFICATE_RENEWAL,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    console.log(
      '[TriggerCertificateRenewal] Accepted — type: %s',
      request.certificateType,
    );

    // Send a SignCertificate request to the server
    const signRequest: SignCertificateRequest = {
      certificateType: request.certificateType,
      csr: `-----BEGIN CERTIFICATE REQUEST-----\nMIIBSimulated${Date.now()}\n-----END CERTIFICATE REQUEST-----`,
    };

    await station.sender.send<SignCertificateRequest>(
      OsppAction.SIGN_CERTIFICATE,
      MessageType.REQUEST,
      signRequest,
    );

    console.log(
      '[TriggerCertificateRenewal] SignCertificate request sent for type: %s',
      request.certificateType,
    );
  }
}
