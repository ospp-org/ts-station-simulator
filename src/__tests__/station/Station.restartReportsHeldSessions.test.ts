import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  wire, resetWire, fakeClock, certDir, connectConfig, startService, bootAccepted, until, settled, frames, indexOf,
  readSessionRecord, STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * M3 - AFTER ANY RESTART THE STATION REPORTS EVERY SESSION IT HELD (DESIGN-A2 S3).
 *
 * For every session it held the station MUST either resume the wash and send its normal
 * SessionEnded at the end, or - when it cannot resume - send SessionEnded `Fault` at once after
 * the boot, carrying the last delivered time it persisted. `Fault` is widened to mean "a hardware
 * fault, or a restart the station could not resume the wash after" (Gabi, 2026-10-13); it settles
 * on Fault's existing row and needs no new wire value.
 *
 * The six boot reasons that keep a session (PowerOn, Watchdog, ErrorRecovery, Reconnect,
 * ManualReset, ScheduledReset) now mean "the station may resume the wash after this boot": the
 * simulator resumes by default, and `behavior.onRestart: 'interrupt'` is the knob that makes it
 * end each wash at once instead. RemoteReset and FirmwareUpdate mean no session may be live at
 * that boot, so one the station still holds there cannot be resumed.
 *
 * A restarted connect-mode process held nothing (M-SIM 1.2, "restart / power cycle": the map is
 * gone, the bays report Available), so the server was left to close each session with no record.
 *
 * Two Station objects on one certificate directory are two power cycles of one station. "Power
 * loss" is vi.clearAllTimers(): every timer of the first process dies with it, the disk survives.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');

type StationInstance = InstanceType<typeof Station>;

/** The members this behaviour adds, read through a view so the file compiles on a tree without them. */
type Restartable = StationInstance & {
  restoreSessions?: () => Promise<unknown>;
  restart?: (reason: string) => Promise<void>;
};

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

