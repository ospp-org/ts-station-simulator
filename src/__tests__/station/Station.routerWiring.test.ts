import { describe, it, expect } from 'vitest';
import { Station } from '../../station/Station.js';
import type { StationConfig } from '../../station/StationConfig.js';

// ---------------------------------------------------------------------------
// The router's MAC verification was built and never wired.
//
// MessageRouter takes `getSessionKey` so `verified()` can fail closed on a
// missing key, a missing mac, or a bad mac. Station.ts constructed it as
// `new MessageRouter()` — taking the `() => null` default — so the station stored
// its session key and the router could never see it.
//
// The failure mode is the worst kind: it looks like correct fail-closed
// behaviour. Every inbound server message is refused with
// "no session key held (1013 MAC_MISSING)", which is exactly what a station with
// no key SHOULD say. On a live wire the station refused every Heartbeat response
// and every StartService, forever, and the log line gave no hint that the key was
// sitting on the object one field away.
//
// Every unit test passed, because they construct MessageRouter directly WITH a
// getter. Only the wiring was wrong, so only a test that asserts on the wiring
// catches it — this one reads the key through the router's own accessor rather
// than through a getter the test supplies.
// ---------------------------------------------------------------------------

function makeConfig(): StationConfig {
  return {
    stationId: 'stn_wiretest',
    firmwareVersion: '1.0.0',
    stationModel: 'M',
    stationVendor: 'V',
    timezone: 'UTC',
    bays: [
      {
        bayId: 'bay_wiretest01',
        bayNumber: 1,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }],
      },
    ],
    behavior: {
      acceptRate: 1,
      responseDelayMs: [0, 0],
      heartbeatIntervalSec: 30,
      meterValuesIntervalSec: 10,
    },
  } as unknown as StationConfig;
}

describe('Station — the router can see the station key', () => {
  it('a key set on the station is visible to the router', () => {
    const station = new Station(makeConfig(), {} as never);

    station.sessionKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    expect(station.router.currentSessionKey()).toBe(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
  });

  it('the router reads the key LIVE, not a value captured at construction', () => {
    // The key arrives in the BootNotification response, which is necessarily
    // after the router exists. A router that captured `null` at construction
    // would pass the test above only if the key were set before it was built —
    // which is never the real order.
    const station = new Station(makeConfig(), {} as never);

    expect(station.router.currentSessionKey()).toBeNull();
    station.sessionKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
    expect(station.router.currentSessionKey()).toBe(
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    );
  });

  it('a key cleared on the station is cleared for the router too', () => {
    // Session-key rotation and disconnect both null it. A router holding a stale
    // key would accept messages signed under a key the station no longer has.
    const station = new Station(makeConfig(), {} as never);
    station.sessionKey = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=';

    station.sessionKey = null;

    expect(station.router.currentSessionKey()).toBeNull();
  });
});
