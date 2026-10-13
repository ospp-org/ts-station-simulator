import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir } from 'node:fs/promises';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, bootAccepted, until, settled,
  frames, indexOf, readSessionRecord, sessionRecordFile, STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * THREE THINGS THE SESSION RECORD MUST CARRY, AND ONE THING A RESTARTED STATION MUST SAY.
 *
 *  - start-service.md §6 rule 9: the record is written "before energising anything", and a station
 *    that cannot write it "MUST refuse with 5103 STORAGE_ERROR and MUST NOT activate" - a wash it
 *    could not remember is one it could send no end record for after a restart.
 *  - A wash resumed after a restart had its bay reported Occupied at the boot; when its
 *    SessionEnded has gone, the bay's two transitions are reported, Finishing and then Available.
 *    Otherwise the server's bay stays Occupied after the wash, and the next start on it is refused.
 *  - stop-service.md §6 rule 10: the cached RESPONSE of a stop is kept for the retention horizon,
 *    across a restart too - the server's repeated StopService is how it recovers a lost RESPONSE,
 *    and a restart in between must not turn the answer into 3006.
 *
 * Offline, on the stubbed MQTT link and the fake clocks of stationHarness.ts.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { StopServiceHandler } = await import('../../handlers/StopServiceHandler.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');
const { ReserveBayHandler } = await import('../../handlers/ReserveBayHandler.js');

type StationInstance = InstanceType<typeof Station>;
type Restartable = StationInstance & { restoreSessions?: () => Promise<unknown>; restart?: (reason: string) => Promise<void> };

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

function power(): Restartable {
  const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  return station as Restartable;
}

async function bootOnline(station: Restartable, since: number): Promise<void> {
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification', undefined, since).length > 0, 'the boot report');
}

describe('start-service.md §6 rule 9 - no record, no wash', () => {
  it('RED: a StartService the station cannot record is refused 5103, the wash is not started and the bay stays Available', async () => {
    // The record's own path is a DIRECTORY: the rename that would put the record there fails, and
    // nothing else the station keeps beside its certificates (its topology) is touched.
    await mkdir(sessionRecordFile());

    const station = power();
    await bootOnline(station, 0);
    const since = wire.frames.length;

    await new StartServiceHandler().handle(startService('sess_norecord', 60), station as never);

    expect(frames('StartService', 'Response', since)[0]?.payload, 'a wash the station could not record was accepted')
      .toMatchObject({ status: 'Rejected', errorCode: 5103, errorText: 'STORAGE_ERROR', programNumber: 1 });
    expect(station.sessions.has('sess_norecord')).toBe(false);
    expect(station.getBayState(BAY_ID)).toBe('Available');
    // And nothing ends what never started.
    await elapse(70_000);
    expect(frames('SessionEnded', undefined, since)).toEqual([]);
  });
});

describe('a resumed wash gives its bay back', () => {
  it('RED: after the SessionEnded of a wash resumed across a restart, the bay is reported Finishing (previous Occupied), then Available (previous Finishing)', async () => {
    const first = power();
    await bootOnline(first, 0);
    await new StartServiceHandler().handle(startService('sess_givesback', 60), first as never);
    await elapse(25_000);
    await settled(() => Number(readSessionRecord().sessions[0]?.deliveredSeconds ?? 0) >= 15);
    vi.clearAllTimers();
    const since = wire.frames.length;

    const second = power();
    await second.restoreSessions?.();
    await bootOnline(second, since);
    await elapse(40_000);
    await until(() => frames('SessionEnded', undefined, since).length > 0, 'the SessionEnded of the resumed wash');
    await settled(() => frames('StatusNotification', undefined, indexOf((f) => f.action === 'SessionEnded', since)).length > 1);

    const ended = indexOf((f) => f.action === 'SessionEnded', since);
    const after = frames('StatusNotification', undefined, ended).filter((f) => f.payload.bayId === BAY_ID);
    // Both transitions, after the end record: there is no Occupied -> Available edge (05-state-machines.md
    // §7.2). This pinned the one Available report, previousStatus Occupied, that edge.
    expect(after.map((f) => f.payload), 'the bay stayed Occupied on the wire after the wash ended').toEqual([
      expect.objectContaining({ status: 'Finishing', previousStatus: 'Occupied' }),
      expect.objectContaining({ status: 'Available', previousStatus: 'Finishing' }),
    ]);
  });
});

describe('stop-service.md §6 rule 10 - the answer outlives a restart', () => {
  it('RED: a StopService answered before a power loss is answered again from its cached RESPONSE after it', async () => {
    const first = power();
    await bootOnline(first, 0);
    await new StartServiceHandler().handle(startService('sess_stoppedbefore', 300), first as never);
    await elapse(30_000);
    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_stoppedbefore', bayId: BAY_ID }, 'cmd_stop_before'),
      first as never,
    );
    const answered = frames('StopService', 'Response')[0].payload;
    await settled(() => readSessionRecord().sessions.length === 0);
    vi.clearAllTimers();
    const since = wire.frames.length;

    const second = power();
    await second.restoreSessions?.();
    await bootOnline(second, since);
    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_stoppedbefore', bayId: BAY_ID }, 'cmd_stop_after'),
      second as never,
    );

    const again = frames('StopService', 'Response', since)[0];
    expect(again.messageId).toBe('cmd_stop_after');
    expect(again.payload, 'the restart turned the cached answer into a refusal').toEqual(answered);
  });
});

describe('a restart is a power cycle of the sessions, not of the reservations', () => {
  it('a reservation the station holds keeps its bay Reserved through restart(): the boot report says so', async () => {
    const station = power();
    await bootOnline(station, 0);
    await new ReserveBayHandler().handle(
      request('ReserveBay', {
        reservationId: 'rsv_keptacross',
        bayId: BAY_ID,
        expirationTime: new Date(Date.now() + 600_000).toISOString(),
        sessionSource: 'MobileApp',
      }),
      station as never,
    );
    expect(station.getBayState(BAY_ID)).toBe('Reserved');
    const since = wire.frames.length;

    await station.restart?.('Watchdog');
    station.handleMessage(bootAccepted());
    await until(() => frames('StatusNotification', undefined, since).length > 0, 'the boot report after the restart');

    expect(frames('StatusNotification', undefined, since).find((f) => f.payload.bayId === BAY_ID)?.payload.status)
      .toBe('Reserved');
    expect(station.reservations.has(BAY_ID)).toBe(true);
  });
});
