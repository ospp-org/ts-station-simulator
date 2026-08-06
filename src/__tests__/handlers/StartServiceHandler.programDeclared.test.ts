import { describe, it, expect } from 'vitest';
import { StartServiceHandler } from '../../handlers/StartServiceHandler.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  BayStatus,
  OsppErrorCode,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';

// ---------------------------------------------------------------------------
// spec v0.11.0 start-service-request.schema.json, `programNumber`:
//
//   "The station MUST verify the ordinal was declared for that bay and, if it
//    was not, MUST reject with 3017 PROGRAM_NOT_DECLARED — never accept and do
//    nothing, which is a customer who paid and got no wash."
//
// The station did not verify it. StartServiceHandler echoed `programNumber` back
// in every OTHER rejection — bay, service, duration, reservation — so the field
// looked handled, and the one check the spec makes a MUST was the one missing.
//
// "Never accept and do nothing" is the failure this closes. Before it, a server
// binding naming an ordinal this bay does not have was ACCEPTED: the session
// started, the meter ran, the customer was charged, and no hardware moved.
// ---------------------------------------------------------------------------

interface Sent {
  action: string;
  payload: Record<string, unknown>;
}

function makeStation(programs: number[]): { station: StationContext; sent: Sent[]; sessions: Map<string, SessionInfo> } {
  const sent: Sent[] = [];
  const sessions = new Map<string, SessionInfo>();
  let bayState = BayStatus.AVAILABLE;

  const station = {
    config: {
      bays: [
        {
          bayId: 'bay_test',
          bayNumber: 1,
          programs: programs.map(n => ({ programNumber: n, label: `P${n}`, available: true })),
          services: [{ serviceId: 'svc_test', serviceName: 'Wash', available: true }],
        },
      ],
      behavior: { acceptRate: 1.0 },
    },
    sender: {
      async send(action: string, _t: unknown, payload: Record<string, unknown>): Promise<void> {
        sent.push({ action, payload });
      },
    },
    sessions,
    reservations: new Map(),
    currentRevocationEpoch: 0,
    getBayState: () => bayState,
    setBayState: (_b: string, s: BayStatus) => { bayState = s; },
  } as unknown as StationContext;

  return { station, sent, sessions };
}

function envelope(programNumber?: number): OsppEnvelope {
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
      ...(programNumber === undefined ? {} : { programNumber }),
    },
  } as unknown as OsppEnvelope;
}

describe('StartServiceHandler — the station verifies the ordinal it was sent', () => {
  it('rejects 3017 for an ordinal this bay never declared, echoing it back', async () => {
    const { station, sent, sessions } = makeStation([1, 3]);

    await new StartServiceHandler().handle(envelope(9), station);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.status).toBe('Rejected');
    expect(sent[0].payload.errorCode).toBe(OsppErrorCode.PROGRAM_NOT_DECLARED);
    // REQUIRED when Rejected (start-service-response.schema.json:30) — and the
    // whole point of the echo is that an operator reads which ordinal was wrong
    // without correlating back to the request.
    expect(sent[0].payload.programNumber).toBe(9);
    // "never accept and do nothing" — no session may exist.
    expect(sessions.size).toBe(0);
  });

  it('accepts an ordinal this bay DID declare', async () => {
    // Without this the rejection above proves only that the handler refuses, not
    // that it refuses the right thing.
    const { station, sent, sessions } = makeStation([1, 3]);

    await new StartServiceHandler().handle(envelope(3), station);

    expect(sent[0].payload.status).toBe('Accepted');
    expect(sessions.size).toBe(1);
  });

  it('the check is PER BAY, not against the union of the station', async () => {
    // A station-wide "does any bay have program 3" check passes the test above
    // and is wrong: it starts the wrong hardware on this bay.
    const { station, sent } = makeStation([1]);
    (station.config.bays as unknown[]).push({
      bayId: 'bay_other',
      bayNumber: 3,
      programs: [{ programNumber: 9, label: 'P9', available: true }],
      services: [{ serviceId: 'svc_test', serviceName: 'Wash', available: true }],
    });

    await new StartServiceHandler().handle(envelope(9), station);

    expect(sent[0].payload.errorCode).toBe(OsppErrorCode.PROGRAM_NOT_DECLARED);
  });

  it('a program declared but UNAVAILABLE is not a 3017', async () => {
    // 3017 means "this bay does not have that program". A program that is
    // present-but-broken is a different fault with a different remedy, and
    // conflating them sends an operator to correct a binding that is correct.
    const { station, sent } = makeStation([1, 3]);
    (station.config.bays[0].programs[1] as { available: boolean }).available = false;

    await new StartServiceHandler().handle(envelope(3), station);

    expect(sent[0].payload.errorCode).not.toBe(OsppErrorCode.PROGRAM_NOT_DECLARED);
  });

  it('an ABSENT programNumber is refused, not silently defaulted', async () => {
    // programNumber is REQUIRED. A station that defaults a missing ordinal to 1
    // runs whatever program 1 happens to be — the "charges for one thing and
    // delivers another" that 3017's recommended action rules out in terms.
    const { station, sent, sessions } = makeStation([1, 3]);

    await new StartServiceHandler().handle(envelope(undefined), station);

    expect(sent[0].payload.status).toBe('Rejected');
    expect(sessions.size).toBe(0);
  });
});
