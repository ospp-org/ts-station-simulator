import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station as StationType } from '../../../station/Station.js';

// Stub MqttConnection (an EventEmitter) so we can drive the `connect` event
// without a real socket — mirrors src/__tests__/station/Station.connect.test.ts.
class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn().mockResolvedValue(undefined);
  onMessage = vi.fn();
  connect = vi.fn();
}

vi.mock('../../../mqtt/MqttConnection.js', () => ({
  MqttConnection: MqttConnectionStub,
}));

const { Station } = await import('../../../station/Station.js');
const { WaitForConnectStep } = await import(
  '../../../scenarios/steps/WaitForConnectStep.js'
);

function buildStation(): StationType {
  return new Station(
    {
      stationId: 'stn_test0001',
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-TEST0001',
      bayCount: 1,
      timezone: 'UTC',
      bays: [{ bayId: 'bay_test0001', bayNumber: 1, services: [] }],
      behavior: {
        acceptRate: 1.0,
        responseDelayMs: [0, 0],
        heartbeatIntervalSec: 60,
        meterValuesIntervalSec: 30,
        autoRetryBoot: true,
      },
    },
    { mqttUrl: 'mqtt://localhost:1883', stationId: 'stn_test0001' },
  );
}

// The connection is private; reach it as the EventEmitter stub to drive `connect`.
function conn(station: StationType): EventEmitter {
  return (station as unknown as { connection: EventEmitter }).connection;
}

describe('Station.waitForConnect()', () => {
  it('resolves when the connection emits `connect` (the auto-reconnect connack)', async () => {
    const station = buildStation();
    const pending = station.waitForConnect(1000);
    conn(station).emit('connect', {}); // simulate the reconnect connack
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects after the timeout if no connect arrives', async () => {
    const station = buildStation();
    await expect(station.waitForConnect(20)).rejects.toThrow(
      /Timeout waiting for MQTT \(re\)connect after 20ms/,
    );
  });

  it('removes its `connect` listener after resolving (no leak)', async () => {
    const station = buildStation();
    const pending = station.waitForConnect(1000);
    conn(station).emit('connect', {});
    await pending;
    expect(conn(station).listenerCount('connect')).toBe(0);
  });

  it('removes its `connect` listener after timing out (no leak)', async () => {
    const station = buildStation();
    await station.waitForConnect(20).catch(() => undefined);
    expect(conn(station).listenerCount('connect')).toBe(0);
  });
});

describe('WaitForConnectStep', () => {
  const ctx = {} as unknown as ScenarioContext;

  it('delegates to station.waitForConnect with the 15000ms default', async () => {
    const waitForConnect = vi.fn().mockResolvedValue(undefined);
    const station = { waitForConnect } as unknown as StationType;
    await new WaitForConnectStep().execute(
      { action: 'wait_for_connect' },
      ctx,
      station,
    );
    expect(waitForConnect).toHaveBeenCalledWith(15000);
  });

  it('honors an explicit timeout_ms', async () => {
    const waitForConnect = vi.fn().mockResolvedValue(undefined);
    const station = { waitForConnect } as unknown as StationType;
    await new WaitForConnectStep().execute(
      { action: 'wait_for_connect', timeout_ms: 8000 },
      ctx,
      station,
    );
    expect(waitForConnect).toHaveBeenCalledWith(8000);
  });
});
