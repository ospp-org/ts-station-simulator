import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

export class FaultStep implements Step {
  async execute(
    definition: StepDefinition,
    _context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const faultType = definition.type as string;
    if (!faultType) {
      throw new Error('FaultStep requires a "type" field');
    }

    switch (faultType) {
      case 'disconnect':
        station.destroyConnection();
        break;

      case 'timeout': {
        const ms = (definition.ms as number) ?? 30_000;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        break;
      }

      case 'error':
        throw new Error(
          (definition.message as string) ?? 'Simulated fault error',
        );

      default:
        throw new Error(`Unknown fault type: ${faultType}`);
    }
  }
}
