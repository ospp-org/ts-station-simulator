import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  wire, resetWire, fakeClock, certDir, connectConfig, request, bootAccepted, until, settled,
  frames, indexOf, STATION_ID, BAY_ID, SERVICE_ID,
} from '../helpers/stationHarness.js';
import { schemaErrors } from '../helpers/wireSchemas.js';

/*
 * THE BAY CHANGES A RESERVATION AND MAINTENANCE MAKE, ON THE WIRE (TODO §A0 of csms-server,
 * 2026-10-21).
 *
 *  - 05-state-machines.md §2: "The station MUST send a StatusNotification on every state
 *    transition", within 1 s (status-notification.md §7 rule 3). §2.3's Station rows include
 *    Available -> Reserved (a ReserveBay accepted), Reserved -> Available (the reservation expired
 *    or was cancelled), Available or Faulted -> Unavailable (maintenance on) and
 *    Unavailable -> Available (maintenance off).
 *  - set-maintenance-mode.md §5 rule 4: "On Accepted, the station MUST send a StatusNotification for
 *    each affected bay reflecting the new state"; §6: off moves only an Unavailable bay, and on a bay
 *    already in the requested state it is Accepted with no change (rule 7).
 *
 * Connect mode moved the bay in its own state machine for all four and reported none, so the
 * server's bay stayed where it was (bays.status is written by StatusNotification alone) - and off
 * moved every bay it targeted to Available, an Occupied or Faulted one included.
 *
 * Offline: MqttConnection is stubbed; the clocks are fake.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');
const { ReserveBayHandler } = await import('../../handlers/ReserveBayHandler.js');
const { CancelReservationHandler } = await import('../../handlers/CancelReservationHandler.js');
const { SetMaintenanceModeHandler } = await import('../../handlers/SetMaintenanceModeHandler.js');

const BAY_2 = 'bay_e2d00002';

let cleanup: () => Promise<void>;
let publishedAt: Map<unknown, number>;

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

/** A connect-mode station with two bays, booted through its own handler: its boot report is on the wire. */
async function bootedStation() {
  const station = new Station(connectConfig({
    bayCount: 2,
    bays: [
      {
        bayId: BAY_ID, bayNumber: 1,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: SERVICE_ID, serviceName: 'Basic Wash', available: true }],
      },
      {
        bayId: BAY_2, bayNumber: 2,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: SERVICE_ID, serviceName: 'Basic Wash', available: true }],
      },
    ],
  }), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification').length >= station.config.bays.length, 'the boot report');
  return station;
}

/** The bay reports published at or after `since`, bay by bay, as the server reads them. */
function reports(since: number): Array<{ bayId: unknown; status: unknown; previousStatus: unknown }> {
  return frames('StatusNotification', undefined, since)
    .map((f) => ({ bayId: f.payload.bayId, status: f.payload.status, previousStatus: f.payload.previousStatus }));
}

const reserve = (bayId: string, reservationId: string, inMs = 600_000) => request('ReserveBay', {
  reservationId, bayId, expirationTime: new Date(Date.now() + inMs).toISOString(), sessionSource: 'MobileApp',
});

describe('a reservation is reported (05-state-machines.md §2, §2.3)', () => {
  it('a ReserveBay accepted reports the bay Reserved, after the RESPONSE and within 1 s of it', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    await new ReserveBayHandler().handle(reserve(BAY_ID, 'rsv_e2f00001'), station as never);
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);

    const answer = indexOf((f) => f.action === 'ReserveBay' && f.messageType === 'Response', since);
    expect(wire.frames[answer]?.payload).toEqual({ status: 'Accepted' });
    const report = indexOf((f) => f.action === 'StatusNotification', since);
    expect(report, 'no bay report after the reservation was accepted').toBeGreaterThan(answer);
    expect(reports(since)).toEqual([{ bayId: BAY_ID, status: 'Reserved', previousStatus: 'Available' }]);
    expect(schemaErrors('status-notification.schema.json', wire.frames[report].payload)).toEqual([]);
    expect(publishedAt.get(wire.frames[report])! - publishedAt.get(wire.frames[answer])!).toBeLessThan(1_000);
  });

  it('a reservation that expires reports the bay Available again', async () => {
    const station = await bootedStation();
    await new ReserveBayHandler().handle(reserve(BAY_ID, 'rsv_e2f00002', 5_000), station as never);
    const since = wire.frames.length;
    await vi.advanceTimersByTimeAsync(5_001);
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);

    expect(station.getBayState(BAY_ID)).toBe('Available');
    expect(reports(since)).toEqual([{ bayId: BAY_ID, status: 'Available', previousStatus: 'Reserved' }]);
  });

  it('a CancelReservation accepted reports the bay Available again', async () => {
    const station = await bootedStation();
    await new ReserveBayHandler().handle(reserve(BAY_ID, 'rsv_e2f00003'), station as never);
    const since = wire.frames.length;
    await new CancelReservationHandler().handle(
      request('CancelReservation', { reservationId: 'rsv_e2f00003', bayId: BAY_ID }), station as never,
    );
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);

    const answer = indexOf((f) => f.action === 'CancelReservation' && f.messageType === 'Response', since);
    expect(wire.frames[answer]?.payload).toEqual({ status: 'Accepted' });
    expect(indexOf((f) => f.action === 'StatusNotification', since)).toBeGreaterThan(answer);
    expect(reports(since)).toEqual([{ bayId: BAY_ID, status: 'Available', previousStatus: 'Reserved' }]);
  });

  it('CONTROL: a refused ReserveBay or CancelReservation reports nothing', async () => {
    const station = await bootedStation();
    await new ReserveBayHandler().handle(reserve(BAY_ID, 'rsv_e2f00004'), station as never);
    const since = wire.frames.length;
    // The bay is held: a second reservation is refused, and cancelling a reservation never made is too.
    await new ReserveBayHandler().handle(reserve(BAY_ID, 'rsv_e2f00005'), station as never);
    await new CancelReservationHandler().handle(
      request('CancelReservation', { reservationId: 'rsv_e2f0dead', bayId: BAY_2 }), station as never,
    );
    await settled(() => false, 30);

    expect(frames('ReserveBay', 'Response', since)[0]?.payload.status).toBe('Rejected');
    expect(reports(since)).toEqual([]);
  });
});

