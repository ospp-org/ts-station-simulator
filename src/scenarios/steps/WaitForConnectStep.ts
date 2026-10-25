import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * Wait until the station's MQTT client (re)connects — the connack that
 * follows the reconnect triggered by `fault: disconnect`.
 *
 * This is the deterministic replacement for a fixed `delay` before re-sending.
 * A fixed sleep (e.g. 1000ms) assumes the connection is back, but the client
 * reconnects on the backoff of 02-transport.md §4.5 (reconnectBackoff.ts):
 * 1.0-1.3 s after the drop, longer when that attempt fails. Sending
 * while still disconnected pushes the QoS-1 publish into the mqtt offline
 * store, where the `send` step BLOCKS until the reconnect completes — then the
 * following `wait_for` starts its clock late and races the post-reconnect
 * round-trip, which makes the scenario flaky under load. Synchronizing on the
 * real `connect` event removes that race entirely: the next `send` publishes
 * on a live connection and the `wait_for` gets its full timeout budget.
 *
 * Default timeout 15000ms - room for the first four attempts of the backoff
 * (1, 2, 4 and 8 s, before their jitter); override with `timeout_ms`.
 */
export class WaitForConnectStep implements Step {
  async execute(
    definition: StepDefinition,
    _context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const timeoutMs = (definition.timeout_ms as number) ?? 15000;
    await station.waitForConnect(timeoutMs);
  }
}
