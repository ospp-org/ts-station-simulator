import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ScenarioRunner,
  type ScenarioDefinition,
  type TargetConfig,
} from '../../scenarios/ScenarioRunner.js';
import { Station } from '../../station/Station.js';

/**
 * A client good enough for Station.connect() to resolve against: it announces
 * `connect` on the next tick and calls back from subscribe(). Used only by the
 * end-to-end test at the bottom, which needs the REAL connect path so the will
 * armed at CONNECT can be read off the packet the runner actually produced.
 */
class FakeMqttClient extends EventEmitter {
  endCalls: Array<Record<string, unknown> | undefined> = [];
  constructor() {
    super();
    setTimeout(() => this.emit('connect', { cmd: 'connack' }), 0);
  }
  end = vi.fn((force?: boolean, opts?: object, cb?: () => void) => {
    this.endCalls.push(opts as Record<string, unknown> | undefined);
    cb?.();
    return this;
  });
  subscribe = vi.fn((_t: string, _o: object, cb?: (e?: Error) => void) => { cb?.(); return this; });
  publish = vi.fn((_t: string, _p: unknown, _o: object, cb?: (e?: Error) => void) => { cb?.(); return this; });
  removeListener = super.removeListener;
  stream = { destroy: vi.fn() };
}

const fakeClients: FakeMqttClient[] = [];
const connectCalls: Array<Record<string, unknown>> = [];

vi.mock('mqtt', () => ({
  connect: vi.fn((_url: string, opts: Record<string, unknown>) => {
    const fc = new FakeMqttClient();
    fakeClients.push(fc);
    connectCalls.push(opts);
    return fc;
  }),
}));

/**
 * THE WIRING, which is the half that can rot silently.
 *
 * MqttConnection.releaseWill.test.ts proves the packet is right when the option
 * is passed. It says nothing about whether anything passes it — and an option
 * nobody calls closes no gap at all, while every one of its own tests stays
 * green. So this file asserts the call, from the runner's `finally`, with the
 * argument that decides it.
 *
 * The discrimination under test is `poolStationId !== null`, and it is the whole
 * scope of the change:
 *
 *   LEASED FROM THE POOL — the id goes back to the allocator and another
 *   scenario will boot it within the run. A row left `is_online = true` here is
 *   the one that gets corrected 105s later, mid-someone-else's-lease, with a
 *   cause that is false. This is the release gap.
 *
 *   NOT LEASED — `owns_station` (1 file) and a hardcoded `station.stationId`
 *   (6 files) of 148. The id is used once and abandoned; nothing re-leases it,
 *   so nothing it leaves behind can land inside another scenario. Left alone
 *   deliberately: the change is scoped to the measured defect, and widening it
 *   would put ~7 more markings a run into the journal for no observed harm.
 *
 * Reaching the `finally` needs no broker. connect() is inside the try (line
 * ~2069) and the teardown is in the `finally` below it, so a rejected connect
 * exercises the release path exactly as a passing scenario does — which is also
 * the honest case to pin, since the teardown must clean up after failures too.
 */

const BASE_TARGET: TargetConfig = {
  mqttUrl: 'mqtt://127.0.0.1:1883',
  apiBaseUrl: 'http://127.0.0.1:8080',
};

function def(name: string, extra: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    name,
    station: { bayCount: 1, stationModel: 'WashPro X200', stationVendor: 'SimCorp' },
    steps: [],
    ...extra,
  };
}

/** Captured `publishWill` argument of every Station.disconnect() the run made. */
let disconnectArgs: Array<{ publishWill?: boolean } | undefined>;

