import { describe, it, expect, vi } from 'vitest';
import { SessionEndReason } from '@ospp/protocol';
import { Station } from '../../station/Station.js';
import { SequenceCounter } from '../../station/SequenceCounter.js';
import type { StationConfig } from '../../station/StationConfig.js';
import { BayStatus } from '@ospp/protocol';

// ---------------------------------------------------------------------------
// This file used to pin a BLOCKED state: the fix could not land because
// @ospp/protocol had no OPERATOR_STOPPED, and emitting the string against a
// server that did not know it would have had the SessionEnded REJECTED — worse
// than the mis-billing, because SessionEnded is the sole billing source when no
// StopService was issued, so the session would go unbilled entirely.
//
// SDK 0.13.0 shipped the member and the pin fired, which is what it was for.
// What remains is the assertion that matters: a forced stop reports the reason
// that BILLS, not the one that mandates zero.
//
// spec v0.11.1 03-messages.md §5.4 — `OperatorStopped` is the only member that
// bills a non-zero amount for a session the station did not run to completion.
// `Deauthorized`, which reads as the nearest alternative, carries "Session MUST
// be billed at zero"; a station using it delivers a wash and charges nothing.
// ---------------------------------------------------------------------------

function makeConfig(): StationConfig {
  return {
    stationId: 'stn_opstop',
    firmwareVersion: '1.0.0', stationModel: 'M', stationVendor: 'V', timezone: 'UTC',
    bays: [{
      bayId: 'bay_opstop01', bayNumber: 1,
      programs: [{ programNumber: 1, label: 'P1', available: true }],
      services: [{ serviceId: 'svc_x', serviceName: 'X', available: true }],
    }],
    behavior: { acceptRate: 1, responseDelayMs: [0, 0], heartbeatIntervalSec: 30, meterValuesIntervalSec: 10 },
  } as unknown as StationConfig;
}

describe('a forced stop reports the reason that bills', () => {
  it('emits OperatorStopped, not Deauthorized', async () => {
    const station = new Station(makeConfig(), {} as never);
    const sent: Record<string, unknown>[] = [];
    vi.spyOn(station.sender, 'send').mockImplementation(async (_a, _t, p) => {
      sent.push(p as Record<string, unknown>);
    });
    station.setBayState('bay_opstop01', BayStatus.OCCUPIED);
    station.sessions.set('sess_1', {
      sessionId: 'sess_1', bayId: 'bay_opstop01', serviceId: 'svc_x',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      durationSeconds: 300, seq: new SequenceCounter(),
    } as never);

    await station.settleSessionAsOperatorStop('sess_1');

    expect(sent[0].reason).toBe(SessionEndReason.OPERATOR_STOPPED);
    expect(sent[0].reason).not.toBe(SessionEndReason.DEAUTHORIZED);
    // Billed for what was delivered: 120s at the advisory 100 cr/min.
    expect(sent[0].creditsCharged).toBe(200);
  });

  it('the SDK carries the member — the block that produced this file is gone', () => {
    expect(Object.keys(SessionEndReason)).toContain('OPERATOR_STOPPED');
  });
});
