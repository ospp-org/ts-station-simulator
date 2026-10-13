import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  elapse, wire, resetWire, fakeClock, certDir, connectConfig, request, startService, bootAccepted, until, settled,
  frames, indexOf, readSessionRecord, STATION_ID, BAY_ID, SERVICE_ID, type Frame,
} from '../helpers/stationHarness.js';
import { schemaErrors } from '../helpers/wireSchemas.js';

/*
 * PERIODIC MeterValues WHILE A WASH RUNS (M-SIM Part E, 2026-10-13).
 *
 * The connect-mode boot declares `meterValuesSupported: true`, so meter-values.md §5.1 binds it:
 *   1. the first MeterValues within MeterValuesInterval of service activation;
 *   2. then one at the configured interval until the session ends;
 *   3. a final reading immediately before or at service termination, also carried in the end
 *      record (stop-service.md §6 rule 7; session-ended.md §3 `meterValues`);
 *   6. a ChangeConfiguration of the interval applies from the next scheduled event;
 * and §6 rule 5: never for a bay without an active session. The interval is the station-held
 * key MeterValuesInterval (08-configuration.md §3: default 60, range 10-3600), set by
 * ChangeConfiguration - validated, `5109 INVALID_CONFIGURATION_VALUE` and nothing in the batch
 * applied on a bad value (§8.2, change-configuration.md §6 rules 2 and 6) - or by an Accepted
 * boot's `configuration` (§8.3), and reported by GetConfiguration under its name.
 *
 * seqNo (02-transport.md §3.2; 05-state-machines.md §3.5): per session, from 0, +1 per
 * session-scoped event (MeterValues, SessionEnded); persisted before the publish (rule 1);
 * resumed at persisted + 1 after a reboot (rule 2); finalSeqNo on the end record is the highest
 * emitted (rule 5). While the link is down a MeterValues may be dropped (01 §6.5, Category 2),
 * and a dropped one takes no number - seqNo counts events sent, not intervals elapsed (§5.1 r5).
 *
 * TriggerMessage MeterValues "is a normal message instance" (trigger-message.md §5 rule 2) and
 * is Rejected for a bay that runs no session (rule 4).
 *
 * Connect mode sent no MeterValues at all: the only emitter was the TriggerMessage one-shot, with
 * constant zeros, no seqNo and the bayId ignored. Its interval (`meterValuesIntervalSec: 30`) had no
 * consumer, a ChangeConfiguration of it was answered Accepted and ignored, the boot's
 * `configuration` was never read, and GetConfiguration reported it under a name the spec does not
 * have.
 *
 * Offline: MqttConnection is stubbed; the clocks are fake, the monotonic one included.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { StartServiceHandler } = await import('../../handlers/StartServiceHandler.js');
const { StopServiceHandler } = await import('../../handlers/StopServiceHandler.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');
const { ChangeConfigurationHandler } = await import('../../handlers/ChangeConfigurationHandler.js');
const { GetConfigurationHandler } = await import('../../handlers/GetConfigurationHandler.js');
const { TriggerMessageHandler } = await import('../../handlers/TriggerMessageHandler.js');

type StationInstance = InstanceType<typeof Station>;
type Restorable = StationInstance & { restoreSessions?: () => Promise<unknown> };

const BAY_2 = 'bay_e2d00002';
/** Long cases step the fake clock a second at a time with real time between; under a loaded suite that takes seconds. */
const LONG = 30_000;

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

