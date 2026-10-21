import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, bootAccepted, until, settled,
  frames, indexOf, STATION_ID, BAY_ID, SERVICE_ID, type Frame,
} from '../helpers/stationHarness.js';
import { schemaErrors } from '../helpers/wireSchemas.js';

/*
 * THE BAY CHANGE OF A WASH, ON THE WIRE (M-SIM Part E, 2026-10-13).
 *
 *  - start-service.md §6 rule 10: "On success, the station MUST respond with status: Accepted and
 *    transition the bay to Occupied state"; 05-state-machines.md §2: "The station MUST send a
 *    StatusNotification on every state transition"; status-notification.md §7 rule 3: within 1 s
 *    of the change; 04-flows.md §3 steps 7-8: the RESPONSE first, then StatusNotification
 *    Occupied, previousStatus Available (TC-TX-001) - or Reserved for the holder's start (05 §2.3).
 *  - 05 §2.3 and §7.2: the end goes Occupied -> Finishing -> Available, each reported; there is no
 *    Occupied -> Available edge. 04-flows.md §6 and session-ended.md §5 rule 6: the end record
 *    first (SessionEnded, or the StopService RESPONSE), then the bay reports.
 *  - status-notification.md §7 rule 5: a bay report is regenerable - while the link is down it
 *    may be dropped, and the next boot report carries the bay.
 *
 * Connect mode set the bay Occupied in its own state machine and said nothing: the server's bay
 * stayed `available` for the whole wash (its bays.status is written by StatusNotification alone),
 * and at the end it reported one bay only when the last report differed - never for an ordinary
 * wash, and as the non-existent Occupied -> Available edge for a resumed one.
 *
 * Offline: MqttConnection is stubbed; the clocks are fake, the monotonic one included.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { StopServiceHandler } = await import('../../handlers/StopServiceHandler.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');
const { ReserveBayHandler } = await import('../../handlers/ReserveBayHandler.js');
const { TriggerMessageHandler } = await import('../../handlers/TriggerMessageHandler.js');

const BAY_2 = 'bay_e2d00002';

let cleanup: () => Promise<void>;
/** The station clock (fake) at the moment each frame was published. */
let publishedAt: Map<Frame, number>;

beforeEach(async () => {
  resetWire();
  fakeClock();
  ({ cleanup } = await certDir());
  publishedAt = new Map();
  wire.onPublish = (frame) => { publishedAt.set(frame, Date.now()); };
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await cleanup();
});

