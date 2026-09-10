import type { SequenceCounter } from '../station/SequenceCounter.js';
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
  /**
   * The catalog version this station currently holds — `''` before the first one.
   * Read and then advanced by UpdateServiceCatalogHandler, which reports the old
   * value as `previousCatalogVersion`; see the field's docblock on `Station`.
   */
  currentCatalogVersion: string;
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
   * Settle one running session as an OPERATOR-INITIATED stop and report it.
   *
   * reset-request.schema.json, `force`: "the station settles every active session
   * under the operator-disable policy FIRST — the session is stopped, metered and
   * reported exactly as an operator-initiated stop, so the customer is billed for
   * what they received — and only then reboots. Force is not a licence to drop a
   * session on the floor; it is a licence to end it without waiting."
   */
  settleSessionAsOperatorStop(sessionId: string): Promise<void>;
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
  /**
   * The WALL-CLOCK instant the session began, ISO-8601. This is a stamp, not a
   * measurement: `heartbeat.md:51` rule 6 gives the wall clock the values that
   * get ORDERED — `timestamp`, `startedAt`, `endedAt` — and it is what a receiver
   * that never got a duration has to settle against (`heartbeat.md:48`).
   *
   * It is NOT the origin of `actualDurationSeconds`. It was, at both sites that
   * produce that field, and that is the defect `startedAtMonotonicMs` closes.
   */
  startedAt: string;
  /**
   * The MONOTONIC reading taken at the same moment, and the only legitimate
   * origin for this session's elapsed time — `heartbeat.md:44` rule 5,
   * `stop-service.md:47` rule 5, `session-ended.md:61` rule 2.
   *
   * Required, with no wall-clock fallback anywhere: a fallback would be a silent
   * route back to the wrong clock, and this simulator reached it at 2 of 2 sites
   * for as long as the field did not exist. Milliseconds since an arbitrary
   * per-process origin — see {@link monotonicNowMs}; never serialise it.
   */
  startedAtMonotonicMs: number;
  durationSeconds: number;
  seq: SequenceCounter;
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