function power(extra: Record<string, unknown> = {}): Restorable {
  const station = new Station(connectConfig(extra), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  station.registerHandler('BootNotification' as never, new BootNotificationHandler() as never);
  return station as Restorable;
}

/** Connect, boot, answer it Accepted (with `configuration` when given) and wait for every bay's boot report. */
async function bootOnline(station: Restorable, configuration?: Record<string, string>): Promise<void> {
  const since = wire.frames.length;
  await station.connect();
  await station.retryBoot();
  const answer = bootAccepted() as unknown as { payload: Record<string, unknown> };
  if (configuration !== undefined) answer.payload.configuration = configuration;
  station.handleMessage(answer as never);
  const bays = station.config.bays.length;
  await until(() => frames('StatusNotification', undefined, since).length >= bays, 'the boot report');
}

async function bootedStation(extra: Record<string, unknown> = {}): Promise<Restorable> {
  const station = power(extra);
  await bootOnline(station);
  return station;
}

function meterValuesOf(sessionId: string, since = 0): Frame[] {
  return frames('MeterValues', undefined, since).filter((f) => f.payload.sessionId === sessionId);
}

/**
 * Wait in REAL time for `count` readings of the session: each one's seqNo is written to the real disk
 * before it is published (05 §3.5 rule 1), and the fake clock does not wait for the disk - a reading
 * due on the last step of elapse() is published a few real milliseconds after it.
 */
async function readingsLanded(sessionId: string, since: number, count: number): Promise<void> {
  await settled(() => meterValuesOf(sessionId, since).length >= count);
}

/** Seconds from `origin` (ms, the station's wall clock) to each reading's own `timestamp`. */
function secondsAfter(origin: number, readings: Frame[]): number[] {
  return readings.map((f) => (Date.parse(String(f.payload.timestamp)) - origin) / 1000);
}

type Values = { liquidMl?: number; consumableMl?: number; energyWh?: number };
const valuesOf = (f: Frame) => f.payload.values as Values;

/** Every member cumulative - never below the reading before it - and the wash advancing at least one of them. */
function expectCumulative(readings: Values[]): void {
  for (let i = 1; i < readings.length; i++) {
    for (const member of ['liquidMl', 'consumableMl', 'energyWh'] as const) {
      if (readings[i - 1][member] !== undefined) {
        expect(readings[i][member], `${member} at reading ${i}`).toBeGreaterThanOrEqual(readings[i - 1][member]!);
      }
    }
    const advanced = (['liquidMl', 'consumableMl', 'energyWh'] as const)
      .some((m) => (readings[i][m] ?? 0) > (readings[i - 1][m] ?? 0));
    expect(advanced, `reading ${i} advanced nothing during a delivering wash: ${JSON.stringify(readings)}`).toBe(true);
  }
}

async function changeConfiguration(station: Restorable, keys: Array<{ key: string; value: string }>): Promise<Frame> {
  const since = wire.frames.length;
  await new ChangeConfigurationHandler().handle(request('ChangeConfiguration', { keys }), station as never);
  return frames('ChangeConfiguration', 'Response', since)[0];
}

async function trigger(station: Restorable, payload: Record<string, unknown>): Promise<Frame> {
  const since = wire.frames.length;
  await new TriggerMessageHandler().handle(request('TriggerMessage', payload), station as never);
  return frames('TriggerMessage', 'Response', since)[0];
}

describe('the schema check these cases lean on', () => {
  it('CONTROL: it rejects a MeterValues whose sessionId breaks its pattern and accepts the same reading with a valid one', () => {
    const reading = { bayId: BAY_ID, timestamp: '2026-10-13T12:00:00.000Z', values: { liquidMl: 7500, energyWh: 15 }, seqNo: 0 };
    expect(schemaErrors('meter-values-event.schema.json', { ...reading, sessionId: 'sess_notHex!' })).not.toEqual([]);
    expect(schemaErrors('meter-values-event.schema.json', { ...reading, sessionId: 'sess_e6a00001' })).toEqual([]);
  });
});

describe('the meter cadence (meter-values.md §5.1 rules 1-3)', () => {
  it('RED 6: a 150 s wash at the default MeterValuesInterval (60) sends MeterValues at 60 s and 120 s, seqNo 0 and 1, then the final reading and the SessionEnded that continues the count and carries it', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    const activatedAt = Date.now();
    await new StartServiceHandler().handle(startService('sess_e6a00001', 150), station as never);

    await elapse(59_000);
    expect(meterValuesOf('sess_e6a00001', since), 'a MeterValues before the interval had passed').toEqual([]);
    await elapse(92_000);
    await until(() => frames('SessionEnded', undefined, since).length > 0, 'the SessionEnded at the booked end');
    await settled(() => false, 50);

    const sent = meterValuesOf('sess_e6a00001', since);
    expect(sent.length, `MeterValues of a 150 s wash; frames: ${JSON.stringify(wire.frames.slice(since).map((f) => f.action))}`)
      .toBe(3);
    expect(sent.map((f) => f.payload.seqNo)).toEqual([0, 1, 2]);
    // Two at the interval, then the final reading at the end - no tick at or after the booked end.
    expect(secondsAfter(activatedAt, sent)).toEqual([60, 120, 150]);
    for (const f of sent) {
      expect(f.payload).toMatchObject({ bayId: BAY_ID, sessionId: 'sess_e6a00001' });
      expect(Object.keys(valuesOf(f)).length, 'a reading with no member').toBeGreaterThan(0);
      expect(schemaErrors('meter-values-event.schema.json', f.payload)).toEqual([]);
    }
    expectCumulative(sent.map(valuesOf));

    const ended = frames('SessionEnded', undefined, since)[0];
    expect(indexOf((f) => f === ended)).toBeGreaterThan(indexOf((f) => f === sent[2]));
    expect(ended.payload).toMatchObject({ reason: 'TimerExpired', actualDurationSeconds: 150, seqNo: 3, finalSeqNo: 3 });
    expect(ended.payload.meterValues, 'the end record does not carry the last reading').toEqual(valuesOf(sent[2]));
    expect(schemaErrors('session-ended-event.schema.json', ended.payload)).toEqual([]);
  }, LONG);

  it('RED 7: a StopService at 30 s - the final reading, then the RESPONSE with finalSeqNo the highest emitted and the reading in meterValues; nothing for the session 2 x the interval later', async () => {
    const station = await bootedStation();
    await new StartServiceHandler().handle(startService('sess_e7a00001', 150), station as never);
    await elapse(30_000);
    const since = wire.frames.length;

    await new StopServiceHandler().handle(request('StopService', { sessionId: 'sess_e7a00001', bayId: BAY_ID }), station as never);
    const answer = frames('StopService', 'Response', since)[0];
    const final = meterValuesOf('sess_e7a00001', since);
    expect(final.length, `no final reading before the RESPONSE; frames of the stop: ${JSON.stringify(wire.frames.slice(since).map((f) => f.action))}`)
      .toBe(1);
    expect(indexOf((f) => f === final[0])).toBeLessThan(indexOf((f) => f === answer));
    expect(final[0].payload.seqNo).toBe(0);
    expect(answer.payload).toMatchObject({ status: 'Accepted', actualDurationSeconds: 30, finalSeqNo: 0 });
    expect(answer.payload.meterValues, 'the RESPONSE does not carry the final reading').toEqual(valuesOf(final[0]));
    expect(schemaErrors('stop-service-response.schema.json', answer.payload)).toEqual([]);

    // TC-TX-001 :68 - none after the session ended, 2 x the interval later.
    const after = wire.frames.length;
    await elapse(120_000);
    expect(meterValuesOf('sess_e7a00001', after), 'MeterValues for a session after its end record').toEqual([]);
  }, LONG);
});

