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
import { monotonicNowMs } from '../../station/monotonicClock.js';

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
  options: { startedAtOffsetMs?: number; priceCreditsPerMinute?: number; canTransmit?: boolean } = {},
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
      // TWO anchors, because the session carries two clocks for two jobs
      // (heartbeat.md §6 Clock Synchronization rule 6): `startedAt` is the wall-clock STAMP, and
      // `startedAtMonotonicMs` is what the elapsed time is DIFFERENCED from.
      // Offset by the same amount, so this fixture still says "the wash ran for
      // startedAtOffsetMs" and the assertions below are unchanged.
        startedAt: new Date(Date.now() - startedAtOffsetMs).toISOString(),
        startedAtMonotonicMs: monotonicNowMs() - startedAtOffsetMs,
        durationSeconds: 300,
        seq: counterAt(seqNoAtStop),
        priceCreditsPerMinute,
      },
    ],
  ]);

  let bayState = BayStatus.OCCUPIED;

  const station = {
    // The bay the session runs on, so its end can be reported (bayReport.ts reads the bay's programs).
    config: {
      bays: [{ bayId: 'bay_test', bayNumber: 1, programs: [{ programNumber: 1, label: 'P1', available: true }], services: [] }],
    },
    ...(options.canTransmit !== undefined ? { canTransmit: () => options.canTransmit } : {}),
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

/**
 * The Accepted arm of the `StopServiceResponse` union. `actualDurationSeconds`
 * and `creditsCharged` live only there — the Rejected arm carries an error code
 * instead — so reading them off the bare union is a type error, which is what the
 * inline `as { creditsCharged?: number }` escapes here were silently paying for.
 */
type AcceptedStopService = Extract<StopServiceResponse, { status: 'Accepted' }>;

// 05-state-machines.md §3.5 rule 5: finalSeqNo is "the highest seqNo emitted in the session"; the
// response schema: "Present when status is Accepted and the station has emitted at least one
// session-scoped EVENT (MeterValues) with seqNo". It was `peek()` - the NEXT number, one more than
// was ever sent, and present for a session that emitted none. The stop now sends the final reading
// first (meter-values.md §5.1 rule 3), so the highest emitted is usually that reading's own number.
describe('StopServiceHandler — finalSeqNo is the highest seqNo emitted', () => {
  function stopResponse(captured: CapturedSend[]): AcceptedStopService & { finalSeqNo?: number } {
    const response = captured.find(
      (c) => c.action === OsppAction.STOP_SERVICE && c.messageType === MessageType.RESPONSE,
    );
    expect(response).toBeDefined();
    return response!.payload as AcceptedStopService & { finalSeqNo?: number };
  }

  it('after seven MeterValues (seqNo 0-6) the final reading takes 7, and the RESPONSE says finalSeqNo 7', async () => {
    const { station, captured } = makeMockStation(7);

    await new StopServiceHandler().handle(makeStopServiceRequest(), station);

    const final = captured.find((c) => c.action === OsppAction.METER_VALUES);
    expect((final?.payload as { seqNo?: number }).seqNo).toBe(7);
    const payload = stopResponse(captured);
    expect(payload.status).toBe('Accepted');
    expect(payload.finalSeqNo).toBe(7);
    expect(payload.meterValues).toEqual((final?.payload as { values: unknown }).values);
  });

  it('when the final reading cannot leave, finalSeqNo is the last one that did - 6, not 7', async () => {
    const { station, captured } = makeMockStation(7, { canTransmit: false });

    await new StopServiceHandler().handle(makeStopServiceRequest(), station);

    expect(captured.some((c) => c.action === OsppAction.METER_VALUES)).toBe(false);
    expect(stopResponse(captured).finalSeqNo).toBe(6);
  });

  it('a session that emitted no seqNo-bearing event gets no finalSeqNo at all', async () => {
    const { station, captured } = makeMockStation(0, { canTransmit: false });

    await new StopServiceHandler().handle(makeStopServiceRequest(), station);

    expect(stopResponse(captured)).not.toHaveProperty('finalSeqNo');
  });
});

// spec v0.13.0 session-ended.md §4 Reasons, the one RFC-2119 rule on
// this: the station "MUST emit SessionEnded for every session that terminates
// without a StopService command, and MUST NOT emit it for one that terminates with
// one." The Accepted RESPONSE already carries the settlement (its schema REQUIRES
// actualDurationSeconds + creditsCharged when status=Accepted), and 03-messages.md §5.4, "Payload"
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
  it('emits the final reading, the RESPONSE and the bay\'s two transitions - and no SessionEnded', async () => {
    const { station, captured } = makeMockStation(12);
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    // The final reading before the end record (meter-values.md §5.1 rule 3), then the RESPONSE that is
    // the end record, then Finishing and Available (05-state-machines.md §7.2, 04-flows.md §6).
    expect(captured.map((c) => `${c.action}:${c.messageType}`)).toEqual([
      `${OsppAction.METER_VALUES}:${MessageType.EVENT}`,
      `${OsppAction.STOP_SERVICE}:${MessageType.RESPONSE}`,
      `${OsppAction.STATUS_NOTIFICATION}:${MessageType.EVENT}`,
      `${OsppAction.STATUS_NOTIFICATION}:${MessageType.EVENT}`,
    ]);
    expect(captured.slice(2).map((c) => c.payload)).toEqual([
      expect.objectContaining({ status: BayStatus.FINISHING, previousStatus: BayStatus.OCCUPIED }),
      expect.objectContaining({ status: BayStatus.AVAILABLE, previousStatus: BayStatus.FINISHING }),
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
    const payload = response!.payload as AcceptedStopService;
    expect(payload.actualDurationSeconds).toBe(60);
    expect(payload.creditsCharged).toBe(100);
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
    const payload = response!.payload as AcceptedStopService;
    expect(payload.actualDurationSeconds).toBe(75);
    expect(payload.creditsCharged).toBe(125);
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
    const payload = response!.payload as AcceptedStopService;
    expect(payload.creditsCharged).toBe(10);
  });
});
