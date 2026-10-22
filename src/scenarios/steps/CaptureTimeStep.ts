import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * Capture the moment this step runs, as an OSPP timestamp (ISO 8601 UTC with milliseconds,
 * common/timestamp.schema.json). `capture:` maps each captured name to an offset in whole
 * seconds from that moment, either way:
 *
 *   - action: capture_time
 *     capture:
 *       washStartedAt: 0
 *       washEndedAt: 300
 *
 * `from:` moves from a moment the server wrote instead of the runner's clock - typically a pass's
 * own `issuedAt` or `expiresAt`, captured from its issuance:
 *
 *   - action: capture_time
 *     from: "{{captured.passExpiresAt}}"
 *     capture:
 *       lastMinuteStartedAt: -60
 *
 * The server judges a wash against moments on ITS clock (the pass's validity, the revocation
 * moment), so a date taken from one of them holds however far the runner's clock is off.
 *
 * WHY A STEP, AND NOT A RUN VARIABLE. The server judges an offline pass at the moment its wash
 * began - the signed `startedAt` (reconciliation.md 6.1) - so a scenario that proves a refusal
 * after a revocation, a raise of the epoch or an expiry must sign a start AFTER that act, which
 * happens mid-scenario. A value fixed when the run starts, or a literal date, is before all of
 * them, and the server would rightly settle the wash.
 */
/** The OSPP timestamp: ISO 8601 UTC with milliseconds (common/timestamp.schema.json). */
const OSPP_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class CaptureTimeStep implements Step {
  async execute(definition: StepDefinition, context: ScenarioContext, _station: Station): Promise<void> {
    const capture = definition.capture;
    if (!capture) {
      throw new Error('capture_time requires a "capture" field: a map from captured names to offsets in seconds');
    }
    if (typeof capture !== 'object' || Array.isArray(capture) || Object.keys(capture).length === 0) {
      throw new Error('capture_time: "capture" maps captured names to offsets in seconds, and names at least one');
    }

    let now = Date.now();
    if (definition.from !== undefined) {
      const from = definition.from;
      if (typeof from !== 'string' || !OSPP_TIMESTAMP.test(from)) {
        throw new Error(`capture_time: "from" must be an OSPP timestamp (YYYY-MM-DDTHH:MM:SS.mmmZ), got ${String(from)}`);
      }
      now = Date.parse(from);
    }
    for (const [name, offset] of Object.entries(capture as Record<string, unknown>)) {
      if (typeof offset !== 'number' || !Number.isInteger(offset)) {
        throw new Error(`capture_time: the offset of "${name}" must be a whole number of seconds`);
      }
      context.captured.set(name, new Date(now + offset * 1000).toISOString());
    }
  }
}