function power(extra: Record<string, unknown> = {}, behavior: Record<string, unknown> = {}): Restartable {
  const station = new Station(connectConfig(extra, behavior), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  return station as Restartable;
}

async function bootOnline(station: Restartable, since: number): Promise<void> {
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification', undefined, since).length > 0, 'the boot report');
}

/**
 * The first process: boots, accepts a 60 s wash and runs it 25 s, then loses power. Its record's
 * last checkpoint is the 20 s one - the delivered time a restart can know.
 */
async function washCutByPowerLoss(sessionId: string): Promise<void> {
  const first = power();
  await bootOnline(first, 0);
  await new StartServiceHandler().handle(startService(sessionId, 60), first as never);
  await vi.advanceTimersByTimeAsync(25_000);
  // The checkpoint the clock just fired is written on the real event loop; let it land, then cut the power.
  // Not a throw when none lands: a station that keeps nothing is what the assertions below name.
  await settled(() => Number(readSessionRecord().sessions[0]?.deliveredSeconds ?? 0) >= 15);
  vi.clearAllTimers();
}

/** The second process: what `simulator connect` does at start - restore what it kept, connect, boot. */
async function powerOnAgain(since: number, extra: Record<string, unknown> = {}, behavior: Record<string, unknown> = {}): Promise<Restartable> {
  const second = power(extra, behavior);
  await second.restoreSessions?.();
  await bootOnline(second, since);
  return second;
}

function bootReportOf(bayId: string, since: number): Record<string, unknown> | undefined {
  return frames('StatusNotification', undefined, since).find((f) => f.payload.bayId === bayId)?.payload;
}

function lastBootRequest(): Record<string, unknown> {
  const boots = frames('BootNotification', 'Request');
  return boots[boots.length - 1].payload;
}

describe('M3 - a restart that keeps the session: the station resumes the wash', () => {
  it('RED: after a PowerOn restart the boot report says Occupied, and SessionEnded TimerExpired with the whole booked duration comes at the end', async () => {
    await washCutByPowerLoss('sess_m3poweron');
    const since = wire.frames.length;

    const station = await powerOnAgain(since);

    expect(lastBootRequest()).toMatchObject({ bootReason: 'PowerOn', uptimeSeconds: 0 });
    expect(bootReportOf(BAY_ID, since)?.status, 'the bay of a resumed wash was reported').toBe('Occupied');
    expect(station.sessions.has('sess_m3poweron')).toBe(true);
    expect(frames('SessionEnded', undefined, since)).toEqual([]);

    // The record said 20 s delivered, so the resumed wash has 40 s left.
    await vi.advanceTimersByTimeAsync(40_000);
    await until(() => frames('SessionEnded', undefined, since).length > 0, 'the SessionEnded of the resumed wash');
    expect(frames('SessionEnded', undefined, since)[0].payload).toMatchObject({
      sessionId: 'sess_m3poweron',
      bayId: BAY_ID,
      reason: 'TimerExpired',
      actualDurationSeconds: 60,
    });
  });

  it.each(['Watchdog', 'ErrorRecovery', 'ManualReset', 'ScheduledReset'])(
    'RED: a %s restart keeps the session too - the wash resumes and ends on its timer',
    async (bootReason) => {
      await washCutByPowerLoss(`sess_m3${bootReason.toLowerCase()}`);
      const since = wire.frames.length;

      await powerOnAgain(since, { bootReason });

      expect(lastBootRequest().bootReason).toBe(bootReason);
      expect(bootReportOf(BAY_ID, since)?.status).toBe('Occupied');
      await vi.advanceTimersByTimeAsync(40_000);
      await until(() => frames('SessionEnded', undefined, since).length > 0, 'the SessionEnded of the resumed wash');
      expect(frames('SessionEnded', undefined, since)[0].payload.reason).toBe('TimerExpired');
    },
  );
});

describe('M3 - a restart the station cannot resume after: SessionEnded Fault at once, with the persisted delivered time', () => {
  it("RED: with behavior.onRestart 'interrupt' the Accepted boot is followed at once by SessionEnded Fault carrying the last persisted delivered time", async () => {
    await washCutByPowerLoss('sess_m3interrupt');
    const since = wire.frames.length;

    const station = await powerOnAgain(since, {}, { onRestart: 'interrupt' });
    await until(() => frames('SessionEnded', undefined, since).length > 0, 'a SessionEnded right after the boot');

    const ended = frames('SessionEnded', undefined, since)[0].payload;
    expect(ended).toMatchObject({ sessionId: 'sess_m3interrupt', bayId: BAY_ID, reason: 'Fault' });
    // The last checkpoint before the power went: at most 10 s behind the 25 s actually run.
    expect(ended.actualDurationSeconds).toBeGreaterThanOrEqual(15);
    expect(ended.actualDurationSeconds).toBeLessThanOrEqual(25);
    expect(station.sessions.has('sess_m3interrupt')).toBe(false);
    expect(bootReportOf(BAY_ID, since)?.status, 'an interrupted wash leaves its bay idle').toBe('Available');
    // Sent on the boot it reports, never before it.
    expect(indexOf((f) => f.action === 'SessionEnded', since))
      .toBeGreaterThan(indexOf((f) => f.action === 'BootNotification' && f.messageType === 'Request', since));
  });

  it.each(['RemoteReset', 'FirmwareUpdate'])(
    'RED: a session still held at a %s boot cannot be resumed - SessionEnded Fault at once',
    async (bootReason) => {
      await washCutByPowerLoss(`sess_m3${bootReason.toLowerCase()}`);
      const since = wire.frames.length;

      await powerOnAgain(since, { bootReason });
      await until(() => frames('SessionEnded', undefined, since).length > 0, 'a SessionEnded right after the boot');

      expect(lastBootRequest().bootReason).toBe(bootReason);
      expect(frames('SessionEnded', undefined, since)[0].payload).toMatchObject({ reason: 'Fault' });
      expect(bootReportOf(BAY_ID, since)?.status).toBe('Available');
    },
  );
});

describe('M3 - the in-process power cycle', () => {
  it('RED: Station.restart(reason) boots again with that reason and uptime 0, and resumes the wash it held', async () => {
    const station = power();
    await bootOnline(station, 0);
    await new StartServiceHandler().handle(startService('sess_m3inproc', 60), station as never);
    await vi.advanceTimersByTimeAsync(25_000);
    await settled(() => Number(readSessionRecord().sessions[0]?.deliveredSeconds ?? 0) >= 15);

    const since = wire.frames.length;
    await station.restart?.('Watchdog');
    station.handleMessage(bootAccepted());
    await until(() => frames('StatusNotification', undefined, since).length > 0, 'the boot report after the restart');

    expect(frames('BootNotification', 'Request', since).map((f) => f.payload))
      .toEqual([expect.objectContaining({ bootReason: 'Watchdog', uptimeSeconds: 0 })]);
    expect(bootReportOf(BAY_ID, since)?.status).toBe('Occupied');

    await vi.advanceTimersByTimeAsync(40_000);
    await until(() => frames('SessionEnded', undefined, since).length > 0, 'the SessionEnded of the resumed wash');
    expect(frames('SessionEnded', undefined, since)[0].payload).toMatchObject({ reason: 'TimerExpired', actualDurationSeconds: 60 });
  });
});
