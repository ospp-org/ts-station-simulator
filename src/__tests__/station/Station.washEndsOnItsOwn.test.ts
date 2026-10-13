import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, until, frames,
  SESSION_KEY, STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * M1 - ONE SessionEnded PATH, AND THE WASH TIMER THAT FEEDS IT (session-end-truth 2026-10-13).
 *
 * The rule: a session is ended ONLY by the station's end record, and the station MUST send one
 * for every session it started - SessionEnded for every end it decides, the StopService RESPONSE
 * for a stop the server asked for (DESIGN-A2 S1). The end a station decides most often is the
 * timer: the booked duration elapses and the wash stops.
 *
 * In connect mode an accepted StartService armed nothing: no timer, so no SessionEnded, and the
 * session stayed in the map for ever (docs/CONFORMANCE-GAPS.md, "Zero of the four timers is
 * session-bound"). The server's sweep closed it, as a session with NO end record - charged in full
 * with the anomaly mark, the outcome the rule reserves for a station that went silent.
 *
 * Offline: MqttConnection is stubbed; the clocks are fake, the monotonic one included.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { StopServiceHandler } = await import('../../handlers/StopServiceHandler.js');

let cleanup: () => Promise<void>;

async function onlineStation() {
  const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  await station.connect();
  // What an Accepted boot leaves behind: the key, and the verdict that lets the station transmit.
  station.sessionKey = SESSION_KEY;
  station.bootAccepted = true;
  return station;
}

beforeEach(async () => {
  resetWire();
  fakeClock();
  ({ cleanup } = await certDir());
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await cleanup();
});

describe('M1 - the station ends the wash it accepted, on its own, at its booked duration', () => {
  it('RED: SessionEnded TimerExpired with the booked duration delivered, its credits and the final seqNo, and the bay is Available again', async () => {
    const station = await onlineStation();

    await new StartServiceHandler().handle(startService('sess_m1timer', 60), station as never);
    expect(frames('StartService', 'Response')[0]?.payload.status).toBe('Accepted');

    // One second short of the booking: the wash is still running.
    await elapse(59_000);
    expect(frames('SessionEnded'), 'the wash ended before its booked duration').toEqual([]);

    await elapse(1_000);
    await until(() => frames('SessionEnded').length > 0, 'a SessionEnded at the booked end');

    const ended = frames('SessionEnded')[0].payload;
    expect(ended.sessionId).toBe('sess_m1timer');
    expect(ended.bayId).toBe(BAY_ID);
    expect(ended.reason).toBe('TimerExpired');
    // 60 s at the simulator's 100 credits/minute: the whole booking was delivered.
    expect(ended.actualDurationSeconds).toBe(60);
    expect(ended.creditsCharged).toBe(100);
    expect(ended.finalSeqNo).toBe(0);
    expect(station.sessions.has('sess_m1timer')).toBe(false);
    // Occupied -> Finishing -> Available, as the stop takes it.
    expect(station.getBayState(BAY_ID)).toBe('Available');
  });

  it('CONTROL: a StopService accepted before the end is the end record - no SessionEnded follows it, then or at the booked end', async () => {
    const station = await onlineStation();
    await new StartServiceHandler().handle(startService('sess_m1stop', 60), station as never);

    await elapse(20_000);
    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_m1stop', bayId: BAY_ID }),
      station as never,
    );
    expect(frames('StopService', 'Response')[0]?.payload).toMatchObject({ status: 'Accepted', actualDurationSeconds: 20 });

    // Past the booked end: the cleared timer must not fire a second end record.
    await elapse(60_000);
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    expect(frames('SessionEnded'), `frames: ${JSON.stringify(wire.frames.map((f) => f.action))}`).toEqual([]);
  });
});
