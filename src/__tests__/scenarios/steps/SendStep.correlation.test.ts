import { describe, it, expect } from 'vitest';
import { SendStep } from '../../../scenarios/steps/SendStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  createEnvelope,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { Station, SessionInfo } from '../../../station/Station.js';

interface CapturedSend {
  action: OsppAction;
  messageType: MessageType;
  payload: Record<string, unknown>;
  messageId: string;
}

function makeMockStation(): { station: Station; captured: CapturedSend[] } {
  const captured: CapturedSend[] = [];
  const sessions = new Map<string, SessionInfo>();
  const sender = {
    async send(
      action: OsppAction,
      messageType: MessageType,
      payload: Record<string, unknown>,
      correlationId?: string,
    ): Promise<OsppEnvelope> {
      const messageId = correlationId ?? 'no-id';
      captured.push({ action, messageType, payload, messageId });
      return createEnvelope({
        messageId,
        messageType,
        action,
        source: MessageSource.STATION,
        payload,
      });
    },
  };
  const station = { sender, sessions } as unknown as Station;
  return { station, captured };
}

function makeReceivedRequest(action: OsppAction, messageId: string): OsppEnvelope {
  return {
    messageId,
    messageType: MessageType.REQUEST,
    action,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {},
  };
}

describe('SendStep — Response auto-correlation (mirror of WaitForStep)', () => {
  const step = new SendStep();

  it('Response without explicit correlationId echoes the most recent received Request messageId', async () => {
    const { station, captured } = makeMockStation();
    const ctx = createContext();
    ctx.receivedMessages.push(makeReceivedRequest(OsppAction.START_SERVICE, 'srv-req-A'));

    await step.execute(
      { action: 'send', message: 'StartService', messageType: 'Response', payload: { status: 'Accepted' } },
      ctx,
      station,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].messageId).toBe('srv-req-A');
    expect(ctx.consumedReceivedMessageIds.has('srv-req-A')).toBe(true);
  });

  it('Request keeps a freshly generated UUID (no behavior change vs pre-fix)', async () => {
    const { station, captured } = makeMockStation();
    const ctx = createContext();
    // Receiving a Request must NOT influence the next outbound Request (only Responses correlate).
    ctx.receivedMessages.push(makeReceivedRequest(OsppAction.START_SERVICE, 'srv-req-A'));

    await step.execute(
      {
        action: 'send',
        message: 'BootNotification',
        messageType: 'Request',
        payload: {
          stationId: 'stn_abcdef0123456789',
          firmwareVersion: '1.0.0',
          stationModel: 'Test',
          stationVendor: 'Test',
          serialNumber: 'SN-test',
          bayCount: 1,
        },
      },
      ctx,
      station,
    );

    expect(captured).toHaveLength(1);
    // Auto-generated UUID v4 shape — NOT 'srv-req-A'
    expect(captured[0].messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured[0].messageId).not.toBe('srv-req-A');
    // The received Request stays unclaimed since this was a Request send.
    expect(ctx.consumedReceivedMessageIds.has('srv-req-A')).toBe(false);
  });

  it('back-to-back received Requests, each Response claims its own (FIFO)', async () => {
    const { station, captured } = makeMockStation();
    const ctx = createContext();
    // Two inbound StartService Requests in arrival order.
    ctx.receivedMessages.push(makeReceivedRequest(OsppAction.START_SERVICE, 'srv-1'));
    ctx.receivedMessages.push(makeReceivedRequest(OsppAction.START_SERVICE, 'srv-2'));

    // Two Responses — reverse-scan picks the most-recent unclaimed each time,
    // which means: 1st Response → srv-2, 2nd Response → srv-1.
    await step.execute(
      { action: 'send', message: 'StartService', messageType: 'Response', payload: { status: 'Accepted' } },
      ctx,
      station,
    );
    await step.execute(
      { action: 'send', message: 'StartService', messageType: 'Response', payload: { status: 'Accepted' } },
      ctx,
      station,
    );

    expect(captured.map((c) => c.messageId)).toEqual(['srv-2', 'srv-1']);
    expect(ctx.consumedReceivedMessageIds.has('srv-1')).toBe(true);
    expect(ctx.consumedReceivedMessageIds.has('srv-2')).toBe(true);
  });

  it('explicit correlationId on YAML step wins over auto-correlation', async () => {
    const { station, captured } = makeMockStation();
    const ctx = createContext();
    ctx.receivedMessages.push(makeReceivedRequest(OsppAction.START_SERVICE, 'srv-auto'));

    await step.execute(
      {
        action: 'send',
        message: 'StartService',
        messageType: 'Response',
        correlationId: 'explicit-from-yaml',
        payload: { status: 'Accepted' },
      },
      ctx,
      station,
    );

    expect(captured[0].messageId).toBe('explicit-from-yaml');
    // Explicit choice MUST NOT consume the inbound — operator's intent is overriding.
    expect(ctx.consumedReceivedMessageIds.has('srv-auto')).toBe(false);
  });

  it('Response without any matching received Request falls back to fresh UUID', async () => {
    const { station, captured } = makeMockStation();
    const ctx = createContext();
    // No inbound Requests at all — Response correlation has nothing to claim.

    await step.execute(
      { action: 'send', message: 'StartService', messageType: 'Response', payload: { status: 'Accepted' } },
      ctx,
      station,
    );

    expect(captured[0].messageId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
