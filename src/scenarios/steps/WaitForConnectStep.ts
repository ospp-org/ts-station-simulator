import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * Wait until the station's MQTT client (re)connects — the connack that
 * follows the auto-reconnect triggered by `fault: disconnect`.
 *
 * This is the deterministic replacement for a fixed `delay` before re-sending.
 * A fixed sleep (e.g. 1000ms) assumes the connection is back, but the client
 * only auto-reconnects on `MqttConnection.reconnectPeriod` (5000ms). Sending
 * while still disconnected pushes the QoS-1 publish into the mqtt offline
 * store, where the `send` step BLOCKS until the reconnect completes — then the
 * following `wait_for` starts its clock late and races the post-reconnect
 * round-trip, which makes the scenario flaky under load. Synchronizing on the
 * real `connect` event removes that race entirely: the next `send` publishes
 * on a live connection and the `wait_for` gets its full timeout budget.
 *
 * Default timeout 15000ms (≈3× the 5000ms reconnect period); override with
 * `timeout_ms`.
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
