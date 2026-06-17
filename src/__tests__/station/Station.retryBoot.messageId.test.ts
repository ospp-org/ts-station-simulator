import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/*
 * Regression guard for the server-side duplicate-REQUEST cached-RESPONSE replay
 * (csms, OSPP 02-transport.md §3.3). The sim's DEFAULT boot-retry mints a fresh
 * UUID each attempt, so it never emits a duplicate messageId and never exercises
 * that server path — which is why the csms silent-drop bug went unnoticed on e2e.
 *
 * This pins the default (fresh UUID, UNCHANGED) and proves the opt-in
 * retryBoot(fixedMessageId) reuses the SAME messageId across attempts — the
 * traffic a spec-conformant station emits on timeout (glossary: "retry with the
 * same messageId") and the precondition for a sim↔csms e2e to hit the replay path.
 *
 * Fully offline: MqttConnection is stubbed; no broker, no csms.
 */
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

describe('Station.retryBoot() — messageId reuse opt-in', () => {
  beforeEach(() => {
    publishCalls.length = 0;
  });

  it('default: each retryBoot() mints a fresh UUID (default behaviour unchanged)', async () => {
    const station = buildStation();
    await station.connect();

    await station.retryBoot();
    await station.retryBoot();

    const ids = publishCalls.map(c => JSON.parse(c.payload).messageId as string);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]); // always fresh — the existing deviation, preserved
  });

  it('opt-in: retryBoot(fixedMessageId) reuses the SAME messageId on retry (exercises csms §3.3 replay)', async () => {
    const station = buildStation();
    await station.connect();

    const FIXED_ID = '00000000-0000-4000-8000-000000000001';
    await station.retryBoot(FIXED_ID);
    await station.retryBoot(FIXED_ID);

    const ids = publishCalls.map(c => JSON.parse(c.payload).messageId as string);
    expect(ids).toEqual([FIXED_ID, FIXED_ID]);
  });
});
