import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resetWire, fakeClock, certDir, connectConfig, request, startService, frames,
  SESSION_KEY, STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * S4 - A REPEATED StopService IS ANSWERED WITH THE CACHED RESPONSE (DESIGN-A2 S4).
 *
 * stop-service.md §6 rule 10: after answering `Accepted`, the station "MUST retain the cached
 * RESPONSE payload (including actualDurationSeconds, creditsCharged, and final meterValues) for at
 * least the OSPP Session Retention Horizon (24 hours)", and "Duplicate StopService REQUESTs
 * targeting the same sessionId within the horizon MUST return the same cached RESPONSE without
 * re-running the stop logic"; rule 2 is evaluated after it, so 3006 is for a session the station
 * never stopped.
 *
 * Under the session-end rule this is the server's only recovery for a lost RESPONSE: it no longer
 * settles a stop on its own (no StopAckLost close, no refused-stop settlement); it re-sends the
 * StopService and takes the station's cached answer as the end record (Gabi, 2026-10-13, Q1).
 *
 * Connect mode deleted the session at the stop and kept nothing, so the re-sent StopService was
 * answered `3006 SESSION_NOT_FOUND` - a refusal that, under the new rule, leaves a stopped wash
 * open until the sweep charges it in full.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { StopServiceHandler } = await import('../../handlers/StopServiceHandler.js');

let cleanup: () => Promise<void>;

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

async function washingStation(sessionId: string) {
  const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  await station.connect();
  station.sessionKey = SESSION_KEY;
  station.bootAccepted = true;
  await new StartServiceHandler().handle(startService(sessionId, 300), station as never);
  return station;
}

describe('S4 - the second StopService for a stopped session gets the first answer again', () => {
  it('RED: the repeat is answered Accepted with the cached delivered time, credits and finalSeqNo, correlated to the repeat', async () => {
    const station = await washingStation('sess_s4cached');
    await vi.advanceTimersByTimeAsync(30_000);

    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_s4cached', bayId: BAY_ID }, 'cmd_stop_first'),
      station as never,
    );
    // The RESPONSE was lost; the server re-sends the stop ten seconds later.
    await vi.advanceTimersByTimeAsync(10_000);
    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_s4cached', bayId: BAY_ID }, 'cmd_stop_again'),
      station as never,
    );

    const [first, again] = frames('StopService', 'Response');
    expect(first.payload).toMatchObject({ status: 'Accepted', actualDurationSeconds: 30, creditsCharged: 50 });
    expect(again?.messageId).toBe('cmd_stop_again');
    expect(again?.payload, 'the repeated stop was answered with something other than the cached RESPONSE').toEqual(first.payload);
    // The stop logic did not run twice: the bay is idle and the wash it ended is not running.
    expect(station.getBayState(BAY_ID)).toBe('Available');
    expect(frames('SessionEnded')).toEqual([]);
  });

  it('CONTROL: a StopService for a session this station never ran is still refused 3006', async () => {
    const station = await washingStation('sess_s4running');

    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_s4unknown', bayId: BAY_ID }),
      station as never,
    );

    expect(frames('StopService', 'Response')[0].payload).toMatchObject({ status: 'Rejected', errorCode: 3006 });
    expect(station.sessions.has('sess_s4running')).toBe(true);
  });
});
