import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * Start the station's background Heartbeat timer for the rest of the scenario.
 *
 * Why this exists — scenario mode vs. the server's offline watchdog:
 * scenario-mode stations register `BootNotificationHandler(autoReact=false)`, so
 * — unlike `connect` mode and unlike real firmware — they do NOT auto-start the
 * heartbeat after boot (see BootNotificationHandler's constructor doc). The csms
 * `station:check-heartbeats` sweep marks a station offline after
 * `3.5 x heartbeatIntervalSec` of application silence (OSPP 02-transport.md §4.2;
 * server-side HeartbeatTracker + CheckStationHeartbeatsCommand). Only an actual
 * Heartbeat refreshes that tracker — StatusNotification / MeterValues /
 * SessionEnded traffic does not. With the csms default OSPP_HEARTBEAT_INTERVAL=30
 * that window is 105s. The long multi-bay e2e scenarios cross it mid-run, the
 * sweep marks the station offline (dropping the bays, the heartbeat key AND the
 * session-key cache), and the next station-dependent call — e.g.
 * POST /sessions/start — then fails STATION_OFFLINE.
 *
 * Long scenarios add this step right after a successful boot so the station
 * heartbeats like real firmware and stays online for its whole lifecycle. The
 * timer is torn down when the runner's `finally` calls `station.disconnect()`,
 * which invokes `stopHeartbeat()` — no explicit stop step is needed.
 *
 * Short scenarios (the vast majority) deliberately do NOT use this step: they
 * finish well inside the 105s window and keep scenario mode's explicit-control
 * default of zero background traffic — which also preserves the ability to
 * script a silence/offline-detection test (impossible if the sim always
 * heartbeated).
 *
 * `interval_sec` is required and validated (fail-loud, mirroring DelayStep's
 * `ms`): it lives in the scenario YAML next to the other empirically-tuned
 * timing constants, so the keep-alive cadence is visible where the 105s sweep
 * reasoning is documented. Pick a value comfortably below
 * `3.5 x server heartbeatIntervalSec` (30 against the default csms config).
 */
export class StartHeartbeatStep implements Step {
  async execute(
    definition: StepDefinition,
    _context: ScenarioContext,
    station: Station,
  ): Promise<void> {
    const intervalSec = definition.interval_sec;
    if (
      typeof intervalSec !== 'number' ||
      !Number.isFinite(intervalSec) ||
      intervalSec <= 0
    ) {
      throw new Error(
        'StartHeartbeatStep requires "interval_sec" to be a positive number (seconds)',
      );
    }
    station.startHeartbeat(intervalSec);
  }
}
