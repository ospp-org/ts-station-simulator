import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, bootAccepted, until, frames,
  STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * NO SESSION BEGINS WHILE A FIRMWARE INSTALL IS IN PROGRESS (Gabi, 2026-10-21).
 *
 * 05-state-machines.md §7.4: "From the start of the write until it reboots the station MUST NOT
 * begin a session: it answers StartService and ReserveBay `Rejected` with `3002 BAY_NOT_READY` and
 * authorizes no BLE session, so no session runs when it reboots". Connect mode accepted a start
 * between its `Installing` and its reboot, and the reboot then ended that wash with the image's
 * boot. The control is the station after the new image's boot answered `Accepted`: it sells again.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { ReserveBayHandler } = await import('../../handlers/ReserveBayHandler.js');
const { UpdateFirmwareHandler } = await import('../../handlers/UpdateFirmwareHandler.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');

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

const UPDATE = {
  firmwareUrl: 'https://firmware.example.invalid/washpro-1.1.0.bin',
  firmwareVersion: '1.1.0',
  checksum: 'sha256:00',
  signature: 'MEUCIQ==',
};

function reserveBay(reservationId: string): never {
  return request('ReserveBay', {
    reservationId,
    bayId: BAY_ID,
    expirationTime: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
}

async function stationInstalling() {
  const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification').length > 0, 'the boot report');
  const since = wire.frames.length;

  const handled = new UpdateFirmwareHandler().handle(request('UpdateFirmware', UPDATE), station as never);
  for (let second = 0; second < 10; second++) {
    if (frames('FirmwareStatusNotification', undefined, since).some((f) => f.payload.status === 'Installing')) break;
    await elapse(1_000);
  }
  expect(frames('FirmwareStatusNotification', undefined, since).map((f) => f.payload.status)).toEqual(['Downloading', 'Downloaded', 'Installing']);

  return { station, handled, since };
}

describe('the write has begun and the station has not rebooted: it begins no session', () => {
  it('RED: a StartService between Installing and the reboot is answered Rejected 3002, and no session runs into the reboot', async () => {
    const { station, handled, since } = await stationInstalling();

    await new StartServiceHandler().handle(startService('sess_fw_install', 60), station as never);

    expect(frames('StartService', 'Response', since)[0]?.payload).toMatchObject({ status: 'Rejected', errorCode: 3002 });
    expect(station.sessions.size).toBe(0);

    await elapse(2_000);
    await until(() => frames('BootNotification', 'Request', since).length > 0, 'the boot into the new image');
    await handled;
    expect(frames('SessionEnded', undefined, since)).toEqual([]);
  });

  it('RED: a ReserveBay between Installing and the reboot is answered Rejected 3002', async () => {
    const { station, handled, since } = await stationInstalling();

    await new ReserveBayHandler().handle(reserveBay('rsv_fw_install'), station as never);

    expect(frames('ReserveBay', 'Response', since)[0]?.payload).toMatchObject({ status: 'Rejected', errorCode: 3002 });
    expect(station.reservations.size).toBe(0);

    await elapse(2_000);
    await until(() => frames('BootNotification', 'Request', since).length > 0, 'the boot into the new image');
    await handled;
  });

  it('CONTROL: after the new image boots and is answered Accepted, the station sells again', async () => {
    const { station, handled, since } = await stationInstalling();

    await elapse(2_000);
    await until(() => frames('BootNotification', 'Request', since).length > 0, 'the boot into the new image');
    await handled;
    station.handleMessage(bootAccepted());
    await until(() => frames('StatusNotification', undefined, since).length > 0, 'the post-boot report');
    const after = wire.frames.length;

    await new StartServiceHandler().handle(startService('sess_after_install', 60), station as never);

    expect(frames('StartService', 'Response', after)[0]?.payload).toMatchObject({ status: 'Accepted' });
  });
});
