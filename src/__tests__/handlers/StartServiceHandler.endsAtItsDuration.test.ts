import { describe, it, expect, vi, afterEach } from 'vitest';
import { StartServiceHandler } from '../../handlers/StartServiceHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';

/**
 * RED (O2) - a connect-mode station that accepted a StartService never ends the wash: no timer is
 * armed at durationSeconds, so no SessionEnded TimerExpired is ever sent and the session stays in
 * the map for ever (docs/CONFORMANCE-GAPS.md, "Zero of the four timers is session-bound").
 */
function station(): { ctx: StationContext; sent: Array<{ action: string; type: string; payload: unknown }>; sessions: Map<string, SessionInfo> } {
  const sessions = new Map<string, SessionInfo>();
  const sent: Array<{ action: string; type: string; payload: unknown }> = [];
  let bayState = BayStatus.AVAILABLE;
  const ctx = {
    config: {
      bays: [{
        bayId: 'bay_test', bayNumber: 1,
        programs: [{ programNumber: 1, label: 'Basic Wash', available: true }],
        services: [{ serviceId: 'svc_test', serviceName: 'Wash', available: true }],
      }],
      behavior: { acceptRate: 1.0 },
    },
    sender: { async send(action: string, type: string, payload: unknown) { sent.push({ action, type, payload }); } },
    sessions,
    reservations: new Map(),
    terminalReservations: new Map(),
    currentRevocationEpoch: 0,
    getBayState: () => bayState,
    setBayState: (_b: string, s: BayStatus) => { bayState = s; },
  } as unknown as StationContext;
  return { ctx, sent, sessions };
}

const start = (durationSeconds: number): OsppEnvelope => ({
  messageId: 'msg-1', messageType: MessageType.REQUEST, action: OsppAction.START_SERVICE,
  timestamp: new Date().toISOString(), source: MessageSource.SERVER, protocolVersion: OSPP_PROTOCOL_VERSION,
  payload: { sessionId: 'sess_test', bayId: 'bay_test', serviceId: 'svc_test', durationSeconds, sessionSource: 'MobileApp', programNumber: 1 },
} as unknown as OsppEnvelope);

describe('RED (O2) - the station ends the wash it accepted when its duration elapses', () => {
  afterEach(() => vi.useRealTimers());

  it('sends SessionEnded TimerExpired with the delivered time once durationSeconds has elapsed', async () => {
    vi.useFakeTimers();
    const { ctx, sent, sessions } = station();
    await new StartServiceHandler().handle(start(2), ctx);
    expect(sent.map((m) => `${m.action}/${m.type}`)).toEqual([`${OsppAction.START_SERVICE}/${MessageType.RESPONSE}`]);

    await vi.advanceTimersByTimeAsync(3000);

    const ended = sent.find((m) => m.action === OsppAction.SESSION_ENDED);
    expect(ended, `sent after 3 s: ${JSON.stringify(sent.map((m) => m.action))}; sessions held: ${[...sessions.keys()]}`).toBeDefined();
    expect((ended!.payload as { reason: string }).reason).toBe('TimerExpired');
    expect(sessions.has('sess_test')).toBe(false);
  });
});
