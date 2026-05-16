import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Replace MqttConnection with a stub that simulates broker connect/subscribe
// without opening a real socket. Records publish() calls so the test can
// assert no BootNotification was published during connect().
const publishCalls: Array<{ topic: string; payload: string }> = [];

class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn(async (topic: string, payload: string) => {
    publishCalls.push({ topic, payload: String(payload) });
  });
  onMessage = vi.fn();
  connect = vi.fn(() => {
    setImmediate(() => this.emit('connect', {}));
  });
}

vi.mock('../../mqtt/MqttConnection.js', () => ({
  MqttConnection: MqttConnectionStub,
}));

// Import AFTER the mock so Station picks up the stub.
const { Station } = await import('../../station/Station.js');
const { OsppAction } = await import('@ospp/protocol');

function buildStation() {
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

describe('Station.connect()', () => {
  beforeEach(() => {
    publishCalls.length = 0;
  });

  it('does not auto-publish BootNotification (autoBoot removed — scenario YAML must send it explicitly)', async () => {
    const station = buildStation();

    await station.connect();

    const bootPublished = publishCalls.some(c =>
      c.payload.includes(`"action":"${OsppAction.BOOT_NOTIFICATION}"`),
    );
    expect(bootPublished).toBe(false);
    expect(publishCalls.length).toBe(0);
  });

  it('retryBoot() publishes a BootNotification REQUEST with config payload', async () => {
    const station = buildStation();
    await station.connect();

    await station.retryBoot();

    expect(publishCalls.length).toBe(1);
    const envelope = JSON.parse(publishCalls[0].payload);
    expect(envelope.action).toBe(OsppAction.BOOT_NOTIFICATION);
    expect(envelope.payload.stationModel).toBe('WashPro X200');
    expect(envelope.payload.stationVendor).toBe('SimCorp');
  });
});
