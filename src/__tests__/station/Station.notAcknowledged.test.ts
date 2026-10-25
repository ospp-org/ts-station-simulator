import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, startService, bootAccepted, until, settled, frames, indexOf,
  readSessionRecord, STATION_ID, type Frame,
} from '../helpers/stationHarness.js';

/*
 * FREEZE ITEM 33, DECIDED BY GABI (2026-10-25): A MESSAGE THE BROKER DID NOT ACKNOWLEDGE WITH SUCCESS STAYS IN THE
 * STATION'S BUFFER AND IS RESENT AFTER THE RECONNECTION, THROUGH THE EXISTING REPLAY.
 *
 * Any message the broker did not acknowledge with PUBACK 0x00 - a PUBACK 0x10 "No matching subscribers" included,
 * which MQTT counts a success and which means no server received it, and a message in flight when the station
 * reconnects to a broker that kept no session (Session Present 0) - stays in the station's buffer, and the replay
 * after the next boot answered `Accepted` sends it again (01-architecture.md §6.5, connection-lost.md §6 step 4):
 * after the bay reports, with its original messageId, each session's records in their own order, its MeterValues
 * before its SessionEnded. A message of a kind the replay sends fresh - a Heartbeat - is not sent again: the fresh
 * one stands in for it. The station took a 0x10 as delivery and dropped the record: a SessionEnded lost that way
 * left its session to the sweep, charged in full (UAT, 2026-10-25: 3 SessionEnded in one broker recreate).
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

async function bootedStation(): Promise<InstanceType<typeof Station>> {
  const station = new Station(connectConfig(), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  await station.connect();
  await station.retryBoot();
  station.handleMessage(bootAccepted());
  await until(() => frames('StatusNotification').length > 0, 'the boot report');
  return station;
}

/** The link drops and mqtt.js brings it back; the station boots, and the server answers Accepted. Returns where it began. */
async function reconnectAndBoot(station: InstanceType<typeof Station>): Promise<number> {
  const link = wire.connections[wire.connections.length - 1];
  link.emit('close');
  const away = wire.frames.length;
  link.emit('connect', {});
  await until(() => frames('BootNotification', 'Request', away).length > 0, 'a BootNotification after the reconnect');
  station.handleMessage(bootAccepted());
  return away;
}

const byAction = (action: string, code: number | null) => (f: Frame): number | null => (f.action === action ? code : 0);

