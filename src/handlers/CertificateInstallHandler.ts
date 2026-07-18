import {
  OsppAction,
  MessageType,
  type OsppEnvelope,
  type CertificateInstallRequest,
  type CertificateInstallResponse,
} from '@ospp/protocol';
import type { Handler, StationContext } from './Handler.js';

/**
 * Inbound CertificateInstall (Server → Station) — ADR-0002 T1.
 *
 * The server pushes the signed renewed leaf here (payload.certificate) after it
 * signs the CSR sent by TriggerCertificateRenewalHandler. The station:
 *   1. pairs the leaf with the private key it retained for this renewal,
 *   2. writes both to its TLS files (the client-cert swap),
 *   3. ACKs Accepted, then
 *   4. re-handshakes mTLS presenting the renewed leaf and re-boots.
 *
 * If no renewal is in flight (no retained key) the station rejects rather than
 * install a certificate it has no matching key for.
 */
export class CertificateInstallHandler implements Handler {
  async handle(envelope: OsppEnvelope, station: StationContext): Promise<void> {
    const request = envelope.payload as CertificateInstallRequest;
    const privateKeyPem = station.pendingRenewalKeyPem;

    if (privateKeyPem === null) {
      const rejected: CertificateInstallResponse = {
        status: 'Rejected',
        errorText: 'No certificate renewal in flight — no matching private key retained.',
      };
      await station.sender.send<CertificateInstallResponse>(
        OsppAction.CERTIFICATE_INSTALL,
        MessageType.RESPONSE,
        rejected,
        envelope.messageId,
      );
      console.warn('[CertificateInstall] Rejected — no pending renewal key');
      return;
    }

    // 1-2. Swap the client cert on disk (renewed leaf + retained key).
    await station.installRenewedCertificate({
      certificatePem: request.certificate,
      privateKeyPem,
      caChainPem: request.caCertificateChain,
    });
    station.pendingRenewalKeyPem = null;

    // 3. ACK on the current connection (before it is torn down for re-handshake).
    const response: CertificateInstallResponse = {
      status: 'Accepted',
    };
    await station.sender.send<CertificateInstallResponse>(
      OsppAction.CERTIFICATE_INSTALL,
      MessageType.RESPONSE,
      response,
      envelope.messageId,
    );
    console.log(
      '[CertificateInstall] Accepted — installed renewed %s; re-handshaking',
      request.certificateType,
    );

    // 4. Re-handshake mTLS with the renewed leaf, then re-boot.
    await station.reconnectWithRenewedCertificate();
    await station.retryBoot();
  }
}
