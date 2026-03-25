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
  getBayState(bayId: string): BayStatus;
  setBayState(bayId: string, status: BayStatus): void;
  startHeartbeat(intervalSec: number): void;
  stopHeartbeat(): void;
  retryBoot(): Promise<void>;
  destroyConnection(): void;
}

export interface SessionInfo {
  sessionId: string;
  bayId: string;
  serviceId: string;
  startedAt: string;
  durationSeconds: number;
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
