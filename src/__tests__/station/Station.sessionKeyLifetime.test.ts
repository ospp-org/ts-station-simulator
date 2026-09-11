import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/*
 * THE SESSION KEY LIVES EXACTLY AS LONG AS THE MQTT SESSION.
 *
 * `06-security.md:1070` rule 2 — "Both peers MUST discard it when the MQTT
 * session ends — the station on disconnect, the server on the LWT or on any
 * broker-reported disconnect."
 *
 * The simulator held one write to `station.sessionKey` and no clear at all, so
 * the station kept a dead session's key across disconnect. `bootAccepted` IS
 * reset on connect (Station.ts:245) and on `kicked` (:187); `sessionKey` was
 * left out of both.
 *
 * This is the SAME sentence as the Pending fix in
 * BootNotificationHandler.pendingSessionKey.test.ts — the rule has two halves
 * and the simulator had neither.
 *
 * IT IS ALSO WHY A MEASUREMENT CAN LIE. The server discards on the LWT, so
 * probing a station's key while the station is stopped reads empty for a
 * perfectly conformant reason — the absence proves the LWT fired, not that the
 * key was never stored. A simulator that never discarded its own copy made the
 * two sides disagree about what "the session ended" means.
 *
 * Fully offline: MqttConnection is stubbed; no broker, no csms.
 */

class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn().mockResolvedValue(undefined);
  onMessage = vi.fn();
  getTlsPaths = vi.fn(() => null);
  connect = vi.fn(() => {
    setImmediate(() => this.emit('connect', {}));
  });
}

vi.mock('../../mqtt/MqttConnection.js', () => ({
  MqttConnection: MqttConnectionStub,
}));

const { Station } = await import('../../station/Station.js');

const KEY = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');

function buildStation() {
  return new Station(
    {
      stationId: 'stn_keylife01',
      firmwareVersion: '1.0.0',
      stationModel: 'WashPro X200',
      stationVendor: 'SimCorp',
      serialNumber: 'SN-KEYLIFE01',
      bayCount: 1,
      timezone: 'UTC',
      bays: [
        {
          bayId: 'bay_keylife01',
          bayNumber: 1,
          programs: [{ programNumber: 1, label: 'P1', available: true }],
          services: [],
        },
      ],
      behavior: {
        acceptRate: 1.0,
        responseDelayMs: [0, 0],
        heartbeatIntervalSec: 60,
        meterValuesIntervalSec: 30,
        autoRetryBoot: false,
      },
    },
    { mqttUrl: 'mqtt://localhost:1883', stationId: 'stn_keylife01' },
  );
}

describe('session key lifetime', () => {
  let station: ReturnType<typeof buildStation>;

  beforeEach(() => {
    station = buildStation();
  });

  it('CONTROL: the key is held while the session is alive', async () => {
    station.sessionKey = KEY;

    // `06-security.md:1072` rule 3 — a peer MUST NOT expire the key while the
    // MQTT session is alive. Without this control, "always null" would pass.
    expect(station.sessionKey).toBe(KEY);
  });

  it('RED: discards the key on disconnect', async () => {
    station.sessionKey = KEY;

    await station.disconnect();

    expect(station.sessionKey).toBeNull();
  });

  it('RED: discards the key on an announced departure too', async () => {
    // The other arm of the same door — a planned shutdown ends the MQTT
    // session just as a silent one does.
    station.sessionKey = KEY;

    await station.disconnect({ announceDeparture: true });

    expect(station.sessionKey).toBeNull();
  });
});
