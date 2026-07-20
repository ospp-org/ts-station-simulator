import { describe, it, expect } from 'vitest';
import { AssertStep } from '../../../scenarios/steps/AssertStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';
import type { SeveranceState } from '../../../mqtt/MqttConnection.js';
import type { OsppEnvelope } from '@ospp/protocol';
import { OsppAction, MessageType, MessageSource, OSPP_PROTOCOL_VERSION } from '@ospp/protocol';

function makeContext(receivedMessage: OsppEnvelope): ScenarioContext {
  const ctx = createContext();
  ctx.receivedMessages.push(receivedMessage);
  return ctx;
}

function makeEnvelope(payload: unknown): OsppEnvelope {
  return {
    messageId: 'msg-test',
    messageType: MessageType.RESPONSE,
    action: OsppAction.BOOT_NOTIFICATION,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload,
  };
}

// AssertStep.execute requires a Station parameter but never uses it.
// We pass null and cast to satisfy the type without instantiating Station.
const nullStation = null as never;

describe('AssertStep', () => {
  const step = new AssertStep();

  it('passes when field equals expected value', async () => {
    const ctx = makeContext(makeEnvelope({ status: 'Accepted' }));
    await expect(
      step.execute(
        { action: 'assert', field: 'payload.status', equals: 'Accepted' },
        ctx,
        nullStation,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails when field does not match', async () => {
    const ctx = makeContext(makeEnvelope({ status: 'Rejected' }));
    await expect(
      step.execute(
        { action: 'assert', field: 'payload.status', equals: 'Accepted' },
        ctx,
        nullStation,
      ),
    ).rejects.toThrow('Assertion failed');
  });

  it('supports nested field paths (e.g., "payload.status")', async () => {
    const ctx = makeContext(
      makeEnvelope({ data: { nested: { value: 42 } } }),
    );
    await expect(
      step.execute(
        { action: 'assert', field: 'payload.data.nested.value', equals: 42 },
        ctx,
        nullStation,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails for deeply nested path when value differs', async () => {
    const ctx = makeContext(
      makeEnvelope({ data: { nested: { value: 99 } } }),
    );
    await expect(
      step.execute(
        { action: 'assert', field: 'payload.data.nested.value', equals: 42 },
        ctx,
        nullStation,
      ),
    ).rejects.toThrow('Assertion failed');
  });
});

// C3 TLS-1.2-floor arc: a scenario must be able to assert the negotiated
// TLS protocol version (S1/S2) — a transport-level property with no
// "received message" to read it off. `field: "connection.*"` reads off the
// live Station/MqttConnection instead of context.receivedMessages.
describe('AssertStep — "connection.*" transport-level assertions', () => {
  const step = new AssertStep();

  function makeStationStub(
    tlsProtocol: string | null,
    severance: Partial<SeveranceState> = {},
  ): Station {
    // `connection.*` resolves against BOTH the negotiated TLS version and the
    // severance state (ADR-0004 TIER 1), so the stub must supply both.
    const fullSeverance: SeveranceState = {
      lastCloseCause: 'none',
      kicked: false,
      kickReasonCode: null,
      reconnectRefused: false,
      refusalReasonCode: null,
      ...severance,
    };
    return {
      getNegotiatedTlsProtocol: () => tlsProtocol,
      getSeverance: () => fullSeverance,
    } as unknown as Station;
  }

  it('reads connection.tlsProtocol off station.getNegotiatedTlsProtocol(), not the last message', async () => {
    const ctx = createContext(); // no receivedMessages pushed — would throw if AssertStep fell back to the message path
    const station = makeStationStub('TLSv1.2');
    await expect(
      step.execute(
        { action: 'assert', field: 'connection.tlsProtocol', equals: 'TLSv1.2' },
        ctx,
        station,
      ),
    ).resolves.toBeUndefined();
  });

  it('fails when the negotiated protocol does not match', async () => {
    const ctx = createContext();
    const station = makeStationStub('TLSv1.2');
    await expect(
      step.execute(
        { action: 'assert', field: 'connection.tlsProtocol', equals: 'TLSv1.3' },
        ctx,
        station,
      ),
    ).rejects.toThrow('Assertion failed');
  });

  it('asserts connection.kicked — a scenario can pin the broker-initiated sever', async () => {
    const ctx = createContext();
    const station = makeStationStub('TLSv1.2', {
      lastCloseCause: 'broker-kick',
      kicked: true,
      kickReasonCode: 0x98,
    });
    await expect(
      step.execute({ action: 'assert', field: 'connection.kicked', equals: true }, ctx, station),
    ).resolves.toBeUndefined();
    await expect(
      step.execute(
        { action: 'assert', field: 'connection.lastCloseCause', equals: 'broker-kick' },
        ctx,
        station,
      ),
    ).resolves.toBeUndefined();
  });

  it('a self-closed station FAILS a connection.kicked assertion (kick is not just "closed")', async () => {
    const ctx = createContext();
    const station = makeStationStub('TLSv1.2', { lastCloseCause: 'self', kicked: false });
    await expect(
      step.execute({ action: 'assert', field: 'connection.kicked', equals: true }, ctx, station),
    ).rejects.toThrow('Assertion failed');
  });

  it('asserts connection.reconnectRefused — the ban half of the TIER 1 proof', async () => {
    const ctx = createContext();
    const station = makeStationStub('TLSv1.2', {
      reconnectRefused: true,
      refusalReasonCode: 0x87,
    });
    await expect(
      step.execute(
        { action: 'assert', field: 'connection.reconnectRefused', equals: true },
        ctx,
        station,
      ),
    ).resolves.toBeUndefined();
    await expect(
      step.execute(
        { action: 'assert', field: 'connection.refusalReasonCode', equals: 0x87 },
        ctx,
        station,
      ),
    ).resolves.toBeUndefined();
  });

  it('works with no prior receivedMessages at all (pure transport-layer check, S2 shape)', async () => {
    const ctx = createContext();
    expect(ctx.receivedMessages).toHaveLength(0);
    const station = makeStationStub('TLSv1.3');
    await expect(
      step.execute(
        { action: 'assert', field: 'connection.tlsProtocol', equals: 'TLSv1.3' },
        ctx,
        station,
      ),
    ).resolves.toBeUndefined();
  });
});
