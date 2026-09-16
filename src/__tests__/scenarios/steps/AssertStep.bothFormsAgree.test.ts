import { describe, it, expect } from 'vitest';
import { AssertStep } from '../../../scenarios/steps/AssertStep.js';
import { FrameJournal } from '../../../mqtt/FrameJournal.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';
import type { OsppEnvelope } from '@ospp/protocol';

/**
 * THE TWO FORMS, ON ONE FRAME.
 *
 * `scenarios/sessions/session-rejected-maintenance.yaml` now asserts the boot
 * verdict twice: once as `payload.status` (the router buffer, which is what every
 * scenario has always read) and once as
 * `journal.in[action=BootNotification].envelope.payload.status` (the wire). Both are
 * kept so that a disagreement turns that file red.
 *
 * This file is why keeping both is safe: it drives ONE frame into BOTH surfaces and
 * asserts that the two paths resolve to the same value, and that each one fails on
 * the same wrong value. Without it, "both forms agree" would be a claim about a
 * scenario nobody can run offline.
 *
 * The two surfaces are NOT interchangeable, and the last case here is the reason the
 * journal exists at all: a frame the router REFUSES never reaches
 * `receivedMessages`, so the old form cannot tell "the server never answered" from
 * "the server answered and this station rejected it". The journal can.
 */
const BOOT_RESPONSE = {
  messageId: 'boot-1',
  messageType: 'Response',
  action: 'BootNotification',
  payload: { status: 'Accepted', heartbeatIntervalSec: 60, sessionKey: 'k' },
};

function stationWithJournal(): { station: Station; journal: FrameJournal } {
  const journal = new FrameJournal();
  journal.record('out', 't', JSON.stringify({
    messageId: 'boot-1', messageType: 'Request', action: 'BootNotification', payload: {},
  }), 1);
  journal.record('in', 't', JSON.stringify(BOOT_RESPONSE), 1);
  return { station: { journal } as unknown as Station, journal };
}

/** The context a `wait_for` leaves behind: the accepted envelope, and only that. */
function contextWithTheSameFrame(): ScenarioContext {
  return {
    receivedMessages: [BOOT_RESPONSE as unknown as OsppEnvelope],
  } as unknown as ScenarioContext;
}

const run = (field: string, extra: Record<string, unknown>, station: Station, context: ScenarioContext) =>
  new AssertStep().execute({ action: 'assert', field, ...extra }, context, station);

const ROUTER_FORM = 'payload.status';
const JOURNAL_FORM = 'journal.in[action=BootNotification].envelope.payload.status';

describe('the router-buffer form and the journal form agree', () => {
  it('both PASS on the value the frame carries', async () => {
    const { station } = stationWithJournal();
    const context = contextWithTheSameFrame();
    await expect(run(ROUTER_FORM, { equals: 'Accepted' }, station, context)).resolves.toBeUndefined();
    await expect(run(JOURNAL_FORM, { equals: 'Accepted' }, station, context)).resolves.toBeUndefined();
  });

  it('both FAIL on the same wrong value — agreement in the red direction too', async () => {
    // A pair that only agrees when green is not a cross-check: it would be satisfied
    // by a journal path that silently resolves to undefined.
    const { station } = stationWithJournal();
    const context = contextWithTheSameFrame();
    await expect(run(ROUTER_FORM, { equals: 'Rejected' }, station, context)).rejects.toThrow(/Accepted/);
    await expect(run(JOURNAL_FORM, { equals: 'Rejected' }, station, context)).rejects.toThrow(/Accepted/);
  });

  it('they agree on a sibling field of the same frame', async () => {
    const { station } = stationWithJournal();
    const context = contextWithTheSameFrame();
    await expect(run('payload.heartbeatIntervalSec', { equals: 60 }, station, context)).resolves.toBeUndefined();
    await expect(
      run('journal.in[action=BootNotification].envelope.payload.heartbeatIntervalSec', { equals: 60 }, station, context),
    ).resolves.toBeUndefined();
  });

  it('and on the messageId, which is what correlates the two directions', async () => {
    const { station } = stationWithJournal();
    const context = contextWithTheSameFrame();
    await expect(run('messageId', { equals: 'boot-1' }, station, context)).resolves.toBeUndefined();
    await expect(
      run('journal.in[action=BootNotification].envelope.messageId', { equals: 'boot-1' }, station, context),
    ).resolves.toBeUndefined();
  });
});

describe('where the two forms DIVERGE — the reason the journal exists', () => {
  it('a REFUSED frame is on the journal and absent from the router buffer', async () => {
    // MessageRouter.route() emits nothing on a parse, MAC or schema failure, so the
    // frame never reaches `receivedMessages`. The journal records it anyway.
    const journal = new FrameJournal();
    journal.record('in', 't', JSON.stringify(BOOT_RESPONSE), 1);
    const station = { journal } as unknown as Station;
    const emptyContext = { receivedMessages: [] } as unknown as ScenarioContext;

    // The old form cannot even be evaluated.
    await expect(run(ROUTER_FORM, { equals: 'Accepted' }, station, emptyContext))
      .rejects.toThrow(/no received messages/);

    // The new form answers.
    await expect(run(JOURNAL_FORM, { equals: 'Accepted' }, station, emptyContext)).resolves.toBeUndefined();
  });

  it('the journal also holds the OUTBOUND half, which the router buffer never sees', async () => {
    const { station } = stationWithJournal();
    const context = contextWithTheSameFrame();
    await expect(
      run('journal.out[action=BootNotification].envelope.messageType', { equals: 'Request' }, station, context),
    ).resolves.toBeUndefined();
    // There is no router-buffer equivalent to compare against: `receivedMessages` is
    // inbound-only, which is why no scenario could assert on a sent frame before.
    expect(context.receivedMessages.every(m => m.messageType !== 'Request')).toBe(true);
  });
});
