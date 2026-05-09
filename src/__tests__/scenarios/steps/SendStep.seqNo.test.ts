import { describe, it, expect } from 'vitest';
import { SendStep } from '../../../scenarios/steps/SendStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  createEnvelope,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { Station, SessionInfo } from '../../../station/Station.js';

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: Record<string, unknown>;
}

function makeMockStation(): { station: Station; captured: CapturedSend[]; session: SessionInfo } {
  const captured: CapturedSend[] = [];
  const session: SessionInfo = {
    sessionId: 'sess_test',
    bayId: 'bay_test',
    serviceId: 'svc_test',
    startedAt: new Date(),
    durationSeconds: 300,
    seqNo: 0,
  };

  const sessions = new Map<string, SessionInfo>([[session.sessionId, session]]);

  const sender = {
    async send(
      action: OsppAction,
      messageType: MessageType,
      payload: Record<string, unknown>,
      correlationId?: string,
    ): Promise<OsppEnvelope> {
      captured.push({ action, messageType, payload });
      return createEnvelope({
        messageId: correlationId ?? 'msg-test',
        messageType,
        action,
        source: MessageSource.STATION,
        payload,
      });
    },
  };

  const station = { sender, sessions } as unknown as Station;
  return { station, captured, session };
}

describe('SendStep — v0.4.0 seqNo/finalSeqNo auto-injection', () => {
  const step = new SendStep();

  it('MeterValues Event: stamps session.seqNo and advances counter', async () => {
    const { station, captured, session } = makeMockStation();
    const ctx = createContext();

    for (let i = 0; i < 3; i++) {
      await step.execute(
        {
          action: 'send',
          message: 'MeterValues',
          messageType: 'Event',
          payload: { sessionId: 'sess_test', bayId: 'bay_test', timestamp: '2026-05-09T00:00:00Z', values: { liquidMl: 100 } },
        },
        ctx,
        station,
      );
    }

    expect(captured[0].payload.seqNo).toBe(0);
    expect(captured[1].payload.seqNo).toBe(1);
    expect(captured[2].payload.seqNo).toBe(2);
    expect(session.seqNo).toBe(3);
  });

  it('SessionEnded Event: stamps current seqNo + finalSeqNo without advancing', async () => {
    const { station, captured, session } = makeMockStation();
    session.seqNo = 5;
    const ctx = createContext();

    await step.execute(
      {
        action: 'send',
        message: 'SessionEnded',
        messageType: 'Event',
        payload: { sessionId: 'sess_test', bayId: 'bay_test', reason: 'Local', actualDurationSeconds: 60, creditsCharged: 100 },
      },
      ctx,
      station,
    );

    expect(captured[0].payload.seqNo).toBe(5);
    expect(captured[0].payload.finalSeqNo).toBe(5);
    expect(session.seqNo).toBe(5);
  });

  it('StopService Accepted Response: stamps finalSeqNo from session counter', async () => {
    const { station, captured, session } = makeMockStation();
    session.seqNo = 7;
    const ctx = createContext();

    await step.execute(
      {
        action: 'send',
        message: 'StopService',
        messageType: 'Response',
        payload: { sessionId: 'sess_test', status: 'Accepted', actualDurationSeconds: 60, creditsCharged: 100 },
      },
      ctx,
      station,
    );

    expect(captured[0].payload.finalSeqNo).toBe(7);
  });

  it('explicit YAML seqNo overrides auto-injection (negative test for late MeterValues)', async () => {
    const { station, captured, session } = makeMockStation();
    session.seqNo = 3;
    const ctx = createContext();

    await step.execute(
      {
        action: 'send',
        message: 'MeterValues',
        messageType: 'Event',
        payload: { sessionId: 'sess_test', bayId: 'bay_test', timestamp: '2026-05-09T00:00:00Z', values: { liquidMl: 100 }, seqNo: 99 },
      },
      ctx,
      station,
    );

    expect(captured[0].payload.seqNo).toBe(99);
    expect(session.seqNo).toBe(100);
  });

  it('no-op when sessionId is unknown to station.sessions', async () => {
    const { station, captured } = makeMockStation();
    const ctx = createContext();

    await step.execute(
      {
        action: 'send',
        message: 'MeterValues',
        messageType: 'Event',
        payload: { sessionId: 'sess_unknown', bayId: 'bay_test', timestamp: '2026-05-09T00:00:00Z', values: { liquidMl: 100 } },
      },
      ctx,
      station,
    );

    expect(captured[0].payload.seqNo).toBeUndefined();
  });
});
