import { describe, it, expect, vi } from 'vitest';
import { Station } from '../../station/Station.js';
import { SequenceCounter } from '../../station/SequenceCounter.js';
import type { StationConfig } from '../../station/StationConfig.js';
import { BayStatus } from '@ospp/protocol';

// ---------------------------------------------------------------------------
// The REAL settle, not a mocked one.
//
// ResetHandler's own test supplies a fake `settleSessionAsOperatorStop`, so it
// proved the handler CALLS it and nothing about what it does. On a live wire the
// real method threw:
//
//     TypeError: session.startedAt.getTime is not a function
//
// Station.SessionInfo declares `startedAt: Date`. StartServiceHandler stores
// `new Date().toISOString()` — a string. TWO interfaces named SessionInfo
// describe the same map (Handler.ts says string, Station.ts said Date) and
// TypeScript never saw the conflict, because handlers write through the
// StationContext shape while Station declares its own.
//
// Nothing had ever read `startedAt` back off a Station-held session, so the type
// was free to be wrong until the forced-reset settle needed it.
// ---------------------------------------------------------------------------

function makeConfig(): StationConfig {
  return {
    stationId: 'stn_settle',
    firmwareVersion: '1.0.0', stationModel: 'M', stationVendor: 'V', timezone: 'UTC',
    bays: [{
      bayId: 'bay_settle01', bayNumber: 1,
      programs: [{ programNumber: 1, label: 'P1', available: true }],
      services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }],
    }],
    behavior: { acceptRate: 1, responseDelayMs: [0, 0], heartbeatIntervalSec: 30, meterValuesIntervalSec: 10 },
  } as unknown as StationConfig;
}

function stationWithSession(startedAtIsoSecondsAgo: number): { station: Station; sent: unknown[] } {
  const station = new Station(makeConfig(), {} as never);
  const sent: unknown[] = [];
  vi.spyOn(station.sender, 'send').mockImplementation(async (_a: unknown, _t: unknown, p: unknown) => {
    sent.push(p);
  });

  // A bay carrying a session is OCCUPIED — what StartServiceHandler sets on
  // accept. Settling from Available would be a self-transition the FSM rejects,
  // and it is not the state a live session leaves behind.
  station.setBayState('bay_settle01', BayStatus.OCCUPIED);

  station.sessions.set('sess_1', {
    sessionId: 'sess_1',
    bayId: 'bay_settle01',
    serviceId: 'svc_x',
    // EXACTLY what StartServiceHandler writes — an ISO string, not a Date.
    startedAt: new Date(Date.now() - startedAtIsoSecondsAgo * 1000).toISOString(),
    durationSeconds: 300,
    seq: new SequenceCounter(),
  } as never);

  return { station, sent };
}

describe('Station.settleSessionAsOperatorStop — the real one', () => {
  it('settles a session whose startedAt is what the handler actually stored', async () => {
    const { station, sent } = stationWithSession(120);

    await station.settleSessionAsOperatorStop('sess_1');

    expect(station.sessions.size).toBe(0);
    expect(sent).toHaveLength(1);
    const p = sent[0] as Record<string, unknown>;
    expect(p.sessionId).toBe('sess_1');
    // 120s elapsed → 2 minutes. Metered from ELAPSED, not from the 300s
    // requested: the reset cut the wash short and billing the full request would
    // charge for time the customer never got.
    expect(p.actualDurationSeconds).toBe(120);
    expect(p.creditsCharged).toBe(200);
  });

  it('reports a SessionEnded, not a silent removal', async () => {
    // "reported exactly as an operator-initiated stop" — dropping the session
    // from the map without telling the server is the "licence to drop a session
    // on the floor" the clause rules out.
    const { station, sent } = stationWithSession(60);

    await station.settleSessionAsOperatorStop('sess_1');

    expect((sent[0] as Record<string, unknown>).reason).toBeDefined();
    expect((sent[0] as Record<string, unknown>).finalSeqNo).toBeDefined();
  });

  it('an unknown sessionId is a no-op, not a throw', async () => {
    // A forced reset iterates whatever is in the map; a race that removes one
    // mid-iteration must not abort the reboot.
    const { station, sent } = stationWithSession(10);

    await station.settleSessionAsOperatorStop('sess_nope');

    expect(station.sessions.size).toBe(1);
    expect(sent).toHaveLength(0);
  });
});
