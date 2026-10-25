import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { elapse, wire, resetWire, fakeClock, certDir, connectConfig, STATION_ID } from '../helpers/stationHarness.js';

/*
 * `wait_for_connect` WAITS FOR THE STATION TO BE CONNECTED AGAIN, NOT FOR THE NEXT CONNECT (2026-10-25).
 *
 * A station is back 1.0-1.3 s after its link drops (02-transport.md §4.5, reconnectBackoff.ts) - before the next step
 * of a scenario that does anything between the drop and its wait. core/boot-disabled-station-boots-and-stays-gated.yaml
 * waits 2 s and asserts the kick before it waits for the reconnect: on UAT (2026-10-25) the reconnect had come and
 * gone, Station.waitForConnect waited for another for its 20 s and failed, and the pool station stayed disabled for
 * the rest of the corpus. So it returns at once on a link that is up again since its last drop, and waits on one that
 * is down - and a drop the station makes itself (`fault: disconnect`) is a drop from that instant, though the close
 * of its socket is reported a tick later. For every station: a scenario's station does not otherwise track its link.
 */

vi.mock('../../mqtt/MqttConnection.js', async () =>
  ({ MqttConnection: (await import('../helpers/stationHarness.js')).MqttConnectionStub }));

const { Station } = await import('../../station/Station.js');

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

async function scenarioStation(): Promise<InstanceType<typeof Station>> {
  const station = new Station(connectConfig({ rebootOnReconnect: false }), { mqttUrl: 'mqtts://localhost:8883', stationId: STATION_ID });
  await station.connect();
  return station;
}

/** What the wait came to: 'connected', or the message it failed with. */
function outcomeOf(wait: Promise<void>): { value: () => string | null } {
  let value: string | null = null;
  wait.then(() => { value = 'connected'; }, (err: Error) => { value = err.message; });
  return { value: () => value };
}

describe('Station.waitForConnect - connected again, not the next connect', () => {
  it('returns at once when the link dropped and came back before the wait - the reconnect of the backoff', async () => {
    const station = await scenarioStation();
    const link = wire.connections[wire.connections.length - 1];
    link.emit('close');
    link.emit('connect', {});

    const outcome = outcomeOf(station.waitForConnect(5_000));
    await elapse(5_001);

    expect(outcome.value()).toBe('connected');
  });

  it('waits on a link that is down, and returns on the reconnect', async () => {
    const station = await scenarioStation();
    const link = wire.connections[wire.connections.length - 1];
    link.emit('close');

    const outcome = outcomeOf(station.waitForConnect(5_000));
    await elapse(1_000);
    expect(outcome.value()).toBeNull();

    link.emit('connect', {});
    await elapse(10);
    expect(outcome.value()).toBe('connected');
  });

  it('CONTROL: after a drop the station makes itself it waits for the reconnect, though its socket reports the close a tick later', async () => {
    const station = await scenarioStation();
    const link = wire.connections[wire.connections.length - 1];

    station.destroyConnection();
    const outcome = outcomeOf(station.waitForConnect(5_000));
    await elapse(1_000);
    expect(outcome.value()).toBeNull();

    link.emit('close');
    link.emit('connect', {});
    await elapse(10);
    expect(outcome.value()).toBe('connected');
  });
});
