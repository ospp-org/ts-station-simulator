import { describe, it, expect } from 'vitest';
import { AssertStep } from '../../../scenarios/steps/AssertStep.js';
import { FrameJournal } from '../../../mqtt/FrameJournal.js';
import type { ScenarioContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

function journalWithABootAndAGoodbye(): FrameJournal {
  const j = new FrameJournal();
  j.record('out', 't', JSON.stringify({
    messageId: 'boot-1', messageType: 'Request', action: 'BootNotification',
    payload: { stationId: 'stn_aaaaaaaa', bays: [{ bayNumber: 1, programNumbers: [1] }] },
  }), 1);
  j.record('in', 't', JSON.stringify({
    messageId: 'boot-1', messageType: 'Response', action: 'BootNotification',
    payload: { status: 'Accepted', heartbeatIntervalSec: 60 },
  }), 1);
  j.record('out', 't', JSON.stringify({
    messageId: 'bye-1', messageType: 'Event', action: 'ConnectionLost',
    payload: { stationId: 'stn_aaaaaaaa', reason: 'PlannedShutdown' },
  }), 1);
  return j;
}

function fakeStation(journal?: FrameJournal): Station {
  return { journal } as unknown as Station;
}

const emptyContext = () => ({ receivedMessages: [] }) as unknown as ScenarioContext;

const run = (field: string, extra: Record<string, unknown>, station: Station) =>
  new AssertStep().execute({ action: 'assert', field, ...extra }, emptyContext(), station);

describe('assert against the frame journal, not against stdout', () => {
  it('counts an outbound action, per direction', async () => {
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(run('journal.counts.out.ConnectionLost', { equals: 1 }, station)).resolves.toBeUndefined();
    await expect(run('journal.counts.out.BootNotification', { equals: 1 }, station)).resolves.toBeUndefined();
    await expect(run('journal.counts.in.BootNotification', { equals: 1 }, station)).resolves.toBeUndefined();
  });

  it('an action that never crossed the wire has NO count key, which `exists: false` states', async () => {
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(run('journal.counts.in.ConnectionLost', { exists: false }, station)).resolves.toBeUndefined();
    await expect(run('journal.counts.out.StopService', { exists: false }, station)).resolves.toBeUndefined();
  });

  it('reaches into the parsed envelope of a selected frame', async () => {
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(
      run('journal.out[action=ConnectionLost].envelope.payload.reason', { equals: 'PlannedShutdown' }, station),
    ).resolves.toBeUndefined();
    await expect(
      run('journal.out[action=ConnectionLost].envelope.messageType', { equals: 'Event' }, station),
    ).resolves.toBeUndefined();
  });

  it('reaches the RAW payload, so a byte-level claim can be made', async () => {
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(
      run('journal.out[action=ConnectionLost].payload', { contains: '"reason":"PlannedShutdown"' }, station),
    ).resolves.toBeUndefined();
  });

  it('total is the denominator every other journal claim is read against', async () => {
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(run('journal.total', { equals: 3 }, station)).resolves.toBeUndefined();
  });

  it('a wrong count FAILS, and the message names the journal', async () => {
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(run('journal.counts.out.ConnectionLost', { equals: 2 }, station))
      .rejects.toThrow(/journal\.counts\.out\.ConnectionLost/);
  });

  it('a station with no journal REFUSES the assertion instead of passing it vacuously', async () => {
    // The trap this guards: `journal.counts.out.X` resolves to undefined on a
    // station that journals nothing, so `exists: false` would pass and the scenario
    // would report having proved an absence it never observed.
    const station = fakeStation(undefined);
    await expect(run('journal.counts.out.ConnectionLost', { exists: false }, station))
      .rejects.toThrow(/no frame journal/i);
  });

  it('does not need a received message — it reads the wire, not the router buffer', async () => {
    // Every non-`connection.` assertion until now threw "no received messages to
    // assert against" before reading anything. A journal claim must be answerable
    // about a frame the router REFUSED, which by definition never reaches that buffer.
    const station = fakeStation(journalWithABootAndAGoodbye());
    await expect(run('journal.total', { equals: 3 }, station)).resolves.toBeUndefined();
  });
});
