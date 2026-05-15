import { describe, it, expect } from 'vitest';
import { WaitForStep } from '../../../scenarios/steps/WaitForStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import { MessageRouter } from '../../../mqtt/MessageRouter.js';
import {
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { Station } from '../../../station/Station.js';

function makeEnvelope(
  action: OsppAction,
  messageType: MessageType,
  messageId: string,
  source: MessageSource = MessageSource.SERVER,
): OsppEnvelope {
  return {
    messageId,
    messageType,
    action,
    timestamp: new Date().toISOString(),
    source,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload: {},
  };
}

function makeMockStation(): { station: Station; router: MessageRouter } {
  const router = new MessageRouter();
  const station = { router } as unknown as Station;
  return { station, router };
}

function publish(router: MessageRouter, env: OsppEnvelope): void {
  router.route('test/topic', Buffer.from(JSON.stringify(env)));
}

describe('WaitForStep — Drift 7-E messageId correlation', () => {
  const step = new WaitForStep();

  it('matches the Response correlated to the just-sent Request (auto-correlation, buffered)', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    // Simulate an internal auto-Boot whose Response landed in the buffer
    // *before* the YAML's explicit Send. The Request was never recorded in
    // context.sentMessages, so its Response should NOT be matched.
    publish(router, makeEnvelope(OsppAction.BOOT_NOTIFICATION, MessageType.RESPONSE, 'stale-A'));

    // YAML's send: BootNotification Request — recorded in context.sentMessages.
    ctx.sentMessages.push(makeEnvelope(OsppAction.BOOT_NOTIFICATION, MessageType.REQUEST, 'req-B', MessageSource.STATION));

    // Server's correlated Response (echoes messageId).
    publish(router, makeEnvelope(OsppAction.BOOT_NOTIFICATION, MessageType.RESPONSE, 'req-B'));

    await step.execute(
      { action: 'wait_for', message: 'BootNotification', messageType: 'Response', timeout_ms: 200 },
      ctx,
      station,
    );

    expect(ctx.receivedMessages).toHaveLength(1);
    expect(ctx.receivedMessages[0].messageId).toBe('req-B');
    expect(ctx.consumedSentMessageIds.has('req-B')).toBe(true);

    // The stale-A Response remains in the router buffer — nothing claimed it.
    const leftover = router.drainBuffered(OsppAction.BOOT_NOTIFICATION, MessageType.RESPONSE);
    expect(leftover).toHaveLength(1);
    expect(leftover[0].messageId).toBe('stale-A');
  });

  it('two back-to-back Requests, Responses arrive reverse-order, each WaitFor matches its own', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    ctx.sentMessages.push(makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'hb-X', MessageSource.STATION));
    ctx.sentMessages.push(makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'hb-Y', MessageSource.STATION));

    // Reverse-order arrival: Y's Response first, then X's.
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'hb-Y'));
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'hb-X'));

    // First WaitFor — FIFO picks hb-X (first unconsumed sent Request).
    await step.execute(
      { action: 'wait_for', message: 'Heartbeat', messageType: 'Response', timeout_ms: 200 },
      ctx,
      station,
    );
    expect(ctx.receivedMessages[0].messageId).toBe('hb-X');
    expect(ctx.consumedSentMessageIds.has('hb-X')).toBe(true);

    // Second WaitFor — next unconsumed is hb-Y.
    await step.execute(
      { action: 'wait_for', message: 'Heartbeat', messageType: 'Response', timeout_ms: 200 },
      ctx,
      station,
    );
    expect(ctx.receivedMessages[1].messageId).toBe('hb-Y');
    expect(ctx.consumedSentMessageIds.has('hb-Y')).toBe(true);
  });

  it('resolves from live emit when the correlated Response arrives after the wait registers', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    ctx.sentMessages.push(makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'live-1', MessageSource.STATION));

    const waitPromise = step.execute(
      { action: 'wait_for', message: 'Heartbeat', messageType: 'Response', timeout_ms: 500 },
      ctx,
      station,
    );

    // A non-correlated Response arrives first — must not resolve the wait.
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'noise'));
    // Then the correlated one.
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'live-1'));

    await waitPromise;
    expect(ctx.receivedMessages).toHaveLength(1);
    expect(ctx.receivedMessages[0].messageId).toBe('live-1');
  });

  it('explicit YAML correlationId overrides auto-pick and does not consume sentMessages', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    ctx.sentMessages.push(makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'auto-id', MessageSource.STATION));
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'explicit-id'));

    await step.execute(
      {
        action: 'wait_for',
        message: 'Heartbeat',
        messageType: 'Response',
        correlationId: 'explicit-id',
        timeout_ms: 200,
      },
      ctx,
      station,
    );

    expect(ctx.receivedMessages[0].messageId).toBe('explicit-id');
    // auto-id stays unconsumed since explicit override was used.
    expect(ctx.consumedSentMessageIds.has('auto-id')).toBe(false);
  });

  it('Request waits keep first-match-wins (no auto-correlation when waiting for a Request)', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    // Pre-buffer a Request envelope (e.g. server-initiated GetDiagnostics).
    publish(router, makeEnvelope(OsppAction.GET_DIAGNOSTICS, MessageType.REQUEST, 'server-req-1'));

    await step.execute(
      { action: 'wait_for', message: 'GetDiagnostics', messageType: 'Request', timeout_ms: 200 },
      ctx,
      station,
    );

    expect(ctx.receivedMessages[0].messageId).toBe('server-req-1');
  });

  it('times out with a descriptive correlationId hint when the correlated Response never arrives', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    ctx.sentMessages.push(makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'missing', MessageSource.STATION));
    // Only a non-correlated Response is published.
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'other'));

    await expect(
      step.execute(
        { action: 'wait_for', message: 'Heartbeat', messageType: 'Response', timeout_ms: 100 },
        ctx,
        station,
      ),
    ).rejects.toThrow(/correlationId=missing/);
  });
});
