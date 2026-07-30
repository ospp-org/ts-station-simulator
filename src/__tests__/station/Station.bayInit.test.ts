import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BayStatus, isReportableBayStatus } from '@ospp/protocol';

/*
 * A bay's initial state must be REPORTABLE, because the first thing the station
 * does with it is report it.
 *
 * Spec v0.10.0 took `Unknown` off the wire: it is the FSM's seventh state, held
 * by both parties and transmitted by neither (05-state-machines.md §1.2). A
 * station leaves it by finishing its self-test and reporting what it found.
 *
 * This simulator has no hardware and therefore no self-test to finish. The
 * spec's own boot sequence puts that step three steps before the network
 * (01-architecture.md §7.3: bays initialise, THEN TLS, THEN subscribe, THEN
 * BootNotification), so a station whose power-on checks completed before the
 * radio came up is exactly what a hardware-less simulator should model. Its bays
 * are Available from construction.
 *
 * The bug this pins: `BayStateMachine`'s constructor defaults to `UNKNOWN`, and
 * `BootNotificationHandler` reads `getBayState()` straight into the payload it
 * publishes. Every bay's first StatusNotification therefore carried
 * `status: "Unknown"` — non-conforming, and now schema-invalid.
 *
 * Deliberately uses a REAL Station rather than a StationContext double. The
 * existing autoReact test stubs `getBayState()` to return AVAILABLE, which is
 * precisely what hid this: the double asserted the answer the code was supposed
 * to produce.
 *
 * Fully offline — MqttConnection is stubbed, nothing dials out.
 */

class MqttConnectionStub extends EventEmitter {
  setTls = vi.fn();
  destroyConnection = vi.fn();
  disconnect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  publish = vi.fn().mockResolvedValue(undefined);
  onMessage = vi.fn();
  getTlsPaths = vi.fn(() => null);
  connect = vi.fn();
  isConnected = vi.fn(() => false);
}

vi.mock('../../mqtt/MqttConnection.js', () => ({
  MqttConnection: MqttConnectionStub,
}));

const { Station } = await import('../../station/Station.js');

function makeStation() {
  return new Station(
    {
      stationId: 'stn_bayinit0001',
      bays: [
        { bayId: 'bay_init_a', bayNumber: 1, services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }] },
        { bayId: 'bay_init_b', bayNumber: 2, services: [{ serviceId: 'svc_y', serviceName: 'Y', available: true }] },
      ],
      behavior: { autoRetryBoot: false },
    } as never,
    { mqttUrl: 'mqtts://127.0.0.1:8883', stationId: 'stn_bayinit0001' } as never,
  );
}

describe('bay initialisation', () => {
  it('starts every bay in a state the station may actually report', () => {
    const station = makeStation();

    for (const bayId of ['bay_init_a', 'bay_init_b']) {
      const state = station.getBayState(bayId);
      expect(
        isReportableBayStatus(state),
        `bay ${bayId} initialised to ${state}, which no station may put on the wire`,
      ).toBe(true);
    }
  });

  it('starts every bay Available specifically', () => {
    const station = makeStation();

    expect(station.getBayState('bay_init_a')).toBe(BayStatus.AVAILABLE);
    expect(station.getBayState('bay_init_b')).toBe(BayStatus.AVAILABLE);
  });

  it('never initialises a bay to Unknown', () => {
    const station = makeStation();

    expect(station.getBayState('bay_init_a')).not.toBe(BayStatus.UNKNOWN);
    expect(station.getBayState('bay_init_b')).not.toBe(BayStatus.UNKNOWN);
  });
});
