import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

export class DelayStep implements Step {
  async execute(
    definition: StepDefinition,
    _context: ScenarioContext,
    _station: Station,
  ): Promise<void> {
    const ms = definition.ms as number;
    if (typeof ms !== 'number' || ms < 0) {
      throw new Error('DelayStep requires a positive "ms" field');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