describe('maintenance is reported (set-maintenance-mode.md §5 rule 4, §6)', () => {
  const maintenance = (enabled: boolean, bayId?: string) =>
    request('SetMaintenanceMode', { enabled, ...(bayId === undefined ? {} : { bayId }), reason: 'technician' });

  it('on, for a bay: reports it Unavailable; off: reports it Available again', async () => {
    const station = await bootedStation();
    let since = wire.frames.length;
    await new SetMaintenanceModeHandler().handle(maintenance(true, BAY_ID), station as never);
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);
    const answer = indexOf((f) => f.action === 'SetMaintenanceMode' && f.messageType === 'Response', since);
    expect(wire.frames[answer]?.payload).toEqual({ status: 'Accepted' });
    expect(indexOf((f) => f.action === 'StatusNotification', since)).toBeGreaterThan(answer);
    expect(reports(since)).toEqual([{ bayId: BAY_ID, status: 'Unavailable', previousStatus: 'Available' }]);

    since = wire.frames.length;
    await new SetMaintenanceModeHandler().handle(maintenance(false, BAY_ID), station as never);
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);
    expect(reports(since)).toEqual([{ bayId: BAY_ID, status: 'Available', previousStatus: 'Unavailable' }]);
  });

  it('on, for the station: reports every bay it took out of service', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    await new SetMaintenanceModeHandler().handle(maintenance(true), station as never);
    await settled(() => frames('StatusNotification', undefined, since).length >= 2, 300);

    expect(reports(since)).toEqual([
      { bayId: BAY_ID, status: 'Unavailable', previousStatus: 'Available' },
      { bayId: BAY_2, status: 'Unavailable', previousStatus: 'Available' },
    ]);
  });

  it('off moves only an Unavailable bay: a Faulted one stays Faulted and is not reported (§6, rule 7)', async () => {
    const station = await bootedStation();
    station.setBayState(BAY_2, 'Faulted' as never);
    await new SetMaintenanceModeHandler().handle(maintenance(true, BAY_ID), station as never);
    const since = wire.frames.length;
    await new SetMaintenanceModeHandler().handle(maintenance(false), station as never);
    await settled(() => frames('StatusNotification', undefined, since).length > 0, 300);

    expect(frames('SetMaintenanceMode', 'Response', since)[0]?.payload).toEqual({ status: 'Accepted' });
    expect(station.getBayState(BAY_2)).toBe('Faulted');
    expect(reports(since)).toEqual([{ bayId: BAY_ID, status: 'Available', previousStatus: 'Unavailable' }]);
  });

  it('on, for a bay already in maintenance, is Accepted and reports nothing (rule 7) - it threw on Unavailable -> Unavailable', async () => {
    const station = await bootedStation();
    await new SetMaintenanceModeHandler().handle(maintenance(true, BAY_ID), station as never);
    const since = wire.frames.length;
    await new SetMaintenanceModeHandler().handle(maintenance(true, BAY_ID), station as never);
    await settled(() => false, 30);

    expect(frames('SetMaintenanceMode', 'Response', since)[0]?.payload).toEqual({ status: 'Accepted' });
    expect(reports(since)).toEqual([]);
  });
});