describe('the interval is the station-held MeterValuesInterval (08-configuration.md §3, §8.2, §8.3)', () => {
  it('RED 8: ChangeConfiguration MeterValuesInterval=10 is Accepted and applies from the next scheduled event', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    const activatedAt = Date.now();
    await new StartServiceHandler().handle(startService('sess_e8a00001', 150), station as never);
    await elapse(30_000);

    const answer = await changeConfiguration(station, [{ key: 'MeterValuesInterval', value: '10' }]);
    expect(answer.payload).toEqual({ results: [{ key: 'MeterValuesInterval', status: 'Accepted' }] });
    expect(schemaErrors('change-configuration-response.schema.json', answer.payload)).toEqual([]);

    // The event already scheduled at the old interval (60 s) comes when it was due; the ones after it at 10 s.
    await elapse(55_000);
    await readingsLanded('sess_e8a00001', since, 3);
    const sent = meterValuesOf('sess_e8a00001', since);
    expect(secondsAfter(activatedAt, sent), 'the MeterValues of the wash, in seconds after its start').toEqual([60, 70, 80]);
    expect(sent.map((f) => f.payload.seqNo)).toEqual([0, 1, 2]);
  }, LONG);

  it('RED 9: MeterValuesInterval=5, abc, 10.5 and 3601 are each Rejected 5109 INVALID_CONFIGURATION_VALUE, and nothing in the batch is applied', async () => {
    const station = await bootedStation();

    const answer = await changeConfiguration(station, [
      { key: 'MeterValuesInterval', value: '5' },
      { key: 'RevocationEpoch', value: '4' },
    ]);
    expect(answer.payload).toEqual({
      results: [
        { key: 'MeterValuesInterval', status: 'Rejected', errorCode: 5109, errorText: 'INVALID_CONFIGURATION_VALUE' },
        // A per-key verdict on validation: the epoch passed, and the batch carrying a Rejected entry applies nothing.
        { key: 'RevocationEpoch', status: 'Accepted' },
      ],
    });
    expect(schemaErrors('change-configuration-response.schema.json', answer.payload)).toEqual([]);
    expect(station.currentRevocationEpoch, 'a key of a rejected batch was applied').toBe(0);

    for (const value of ['abc', '10.5', '3601', '9', '']) {
      const refused = await changeConfiguration(station, [{ key: 'MeterValuesInterval', value }]);
      expect(refused.payload, `MeterValuesInterval=${JSON.stringify(value)}`).toEqual({
        results: [{ key: 'MeterValuesInterval', status: 'Rejected', errorCode: 5109, errorText: 'INVALID_CONFIGURATION_VALUE' }],
      });
    }
    const sampled = await changeConfiguration(station, [{ key: 'MeterValuesSampleInterval', value: '61' }]);
    expect(sampled.payload).toEqual({
      results: [{ key: 'MeterValuesSampleInterval', status: 'Rejected', errorCode: 5109, errorText: 'INVALID_CONFIGURATION_VALUE' }],
    });

    // The interval in force is still the default: the first reading comes at 60 s.
    const since = wire.frames.length;
    const activatedAt = Date.now();
    await new StartServiceHandler().handle(startService('sess_e9a00001', 150), station as never);
    await elapse(61_000);
    await readingsLanded('sess_e9a00001', since, 1);
    expect(secondsAfter(activatedAt, meterValuesOf('sess_e9a00001', since))).toEqual([60]);
  }, LONG);

  it('RED 10: an Accepted boot whose configuration carries MeterValuesInterval=15 sets the cadence; an invalid entry beside it is warned and ignored, and the boot goes on', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const station = power();
      await bootOnline(station, { MeterValuesInterval: '15', MeterValuesSampleInterval: 'abc', HeartbeatIntervalSeconds: '30' });
      const since = wire.frames.length;
      const activatedAt = Date.now();
      await new StartServiceHandler().handle(startService('sess_e10a0001', 150), station as never);

      await elapse(32_000);
      await readingsLanded('sess_e10a0001', since, 2);
      const sent = meterValuesOf('sess_e10a0001', since);
      expect(secondsAfter(activatedAt, sent), 'the MeterValues of the wash, in seconds after its start').toEqual([15, 30]);
      expect(sent.map((f) => f.payload.seqNo)).toEqual([0, 1]);
      expect(
        warn.mock.calls.some((call) => call.map(String).join(' ').includes('MeterValuesSampleInterval')),
        'the invalid boot configuration entry was not warned about',
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, LONG);

  it('RED 16: MeterValuesSampleInterval=5 is applied - the delivered time on disk is never more than 5 s old while a wash runs (05-state-machines.md §3.5 rule 3)', async () => {
    const station = await bootedStation();
    const answer = await changeConfiguration(station, [{ key: 'MeterValuesSampleInterval', value: '5' }]);
    expect(answer.payload).toEqual({ results: [{ key: 'MeterValuesSampleInterval', status: 'Accepted' }] });

    await new StartServiceHandler().handle(startService('sess_e16a0001', 150), station as never);
    await elapse(6_000);
    await settled(() => Number(readSessionRecord().sessions[0]?.deliveredSeconds ?? 0) >= 5, 300);
    expect(readSessionRecord().sessions[0]?.deliveredSeconds, 'the delivered time on disk at 6 s into the wash').toBe(5);
    await elapse(5_000);
    await settled(() => Number(readSessionRecord().sessions[0]?.deliveredSeconds ?? 0) >= 10, 300);
    expect(readSessionRecord().sessions[0]?.deliveredSeconds, 'the delivered time on disk at 11 s into the wash').toBe(10);
  }, LONG);

  it('RED 13: GetConfiguration reports MeterValuesInterval and MeterValuesSampleInterval under their spec names, not meterValuesIntervalSec', async () => {
    const station = await bootedStation();
    const get = async (payload: Record<string, unknown>) => {
      const since = wire.frames.length;
      await new GetConfigurationHandler().handle(request('GetConfiguration', payload), station as never);
      return frames('GetConfiguration', 'Response', since)[0].payload;
    };

    const asked = await get({ keys: ['MeterValuesInterval', 'MeterValuesSampleInterval'] });
    expect(asked).toEqual({
      configuration: [
        { key: 'MeterValuesInterval', value: '60', readonly: false },
        { key: 'MeterValuesSampleInterval', value: '10', readonly: false },
      ],
    });
    expect(schemaErrors('get-configuration-response.schema.json', asked)).toEqual([]);

    const all = (await get({})) as { configuration: Array<{ key: string }> };
    expect(all.configuration.map((e) => e.key)).toContain('MeterValuesInterval');
    expect(all.configuration.map((e) => e.key)).not.toContain('meterValuesIntervalSec');

    await changeConfiguration(station, [{ key: 'MeterValuesInterval', value: '20' }]);
    expect(await get({ keys: ['MeterValuesInterval'] })).toEqual({
      configuration: [{ key: 'MeterValuesInterval', value: '20', readonly: false }],
    });
  });
});

