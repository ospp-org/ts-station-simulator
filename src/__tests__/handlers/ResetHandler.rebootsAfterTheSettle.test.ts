import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, bootAccepted, until, frames, indexOf,
  STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * M4 - A RESET IS A REBOOT: SETTLE FIRST, THEN BOOT AGAIN WITH `RemoteReset` (DESIGN-A2 S6).
 *
 * reset.md §5, unchanged by the session-end rule and kept by it:
 *   rule 2 - a session running and `force` absent or false: Rejected `3016`, no reboot;
 *   rule 3 - `force: true`: settle every session first (SessionEnded `OperatorStopped`, the
 *            delivered time) and complete that settlement before rebooting;
 *   rule 6 - "After restarting it MUST send a BootNotification with `bootReason: "RemoteReset"`".
 *
 * Connect mode did rules 2 and 3 and then only dropped its socket (`stopHeartbeat()` +
 * `destroyConnection()`): mqtt.js reconnected 5 s later and the station sent nothing - no boot,
 * uptime not reset, no heartbeat - connected and silent (M-SIM 1.2, "Reset, forced").
 *
 * Under the session-end rule that boot is no longer an end of anything; the station's
 * SessionEnded is the record, and the boot that follows it says only that the station is back.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { ResetHandler } = await import('../../handlers/ResetHandler.js');
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

async function bootedStation() {
  const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification').length > 0, 'the boot report');
  return station;
}

/**
 * Run the Reset handler on the fake clock: it waits out its reboot delay before it reboots. The
 * clock moves a second at a time and stops once the handler is done, so the boot it sends is read
 * at the second it was sent in - not seconds later, while its own disk reads were in flight.
 */
async function reset(station: unknown, force: boolean | undefined): Promise<void> {
  let done = false;
  const handled = new ResetHandler()
    .handle(request('Reset', force === undefined ? {} : { force }), station as never)
    .finally(() => { done = true; });
  for (let second = 0; second < 10 && !done; second++) await elapse(1_000);
  await handled;
}

describe('M4 - a forced Reset settles every session first, then reboots with RemoteReset', () => {
  it('RED: Reset Accepted, then SessionEnded OperatorStopped with the delivered time, then a BootNotification RemoteReset with uptime 0', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_m4forced', 300), station as never);
    await elapse(45_000);
    const since = wire.frames.length;

    await reset(station, true);
    await until(() => frames('BootNotification', 'Request', since).length > 0, 'a BootNotification after the forced Reset');

    const answer = indexOf((f) => f.action === 'Reset' && f.messageType === 'Response', since);
    const settled = indexOf((f) => f.action === 'SessionEnded', since);
    const boot = indexOf((f) => f.action === 'BootNotification' && f.messageType === 'Request', since);
    expect(wire.frames[answer].payload.status).toBe('Accepted');
    expect(wire.frames[settled].payload).toMatchObject({
      sessionId: 'sess_m4forced',
      bayId: BAY_ID,
      reason: 'OperatorStopped',
      actualDurationSeconds: 45,
    });
    expect(wire.frames[boot].payload.bootReason).toBe('RemoteReset');
    // The uptime started again: below the 45 s the station had run before the Reset.
    expect(Number(wire.frames[boot].payload.uptimeSeconds)).toBeLessThan(45);
    // The settlement is complete before the reboot (rule 3), and the answer goes before both (rule 5).
    expect(answer).toBeLessThan(settled);
    expect(settled).toBeLessThan(boot);
    expect(station.sessions.size).toBe(0);
    // One end record for the session, not a second one at the booked end.
    await elapse(300_000);
    expect(frames('SessionEnded', undefined, since)).toHaveLength(1);
  });

  it('RED: an unforced Reset with nothing running is Accepted and reboots with RemoteReset', async () => {
    const station = await bootedStation();
    await elapse(30_000);
    const since = wire.frames.length;

    await reset(station, false);
    await until(() => frames('BootNotification', 'Request', since).length > 0, 'a BootNotification after the Reset');

    expect(frames('Reset', 'Response', since)[0].payload.status).toBe('Accepted');
    expect(frames('BootNotification', 'Request', since)[0].payload.bootReason).toBe('RemoteReset');
    // Below the 30 s the station had run: the uptime started again.
    expect(Number(frames('BootNotification', 'Request', since)[0].payload.uptimeSeconds)).toBeLessThan(30);
  });

  it('CONTROL: an unforced Reset with a session running is refused 3016 and nothing reboots', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_m4refused', 300), station as never);
    const since = wire.frames.length;

    await reset(station, undefined);

    expect(frames('Reset', 'Response', since)[0].payload).toMatchObject({ status: 'Rejected', errorCode: 3016 });
    expect(frames('BootNotification', 'Request', since)).toEqual([]);
    expect(frames('SessionEnded', undefined, since)).toEqual([]);
    expect(station.sessions.has('sess_m4refused')).toBe(true);
  });
});
