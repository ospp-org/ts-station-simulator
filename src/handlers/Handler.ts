import type { OsppEnvelope, BayStatus } from '@ospp/protocol';

/**
 * Minimal station context passed to every handler.
 * Uses inline imports to avoid circular dependency issues.
 */
export interface StationContext {
  readonly config: import('../station/StationConfig.js').StationConfig;
  readonly sender: import('../mqtt/MessageSender.js').MessageSender;
  readonly lifecycle: import('../station/StationLifecycle.js').StationLifecycle;
  sessions: Map<string, SessionInfo>;
  reservations: Map<string, ReservationInfo>;
  currentRevocationEpoch: number;
  sessionKey: string | null;
  /**
   * The device-held private key (PKCS8 PEM) minted for an in-flight certificate
   * renewal. Set by TriggerCertificateRenewalHandler when it sends the CSR;
   * consumed by CertificateInstallHandler to pair with the signed leaf the
   * server returns. Null when no renewal is in flight. (ADR-0002 T1.)
   */
  pendingRenewalKeyPem: string | null;
  getBayState(bayId: string): BayStatus;
  setBayState(bayId: string, status: BayStatus): void;
  startHeartbeat(intervalSec: number): void;
  stopHeartbeat(): void;
  retryBoot(): Promise<void>;
  /**
   * Persist a renewed leaf cert (+ optional issuing chain) and its retained
   * private key to the station's TLS file paths — the client-cert swap. ADR-0002 T1.
   */
  installRenewedCertificate(input: {
    certificatePem: string;
    privateKeyPem: string;
    caChainPem?: string;
  }): Promise<void>;
  /** Re-handshake mTLS presenting the freshly-installed leaf. ADR-0002 T1. */
  reconnectWithRenewedCertificate(): Promise<void>;
  destroyConnection(): void;
}

export interface SessionInfo {
  sessionId: string;
  bayId: string;
  serviceId: string;
  startedAt: string;
  durationSeconds: number;
  seqNo: number;
  // Credits-per-minute used to compute `creditsCharged` on session end per OSPP
  // §03-messages.md:700: `creditsCharged = ceil(actualDurationSeconds / 60 * priceCreditsPerMinute)`.
  // StartService Request schema does not carry pricing; sim defaults to 100 cr/min,
  // matching csms-server's typical test catalog. Server is the authoritative billing
  // engine (§04-flows.md:823-833) — this value is advisory only.
  priceCreditsPerMinute: number;
}

export interface ReservationInfo {
  reservationId: string;
  bayId: string;
  expirationTime: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface Handler {
  handle(envelope: OsppEnvelope, station: StationContext): Promise<void>;
}
