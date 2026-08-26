import { describe, it, expect } from 'vitest';
import { WaitForStep } from '../../../scenarios/steps/WaitForStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import { MessageRouter } from '../../../mqtt/MessageRouter.js';
import {
  computeMac,
  OsppAction,
  MessageType,
  MessageSource,
  OSPP_PROTOCOL_VERSION,
  type OsppEnvelope,
} from '@ospp/protocol';
import type { Station } from '../../../station/Station.js';

/**
 * THE TRAP THE INBOUND GATE OPENS, CLOSED.
 *
 * `expect_silence` passes when nothing matching is DELIVERED. In `strict` mode a
 * non-conformant message is not delivered — so a server that answered with a
 * malformed message would make a silence proof pass, and pass for the single
 * reason it must never pass for: the server DID answer, and the answer was
 * broken.
 *
 * There are six silence controls in the scenario corpus. Arming the schema gate
 * without this guard would have converted every one of them into a proof that
 * cannot distinguish "the server correctly said nothing" from "the server said
 * something invalid". That is a strictly worse instrument than the one that
 * existed before the gate, and the failure would have been invisible: green.
 */
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function envelope(payload: unknown, messageId = 'hb-bad'): OsppEnvelope {
  return {
    messageId,
    messageType: MessageType.RESPONSE,
    action: OsppAction.HEARTBEAT,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload,
  } as OsppEnvelope;
}

function publish(router: MessageRouter, env: OsppEnvelope): void {
  router.route('to-station', Buffer.from(JSON.stringify({ ...env, mac: computeMac(KEY, env) })));
}

function stationWith(mode: 'strict' | 'warn'): { station: Station; router: MessageRouter } {
  const router = new MessageRouter(() => KEY, { schemaMode: mode });
  return { station: { router } as unknown as Station, router };
}

const silenceStep = {
  action: 'wait_for',
  message: 'Heartbeat',
  messageType: 'Response',
  timeout_ms: 150,
  expect_silence: true,
};

describe('expect_silence cannot be satisfied by a REFUSED message', () => {
  it('FAILS when a matching message arrived and was refused for its schema', async () => {
    const { station, router } = stationWith('strict');
    const ctx = createContext();

    setTimeout(() => {
      // A Heartbeat Response missing its required `serverTime`. Strict mode
      // withholds it, so without the guard this step would see pure silence.
      publish(router, envelope({}));
    }, 20);

    await expect(new WaitForStep().execute(silenceStep, ctx, station)).rejects.toThrow(
      /none was DELIVERED.*REFUSED as non-conformant/s,
    );
  });

  it('still PASSES on real silence — the guard did not just break the step', async () => {
    const { station } = stationWith('strict');
    const ctx = createContext();

    await expect(
      new WaitForStep().execute(silenceStep, ctx, station),
    ).resolves.toBeUndefined();
  });

  it('a refusal for a DIFFERENT action does not fail this step', async () => {
    // Attribution has to be narrow, or the guard becomes a source of false reds
    // in any scenario where anything else on the connection was malformed.
    const { station, router } = stationWith('strict');
    const ctx = createContext();

    setTimeout(() => {
      publish(router, {
        ...envelope({ nope: true }, 'reset-bad'),
        action: OsppAction.RESET,
        messageType: MessageType.REQUEST,
      } as OsppEnvelope);
    }, 20);

    await expect(
      new WaitForStep().execute(silenceStep, ctx, station),
    ).resolves.toBeUndefined();
  });

  it('a refusal recorded BEFORE the step began is not attributed to it', async () => {
    const { station, router } = stationWith('strict');
    const ctx = createContext();

    // Earlier in the scenario, already logged. The step must judge only what
    // happened inside its own window; the router's log spans the whole station.
    publish(router, envelope({}, 'hb-earlier'));
    expect(router.schemaViolations).toHaveLength(1);

    await expect(
      new WaitForStep().execute(silenceStep, ctx, station),
    ).resolves.toBeUndefined();
  });

  it('in warn mode the message is delivered, so the step fails as an ARRIVAL', async () => {
    // Same defect, different mode, and the failure must name what actually
    // happened: warn delivers, so this is "one arrived", not "one was refused".
    const { station, router } = stationWith('warn');
    const ctx = createContext();

    setTimeout(() => {
      publish(router, envelope({}));
    }, 20);

    await expect(new WaitForStep().execute(silenceStep, ctx, station)).rejects.toThrow(
      /but one arrived/,
    );
  });
});
