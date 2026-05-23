import { describe, it, expect } from 'vitest';
import { StopServiceHandler } from '../../handlers/StopServiceHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  SessionEndReason,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
  type StopServiceResponse,
  type SessionEndedPayload,
} from '@ospp/protocol';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';

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
        seqNo: seqNoAtStop,
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

  it('SessionEnded event carries seqNo + finalSeqNo from session.seqNo', async () => {
    const { station, captured } = makeMockStation(12);
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    const event = captured.find(
      (c) => c.action === OsppAction.SESSION_ENDED && c.messageType === MessageType.EVENT,
    );
    expect(event).toBeDefined();
    const payload = event!.payload as SessionEndedPayload;
    expect(payload.reason).toBe(SessionEndReason.TIMER_EXPIRED);
    expect((payload as { seqNo?: number }).seqNo).toBe(12);
    expect((payload as { finalSeqNo?: number }).finalSeqNo).toBe(12);
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

  it('SessionEnded event creditsCharged matches StopService Response creditsCharged', async () => {
    const { station, captured } = makeMockStation(1, {
      startedAtOffsetMs: 60_000,
      priceCreditsPerMinute: 100,
    });
    const handler = new StopServiceHandler();

    await handler.handle(makeStopServiceRequest(), station);

    const response = captured.find(
      (c) => c.action === OsppAction.STOP_SERVICE && c.messageType === MessageType.RESPONSE,
    );
    const event = captured.find(
      (c) => c.action === OsppAction.SESSION_ENDED && c.messageType === MessageType.EVENT,
    );
    const responsePayload = response!.payload as StopServiceResponse;
    const eventPayload = event!.payload as SessionEndedPayload;
    expect((eventPayload as { creditsCharged?: number }).creditsCharged).toBe(
      (responsePayload as { creditsCharged?: number }).creditsCharged,
    );
    expect((eventPayload as { creditsCharged?: number }).creditsCharged).toBe(100);
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