/** A connect-mode station that booted through its own handler: its boot report is on the wire and recorded. */
async function bootedStation(extra: Record<string, unknown> = {}) {
  const station = new Station(connectConfig(extra), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification').length >= station.config.bays.length, 'the boot report');
  return station;
}

/** The bay reports published at or after `since`, as the server reads them. */
function bayReports(since: number): Array<{ status: unknown; previousStatus: unknown }> {
  return frames('StatusNotification', undefined, since)
    .filter((f) => f.payload.bayId === BAY_ID)
    .map((f) => ({ status: f.payload.status, previousStatus: f.payload.previousStatus }));
}

const actions = (since: number) => JSON.stringify(wire.frames.slice(since).map((f) => `${f.action}/${f.messageType}`));

describe('the start of a wash is reported (start-service.md §6 rule 10, status-notification.md §7 rule 3)', () => {
  it('RED 1: an accepted StartService is followed, after its RESPONSE and within 1 s, by StatusNotification Occupied, previousStatus Available, for its bay, with every declared program', async () => {
    const station = await bootedStation();
    expect(frames('StatusNotification')[0].payload).toMatchObject({ bayId: BAY_ID, status: 'Available' });
    const since = wire.frames.length;

    await new StartServiceHandler().handle(startService('sess_e1a00001', 150), station as never);
    // No station time passes: the report is owed within 1 s of the change, not at the next timer.
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);

    const answer = indexOf((f) => f.action === 'StartService' && f.messageType === 'Response', since);
    const occupied = indexOf((f) => f.action === 'StatusNotification' && f.payload.bayId === BAY_ID, since);
    expect(wire.frames[answer]?.payload.status).toBe('Accepted');
    expect(occupied, `no bay report after the accepted start; frames after it: ${actions(since)}`).toBeGreaterThan(answer);
    expect(wire.frames[occupied].payload).toEqual({
      bayId: BAY_ID,
      bayNumber: 1,
      status: 'Occupied',
      previousStatus: 'Available',
      programs: [{ programNumber: 1, available: true }],
    });
    expect(schemaErrors('status-notification.schema.json', wire.frames[occupied].payload)).toEqual([]);
    expect(publishedAt.get(wire.frames[occupied])! - publishedAt.get(wire.frames[answer])!).toBeLessThan(1_000);
    // One report for one change.
    expect(bayReports(since)).toHaveLength(1);
  });

  it('RED 2: the holder\'s start on a reserved bay reports Occupied with previousStatus Reserved (05-state-machines.md §2.3)', async () => {
    const station = await bootedStation();
    await new ReserveBayHandler().handle(
      request('ReserveBay', {
        reservationId: 'rsv_e2a00001',
        bayId: BAY_ID,
        expirationTime: new Date(Date.now() + 600_000).toISOString(),
        sessionSource: 'MobileApp',
      }),
      station as never,
    );
    expect(station.getBayState(BAY_ID)).toBe('Reserved');
    const since = wire.frames.length;

    await new StartServiceHandler().handle(
      request('StartService', {
        sessionId: 'sess_e2a00001',
        bayId: BAY_ID,
        serviceId: SERVICE_ID,
        durationSeconds: 150,
        sessionSource: 'MobileApp',
        programNumber: 1,
        reservationId: 'rsv_e2a00001',
      }),
      station as never,
    );
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);

    const answer = indexOf((f) => f.action === 'StartService' && f.messageType === 'Response', since);
    expect(wire.frames[answer]?.payload.status).toBe('Accepted');
    const occupied = indexOf((f) => f.action === 'StatusNotification' && f.payload.bayId === BAY_ID, since);
    expect(occupied, `no bay report after the holder's start; frames after it: ${actions(since)}`).toBeGreaterThan(answer);
    expect(wire.frames[occupied].payload).toMatchObject({ status: 'Occupied', previousStatus: 'Reserved' });
  });

  it('CONTROL 3: a refused StartService reports no bay change - 3004 unknown service, 3017 undeclared program, 3001 bay busy', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    const start = new StartServiceHandler();

    await start.handle(
      request('StartService', {
        sessionId: 'sess_e3a00001', bayId: BAY_ID, serviceId: 'svc_not_sold_here', durationSeconds: 60,
        sessionSource: 'MobileApp', programNumber: 1,
      }),
      station as never,
    );
    await start.handle(
      request('StartService', {
        sessionId: 'sess_e3a00002', bayId: BAY_ID, serviceId: SERVICE_ID, durationSeconds: 60,
        sessionSource: 'MobileApp', programNumber: 9,
      }),
      station as never,
    );
    expect(frames('StartService', 'Response', since).map((f) => f.payload.errorCode)).toEqual([3004, 3017]);
    expect(bayReports(since), 'a refused start reported a bay change').toEqual([]);
    expect(station.getBayState(BAY_ID)).toBe('Available');

    // A wash on the bay, then a second start on it: refused 3001, and that refusal reports nothing either.
    await start.handle(startService('sess_e3a00003', 150), station as never);
    await settled(() => false, 50);
    const busy = wire.frames.length;
    await start.handle(startService('sess_e3a00004', 60), station as never);
    expect(frames('StartService', 'Response', busy)[0]?.payload).toMatchObject({ status: 'Rejected', errorCode: 3001 });
    await settled(() => false, 50);
    expect(bayReports(busy), 'a start refused on a busy bay reported a bay change').toEqual([]);
  });
});

describe('the end of a wash is reported after its end record (05-state-machines.md §7.2, 04-flows.md §6)', () => {
  it('RED 4a: the booked end - SessionEnded TimerExpired, then Finishing (previous Occupied), then Available (previous Finishing)', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    await new StartServiceHandler().handle(startService('sess_e4a00001', 30), station as never);

    await elapse(31_000);
    await until(() => frames('SessionEnded', undefined, since).length > 0, 'the SessionEnded at the booked end');
    const ended = indexOf((f) => f.action === 'SessionEnded', since);
    await settled(() => bayReports(ended).length >= 2, 300);

    expect(frames('SessionEnded', undefined, since)[0].payload).toMatchObject({ sessionId: 'sess_e4a00001', reason: 'TimerExpired' });
    expect(bayReports(ended), `bay reports after the SessionEnded; frames of the wash: ${actions(since)}`).toEqual([
      { status: 'Finishing', previousStatus: 'Occupied' },
      { status: 'Available', previousStatus: 'Finishing' },
    ]);
    for (const report of frames('StatusNotification', undefined, ended)) {
      expect(schemaErrors('status-notification.schema.json', report.payload)).toEqual([]);
    }
    expect(station.getBayState(BAY_ID)).toBe('Available');
  });

  it('RED 4b: an accepted StopService - its RESPONSE, then Finishing (previous Occupied), then Available (previous Finishing)', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_e4b00001', 150), station as never);
    await elapse(20_000);
    const since = wire.frames.length;

    await new StopServiceHandler().handle(
      request('StopService', { sessionId: 'sess_e4b00001', bayId: BAY_ID }),
      station as never,
    );
    const answered = indexOf((f) => f.action === 'StopService' && f.messageType === 'Response', since);
    expect(wire.frames[answered]?.payload).toMatchObject({ status: 'Accepted', actualDurationSeconds: 20 });
    await settled(() => bayReports(answered).length >= 2, 300);

    expect(bayReports(since), 'a bay report went before the RESPONSE that ended the wash').toEqual(bayReports(answered));
    expect(bayReports(answered), `bay reports after the RESPONSE; frames of the stop: ${actions(since)}`).toEqual([
      { status: 'Finishing', previousStatus: 'Occupied' },
      { status: 'Available', previousStatus: 'Finishing' },
    ]);
  });
});

