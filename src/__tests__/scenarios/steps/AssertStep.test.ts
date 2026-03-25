import { describe, it, expect } from 'vitest';
import { AssertStep } from '../../../scenarios/steps/AssertStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
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
