import type { SessionInfo } from '../handlers/Handler.js';
import { monotonicNowMs } from './monotonicClock.js';

/**
 * THE SERVICE A SESSION HAS DELIVERED SO FAR - the one measure its end record, its meter readings and
 * its persisted record all read: what a restart carried in, plus the monotonic time since this
 * process began (or resumed) delivering it (stop-service.md §6 rule 5, session-ended.md §5 rule 2).
 * Never the wall clock. The time the station was off is not delivered time (05-state-machines.md
 * §3.5 rule 3).
 */
type Delivering = Pick<SessionInfo, 'startedAtMonotonicMs' | 'deliveredBeforeRestartSeconds'>;

/** In milliseconds, unrounded: what the session's timers are scheduled against. */
export function deliveredMs(session: Delivering, nowMs: number = monotonicNowMs()): number {
  return (session.deliveredBeforeRestartSeconds ?? 0) * 1000 + Math.max(0, nowMs - session.startedAtMonotonicMs);
}

/** In seconds, rounded to the nearest one (stop-service.md §6 rule 5): what goes on the wire. */
export function deliveredSeconds(session: Delivering, nowMs: number = monotonicNowMs()): number {
  const sinceThisProcess = Math.max(0, Math.round((nowMs - session.startedAtMonotonicMs) / 1000));
  return (session.deliveredBeforeRestartSeconds ?? 0) + sinceThisProcess;
}