describe('freeze item 33 - a message the broker did not acknowledge with success is resent after the reconnection', () => {
  it('a SessionEnded the broker answered 0x10 stays held, on disk, and the next Accepted boot sends it again, with its messageId, after the bay report', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_x10', 30), station as never);

    wire.puback = byAction('SessionEnded', 0x10);
    await elapse(31_000);
    await until(() => frames('SessionEnded').length > 0, 'the SessionEnded at the end of the wash');
    const first = frames('SessionEnded')[0];
    await settled(() => readSessionRecord().heldSessionEnded.length > 0);
    expect(readSessionRecord().heldSessionEnded, 'a SessionEnded answered 0x10 was released').toHaveLength(1);

    wire.puback = null;
    const away = await reconnectAndBoot(station);
    await until(() => frames('SessionEnded', undefined, away).length > 0, 'the SessionEnded sent again');

    const again = frames('SessionEnded', undefined, away)[0];
    expect(again.messageId, 'not the same message').toBe(first.messageId);
    expect(again.payload).toEqual(first.payload);
    expect(indexOf((f) => f.action === 'StatusNotification', away), 'sent again ahead of the bay report')
      .toBeLessThan(indexOf((f) => f.action === 'SessionEnded', away));
    await until(() => readSessionRecord().heldSessionEnded.length === 0, 'released once acknowledged 0x00');
  });

  it('a SessionEnded in flight when the broker kept no session is resent the same way', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_sp0', 30), station as never);

    wire.puback = byAction('SessionEnded', null);
    await elapse(31_000);
    await until(() => frames('SessionEnded').length > 0, 'the SessionEnded at the end of the wash');
    const first = frames('SessionEnded')[0];

    wire.puback = null;
    const away = await reconnectAndBoot(station);
    await until(() => frames('SessionEnded', undefined, away).length > 0, 'the SessionEnded sent again');
    expect(frames('SessionEnded', undefined, away)[0].messageId).toBe(first.messageId);
  });

  it('the MeterValues of a session answered 0x10 are resent too, ahead of its SessionEnded, in their own order', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_mv', 70), station as never);

    wire.puback = (f) => (f.action === 'MeterValues' || f.action === 'SessionEnded' ? 0x10 : 0);
    await elapse(71_000);
    await until(() => readSessionRecord().heldSessionEnded.length > 0, 'the SessionEnded held at the end of the wash');
    // Not sent ahead of its own MeterValues, which wait for the replay: the server would read a gap in the seqNo.
    expect(frames('SessionEnded'), 'the SessionEnded went out ahead of the MeterValues it follows').toEqual([]);
    const meters = frames('MeterValues').filter((f) => f.payload.sessionId === 'sess_mv');
    expect(meters.length, 'no MeterValues in a 70 s wash').toBeGreaterThan(0);
    await settled(() => readSessionRecord().heldMessages.length >= meters.length);
    expect(readSessionRecord().heldMessages.map((m) => m.messageId)).toEqual(meters.map((m) => m.messageId));

    wire.puback = null;
    const away = await reconnectAndBoot(station);
    await until(() => frames('SessionEnded', undefined, away).length > 0, 'the SessionEnded sent again');

    const replayed = wire.frames.slice(away).filter((f) => f.action === 'MeterValues' || f.action === 'SessionEnded');
    expect(replayed.map((f) => f.messageId)).toEqual([...meters.map((m) => m.messageId), frames('SessionEnded')[0].messageId]);
    await until(() => readSessionRecord().heldMessages.length === 0, 'the MeterValues released once acknowledged 0x00');
  });

  it('a Heartbeat answered 0x10 is not sent again: the fresh one the replay sends stands in for it', async () => {
    const station = await bootedStation();

    wire.puback = byAction('Heartbeat', 0x10);
    await elapse(31_000);
    await until(() => frames('Heartbeat').length > 0, 'a Heartbeat');
    const dropped = frames('Heartbeat')[0].messageId;

    wire.puback = null;
    const away = await reconnectAndBoot(station);
    await elapse(31_000);
    await until(() => frames('Heartbeat', undefined, away).length > 0, 'a Heartbeat after the boot');

    expect(wire.frames.slice(away).map((f) => f.messageId)).not.toContain(dropped);
    await until(() => readSessionRecord().heldMessages.length === 0, 'the superseded Heartbeat let go');
  });

  it('a message answered 0x10 again when it is resent stays held for the next boot', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_twice', 30), station as never);

    wire.puback = byAction('SessionEnded', 0x10);
    await elapse(31_000);
    await until(() => frames('SessionEnded').length > 0, 'the SessionEnded at the end of the wash');

    let away = await reconnectAndBoot(station);
    await until(() => frames('SessionEnded', undefined, away).length > 0, 'the first resend');
    await settled(() => false, 50);
    expect(readSessionRecord().heldSessionEnded, 'answered 0x10 again and released').toHaveLength(1);

    wire.puback = null;
    away = await reconnectAndBoot(station);
    await until(() => frames('SessionEnded', undefined, away).length > 0, 'the second resend');
    await until(() => readSessionRecord().heldSessionEnded.length === 0, 'released at last');
  });
});

describe('freeze item 33 - a scenario station, which boots by the steps of its file', () => {
  it('holds a message answered 0x10 too, and sends it again with its messageId when its file asks for the replay', async () => {
    const station = new Station(connectConfig({ rebootOnReconnect: false }), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
    // A scenario station's boot handler: it takes the session key and reports nothing on its own.
    station.registerHandler('BootNotification' as never, new BootNotificationHandler(false) as never);
    await station.connect();
    await station.retryBoot();
    station.handleMessage(bootAccepted());

    wire.puback = byAction('SessionEnded', 0x10);
    const payload = {
      sessionId: 'sess_scenario', bayId: 'bay_e2d00001', reason: 'TimerExpired', actualDurationSeconds: 33,
      creditsCharged: 55, meterValues: { durationSeconds: 33 }, seqNo: 2, finalSeqNo: 2,
    };
    await station.sender.send('SessionEnded' as never, 'Event' as never, payload, 'msg-scenario-1');
    await settled(() => station.heldMessages.length > 0);
    expect(station.heldMessages.map((m) => m.messageId)).toEqual(['msg-scenario-1']);

    wire.puback = null;
    const since = wire.frames.length;
    await station.replayHeld();

    expect(frames('SessionEnded', undefined, since).map((f) => f.messageId)).toEqual(['msg-scenario-1']);
    expect(station.heldMessages).toEqual([]);
  });
});