describe('MeterValues and the link (01-architecture.md §6.5, 05-state-machines.md §3.5)', () => {
  it('RED 11: while the link is down no MeterValues is published and seqNo does not advance; after the Reconnect boot they resume at the next number', async () => {
    const station = await bootedStation();
    const since = wire.frames.length;
    const activatedAt = Date.now();
    await new StartServiceHandler().handle(startService('sess_e11a0001', 300), station as never);
    await elapse(70_000);
    await readingsLanded('sess_e11a0001', since, 1);
    expect(meterValuesOf('sess_e11a0001', since).map((f) => f.payload.seqNo), 'the MeterValues before the link dropped').toEqual([0]);

    const link = wire.connections[wire.connections.length - 1];
    link.emit('close');
    const away = wire.frames.length;
    // Away across two ticks (120 s and 180 s).
    await elapse(120_000);
    expect(wire.frames.slice(away).map((f) => f.action), 'the station published into a dead link').toEqual([]);

    link.emit('connect', {});
    await until(() => frames('BootNotification', 'Request', away).length > 0, 'the BootNotification after the reconnect');
    station.handleMessage(bootAccepted());
    await until(() => frames('StatusNotification', undefined, away).length > 0, 'the boot report after the reconnect');
    await elapse(55_000);
    await readingsLanded('sess_e11a0001', away, 1);

    const resumed = meterValuesOf('sess_e11a0001', away);
    expect(resumed.map((f) => f.payload.seqNo), 'the MeterValues after the reconnect').toEqual([1]);
    expect(secondsAfter(activatedAt, resumed)).toEqual([240]);
    expect(indexOf((f) => f === resumed[0])).toBeGreaterThan(indexOf((f) => f.action === 'StatusNotification', away));
  }, LONG);

  it('RED 12: a wash resumed after a restart resumes MeterValues at the persisted seqNo + 1, its readings never below the last one sent', async () => {
    const first = power();
    await bootOnline(first);
    await new StartServiceHandler().handle(startService('sess_e12a0001', 300), first as never);
    await elapse(125_000);
    await readingsLanded('sess_e12a0001', 0, 2);
    const before = meterValuesOf('sess_e12a0001');
    expect(before.map((f) => f.payload.seqNo), 'the MeterValues before the power loss').toEqual([0, 1]);
    // Persisted before each publish (rule 1): the record already names the next number.
    await settled(() => readSessionRecord().sessions[0]?.seqNo === 2);
    expect(readSessionRecord().sessions[0]?.seqNo).toBe(2);
    vi.clearAllTimers();
    const since = wire.frames.length;

    const second = power();
    await second.restoreSessions?.();
    await bootOnline(second);
    await elapse(61_000);
    await readingsLanded('sess_e12a0001', since, 1);

    const resumed = meterValuesOf('sess_e12a0001', since);
    expect(resumed.map((f) => f.payload.seqNo), 'the MeterValues of the resumed wash').toEqual([2]);
    expectCumulative([valuesOf(before[1]), valuesOf(resumed[0])]);
  }, LONG);
});

