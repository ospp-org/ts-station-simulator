import { describe, it, expect } from 'vitest';
import { ResetHandler } from '../../handlers/ResetHandler.js';
import {
  OsppAction, MessageType, MessageSource, OsppErrorCode,
  OSPP_PROTOCOL_VERSION, type OsppEnvelope,
} from '@ospp/protocol';
import type { StationContext, SessionInfo } from '../../handlers/Handler.js';

// ---------------------------------------------------------------------------
// spec v0.11.0 reset-request.schema.json, `force`:
//
//   "Omitted or false: the station REFUSES if any bay has an active session,
//    answering 3016 ACTIVE_SESSIONS_PRESENT … True: the station settles every
//    active session under the operator-disable policy FIRST — the session is
//    stopped, metered and reported exactly as an operator-initiated stop, so the
//    customer is billed for what they received — and only then reboots. Force is
//    not a licence to drop a session on the floor; it is a licence to end it
//    without waiting."
//
// The handler refused 3016 whenever `station.sessions.size > 0`, UNCONDITIONALLY,
// and read `force` only afterwards — on the path that a running session can never
// reach. So `force: true` did nothing in the one situation it exists for, and the
// only thing it changed was a reboot delay.
//
// Found on a live wire: an operator forcing a reset on a station mid-wash got
// the same refusal as an unforced one.
// ---------------------------------------------------------------------------

interface Sent { payload: Record<string, unknown> }

function makeStation(sessionCount: number): {
  station: StationContext; sent: Sent[]; sessions: Map<string, SessionInfo>; stopped: string[];
} {
  const sent: Sent[] = [];
  const stopped: string[] = [];
  const sessions = new Map<string, SessionInfo>();
  for (let i = 0; i < sessionCount; i++) {
    sessions.set(`sess_${i}`, { sessionId: `sess_${i}`, bayId: `bay_${i}`, seqNo: 0 } as unknown as SessionInfo);
  }

  const station = {
    sessions,
    sender: { async send(_a: string, _t: unknown, payload: Record<string, unknown>): Promise<void> { sent.push({ payload }); } },
    stopHeartbeat: () => {},
    destroyConnection: () => {},
    settleSessionAsOperatorStop: async (id: string) => { stopped.push(id); sessions.delete(id); },
  } as unknown as StationContext;

  return { station, sent, sessions, stopped };
}

function envelope(force?: boolean): OsppEnvelope {
  return {
    messageId: 'msg-reset', messageType: MessageType.REQUEST, action: OsppAction.RESET,
    timestamp: new Date().toISOString(), source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: force === undefined ? {} : { force },
  } as unknown as OsppEnvelope;
}

describe('ResetHandler — force is what it does to a RUNNING session', () => {
  it('unforced with a session running: 3016, and no reboot', async () => {
    const { station, sent, sessions } = makeStation(1);

    await new ResetHandler().handle(envelope(false), station);

    expect(sent[0].payload.status).toBe('Rejected');
    expect(sent[0].payload.errorCode).toBe(OsppErrorCode.ACTIVE_SESSIONS_PRESENT);
    expect(sessions.size).toBe(1);
  });

  it('OMITTED is the same as false — the schema default', async () => {
    const { station, sent } = makeStation(1);

    await new ResetHandler().handle(envelope(undefined), station);

    expect(sent[0].payload.errorCode).toBe(OsppErrorCode.ACTIVE_SESSIONS_PRESENT);
  });

  it('FORCED with a session running: accepted, and the session is SETTLED first', async () => {
    // "not a licence to drop a session on the floor" — the customer is billed for
    // what they received, so the session must be settled as an operator stop
    // BEFORE the reboot, not abandoned by it.
    const { station, sent, sessions, stopped } = makeStation(2);

    await new ResetHandler().handle(envelope(true), station);

    expect(sent[0].payload.status).toBe('Accepted');
    expect(stopped.sort()).toEqual(['sess_0', 'sess_1']);
    expect(sessions.size).toBe(0);
  });

  it('forced with NO session running is still accepted', async () => {
    // Force is not conditional on there being something to force.
    const { station, sent } = makeStation(0);

    await new ResetHandler().handle(envelope(true), station);

    expect(sent[0].payload.status).toBe('Accepted');
  });

  it('unforced with no session running is accepted', async () => {
    const { station, sent } = makeStation(0);

    await new ResetHandler().handle(envelope(false), station);

    expect(sent[0].payload.status).toBe('Accepted');
  });
});
