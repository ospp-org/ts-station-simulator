import {
  ConfigKey,
  OsppAction,
  MessageType,
  type MeterValues,
  type MeterValuesPayload,
} from '@ospp/protocol';
import type { SessionInfo, StationContext } from '../handlers/Handler.js';
import { configValue } from './StationConfiguration.js';
import { deliveredMs, deliveredSeconds } from './delivered.js';

/**
 * THE METER OF A RUNNING WASH (meter-values.md §5.1).
 *
 * The connect-mode boot declares `meterValuesSupported: true`, so the station MUST send the first
 * MeterValues within MeterValuesInterval of service activation and then one at that interval until the
 * session ends (rules 1-2), SHOULD send a final reading at the end, which the end record also carries
 * (rule 3), and applies a changed interval from the next scheduled event (rule 6). It sent none: the
 * only emitter was the TriggerMessage one-shot, with constant zeros and no seqNo.
 *
 * One timer per session (`SessionInfo.meterTimer`, beside the wash timer), armed at an accepted start
 * and at a resumed wash; each tick schedules the next at the interval in force when it is scheduled,
 * and none is scheduled at or after the booked end - the end path sends the last reading, so a tick
 * and the end never share an instant. Every end clears it with the wash timer.
 *
 * Every MeterValues this station sends is built by nextMeterValues - the ticks, the final reading of
 * every end, and the one the server asks for by TriggerMessage - on the session's one counter.
 */

/**
 * The readings: cumulative since the start of the wash (meter-values.md §4), DETERMINISTIC from the
 * delivered time - which runs on the monotonic clock and is carried across a restart - so they always
 * advance while the wash delivers (§5.1 rule 5 never lets this station skip one), never decrease, and
 * need no state of their own on disk. A bay pump of 7.5 l/min and a 900 W load: 125 ml and 0.25 Wh a
 * second. `consumableMl` is not metered by this station, so it is omitted rather than sent as 0 (§4).
 */
export const LIQUID_ML_PER_SECOND = 125;
export const ENERGY_WH_PER_SECOND = 0.25;

export function readingAt(seconds: number): MeterValues {
  const delivered = Math.max(0, seconds);
  return {
    liquidMl: Math.round(delivered * LIQUID_ML_PER_SECOND),
    // Whole units, rounded to the nearest (§4, Precision).
    energyWh: Math.round(delivered * ENERGY_WH_PER_SECOND),
  };
}

/** The reading of a running wash now: never past its booked duration. */
export function currentReading(session: Pick<SessionInfo, 'durationSeconds' | 'startedAtMonotonicMs' | 'deliveredBeforeRestartSeconds'>): MeterValues {
  return readingAt(Math.min(session.durationSeconds, deliveredSeconds(session)));
}

/**
 * What the meter reads of a session - both SessionInfo declarations (Handler.ts, Station.ts) have it.
 */
type Metered = Pick<
  SessionInfo,
  'sessionId' | 'bayId' | 'durationSeconds' | 'startedAtMonotonicMs' | 'deliveredBeforeRestartSeconds' | 'seq' | 'meterTimer' | 'ending'
>;

/**
 * finalSeqNo (05-state-machines.md §3.5 rule 5; 02-transport.md §3.2): the highest seqNo this session
 * has issued - its MeterValues and, on a SessionEnded, that event's own - or undefined when it issued
 * none, so a StopService RESPONSE leaves the field out. `peek()` would claim one more than was sent.
 */
export function highestSeqNo(session: Pick<SessionInfo, 'seq'>): number | undefined {
  const next = session.seq.peek();
  return next > 0 ? next - 1 : undefined;
}

export function clearMeterTimer(session: Pick<SessionInfo, 'meterTimer'>): void {
  if (session.meterTimer !== undefined) {
    clearTimeout(session.meterTimer);
    session.meterTimer = undefined;
  }
}

/**
 * Schedule the session's next reading, MeterValuesInterval from now - read now, so a ChangeConfiguration
 * applies from the next scheduled event (§5.1 rule 6) and the one already scheduled keeps its time.
 */
export function armMeterTimer(station: StationContext, session: Metered): void {
  clearMeterTimer(session);
  const intervalMs = configValue(station, ConfigKey.METER_VALUES_INTERVAL) * 1000;
  if (deliveredMs(session) + intervalMs >= session.durationSeconds * 1000) return;

  const timer = setTimeout(() => {
    session.meterTimer = undefined;
    // Ending, ended, or replaced by a restart while the timer was pending: nothing to meter.
    if (session.ending === true || station.sessions.get(session.sessionId) !== session) return;
    armMeterTimer(station, session);
    sendMeterValues(station, session).catch((err: unknown) => {
      console.error('[Meter] the reading of %s could not be sent: %s', session.sessionId, err instanceof Error ? err.message : String(err));
    });
  }, intervalMs);
  // The station's MQTT link keeps the process alive; a meter timer alone must not.
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  session.meterTimer = timer;
}

function mayTransmit(station: StationContext): boolean {
  return station.canTransmit === undefined || station.canTransmit();
}

/**
 * The next MeterValues of `session` - `values`, or its reading now - with the session's next seqNo,
 * taken NOW, synchronously: an end path reads finalSeqNo right after it, before anything is awaited.
 *
 * Null while the station cannot transmit: a MeterValues is Category 2, regenerable from the readings
 * around it and the end record (01-architecture.md §6.5; meter-values.md §6), so it is dropped rather
 * than queued into mqtt.js ahead of the next BootNotification, and a dropped one takes no number -
 * seqNo counts events sent (§5.1 rule 5).
 */
export function nextMeterValues(station: StationContext, session: Metered, values?: MeterValues): MeterValuesPayload | null {
  if (!mayTransmit(station)) return null;
  return {
    bayId: session.bayId as MeterValuesPayload['bayId'],
    sessionId: session.sessionId as MeterValuesPayload['sessionId'],
    // The wall clock STAMPS the reading; the delivered time it is computed from is monotonic.
    timestamp: new Date().toISOString(),
    values: values ?? currentReading(session),
    seqNo: session.seq.next(),
  };
}

/**
 * Publish a MeterValues built by nextMeterValues, its seqNo on disk first (05 §3.5 rule 1): a reading
 * whose record cannot be written is not sent, and neither is one whose link went while it was written.
 * Returns whether it was published.
 */
export async function publishMeterValues(station: StationContext, payload: MeterValuesPayload): Promise<boolean> {
  try {
    await station.persistSessions?.();
  } catch (err) {
    console.error(
      '[Meter] seqNo %d of %s could not be recorded on disk - the reading is not sent: %s',
      payload.seqNo, payload.sessionId, err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  if (!mayTransmit(station)) return false;
  try {
    await station.sender.send<MeterValuesPayload>(OsppAction.METER_VALUES, MessageType.EVENT, payload);
  } catch (err) {
    console.log(
      '[Meter] seqNo %d of %s could not be published (%s)',
      payload.seqNo, payload.sessionId, err instanceof Error ? err.message : String(err),
    );
    return false;
  }
  return true;
}

/** Both at once: a tick of the interval, and a reading the server asked for. Returns the payload published, or null. */
export async function sendMeterValues(
  station: StationContext,
  session: Metered,
  values?: MeterValues,
): Promise<MeterValuesPayload | null> {
  const payload = nextMeterValues(station, session, values);
  if (payload === null) return null;
  return (await publishMeterValues(station, payload)) ? payload : null;
}
