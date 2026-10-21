import type { SequenceCounter } from '../station/SequenceCounter.js';
import type { OsppEnvelope, BayStatus, BootReason, StopServiceResponse } from '@ospp/protocol';

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
  /**
   * Reservations that have LEFT the live map, by `reservationId` — the retention
   * `reserve-bay.md` §5.2 requires so `cancel-reservation.md` rules 2/3/6 can be told
   * apart. Without it "expired", "consumed" and "never existed" all look identical.
   */
  terminalReservations: Map<string, import('./bayRefusal.js').TerminalReservation>;
  currentRevocationEpoch: number;
  /**
   * The catalog version this station currently holds — `''` before the first one.
   * Read and then advanced by UpdateServiceCatalogHandler, which reports the old
   * value as `previousCatalogVersion`; see the field's docblock on `Station`.
   */
  currentCatalogVersion: string;
  /**
   * Keep the catalog just accepted where the next process of this station will find it (Station,
   * when its config asks for it - connect mode). Optional: a handler test's hand-built context has none.
   */
  persistCatalog?(catalogVersion: string, services: import('../station/StationConfig.js').ServiceConfig[]): Promise<void>;
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
   * The BootNotification the server asked for by TriggerMessage: `Reconnect`, the uptime running on -
   * no boot occurred (boot-notification.md §5.2) - and the reason a retry of it repeats.
   */
  bootOnRequest(): Promise<void>;
  /**
   * The configuration keys this station holds (08-configuration.md): MeterValuesInterval and
   * MeterValuesSampleInterval. Absent on a handler test's hand-built context, where the spec defaults
   * govern and a change is validated but kept nowhere.
   */
  configuration?: import('../station/StationConfiguration.js').StationConfiguration;
  /**
   * Settle one running session as an OPERATOR-INITIATED stop and report it.
   *
   * reset-request.schema.json (spec v0.44.0), `force`: "the station settles every
   * active session under the operator-disable policy FIRST (04-flows.md, 'The
   * operator-disable policy') — the session is stopped, metered from the time
   * ACTUALLY DELIVERED, and reported as SessionEnded with reason OperatorStopped,
   * which the server settles by service kind (pro-rata on delivered time for
   * UserDuration, a full refund for FixedDuration and MultiUnit; 04-flows.md,
   * 'Settlement by Service Kind') — and only then reboots. Force is not a licence
   * to drop a session on the floor; it is a licence to end it without waiting."
   */
  settleSessionAsOperatorStop(sessionId: string): Promise<void>;
  /**
   * Power-cycle the station in process and boot again with `reason` (a Reset: `RemoteReset`; an
   * installed update: `FirmwareUpdate`): every timer and the session key go, the uptime restarts at
   * 0, and the sessions it kept on disk are resumed or ended exactly as after a real power loss
   * (Station.restoreSessions). The six reasons that keep a session resume it; RemoteReset and
   * FirmwareUpdate find none to keep.
   */
  restart(reason: BootReason): Promise<void>;
  /**
   * Keep the live sessions, the SessionEnded events not yet sent and the stops already answered on
   * disk (session-end rule S2) - Station, when its config asks for it (connect mode). Absent on a
   * handler test's hand-built context, which keeps nothing.
   */
  persistSessions?(): Promise<void>;
  /**
   * Whether a message can leave now: the link is up, a boot was answered `Accepted`, a session key
   * is held. Absent means yes - a handler test's context publishes into its own array.
   */
  canTransmit?(): boolean;
  /**
   * True from the start of a firmware write until the reboot into the new image: the station begins
   * no session then, answering StartService and ReserveBay `3002 BAY_NOT_READY`
   * (05-state-machines.md §7.4). Set by UpdateFirmwareHandler, cleared by `restart()`. Absent on a
   * handler test's hand-built context, which installs nothing.
   */
  firmwareInstalling?: boolean;
  /**
   * The SessionEnded events the station could not publish (offline, restricted, or the publish
   * failed), oldest first, sent after the next `Accepted` boot with their original values
   * (session-ended.md §5 rule 3: buffered, never discarded). Absent on a hand-built context.
   */
  heldSessionEnded?: import('../station/SessionStore.js').HeldSessionEnded[];
  /** The cached RESPONSE of a stop this station answered `Accepted`, within the retention horizon (stop-service.md §6 rule 10). */
  stopAnswerFor?(sessionId: string): Extract<StopServiceResponse, { status: 'Accepted' }> | undefined;
  /** Keep the RESPONSE of a stop just answered `Accepted`, for a repeated StopService (rule 10). */
  rememberStopAnswer?(sessionId: string, bayId: string, response: Extract<StopServiceResponse, { status: 'Accepted' }>): void;
  /** The bay status this station last put on the wire for a bay (the boot report and every report after it). */
  lastReportedBayStatus?: Map<string, BayStatus>;
  /** After an Accepted boot and its bay reports: send every held SessionEnded, oldest first (Station). */
  replayHeldSessionEnded?(): Promise<void>;
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
   * measurement: `heartbeat.md §6 Clock Synchronization` rule 6 gives the wall clock the values that
   * get ORDERED — `timestamp`, `startedAt`, `endedAt` — and it is what a receiver
   * that never got a duration has to settle against (`heartbeat.md §6 Clock Synchronization`).
   *
   * It is NOT the origin of `actualDurationSeconds`. It was, at both sites that
   * produce that field, and that is the defect `startedAtMonotonicMs` closes.
   */
  startedAt: string;
  /**
   * The MONOTONIC reading taken at the same moment, and the only legitimate
   * origin for this session's elapsed time — `heartbeat.md §6 Clock Synchronization` rule 5,
   * `stop-service.md §6 Processing Rules` rule 5, `session-ended.md §5 Processing Rules` rule 2.
   *
   * Required, with no wall-clock fallback anywhere: a fallback would be a silent
   * route back to the wrong clock, and this simulator reached it at 2 of 2 sites
   * for as long as the field did not exist. Milliseconds since an arbitrary
   * per-process origin — see {@link monotonicNowMs}; never serialise it.
   */
  startedAtMonotonicMs: number;
  durationSeconds: number;
  seq: SequenceCounter;
  /**
   * The delivered seconds a restart carried into this process: the time persisted for a wash the
   * station resumed after it (session-end rule S3). Absent - zero - for a wash this process ran from
   * its start. The delivered time is this plus the monotonic time since `startedAtMonotonicMs`, which
   * for a resumed wash is the instant it resumed (sessionEnd.ts, deliveredSeconds).
   */
  deliveredBeforeRestartSeconds?: number;
  /** The timer that ends the wash at its booked duration with SessionEnded TimerExpired; every other end clears it. */
  washTimer?: ReturnType<typeof setTimeout>;
  /** The timer of the next periodic MeterValues (sessionMeter.ts); every end clears it with the wash timer. */
  meterTimer?: ReturnType<typeof setTimeout>;
  /**
   * Set, before anything is awaited, by the path that ends the session - its wash timer, a stop, a
   * forced Reset, a restart - so no second path ends it too while the first is still sending.
   */
  ending?: boolean;
  /** The program the StartService named, and that command's envelope messageId - start-service.md §6 rule 9's record. */
  programNumber?: number;
  startMessageId?: string;
  // Credits-per-minute used to compute `creditsCharged` on session end per OSPP
  // §03-messages.md §3.4 StopService: `creditsCharged = ceil(actualDurationSeconds / 60 * priceCreditsPerMinute)`.
  // StartService Request schema does not carry pricing; sim defaults to 100 cr/min,
  // matching csms-server's typical test catalog. Server is the authoritative billing
  // engine (§04-flows.md "5a. Full Offline Session — BLE" / "Error Paths") — this value is advisory only.
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