beforeEach(() => {
  disconnectArgs = [];
  fakeClients.length = 0;
  connectCalls.length = 0;
  // Never reaches a broker: the scenario fails at connect and the `finally`
  // still runs, which is the point of reaching it this way.
  vi.spyOn(Station.prototype, 'connect').mockRejectedValue(new Error('no broker in this test'));
  vi.spyOn(Station.prototype, 'disconnect').mockImplementation(
    async function (this: Station, opts?: { publishWill?: boolean }) {
      disconnectArgs.push(opts);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the runner releases a POOL station by asking the broker to publish its will', () => {
  it('a scenario holding a pool lease is torn down with publishWill: true', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(def('pooled'), {
      ...BASE_TARGET,
      stationPool: ['stn_poolrel1'],
    });

    // The scenario itself fails (no broker). The teardown is what is under test,
    // and it runs on the failure path — which is the path a real run needs it on.
    expect(result.status).toBe('failed');
    expect(disconnectArgs).toHaveLength(1);
    expect(disconnectArgs[0]).toEqual({ publishWill: true });
  });

  it('the lease is returned to the allocator AFTER the disconnect, not before', async () => {
    // Ordering is load-bearing and invisible from the argument alone. The will
    // has to be on the wire before the id can be handed to the next scenario;
    // releasing first would let an acquire, a connect and a boot start racing a
    // ConnectionLost that is about the PREVIOUS lease — reintroducing the
    // cross-scenario marking this change exists to remove, only faster.
    const runner = new ScenarioRunner();
    const order: string[] = [];

    vi.spyOn(Station.prototype, 'disconnect').mockImplementation(async () => {
      order.push('disconnect');
    });
    const allocator = (runner as unknown as { poolAllocator: unknown });
    await runner.runScenario(def('ordering'), { ...BASE_TARGET, stationPool: ['stn_poolrel2'] });
    const realRelease = (allocator.poolAllocator as { release(id: string): void }).release.bind(
      allocator.poolAllocator,
    );
    (allocator.poolAllocator as { release(id: string): void }).release = (id: string) => {
      order.push('release');
      realRelease(id);
    };

    order.length = 0;
    await runner.runScenario(def('ordering-2'), { ...BASE_TARGET, stationPool: ['stn_poolrel2'] });

    expect(order).toEqual(['disconnect', 'release']);
  });
});

describe('a station the pool does not own is torn down as before', () => {
  /**
   * THE CONTROL. Without it, an implementation that passed `publishWill: true`
   * unconditionally would satisfy every assertion above while quietly arming the
   * will on `owns_station` and on the 6 hardcoded-id files too.
   */
  it('with no station pool configured at all, publishWill is false', async () => {
    const runner = new ScenarioRunner();
    await runner.runScenario(def('unpooled'), BASE_TARGET);

    expect(disconnectArgs).toHaveLength(1);
    expect(disconnectArgs[0]).toEqual({ publishWill: false });
  });

  it('owns_station takes no lease, so it is not released with a will either', async () => {
    const runner = new ScenarioRunner();
    await runner.runScenario(def('owner', { owns_station: true }), {
      ...BASE_TARGET,
      stationPool: ['stn_poolrel3'],
    });

    // A pool is configured and was deliberately not drawn from — the same
    // condition the allocator itself uses to skip acquiring.
    expect(disconnectArgs).toHaveLength(1);
    expect(disconnectArgs[0]).toEqual({ publishWill: false });
  });

  it('a hardcoded stationId takes no lease either', async () => {
    const runner = new ScenarioRunner();
    await runner.runScenario(
      def('hardcoded', {
        station: {
          stationId: 'stn_hardcoded1',
          bayCount: 1,
          stationModel: 'WashPro X200',
          stationVendor: 'SimCorp',
        },
      }),
      { ...BASE_TARGET, stationPool: ['stn_poolrel4'] },
    );

    expect(disconnectArgs).toHaveLength(1);
    expect(disconnectArgs[0]).toEqual({ publishWill: false });
  });
});


describe('end to end through the runner: the will the broker is actually handed', () => {
  /**
   * THE HALF THE ARGUMENT ASSERTIONS CANNOT SEE.
   *
   * `publishWill` and `willDelayInterval` are decided together and take effect at
   * opposite ends of the connection — the delay is armed in the CONNECT packet,
   * the reason code is sent in the DISCONNECT. A test that only reads the
   * disconnect argument would stay green if the delay half were dropped, and the
   * change would then publish the will TEN SECONDS after the id was handed on,
   * which is worse than the defect it replaces.
   *
   * So this one lets Station.connect() run for real against a fake client and
   * reads both packets the runner produced.
   */
  it('a pooled lease: CONNECT arms willDelayInterval 0 and DISCONNECT carries reason code 4', async () => {
    vi.restoreAllMocks();
    const runner = new ScenarioRunner();
    await runner.runScenario(def('e2e-pooled'), { ...BASE_TARGET, stationPool: ['stn_poolrel5'] });

    expect(connectCalls).toHaveLength(1);
    const will = connectCalls[0].will as { properties: { willDelayInterval: number } };
    expect(will.properties.willDelayInterval).toBe(0);

    expect(fakeClients[0].endCalls).toHaveLength(1);
    expect(fakeClients[0].endCalls[0]).toMatchObject({ reasonCode: 4 });
    expect(fakeClients[0].endCalls[0]).not.toHaveProperty('properties');
  });

  it('clean_session:false keeps the armed delay AND takes no reason code', async () => {
    // core/connection-lost-lwt.yaml is the one file in 148 that sets this, and it
    // is the file whose falsification arm needs the will SUPPRESSED for a
    // reconnect to its own session — which the zeroed delay would defeat.
    vi.restoreAllMocks();
    const runner = new ScenarioRunner();
    await runner.runScenario(def('e2e-persistent', { clean_session: false }), {
      ...BASE_TARGET,
      stationPool: ['stn_poolrel6'],
    });

    const will = connectCalls[0].will as { properties: { willDelayInterval: number } };
    expect(will.properties.willDelayInterval).toBeGreaterThan(0);
    expect(fakeClients[0].endCalls[0]).not.toHaveProperty('reasonCode');
  });
});
