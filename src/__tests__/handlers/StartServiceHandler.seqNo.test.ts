import { describe, it, expect } from 'vitest';
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

function makeMockStation(): { station: StationContext; sessions: Map<string, SessionInfo> } {
  const sessions = new Map<string, SessionInfo>();
  let bayState = BayStatus.AVAILABLE;

  const station = {
    config: {
      bays: [
        {
          bayId: 'bay_test',
          bayNumber: 1,
          services: [{ serviceId: 'svc_test', serviceName: 'Wash', available: true }],
        },
      ],
      behavior: { acceptRate: 1.0 },
    },
    sender: {
      async send(): Promise<void> {
        // no-op for test
      },
    },
    sessions,
    reservations: new Map(),
    currentRevocationEpoch: 0,
    getBayState: () => bayState,
    setBayState: (_bayId: string, status: BayStatus) => {
      bayState = status;
    },
  } as unknown as StationContext;

  return { station, sessions };
}

function makeEnvelope(): OsppEnvelope {
  return {
    messageId: 'msg-test',
    messageType: MessageType.REQUEST,
    action: OsppAction.START_SERVICE,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {
      sessionId: 'sess_test',
      bayId: 'bay_test',
      serviceId: 'svc_test',
      durationSeconds: 300,
      sessionSource: 'MobileApp',
    },
  };
}

describe('StartServiceHandler — v0.4.0 SessionInfo.seqNo init', () => {
  it('initialises new session with seqNo: 0', async () => {
    const { station, sessions } = makeMockStation();
    const handler = new StartServiceHandler();

    await handler.handle(makeEnvelope(), station);

    const session = sessions.get('sess_test');
    expect(session).toBeDefined();
    expect(session!.seqNo).toBe(0);
  });
});
