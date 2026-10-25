import { describe, it, expect, vi } from 'vitest';

const { ReplayHeldStep } = await import('../../../scenarios/steps/ReplayHeldStep.js');

/*
 * `replay_held` - THE REPLAY OF A SCENARIO STATION (2026-10-25, freeze item 33).
 *
 * A scenario station sends the boot and the bay reports a reconnection opens with as steps of its file, so it replays
 * what it holds - the messages the broker did not acknowledge with success - where its file says, after them
 * (connection-lost.md §6 step 4). A connect-mode station replays on its own after the boot answered `Accepted`.
 */
describe('ReplayHeldStep', () => {
  it('has the station send what it holds', async () => {
    const replayHeld = vi.fn(async () => undefined);

    await new ReplayHeldStep().execute({ action: 'replay_held' } as never, {} as never, { replayHeld } as never);

    expect(replayHeld).toHaveBeenCalledTimes(1);
  });
});
