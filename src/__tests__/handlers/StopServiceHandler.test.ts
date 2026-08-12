import { describe, it, expect } from 'vitest';
import { StopServiceHandler } from '../../handlers/StopServiceHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
  type StopServiceResponse,
} from '@ospp/protocol';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';
import { SequenceCounter } from '../../station/SequenceCounter.js';

// The station owns the counter now; a fixture seeds it explicitly.
function counterAt(n: number): SequenceCounter {
  const c = new SequenceCounter();
  c.forceTo(n);
  return c;
}

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: unknown;
}

function makeMockStation(
  seqNoAtStop: number,
  options: { startedAtOffsetMs?: number; priceCreditsPerMinute?: number } = {},
): {
  station: StationContext;
  captured: CapturedSend[];
} {
  const captured: CapturedSend[] = [];
  const startedAtOffsetMs = options.startedAtOffsetMs ?? 60_000;
  const priceCreditsPerMinute = options.priceCreditsPerMinute ?? 100;
  const sessions = new Map<string, SessionInfo>([
    [
      'sess_test',
      {
        sessionId: 'sess_test',
        bayId: 'bay_test',
        serviceId: 'svc_test',
        startedAt: new Date(Date.now() - startedAtOffsetMs).toISOString(),
        durationSeconds: 300,
        seq: counterAt(seqNoAtStop),
        priceCreditsPerMinute,
      },
    ],
  ]);

  let bayState = BayStatus.OCCUPIED;

  const station = {
    sessions,
    sender: {
      async send(action: OsppAction, messageType: MessageType, payload: unknown): Promise<void> {
        captured.push({ action, messageType, payload });
      },
    },
    getBayState: () => bayState,
    setBayState: (_bayId: string, status: BayStatus) => {
      bayState = status;
    },
    currentRevocationEpoch: 0,
    reservations: new Map(),
  } as unknown as StationContext;

  return { station, captured };
}

function makeStopServiceRequest(): OsppEnvelope {
  return {
    messageId: 'msg-stop',
    messageType: MessageType.REQUEST,
    action: OsppAction.STOP_SERVICE,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: { bayId: 'bay_test', sessionId: 'sess_test' },
  };
}

describe('StopServiceHandler — v0.4.0 finalSeqNo emission', () => {
  it('Accepted Response carries finalSeqNo from session.seqNo', async () => {
    const { station, captured } = makeMockStation(7);
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    const response = captured.find(
      (c) => c.action === OsppAction.STOP_SERVICE && c.messageType === MessageType.RESPONSE,
    );
    expect(response).toBeDefined();
    const payload = response!.payload as StopServiceResponse;
    expect(payload.status).toBe('Accepted');
    expect((payload as { finalSeqNo?: number }).finalSeqNo).toBe(7);
  });

});

// spec v0.13.0 profiles/transaction/session-ended.md:57, the one RFC-2119 rule on
// this: the station "MUST emit SessionEnded for every session that terminates
// without a StopService command, and MUST NOT emit it for one that terminates with
// one." The Accepted RESPONSE already carries the settlement (its schema REQUIRES
// actualDurationSeconds + creditsCharged when status=Accepted), and 03-messages.md:1195
// records why the enum has no `Remote` value: "emitting both StopService RESPONSE and
// SessionEnded for the same stop would force double-emission ambiguity."
//
// That ambiguity is not theoretical on the csms server. The RESPONSE settles as
// TerminalReason::VoluntaryStop (UserDurationStrategy:53 → pro-rata on delivered
// time); a SessionEnded with reason TimerExpired settles as TerminalReason::TimerExpired
// (UserDurationStrategy:38-40 → fullCharge of the whole pre-authorization). Whichever
// arrives first wins, because the loser hits a terminal-session guard. The station does
// not get to send both and let the server sort it out.
describe('StopServiceHandler — SessionEnded MUST NOT follow an Accepted StopService', () => {
  it('emits the RESPONSE and nothing else', async () => {
    const { station, captured } = makeMockStation(12);
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    expect(captured.map((c) => `${c.action}:${c.messageType}`)).toEqual([
      `${OsppAction.STOP_SERVICE}:${MessageType.RESPONSE}`,
    ]);
  });

  it('emits no SessionEnded even though the session is gone and the bay is Available', async () => {
    const { station, captured } = makeMockStation(12);
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    expect(captured.some((c) => c.action === OsppAction.SESSION_ENDED)).toBe(false);
    expect(station.sessions.has('sess_test')).toBe(false);
    expect(station.getBayState('bay_test')).toBe(BayStatus.AVAILABLE);
  });
});

describe('StopServiceHandler — Bug F: creditsCharged spec formula', () => {
  it('60s @ 100 cr/min → creditsCharged = 100 per ceil(s/60 × rate)', async () => {
    const { station, captured } = makeMockStation(1, {
      startedAtOffsetMs: 60_000,
      priceCreditsPerMinute: 100,
    });
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    const response = captured.find(
      (c) => c.action === OsppAction.STOP_SERVICE && c.messageType === MessageType.RESPONSE,
    );
    const payload = response!.payload as StopServiceResponse;
    expect(payload.actualDurationSeconds).toBe(60);
    expect((payload as { creditsCharged?: number }).creditsCharged).toBe(100);
  });

  it('75s @ 100 cr/min → creditsCharged = 125 (ceil rounding)', async () => {
    const { station, captured } = makeMockStation(1, {
      startedAtOffsetMs: 75_000,
      priceCreditsPerMinute: 100,
    });
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    const response = captured.find(
      (c) => c.action === OsppAction.STOP_SERVICE && c.messageType === MessageType.RESPONSE,
    );
    const payload = response!.payload as StopServiceResponse;
    expect(payload.actualDurationSeconds).toBe(75);
    expect((payload as { creditsCharged?: number }).creditsCharged).toBe(125);
  });

  it('60s @ 10 cr/min → creditsCharged = 10 (different rate)', async () => {
    const { station, captured } = makeMockStation(1, {
      startedAtOffsetMs: 60_000,
      priceCreditsPerMinute: 10,
    });
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    const response = captured.find(
      (c) => c.action === OsppAction.STOP_SERVICE && c.messageType === MessageType.RESPONSE,
    );
    const payload = response!.payload as StopServiceResponse;
    expect((payload as { creditsCharged?: number }).creditsCharged).toBe(10);
  });
});
