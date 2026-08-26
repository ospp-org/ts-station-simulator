import { describe, it, expect } from 'vitest';
import {
  computeMac,
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import { WaitForStep } from '../../../scenarios/steps/WaitForStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import { MessageRouter } from '../../../mqtt/MessageRouter.js';
import type { Station } from '../../../station/Station.js';
import { conformantPayloadFor } from '../../helpers/conformantPayloads.js';

/*
 * `expect_silence: true` asserts an ABSENCE, which is the only wire-observable
 * csms-server offers for a whole class of refusals. Its inbound-MAC gate is the
 * case that forced it: every branch in VerifyIncomingMiddleware.php ends in
 * rejected(), MessageDispatcher.php:169 then returns null, and nothing is
 * published back — so a station sees only that its REQUEST is never answered.
 *
 * An absence is easy to satisfy for the wrong reason, so the two properties
 * worth pinning are: it FAILS when something does arrive (including something
 * already buffered), and it releases its correlation so the CONTROL message
 * that follows can be matched — the control being what makes the silence
 * attributable to a refusal rather than to a dead link.
 */

const TEST_SESSION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

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
    // Real minimal shape, not `{}`: the router refuses a non-conformant inbound
    // payload, so a `{}` Heartbeat Response would never reach the wait at all.
    payload: conformantPayloadFor(action, messageType),
  };
}

function makeMockStation(): { station: Station; router: MessageRouter } {
  const router = new MessageRouter(() => TEST_SESSION_KEY);
  return { station: { router } as unknown as Station, router };
}

function publish(router: MessageRouter, env: OsppEnvelope): void {
  router.route(
    'test/topic',
    Buffer.from(JSON.stringify({ ...env, mac: computeMac(TEST_SESSION_KEY, env) })),
  );
}

describe('WaitForStep — expect_silence', () => {
  const step = new WaitForStep();

  it('passes when nothing arrives before the timeout', async () => {
    const { station } = makeMockStation();
    const ctx = createContext();

    await expect(
      step.execute(
        {
          action: 'wait_for',
          message: 'Heartbeat',
          messageType: 'Response',
          timeout_ms: 120,
          expect_silence: true,
        },
        ctx,
        station,
      ),
    ).resolves.toBeUndefined();

    // Nothing was received, so nothing is recorded — a later assert step must not
    // be able to read a message off this one.
    expect(ctx.receivedMessages).toHaveLength(0);
  });

  it('FAILS when the message it expected not to see arrives during the window', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    setTimeout(() => {
      publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'hb-1'));
    }, 20);

    await expect(
      step.execute(
        {
          action: 'wait_for',
          message: 'Heartbeat',
          messageType: 'Response',
          timeout_ms: 300,
          expect_silence: true,
        },
        ctx,
        station,
      ),
    ).rejects.toThrow(/expect_silence: expected no Heartbeat Response.*but one arrived/s);
  });

  it('FAILS on a message that was already buffered before the step ran', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    // The server answered before the step started. Draining this quietly would
    // let a message the server DID send satisfy "silence" — the exact hollow
    // proof this step must not produce.
    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'hb-early'));

    await expect(
      step.execute(
        {
          action: 'wait_for',
          message: 'Heartbeat',
          messageType: 'Response',
          timeout_ms: 120,
          expect_silence: true,
        },
        ctx,
        station,
      ),
    ).rejects.toThrow(/already buffered \(messageId=hb-early\)/);
  });

  it('releases its correlation so the CONTROL message that follows is matched', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    // The tampered send (refused, never answered) and the clean control send.
    ctx.sentMessages.push(
      makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'tampered', MessageSource.STATION),
    );
    ctx.sentMessages.push(
      makeEnvelope(OsppAction.HEARTBEAT, MessageType.REQUEST, 'control', MessageSource.STATION),
    );

    await step.execute(
      {
        action: 'wait_for',
        message: 'Heartbeat',
        messageType: 'Response',
        timeout_ms: 120,
        expect_silence: true,
      },
      ctx,
      station,
    );

    // Without the release, the next wait_for would re-target 'tampered' and time
    // out on a response the server will never send — the control would look
    // broken and the scenario would fail for the wrong reason.
    expect(ctx.consumedSentMessageIds.has('tampered')).toBe(true);

    publish(router, makeEnvelope(OsppAction.HEARTBEAT, MessageType.RESPONSE, 'control'));

    await step.execute(
      { action: 'wait_for', message: 'Heartbeat', messageType: 'Response', timeout_ms: 500 },
      ctx,
      station,
    );

    expect(ctx.receivedMessages).toHaveLength(1);
    expect(ctx.receivedMessages[0].messageId).toBe('control');
  });

  it('refuses capture: there is no message to capture from', async () => {
    const { station } = makeMockStation();
    const ctx = createContext();

    await expect(
      step.execute(
        {
          action: 'wait_for',
          message: 'Heartbeat',
          messageType: 'Response',
          timeout_ms: 120,
          expect_silence: true,
          capture: { anything: 'payload.x' },
        },
        ctx,
        station,
      ),
    ).rejects.toThrow(/"capture" is meaningless with "expect_silence: true"/);
  });

  it('leaves no listener behind after it resolves', async () => {
    const { station, router } = makeMockStation();
    const ctx = createContext();

    const before = router.listenerCount(OsppAction.HEARTBEAT);

    await step.execute(
      {
        action: 'wait_for',
        message: 'Heartbeat',
        messageType: 'Response',
        timeout_ms: 120,
        expect_silence: true,
      },
      ctx,
      station,
    );

    // A leaked listener would reject a LATER step's promise from a message that
    // step is legitimately waiting for.
    expect(router.listenerCount(OsppAction.HEARTBEAT)).toBe(before);
  });
});