describe('TriggerMessage MeterValues (trigger-message.md §5 rules 2 and 4)', () => {
  it('RED 14: a TriggerMessage MeterValues for a bay with no session is Rejected; for the bay with one it sends that session\'s next seqNo and its real readings', async () => {
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
          programs: [{ programNumber: 1, label: 'P1', available: true }],
          services: [{ serviceId: SERVICE_ID, serviceName: 'Basic Wash', available: true }],
        },
      ],
    });
    const since = wire.frames.length;
    await new StartServiceHandler().handle(startService('sess_e14a0001', 150), station as never);
    await elapse(75_000);
    await readingsLanded('sess_e14a0001', since, 1);

    const quiet = wire.frames.length;
    const refused = await trigger(station, { requestedMessage: 'MeterValues', bayId: BAY_2 });
    expect(refused.payload, 'a MeterValues was promised for a bay that runs no session').toEqual({ status: 'Rejected' });
    expect(frames('MeterValues', undefined, quiet)).toEqual([]);

    const asked = wire.frames.length;
    const accepted = await trigger(station, { requestedMessage: 'MeterValues', bayId: BAY_ID });
    expect(accepted.payload).toEqual({ status: 'Accepted' });
    await settled(() => frames('MeterValues', undefined, asked).length > 0, 300);
    const triggered = frames('MeterValues', undefined, asked);
    expect(triggered).toHaveLength(1);
    // The periodic reading at 60 s took 0; the triggered one is the session's next event.
    expect(triggered[0].payload).toMatchObject({ bayId: BAY_ID, sessionId: 'sess_e14a0001', seqNo: 1 });
    expect(valuesOf(triggered[0]).liquidMl, 'a triggered reading of a running wash is not a constant zero').toBeGreaterThan(0);
    expect(schemaErrors('meter-values-event.schema.json', triggered[0].payload)).toEqual([]);
    const periodic = meterValuesOf('sess_e14a0001', since).filter((f) => f !== triggered[0]);
    expect(periodic.map((f) => f.payload.seqNo)).toEqual([0]);
    expectCumulative([valuesOf(periodic[0]), valuesOf(triggered[0])]);

    // The same counter: the next periodic reading takes the number after the triggered one.
    await elapse(46_000);
    await readingsLanded('sess_e14a0001', asked, 2);
    expect(meterValuesOf('sess_e14a0001', asked).map((f) => f.payload.seqNo)).toEqual([1, 2]);
  }, LONG);
});
