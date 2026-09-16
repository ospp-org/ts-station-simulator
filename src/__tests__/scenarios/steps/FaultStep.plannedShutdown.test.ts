import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    setTimeout(() => this.emit('connect', { cmd: 'connack' }), 0);
  }
  end = vi.fn((_force?: boolean, _opts?: object, cb?: () => void) => { cb?.(); return this; });
  subscribe = vi.fn((_t: string, _o: object, cb?: (e?: Error) => void) => { cb?.(); return this; });
  publish = vi.fn((_t: string, _p: unknown, _o: object, cb?: (e?: Error) => void) => { cb?.(); return this; });
  stream = { destroy: vi.fn() };
}

vi.mock('mqtt', () => ({ connect: vi.fn(() => new FakeMqttClient()) }));

const { Station } = await import('../../../station/Station.js');
const { FrameJournal } = await import('../../../mqtt/FrameJournal.js');
const { FaultStep } = await import('../../../scenarios/steps/FaultStep.js');
const { StationLifecycle } = await import('../../../station/StationLifecycle.js');

import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';

function buildStation(journal: InstanceType<typeof FrameJournal>) {
  return new Station(
    {
      stationId: 'stn_faultbye',
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-TEST',
      bayCount: 1,
      timezone: 'Europe/Bucharest',
      bays: [{
        bayId: 'bay_faultbye01',
        bayNumber: 1,
        programs: [{ programNumber: 1, label: 'Basic Wash', available: true }],
        services: [{ serviceId: 'svc_wash_basic', serviceName: 'Basic Wash', available: true }],
      }],
      behavior: {
        acceptRate: 1, responseDelayMs: [0, 0], heartbeatIntervalSec: 60,
        meterValuesIntervalSec: 30, autoRetryBoot: false,
      },
    },
    { mqttUrl: 'mqtt://x', stationId: 'stn_faultbye', journal },
  );
}

const ctx = () => ({}) as unknown as ScenarioContext;

describe('fault: planned_shutdown — the announced departure a scenario can drive', () => {
  let journal: InstanceType<typeof FrameJournal>;

  beforeEach(() => {
    journal = new FrameJournal();
  });

  it('publishes exactly one ConnectionLost with reason PlannedShutdown', async () => {
    const station = buildStation(journal);
    await station.connect();

    await new FaultStep().execute({ action: 'fault', type: 'planned_shutdown' }, ctx(), station);

    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(1);
    const [bye] = journal.select({ direction: 'out', action: 'ConnectionLost' });
    const envelope = JSON.parse(bye.payload) as { messageType: string; payload: { reason: string } };
    expect(envelope.messageType).toBe('Event');
    expect(envelope.payload.reason).toBe('PlannedShutdown');
  });

  it('then closes the link — an announced departure ends with the station OFFLINE', async () => {
    const station = buildStation(journal);
    await station.connect();
    expect(station.lifecycle).toBe(StationLifecycle.ONLINE);

    await new FaultStep().execute({ action: 'fault', type: 'planned_shutdown' }, ctx(), station);

    expect(station.lifecycle).toBe(StationLifecycle.OFFLINE);
  });

  it('the goodbye is the LAST frame out', async () => {
    const station = buildStation(journal);
    await station.connect();
    await station.retryBoot();

    await new FaultStep().execute({ action: 'fault', type: 'planned_shutdown' }, ctx(), station);

    const outbound = journal.select({ direction: 'out' });
    expect(outbound[outbound.length - 1].action).toBe('ConnectionLost');
  });

  it('`sever` still says NOTHING — the two faults stay the two arms they are', async () => {
    // core/connection-lost-lwt.yaml rests on `sever` producing a BROKER-published
    // will and no station-published goodbye. If this fault leaked into that one, that
    // file would be asserting the opposite of what it proves.
    const station = buildStation(journal);
    await station.connect();
    await new FaultStep().execute({ action: 'fault', type: 'sever' }, ctx(), station);
    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(0);
  });

  it('`disconnect` still says nothing either', async () => {
    const station = buildStation(journal);
    await station.connect();
    await new FaultStep().execute({ action: 'fault', type: 'disconnect' }, ctx(), station);
    expect(journal.count({ direction: 'out', action: 'ConnectionLost' })).toBe(0);
  });

  it('an unknown fault type is still refused, naming the four that exist', async () => {
    const station = buildStation(journal);
    await expect(
      new FaultStep().execute({ action: 'fault', type: 'nonsense' }, ctx(), station),
    ).rejects.toThrow(/Unknown fault type: nonsense/);
  });
});