describe('a bay report is regenerable (status-notification.md §7 rule 5)', () => {
  it('CONTROL 5: while the link is down the start\'s report is not published; the Reconnect boot report carries the bay', async () => {
    const station = await bootedStation();
    const link = wire.connections[wire.connections.length - 1];
    const since = wire.frames.length;
    // The socket drops the moment the RESPONSE has left: what mqtt.js re-emits when the stream closes.
    wire.onPublish = (frame) => {
      publishedAt.set(frame, Date.now());
      if (frame.action === 'StartService' && frame.messageType === 'Response') link.emit('close');
    };

    await new StartServiceHandler().handle(startService('sess_e5a00001', 150), station as never);
    await settled(() => false, 100);
    expect(frames('StartService', 'Response', since)[0]?.payload.status).toBe('Accepted');
    expect(bayReports(since), 'a bay report was published into a dead link').toEqual([]);

    // mqtt.js reconnects on its own: the station boots with Reconnect, and its boot report says Occupied.
    const back = wire.frames.length;
    link.emit('connect', {});
    await until(() => frames('BootNotification', 'Request', back).length > 0, 'the BootNotification after the reconnect');
    expect(frames('BootNotification', 'Request', back)[0].payload.bootReason).toBe('Reconnect');
    station.handleMessage(bootAccepted());
    await until(() => bayReports(back).length > 0, 'the boot report after the reconnect');
    expect(frames('StatusNotification', undefined, back)[0].payload).toEqual({
      bayId: BAY_ID,
      bayNumber: 1,
      status: 'Occupied',
      programs: [{ programNumber: 1, available: true }],
    });
  });
});

describe('the report the server asks for (trigger-message.md §5 rule 3, status-notification.md §5 rule 2)', () => {
  it('RED 15: a triggered StatusNotification reports the bay asked for with its own bayNumber, names previousStatus only when the bay is not what it was last reported as, and is Rejected for a bay the station does not have', async () => {
    const station = await bootedStation({
      bayCount: 2,
      bays: [
        {
          bayId: BAY_ID, bayNumber: 1,
          programs: [{ programNumber: 1, label: 'P1', available: true }],
          services: [{ serviceId: SERVICE_ID, serviceName: 'Basic Wash', available: true }],
        },
        {
          bayId: BAY_2, bayNumber: 2,
          programs: [{ programNumber: 1, label: 'P1', available: true }, { programNumber: 2, label: 'P2', available: true }],
          services: [{ serviceId: SERVICE_ID, serviceName: 'Basic Wash', available: true }],
        },
      ],
    });
    const trigger = async (payload: Record<string, unknown>) => {
      const since = wire.frames.length;
      await new TriggerMessageHandler().handle(request('TriggerMessage', payload), station as never);
      await settled(() => false, 30);
      return {
        answer: frames('TriggerMessage', 'Response', since)[0]?.payload,
        reports: frames('StatusNotification', undefined, since).map((f) => f.payload),
      };
    };
    // A change the station made without reporting it: bay 2 is Reserved, last reported Available. Taken
    // in the station's own state machine directly - a ReserveBay accepted reports its bay since
    // 2026-10-21 (Station.reportsReservationAndMaintenance.test.ts), and this case is about the report
    // the server asks for after a change it was not told of.
    station.setBayState(BAY_2, 'Reserved' as never);

    const asked = await trigger({ requestedMessage: 'StatusNotification', bayId: BAY_2 });
    expect(asked.answer).toEqual({ status: 'Accepted' });
    expect(asked.reports, 'the report of the bay asked for').toEqual([{
      bayId: BAY_2,
      bayNumber: 2,
      status: 'Reserved',
      previousStatus: 'Available',
      programs: [{ programNumber: 1, available: true }, { programNumber: 2, available: true }],
    }]);
    expect(schemaErrors('status-notification.schema.json', asked.reports[0])).toEqual([]);

    // Asked again: nothing changed since that report, so it is not a transition.
    const again = await trigger({ requestedMessage: 'StatusNotification', bayId: BAY_2 });
    expect(again.reports).toEqual([expect.not.objectContaining({ previousStatus: expect.anything() })]);
    expect(again.reports[0]).toMatchObject({ bayId: BAY_2, bayNumber: 2, status: 'Reserved' });

    // Every bay: both as last reported.
    const all = await trigger({ requestedMessage: 'StatusNotification' });
    expect(all.reports.map((r) => [r.bayId, r.bayNumber, r.status, r.previousStatus])).toEqual([
      [BAY_ID, 1, 'Available', undefined],
      [BAY_2, 2, 'Reserved', undefined],
    ]);

    // A bay this station does not have: no report can follow an Accepted.
    const unknown = await trigger({ requestedMessage: 'StatusNotification', bayId: 'bay_0000dead' });
    expect(unknown.answer).toEqual({ status: 'Rejected' });
    expect(unknown.reports).toEqual([]);
  });
});
