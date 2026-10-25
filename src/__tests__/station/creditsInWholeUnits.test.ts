import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import { StartServiceHandler } from '../../handlers/StartServiceHandler.js';
import { StopServiceHandler } from '../../handlers/StopServiceHandler.js';
import { Station } from '../../station/Station.js';
import type { StationConfig } from '../../station/StationConfig.js';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';

/*
 * THE STATION'S FIGURE, IN WHOLE UNITS (2026-10-25, csms-server TODO A0 item 13).
 *
 * `creditsCharged = ceil(actualDurationSeconds / 60 * priceCreditsPerMinute)` (03-messages.md §3.4) is the ceiling of
 * an exact rational. Evaluated as written in binary floating point, 33 / 60 * 100 is 55.00000000000001 and its ceiling
 * 56, where 55 is owed; 66 s gives 111 for 110. The server charged those until csms-server 248b50d4 and charges 55 and
 * 110 now; the station's figure is advisory, and the server compares it with what it settled and journals every
 * disagreement (`settlement_diverged`). So the station reports the same 55 and 110, on both of its carriers: the
 * StopService RESPONSE and the SessionEnded. A session here is priced at 100 credits a minute (StartServiceHandler).
 */

function useClock(): { passRealTime(ms: number): void } {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-25T09:00:00.000Z'));
  let mono = 123_456.789;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  return {
    passRealTime(ms: number): void {
      mono += ms;
      vi.setSystemTime(Date.now() + ms);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Sent { action: OsppAction; messageType: MessageType; payload: Record<string, unknown> }

function handlerContext(): { station: StationContext; sent: Sent[] } {
  const sent: Sent[] = [];
  const sessions = new Map<string, SessionInfo>();
  let bayState = BayStatus.AVAILABLE;
  const station = {
    config: {
      bays: [{
        bayId: 'bay_c4ed1700', bayNumber: 1,
        programs: [{ programNumber: 1, label: 'P1', available: true }],
        services: [{ serviceId: 'svc_whole', serviceName: 'Wash', available: true }],
      }],
      behavior: { acceptRate: 1.0 },
    },
    sender: {
      async send(action: OsppAction, messageType: MessageType, payload: Record<string, unknown>): Promise<void> {
        sent.push({ action, messageType, payload });
      },
    },
    sessions,
    reservations: new Map(),
    currentRevocationEpoch: 0,
    getBayState: () => bayState,
    setBayState: (_b: string, s: BayStatus) => { bayState = s; },
  } as unknown as StationContext;
  return { station, sent };
}

function startEnvelope(): OsppEnvelope {
  return {
    messageId: 'msg-start', messageType: MessageType.REQUEST, action: OsppAction.START_SERVICE,
    timestamp: new Date().toISOString(), source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {
      sessionId: 'sess_c4ed1700', bayId: 'bay_c4ed1700', serviceId: 'svc_whole',
      programNumber: 1, durationSeconds: 300, sessionSource: 'MobileApp',
    },
  } as unknown as OsppEnvelope;
}

function stopEnvelope(): OsppEnvelope {
  return {
    messageId: 'msg-stop', messageType: MessageType.REQUEST, action: OsppAction.STOP_SERVICE,
    timestamp: new Date().toISOString(), source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: { bayId: 'bay_c4ed1700', sessionId: 'sess_c4ed1700' },
  } as unknown as OsppEnvelope;
}

async function stopResponseAfter(seconds: number): Promise<Record<string, unknown>> {
  const clock = useClock();
  const { station, sent } = handlerContext();
  await new StartServiceHandler().handle(startEnvelope(), station);
  clock.passRealTime(seconds * 1000);
  await new StopServiceHandler().handle(stopEnvelope(), station);
  const response = sent.find((s) => s.action === OsppAction.STOP_SERVICE && s.messageType === MessageType.RESPONSE);
  expect(response, 'no StopService RESPONSE was sent').toBeDefined();
  return response!.payload;
}

async function sessionEndedAfter(seconds: number): Promise<Record<string, unknown>> {
  const clock = useClock();
  const station = new Station({
    stationId: 'stn_c4ed1700',
    firmwareVersion: '1.0.0', stationModel: 'M', stationVendor: 'V', timezone: 'UTC',
    bays: [{
      bayId: 'bay_c4ed1700', bayNumber: 1,
      programs: [{ programNumber: 1, label: 'P1', available: true }],
      services: [{ serviceId: 'svc_whole', serviceName: 'Wash', available: true }],
    }],
    behavior: { acceptRate: 1, responseDelayMs: [0, 0], heartbeatIntervalSec: 30 },
  } as unknown as StationConfig, {} as never);
  const ended: Record<string, unknown>[] = [];
  vi.spyOn(station.sender, 'send').mockImplementation(
    (async (a: unknown, _t: unknown, p: unknown) => {
      if (a === OsppAction.SESSION_ENDED) ended.push(p as Record<string, unknown>);
    }) as never,
  );
  await new StartServiceHandler().handle(startEnvelope(), station as unknown as StationContext);
  clock.passRealTime(seconds * 1000);
  await station.settleSessionAsOperatorStop('sess_c4ed1700');
  expect(ended).toHaveLength(1);
  return ended[0];
}

describe('the StopService RESPONSE charges the time delivered in whole units', () => {
  it.each([
    [33, 55],
    [66, 110],
  ])('%i s at 100 credits a minute: %i credits, where the formula in floating point gives one more', async (seconds, credits) => {
    const p = await stopResponseAfter(seconds);

    expect(p.actualDurationSeconds).toBe(seconds);
    expect(p.creditsCharged).toBe(credits);
  });

  it('CONTROL: 40 s, which floating point gets right, is 67, and a whole minute 100', async () => {
    expect((await stopResponseAfter(40)).creditsCharged).toBe(67);
    expect((await stopResponseAfter(60)).creditsCharged).toBe(100);
  });
});

describe('the SessionEnded charges the time delivered in whole units', () => {
  it.each([
    [33, 55],
    [66, 110],
  ])('%i s at 100 credits a minute: %i credits, where the formula in floating point gives one more', async (seconds, credits) => {
    const p = await sessionEndedAfter(seconds);

    expect(p.actualDurationSeconds).toBe(seconds);
    expect(p.creditsCharged).toBe(credits);
  });

  it('CONTROL: 40 s, which floating point gets right, is 67, and a whole minute 100', async () => {
    expect((await sessionEndedAfter(40)).creditsCharged).toBe(67);
    expect((await sessionEndedAfter(60)).creditsCharged).toBe(100);
  });
});
