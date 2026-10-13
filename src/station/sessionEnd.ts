import { randomUUID } from 'node:crypto';
import {
  OsppAction,
  MessageType,
  BayStatus,
  SessionEndReason,
  isReportableBayStatus,
  type SessionEndedPayload,
  type StatusNotificationPayload,
} from '@ospp/protocol';
import type { SessionInfo, StationContext } from '../handlers/Handler.js';
import type { HeldSessionEnded } from './SessionStore.js';
import { monotonicNowMs } from './monotonicClock.js';

/**
 * THE ONE PATH BY WHICH THIS STATION ENDS A SESSION IT DECIDED TO END.
 *
 * The session-end rule (2026-10-13): a session is ended ONLY by the station's end record, and the
 * station MUST send one for every session it started - SessionEnded for every end it decides, the
 * StopService RESPONSE for a stop the server asked for (DESIGN-A2 S1). So every end this station
 * decides comes through endSession(): the wash timer (TimerExpired), a forced Reset's settlement
 * (OperatorStopped), a restart it could not resume the wash after (Fault). A stop the server asked
 * for does not: StopServiceHandler's RESPONSE is that end record, and no SessionEnded follows it.
 *
 * It replaces Station.settleSessionAsOperatorStop's body, which was the only SessionEnded the
 * simulator ever sent on its own (M-SIM 1.1).
 */

/** The simulator's advisory price: the server bills from its own tariff (session-ended.md §5 rule 5). */
const DEFAULT_PRICE_CREDITS_PER_MINUTE = 100;

/** The two reasons that bill nothing, whatever was delivered: "creditsCharged MUST be 0" (03-messages.md §5.4). */
const ZERO_BILLED: ReadonlySet<SessionEndReason> = new Set([
  SessionEndReason.LOCAL_OUT_OF_CREDIT,
  SessionEndReason.DEAUTHORIZED,
]);

/**
 * Seconds of service delivered so far: what a restart carried in, plus the monotonic time since this
 * process began (or resumed) delivering it, rounded to the nearest second (stop-service.md §6 rule 5,
 * session-ended.md §5 rule 2). Never the wall clock.
 */
export function deliveredSeconds(
  session: Pick<SessionInfo, 'startedAtMonotonicMs' | 'deliveredBeforeRestartSeconds'>,
  nowMs: number = monotonicNowMs(),
): number {
  const sinceThisProcess = Math.max(0, Math.round((nowMs - session.startedAtMonotonicMs) / 1000));
  return (session.deliveredBeforeRestartSeconds ?? 0) + sinceThisProcess;
}

export function clearWashTimer(session: Pick<SessionInfo, 'washTimer'>): void {
  if (session.washTimer !== undefined) {
    clearTimeout(session.washTimer);
    session.washTimer = undefined;
  }
}

/**
 * Arm the timer that ends the wash when its booked duration has been delivered: at an accepted
 * StartService, and again for the rest of the duration when a restart resumes the wash. It ends it
 * with SessionEnded TimerExpired - "full booked duration delivered" - carrying the booked duration.
 */
export function armWashTimer(
  station: StationContext,
  session: Pick<SessionInfo, 'sessionId' | 'durationSeconds' | 'startedAtMonotonicMs' | 'deliveredBeforeRestartSeconds' | 'washTimer'>,
): void {
  clearWashTimer(session);
  const deliveredMs = (session.deliveredBeforeRestartSeconds ?? 0) * 1000
    + Math.max(0, monotonicNowMs() - session.startedAtMonotonicMs);
  const remainingMs = Math.max(0, session.durationSeconds * 1000 - deliveredMs);

  const timer = setTimeout(() => {
    session.washTimer = undefined;
    endSession(station, session.sessionId, SessionEndReason.TIMER_EXPIRED, {
      deliveredSeconds: session.durationSeconds,
    }).catch((err: unknown) => {
      console.error(
        '[Session] %s reached its booked end and its SessionEnded could not be built: %s',
        session.sessionId, err instanceof Error ? err.message : String(err),
      );
    });
  }, remainingMs);
  // The station's MQTT link keeps the process alive; a wash timer alone must not.
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  session.washTimer = timer;
}

/**
 * End `sessionId` for `reason` and send its SessionEnded - or hold it, when the station cannot
 * transmit, until the next `Accepted` boot (session-ended.md §5 rule 3).
 *
 * In order: the timer goes; the delivered time is measured (or taken from `deliveredSeconds`, for
 * the timer's booked duration and a restart's persisted time); the session leaves the map and its
 * bay goes Occupied -> Finishing -> Available; the SessionEnded is recorded as held and the record
 * written BEFORE the publish, so a power loss in between still finds it; the station's replay sends
 * it and releases it. After it, a bay whose last report no longer says what it is now is reported
 * again - SessionEnded before that StatusNotification (session-ended.md §5 rule 6).
 *
 * Returns the payload it ended the session with, or null when the station held no such session.
 */
