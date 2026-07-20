import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type TriggerCertificateRenewalRequest,
  type TriggerCertificateRenewalResponse,
  type SignCertificateRequest,
} from '@ospp/protocol';
import { buildStationCsr } from '../cli/provision.js';
import type { Handler, StationContext } from './Handler.js';

/**
 * Inbound TriggerCertificateRenewal (Server → Station) — ADR-0002 T1.
 *
 * A renewal is a genuine re-key: the station mints a FRESH ECDSA P-256 keypair
 * + CSR the same way it does at provisioning (buildStationCsr), so the CSMS
 * CsrValidator accepts it identically (EC secp256r1, CN == stationId, valid
 * proof-of-possession). The new private key is retained on the station to pair
 * with the signed leaf the server later pushes in CertificateInstall.
 */
export class TriggerCertificateRenewalHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as TriggerCertificateRenewalRequest;

    // Acknowledge the trigger, correlated to the inbound messageId.
    const response: TriggerCertificateRenewalResponse = {
      status: 'Accepted',
    };
    await station.sender.send<TriggerCertificateRenewalResponse>(
      OsppAction.TRIGGER_CERTIFICATE_RENEWAL,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );

    // Re-key + retain the private key for the CertificateInstall step.
    const { csrPem, privateKeyPem } = await buildStationCsr(station.config.stationId);
    station.pendingRenewalKeyPem = privateKeyPem;

    const signRequest: SignCertificateRequest = {
      certificateType: request.certificateType,
      csr: csrPem,
    };
    await station.sender.send<SignCertificateRequest>(
      OsppAction.SIGN_CERTIFICATE,
      MessageType.REQUEST,
      signRequest,
    );

    console.log(
      '[TriggerCertificateRenewal] Accepted — re-key CSR sent for type: %s',
      request.certificateType,
    );
  }
}
