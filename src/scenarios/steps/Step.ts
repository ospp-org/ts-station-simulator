import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

export interface StepDefinition {
  action: string;
  [key: string]: unknown;
}

export interface Step {
  execute(definition: StepDefinition, context: ScenarioContext, station: Station): Promise<void>;
}
