import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BootReason, ConfigKey } from '@ospp/protocol';
import {
  wire, resetWire, fakeClock, certDir, connectConfig, request, bootAccepted, until, settled,
  frames, STATION_ID,
} from '../helpers/stationHarness.js';
import { schemaErrors } from '../helpers/wireSchemas.js';

/*
 * EVERY CONFIGURATION KEY, JUDGED AS change-configuration.md §6 AND 08-configuration.md §3 SAY -
 * AND KEPT ACROSS A NEW PROCESS (08 §8.4). TODO §A0 of csms-server, 2026-10-21.
 *
 *  - §6 rule 5: a key the station does not know is `NotSupported`; rule 4: a ReadOnly key is
 *    `Rejected` 5108; rule 6: a value of the wrong type or out of range is `Rejected` 5109; rule 2: one
 *    such key and nothing in the batch is applied. 08 §8.2: a valid value for a Static key is
 *    `RebootRequired`, persisted, and in force from the next boot; for a Dynamic key `Accepted`, and
 *    in force at once.
 *  - get-configuration.md §5.1: GetConfiguration reports the keys the station holds under their spec
 *    names, a WriteOnly key in neither array.
 *  - 08 §8.4: the station keeps its configuration in non-volatile storage.
 *
 * The station held two keys (MeterValuesInterval, MeterValuesSampleInterval) in memory, answered
 * every other key `Accepted` and applied none (RevocationEpoch excepted), and reported non-spec keys -
 * `stationId`, `acceptRate`, `heartbeatIntervalSec` - in GetConfiguration.
 *
 * Offline: MqttConnection is stubbed; the clocks are fake.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');
const { BootNotificationHandler } = await import('../../handlers/BootNotificationHandler.js');
const { ChangeConfigurationHandler } = await import('../../handlers/ChangeConfigurationHandler.js');
const { GetConfigurationHandler } = await import('../../handlers/GetConfigurationHandler.js');

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
  await until(() => frames('StatusNotification').length >= station.config.bays.length, 'the boot report');
  return station;
}

async function change(station: unknown, keys: Array<{ key: string; value: string }>) {
  const since = wire.frames.length;
  await new ChangeConfigurationHandler().handle(request('ChangeConfiguration', { keys }), station as never);
  await settled(() => frames('ChangeConfiguration', 'Response', since).length > 0, 300);
  const answer = frames('ChangeConfiguration', 'Response', since)[0]!.payload;
  expect(schemaErrors('change-configuration-response.schema.json', answer)).toEqual([]);
  return answer.results as Array<Record<string, unknown>>;
}

async function read(station: unknown, keys?: string[]) {
  const since = wire.frames.length;
  await new GetConfigurationHandler().handle(request('GetConfiguration', keys === undefined ? {} : { keys }), station as never);
  await settled(() => frames('GetConfiguration', 'Response', since).length > 0, 300);
  const answer = frames('GetConfiguration', 'Response', since)[0]!.payload as { configuration: Array<{ key: string; value: string; readonly: boolean }>; unknownKeys?: string[] };
  expect(schemaErrors('get-configuration-response.schema.json', answer)).toEqual([]);
  return answer;
}

const valueOf = (answer: { configuration: Array<{ key: string; value: string }> }, key: string) =>
  answer.configuration.find((e) => e.key === key)?.value;

describe('ChangeConfiguration judges every key (change-configuration.md §6, 08-configuration.md §3, §8.2)', () => {
  it('a key the station does not know is NotSupported, and nothing in the batch is applied', async () => {
    const station = await bootedStation();
    const results = await change(station, [
      { key: ConfigKey.RESERVATION_DEFAULT_TTL, value: '600' },
      { key: 'VendorTurboMode', value: 'on' },
    ]);

    expect(results).toEqual([
      { key: ConfigKey.RESERVATION_DEFAULT_TTL, status: 'Accepted' },
      { key: 'VendorTurboMode', status: 'NotSupported' },
    ]);
    expect(valueOf(await read(station, [ConfigKey.RESERVATION_DEFAULT_TTL]), ConfigKey.RESERVATION_DEFAULT_TTL)).toBe('300');
  });

  it('a ReadOnly key is Rejected 5108, and a value out of range or of the wrong type Rejected 5109', async () => {
    const station = await bootedStation();
    const results = await change(station, [
      { key: ConfigKey.FIRMWARE_VERSION, value: '9.9.9' },
      { key: ConfigKey.HEARTBEAT_INTERVAL_SECONDS, value: '5' },
      { key: ConfigKey.AUTHORIZATION_CACHE_ENABLED, value: 'yes' },
      { key: ConfigKey.LOG_LEVEL, value: 'Verbose' },
      { key: ConfigKey.TIME_ZONE, value: 'Mars/Olympus_Mons' },
    ]);

    expect(results.map((r) => [r.key, r.status, r.errorCode])).toEqual([
      [ConfigKey.FIRMWARE_VERSION, 'Rejected', 5108],
      [ConfigKey.HEARTBEAT_INTERVAL_SECONDS, 'Rejected', 5109],
      [ConfigKey.AUTHORIZATION_CACHE_ENABLED, 'Rejected', 5109],
      [ConfigKey.LOG_LEVEL, 'Rejected', 5109],
      [ConfigKey.TIME_ZONE, 'Rejected', 5109],
    ]);
  });

  it('a valid Dynamic key is Accepted and in force at once; a valid Static key RebootRequired, in force from the next boot', async () => {
    const station = await bootedStation();
    const results = await change(station, [
      { key: ConfigKey.RESERVATION_DEFAULT_TTL, value: '600' },
      { key: ConfigKey.STATION_NAME, value: 'Spalatoria Nord - boxa 1' },
    ]);

    expect(results).toEqual([
      { key: ConfigKey.RESERVATION_DEFAULT_TTL, status: 'Accepted' },
      { key: ConfigKey.STATION_NAME, status: 'RebootRequired' },
    ]);
    const now = await read(station);
    expect(valueOf(now, ConfigKey.RESERVATION_DEFAULT_TTL)).toBe('600');
    expect(valueOf(now, ConfigKey.STATION_NAME)).toBe('');

    await station.restart(BootReason.REMOTE_RESET);
    expect(valueOf(await read(station), ConfigKey.STATION_NAME)).toBe('Spalatoria Nord - boxa 1');
  });
});

describe('GetConfiguration reports the keys the station holds, by their spec names (get-configuration.md §5.1)', () => {
  it('every key it holds but a WriteOnly one, ReadOnly ones marked so, and no name the spec does not have', async () => {
    const station = await bootedStation();
    const answer = await read(station);
    const keys = answer.configuration.map((e) => e.key);

    expect(keys).toEqual(expect.arrayContaining([
      ConfigKey.HEARTBEAT_INTERVAL_SECONDS, ConfigKey.FIRMWARE_VERSION, ConfigKey.PROTOCOL_VERSION,
      ConfigKey.METER_VALUES_INTERVAL, ConfigKey.RESERVATION_DEFAULT_TTL, ConfigKey.LOG_LEVEL,
    ]));
    expect(keys).not.toContain('acceptRate');
    expect(keys).not.toContain('stationId');
    expect(keys).not.toContain('heartbeatIntervalSec');
    expect(keys).not.toContain(ConfigKey.OFFLINE_PASS_PUBLIC_KEY);
    expect(answer.configuration.find((e) => e.key === ConfigKey.FIRMWARE_VERSION)).toMatchObject({ value: '1.0.0', readonly: true });

    const asked = await read(station, [ConfigKey.OFFLINE_PASS_PUBLIC_KEY, 'VendorTurboMode', ConfigKey.LOG_LEVEL]);
    expect(asked.configuration.map((e) => e.key)).toEqual([ConfigKey.LOG_LEVEL]);
    expect(asked.unknownKeys).toEqual(['VendorTurboMode']);
  });
});

describe('the configuration outlives the process (08-configuration.md §8.4)', () => {
  it('a value the server set is the value a new process starts with, and a RebootRequired one too', async () => {
    const first = await bootedStation();
    await change(first, [
      { key: ConfigKey.METER_VALUES_INTERVAL, value: '30' },
      { key: ConfigKey.RESERVATION_DEFAULT_TTL, value: '900' },
      { key: ConfigKey.STATION_NAME, value: 'Boxa Nord' },
    ]);

    // A new process: nothing of the first is in memory, and its directory - its certificates, and
    // what it keeps beside them - is the same.
    const tlsPaths = wire.tlsPaths;
    resetWire();
    wire.tlsPaths = tlsPaths;
    const second = await bootedStation();
    const answer = await read(second);
    expect(valueOf(answer, ConfigKey.METER_VALUES_INTERVAL)).toBe('30');
    expect(valueOf(answer, ConfigKey.RESERVATION_DEFAULT_TTL)).toBe('900');
    expect(valueOf(answer, ConfigKey.STATION_NAME)).toBe('Boxa Nord');
    expect(second.configuration.get(ConfigKey.METER_VALUES_INTERVAL)).toBe(30);
  });
});
