import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * `replay_held` - THE REPLAY OF A SCENARIO STATION (2026-10-25, freeze item 33, decided by Gabi).
 *
 * A message the broker did not acknowledge with success - a PUBACK 0x10 "No matching subscribers" or any code but
 * 0x00, or none at a reconnection to a broker that kept no session - stays in the station's buffer, in both modes, and
 * is resent after the next reconnection through the replay (01-architecture.md §6.5). A connect-mode station replays
 * on its own, once its boot is answered `Accepted` and its bays reported. A scenario station sends that boot and those
 * reports as steps of its file, so its file says where the replay goes - after them (connection-lost.md §6 step 4).
 */
export class ReplayHeldStep implements Step {
  async execute(_definition: StepDefinition, _context: ScenarioContext, station: Station): Promise<void> {
    await station.replayHeld();
  }
}
