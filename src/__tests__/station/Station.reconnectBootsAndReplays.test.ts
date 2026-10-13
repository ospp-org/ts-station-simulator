import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  wire, resetWire, fakeClock, certDir, connectConfig, startService, bootAccepted, until, frames, indexOf,
  readSessionRecord, STATION_ID, BAY_ID,
} from '../helpers/stationHarness.js';

/*
 * M6 - A RECONNECT IS FOLLOWED BY A BOOT, AND THE BOOT BY THE REPLAY OF WHAT THE STATION HELD.
 *
 * connection-lost.md §6: "When a previously disconnected station reconnects: the station MUST send
 * a BootNotification as the first message on the new connection", reports its bays (step 2) and
 * then replays what it buffered (step 4). boot-notification.md §5.2 rule 1: `Reconnect` when it
 * re-established the connection without restarting. session-ended.md §5 rule 3: a SessionEnded
 * the station cannot transmit - offline, or in a restricted state - MUST be buffered, never
 * discarded, and sent with its original values.
 *
 * Connect mode's link came back on mqtt.js's own reconnect and the station said nothing: no boot
 * (no listener re-booted on `connect`), so the server - which discards the session key on the
 * will - accepted nothing it sent afterwards; meanwhile its heartbeat kept firing into the dead
 * link (M-SIM 1.2, "lost connection"). A wash that ended while the station was away had no record
 * at all.
 *
 * No first-Heartbeat rule: Heartbeats follow the interval only (DESIGN-A2 S5, N1 removed).
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
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

describe('M6 - the link drops mid-wash and comes back without a restart', () => {
  it('RED: nothing is sent while away, the reconnect is followed by a BootNotification Reconnect with the uptime kept, then the bay report, then the SessionEnded the station held', async () => {
    const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
    station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
    await station.connect();
    await station.retryBoot();
    station.handleMessage(bootAccepted());
    await until(() => frames('StatusNotification').length > 0, 'the boot report');
    await new StartServiceHandler().handle(startService('sess_m6away', 60), station as never);

    await vi.advanceTimersByTimeAsync(10_000);
    // The socket drops: what mqtt.js re-emits through MqttConnection when the stream closes.
    const link = wire.connections[wire.connections.length - 1];
    link.emit('close');
    const away = wire.frames.length;

    // Away for 55 s: the wash reaches its booked end (60 s) while the station cannot transmit.
    await vi.advanceTimersByTimeAsync(55_000);
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    expect(wire.frames.slice(away).map((f) => f.action), 'the station published into a dead link').toEqual([]);
    // Held, not lost: the end record waits on disk for the next boot it can be sent after.
    expect(readSessionRecord().heldSessionEnded, 'the SessionEnded of the wash that ended while away is not held').toHaveLength(1);

    // mqtt.js reconnects on its own.
    link.emit('connect', {});
    await until(() => frames('BootNotification', 'Request', away).length > 0, 'a BootNotification after the reconnect');
    const boot = frames('BootNotification', 'Request', away)[0].payload;
    expect(boot.bootReason).toBe('Reconnect');
    // Not a power cycle: the uptime runs on from the first boot.
    expect(Number(boot.uptimeSeconds)).toBeGreaterThanOrEqual(65);
    expect(wire.frames[away].action, 'the BootNotification is not the first message on the new connection').toBe('BootNotification');

    station.handleMessage(bootAccepted());
    await until(() => frames('SessionEnded', undefined, away).length > 0, 'the replayed SessionEnded');

    const report = indexOf((f) => f.action === 'StatusNotification' && f.payload.bayId === BAY_ID, away);
    const replayed = indexOf((f) => f.action === 'SessionEnded', away);
    expect(report, 'no bay report after the reconnect boot').toBeGreaterThan(-1);
    expect(wire.frames[report].payload.status).toBe('Available');
    expect(report, 'the replay went before the bay report').toBeLessThan(replayed);
    expect(wire.frames[replayed].payload).toMatchObject({
      sessionId: 'sess_m6away',
      reason: 'TimerExpired',
      actualDurationSeconds: 60,
    });
    await until(() => readSessionRecord().heldSessionEnded.length === 0, 'the held SessionEnded released once sent');
  });
});