export async function endSession(
  station: StationContext,
  sessionId: string,
  reason: SessionEndReason,
  opts: { deliveredSeconds?: number } = {},
): Promise<SessionEndedPayload | null> {
  const session = station.sessions.get(sessionId);
  if (session === undefined) {
    return null;
  }

  clearWashTimer(session);
  const actualDurationSeconds = Math.max(0, opts.deliveredSeconds ?? deliveredSeconds(session));
  const creditsCharged = ZERO_BILLED.has(reason)
    ? 0
    : Math.ceil((actualDurationSeconds / 60) * (session.priceCreditsPerMinute ?? DEFAULT_PRICE_CREDITS_PER_MINUTE));

  station.sessions.delete(sessionId);
  releaseBay(station, session.bayId);

  const payload: SessionEndedPayload = {
    sessionId: session.sessionId as SessionEndedPayload['sessionId'],
    bayId: session.bayId as SessionEndedPayload['bayId'],
    reason,
    actualDurationSeconds,
    creditsCharged,
    // peek, not next: SessionEnded reports the FINAL position, it does not issue a new one.
    seqNo: session.seq.peek(),
    finalSeqNo: session.seq.peek(),
  };
  const held: HeldSessionEnded = { messageId: randomUUID(), payload, endedAt: new Date().toISOString() };

  const outbox = station.heldSessionEnded;
  if (outbox !== undefined && station.replayHeldSessionEnded !== undefined) {
    // A STATION THAT HOLDS ITS END RECORDS SENDS THEM FROM ONE PLACE. Held first and on disk before
    // anything is published, so a power loss in between still finds it; then the station's one
    // publisher of held records sends it - now, if the station can transmit, behind any older one,
    // and with nothing else able to send the same record twice. When it cannot transmit, it waits
    // there for the next Accepted boot.
    outbox.push(held);
    await persist(station, `the end of ${sessionId}`);
    await station.replayHeldSessionEnded();
    if (outbox.includes(held)) {
      console.log(
        '[Session] %s ended (%s, %ds) - its SessionEnded is held for the next accepted boot',
        sessionId, reason, actualDurationSeconds,
      );
      return payload;
    }
  } else {
    // A context that holds nothing (a handler test): publish, and let a failure reach the caller.
    await station.sender.send<SessionEndedPayload>(OsppAction.SESSION_ENDED, MessageType.EVENT, payload, held.messageId);
  }
  console.log('[Session] %s ended - %s, %ds, %d credits', sessionId, reason, actualDurationSeconds, creditsCharged);

  await reportBayIfChanged(station, session.bayId);
  return payload;
}

/**
 * Occupied -> Finishing -> Available: the FSM has no direct Occupied -> Available edge, and a wash
 * that is ending passes through Finishing whoever ended it. A bay already idle (a restart that could
 * not resume the wash never set it Occupied) is left alone. A transition hiccup must not lose the
 * end record, so it is logged, not thrown.
 */
function releaseBay(station: StationContext, bayId: string): void {
  try {
    if (station.getBayState(bayId) === BayStatus.OCCUPIED) {
      station.setBayState(bayId, BayStatus.FINISHING);
    }
    if (station.getBayState(bayId) === BayStatus.FINISHING) {
      station.setBayState(bayId, BayStatus.AVAILABLE);
    }
  } catch (err) {
    console.log(
      '[Session] bay %s could not be released (%s) - the session is reported anyway',
      bayId, err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Report a bay whose state is no longer what this station last put on the wire for it - the bay of
 * a wash resumed after a restart, which the boot reported Occupied. A bay whose last report already
 * says what it is gets nothing: connect mode reports at boot and does not report the start of a
 * wash, so an ordinary wash ends where its bay's last report left it.
 */
export async function reportBayIfChanged(station: StationContext, bayId: string): Promise<void> {
  const reported = station.lastReportedBayStatus;
  if (reported === undefined) return;
  let now: BayStatus;
  try {
    now = station.getBayState(bayId);
  } catch {
    return;
  }
  const last = reported.get(bayId);
  if (last === undefined || last === now || !isReportableBayStatus(now)) return;
  if (station.canTransmit !== undefined && !station.canTransmit()) return;

  const bay = station.config.bays.find((b) => b.bayId === bayId);
  if (bay === undefined) return;
  const report: StatusNotificationPayload = {
    bayId: bay.bayId,
    bayNumber: bay.bayNumber,
    status: now,
    previousStatus: last as StatusNotificationPayload['previousStatus'],
    programs: bay.programs.map((p) => ({ programNumber: p.programNumber, available: p.available })),
  };
  try {
    await station.sender.send<StatusNotificationPayload>(OsppAction.STATUS_NOTIFICATION, MessageType.EVENT, report);
    reported.set(bayId, now);
  } catch (err) {
    console.log('[Session] bay %s could not be reported %s (%s)', bayId, now, err instanceof Error ? err.message : String(err));
  }
}

async function persist(station: StationContext, what: string): Promise<void> {
  try {
    await station.persistSessions?.();
  } catch (err) {
    // The end is reported even when the disk refuses it: losing the report is the worse failure.
    console.error('[Session] could not record %s on disk: %s', what, err instanceof Error ? err.message : String(err));
  }
}
