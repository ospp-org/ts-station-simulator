import { describe, expect, it } from 'vitest';
import { AssertStep } from '../../scenarios/steps/AssertStep.js';
import type { ScenarioContext } from '../../scenarios/ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/*
 * A FAILED ASSERTION ON A REFUSAL MUST CARRY THE REASON THE PEER GAVE.
 *
 * MEASURED, and this is why the file exists. `security/offline-pass-authorize` fails in 4 of 6
 * full 149-scenario runs and passes standalone, on both SDK pins. Every attempt to diagnose it
 * ran into the same wall: the only artefact of the failure is
 *
 *     Assertion failed: expected "payload.status" to equal "Accepted", but got "Rejected"
 *
 * The server names the refused check in a SIBLING field — `payload.reason` carries strings like
 * "Offline pass revocation epoch is outdated" or "Minimum interval between uses not yet
 * elapsed", one per check in PassValidator — and `errorCode`/`errorText` carry the registry
 * code. The assertion compared one field and discarded the frame that explained it, so an
 * intermittent refusal is reported as a bare inequality and the run has to be repeated under a
 * packet capture to learn anything.
 *
 * That is a DIAGNOSTIC defect, not a cosmetic one: it is the reason a 4-in-6 failure has no
 * attribution after six full runs. The fix is to attach the refusal context to the message.
 *
 * WHAT THIS IS NOT. It is not a fix for the flake. The race is still unfound; this makes the
 * NEXT occurrence self-describing instead of silent.
 */

function ctx(received: unknown[]): ScenarioContext {
  return { receivedMessages: received } as unknown as ScenarioContext;
}

const station = {} as unknown as Station;

describe('AssertStep — a failed assertion carries the refusal context', () => {
  it('names payload.reason when a status assertion fails on a Rejected frame', async () => {
    const frame = {
      action: 'AuthorizeOfflinePass',
      payload: {
        status: 'Rejected',
        reason: 'Offline pass revocation epoch is outdated',
        errorCode: 2003,
        errorText: 'OFFLINE_EPOCH_REVOKED',
      },
    };

    await expect(
      new AssertStep().execute(
        { action: 'assert', field: 'payload.status', equals: 'Accepted' },
        ctx([frame]),
        station,
      ),
    ).rejects.toThrow(/OFFLINE_EPOCH_REVOKED/);
  });

  it('carries the reason prose too, which is what names the CHECK that refused', async () => {
    const frame = {
      action: 'AuthorizeOfflinePass',
      payload: { status: 'Rejected', reason: 'Minimum interval between uses not yet elapsed' },
    };

    await expect(
      new AssertStep().execute(
        { action: 'assert', field: 'payload.status', equals: 'Accepted' },
        ctx([frame]),
        station,
      ),
    ).rejects.toThrow(/Minimum interval between uses not yet elapsed/);
  });

  it('CONTROL — a PASSING assertion still passes, and says nothing', async () => {
    const frame = { action: 'AuthorizeOfflinePass', payload: { status: 'Accepted' } };

    await expect(
      new AssertStep().execute(
        { action: 'assert', field: 'payload.status', equals: 'Accepted' },
        ctx([frame]),
        station,
      ),
    ).resolves.toBeUndefined();
  });

  it('CONTROL — a failure on a frame with NO refusal context is unchanged, not padded', async () => {
    // The context is attached because it EXISTS, not as decoration. A frame carrying no
    // reason/errorCode/errorText must produce the same message it always did, or every
    // ordinary assertion failure grows noise and the signal is lost again.
    const frame = { action: 'BootNotification', payload: { heartbeatIntervalSec: 30 } };

    await expect(
      new AssertStep().execute(
        { action: 'assert', field: 'payload.heartbeatIntervalSec', equals: 60 },
        ctx([frame]),
        station,
      ),
    ).rejects.toThrow(/^Assertion failed: expected "payload\.heartbeatIntervalSec" to equal 60, but got 30$/);
  });
});
