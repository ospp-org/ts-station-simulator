import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, bootAccepted, until, frames, indexOf,
  STATION_ID,
} from '../helpers/stationHarness.js';

/*
 * M5 - AN UPDATE WAITS FOR THE SESSIONS, IT DOES NOT REFUSE THEM (DESIGN-A2 table 1, S6).
 *
 * update-firmware.md §5: rule 1 - a valid request is answered `Accepted` and the download begins
 * IMMEDIATELY, "not gated on bay state"; rule 7 - "The station MUST NOT begin installation while
 * active sessions are in progress. It MUST wait for sessions to complete" - the install gate, and
 * "the ONLY one". A firmware update has no end record of its own: each session ends first with
 * its own (here its timer's SessionEnded TimerExpired), and the station then installs and boots
 * the new image with `bootReason: "FirmwareUpdate"` and the new `firmwareVersion`.
 *
 * Connect mode refused the whole update `3016` while a session ran (UpdateFirmwareHandler:40-53,
 * contrary to rules 1 and 7), and after `Installed` it never rebooted: no BootNotification, the
 * version unchanged (M-SIM 1.2, "UpdateFirmware").
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
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

function statuses(since: number): string[] {
  return frames('FirmwareStatusNotification', undefined, since).map((f) => String(f.payload.status));
}

describe('M5 - UpdateFirmware with a session running: accepted, downloaded, installed after the session, then a FirmwareUpdate boot', () => {
  it('RED: Accepted and downloaded at once, no install while the wash runs, then Installing, Installed and a BootNotification FirmwareUpdate with the new version', async () => {
    const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
    station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
    await station.connect();
    await station.retryBoot();
    station.handleMessage(bootAccepted());
    await until(() => frames('StatusNotification').length > 0, 'the boot report');
    await new StartServiceHandler().handle(startService('sess_m5wash', 60), station as never);
    const since = wire.frames.length;

    const handled = new UpdateFirmwareHandler().handle(request('UpdateFirmware', UPDATE), station as never);
    await elapse(10_000);

    expect(frames('UpdateFirmware', 'Response', since)[0]?.payload, 'the update was refused while a wash ran').toEqual({ status: 'Accepted' });
    expect(statuses(since)).toEqual(['Downloading', 'Downloaded']);

    // The wash runs to its timer; only then may the image be written. The install gate waits
    // on station seconds for the end record to leave, and that record reaches the real disk
    // first - so the clock keeps moving, a second at a time, until the new image has booted.
    await elapse(55_000);
    for (let second = 0; second < 120 && frames('BootNotification', 'Request', since).length === 0; second++) {
      await elapse(1_000);
    }
    await until(() => frames('BootNotification', 'Request', since).length > 0, 'the boot into the new image');
    await handled;

    expect(statuses(since)).toEqual(['Downloading', 'Downloaded', 'Installing', 'Installed']);
    const ended = indexOf((f) => f.action === 'SessionEnded', since);
    const installing = indexOf((f) => f.action === 'FirmwareStatusNotification' && f.payload.status === 'Installing', since);
    const boot = indexOf((f) => f.action === 'BootNotification' && f.messageType === 'Request', since);
    expect(wire.frames[ended].payload).toMatchObject({ sessionId: 'sess_m5wash', reason: 'TimerExpired' });
    expect(ended, 'the install began while the session ran').toBeLessThan(installing);
    expect(installing).toBeLessThan(boot);
    expect(wire.frames[boot].payload).toMatchObject({ bootReason: 'FirmwareUpdate', firmwareVersion: '1.1.0' });
    // The new image powered on: the uptime started again, below the 60 s the wash alone took.
    expect(Number(wire.frames[boot].payload.uptimeSeconds)).toBeLessThan(60);
  });

  it('CONTROL: the version already installed is still refused 5016, and nothing reboots', async () => {
    const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
    await station.connect();
    station.handleMessage(bootAccepted());
    station.sessionKey = (bootAccepted() as unknown as { payload: { sessionKey: string } }).payload.sessionKey;
    const since = wire.frames.length;

    await new UpdateFirmwareHandler().handle(request('UpdateFirmware', { ...UPDATE, firmwareVersion: '1.0.0' }), station as never);

    expect(frames('UpdateFirmware', 'Response', since)[0].payload).toMatchObject({ status: 'Rejected', errorCode: 5016 });
    expect(frames('BootNotification', 'Request', since)).toEqual([]);
  });
});
