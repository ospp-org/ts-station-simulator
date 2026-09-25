import { describe, it, expect } from 'vitest';
import { AssertStep } from '../../../scenarios/steps/AssertStep.js';
import type { StepDefinition } from '../../../scenarios/steps/Step.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/*
 * A FAILED ASSERTION PRINTS WHAT IT RECEIVED — AND A RECEIVED GetDiagnostics CARRIES A CREDENTIAL.
 *
 * `assert` renders the value its path resolved to into the failure text, and that text is
 * printed and written into the JSON and JUnit reports. A scenario that asserts on a
 * GetDiagnostics Request's `payload.uploadUrl`, or on the whole payload, would copy the
 * single-use upload token csms-server mints into all three.
 *
 * Only the RENDERING is redacted. The comparison must still see the real value, or an assertion
 * about the URL would compare against `<redacted>` and pass or fail for the wrong reason — the
 * control at the end pins exactly that.
 */

const TOKEN = 'abc123SECRET';
const PLATFORM_URL = `https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/${TOKEN}`;
const REDACTED_URL = 'https://api-uat.onestoppay.ro/api/v1/diagnostics/uploads/<redacted>';

const received = {
  action: 'GetDiagnostics',
  messageType: 'Request',
  payload: { uploadUrl: PLATFORM_URL },
};

function ctx(): ScenarioContext {
  return { receivedMessages: [received] } as unknown as ScenarioContext;
}

const station = {} as unknown as Station;

/** The failure text of an assertion that must fail; a pass would make the token check vacuous. */
async function failureOf(definition: StepDefinition): Promise<string> {
  const outcome = await new AssertStep().execute(definition, ctx(), station).then(
    () => null,
    (err: unknown) => err,
  );
  expect(outcome, 'the assertion was expected to FAIL').toBeInstanceOf(Error);
  return (outcome as Error).message;
}

describe('AssertStep — a failure on an uploadUrl does not print the token', () => {
  it('equals on payload.uploadUrl', async () => {
    const text = await failureOf({ action: 'assert', field: 'payload.uploadUrl', equals: 'https://elsewhere.example/up' });

    expect(text).toContain(`but got "${REDACTED_URL}"`);
    expect(text).not.toContain(TOKEN);
  });

  it('contains on payload.uploadUrl', async () => {
    const text = await failureOf({ action: 'assert', field: 'payload.uploadUrl', contains: 'X-Amz-Signature' });

    expect(text).toContain(`but got "${REDACTED_URL}"`);
    expect(text).not.toContain(TOKEN);
  });

  it('exists: false on payload.uploadUrl', async () => {
    const text = await failureOf({ action: 'assert', field: 'payload.uploadUrl', exists: false });

    expect(text).toContain(`but got "${REDACTED_URL}"`);
    expect(text).not.toContain(TOKEN);
  });

  it('equals on the whole payload', async () => {
    const text = await failureOf({ action: 'assert', field: 'payload', equals: { uploadUrl: 'https://elsewhere.example/up' } });

    expect(text).toContain(`but got {"uploadUrl":"${REDACTED_URL}"}`);
    expect(text).not.toContain(TOKEN);
  });

  it('CONTROL: the comparison still sees the real URL — only the rendering is redacted', async () => {
    await expect(
      new AssertStep().execute({ action: 'assert', field: 'payload.uploadUrl', equals: PLATFORM_URL }, ctx(), station),
    ).resolves.toBeUndefined();
    await expect(
      new AssertStep().execute({ action: 'assert', field: 'payload.uploadUrl', contains: TOKEN }, ctx(), station),
    ).resolves.toBeUndefined();
  });
});
