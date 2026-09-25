import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

/*
 * A REFUSED GetDiagnostics IS ATTRIBUTED WITH ITS PAYLOAD, MINUS THE UPLOAD TOKEN.
 *
 * When the inbound schema gate withholds a message, the `wait_for` that expected it fails with
 * the schema errors and the payload, so the report names the server defect instead of blaming
 * the clock. That failure text lands on the console, in the JSON report and in the JUnit XML —
 * three copies of whatever the payload held. For a GetDiagnostics Request that is an uploadUrl
 * whose last path segment is a single-use upload token.
 *
 * The control pins that a refusal of any other payload is rendered exactly as before.
 */

const TOKEN = 'abc123SECRET';
const PLATFORM_URL = `https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/${TOKEN}`;
const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function publish(router: MessageRouter, action: OsppAction, messageType: MessageType, payload: unknown): void {
  const env = {
    messageId: 'refused-0001',
    messageType,
    action,
    timestamp: new Date().toISOString(),
    source: MessageSource.SERVER,
    protocolVersion: OSPP_PROTOCOL_VERSION,
    payload,
  } as OsppEnvelope;
  router.route(
    'to-station',
    Buffer.from(JSON.stringify({ ...env, mac: computeMac(KEY, env as unknown as Record<string, unknown>) })),
  );
}

/** Runs the step to its timeout and returns the failure text; a pass is itself a failure here. */
async function failureOf(
  message: string,
  messageType: string,
  arrive: (router: MessageRouter) => void,
): Promise<string> {
  const router = new MessageRouter(() => KEY, { schemaMode: 'strict' });
  const station = { router } as unknown as Station;
  setTimeout(() => arrive(router), 20);

  const outcome = await new WaitForStep()
    .execute({ action: 'wait_for', message, messageType, timeout_ms: 150 }, createContext(), station)
    .then(
      () => null,
      (err: unknown) => err,
    );

  expect(outcome, 'the wait was expected to FAIL on a refused message').toBeInstanceOf(Error);
  const text = (outcome as Error).message;
  // The refusal note was rendered at all — otherwise the absence of the token proves nothing.
  expect(text).toContain('REFUSED as non-conformant');
  return text;
}

beforeEach(() => {
  // The router announces each refusal on console.warn; that line is covered elsewhere.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('WaitForStep — a schema refusal note does not carry the upload token', () => {
  it('a refused GetDiagnostics is reported with its payload shape and the token redacted', async () => {
    const text = await failureOf('GetDiagnostics', 'Request', (router) =>
      publish(router, OsppAction.GET_DIAGNOSTICS, MessageType.REQUEST, {
        uploadUrl: PLATFORM_URL,
        unexpected: true,
      }),
    );

    expect(text).toContain(
      '| payload={"uploadUrl":"https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>","unexpected":true}',
    );
    expect(text).not.toContain(TOKEN);
  });

  it('CONTROL: a refused payload with no uploadUrl is rendered exactly as before', async () => {
    const payload = { serverTime: 42, note: 'https://example.com/?q=1' };

    const text = await failureOf('Heartbeat', 'Response', (router) =>
      publish(router, OsppAction.HEARTBEAT, MessageType.RESPONSE, payload),
    );

    expect(text).toContain(`| payload=${JSON.stringify(payload)}`);
  });
});
