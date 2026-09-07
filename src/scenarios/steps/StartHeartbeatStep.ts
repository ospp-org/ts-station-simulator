import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

/**
 * Re-arm the station's background Heartbeat timer at an EXPLICIT interval.
 *
 * WHAT THIS STEP IS FOR SINCE 2026-09-07: an interval OVERRIDE. It is no longer how a
 * scenario gets a heartbeat at all — an accepted boot arms one automatically, at the
 * interval the server itself declared in the Response, in every file that does not carry
 * `suppress_heartbeat:`. `startHeartbeat()` stops any running timer first, so calling this
 * after boot simply replaces the cadence.
 *
 * WHAT IT USED TO BE FOR, and why that stopped. Scenario-mode stations registered
 * `BootNotificationHandler(autoReact=false)`, and that one flag silenced the heartbeat along
 * with the per-bay boot report. So — unlike `connect` mode and unlike real firmware — a
 * scenario station booted and then never beat again. The csms `station:check-heartbeats`
 * sweep marks a station offline after `3.5 x heartbeatIntervalSec` of application silence
 * (OSPP 02-transport.md §4.2; HeartbeatTracker + CheckStationHeartbeatsCommand), and only an
 * actual Heartbeat refreshes that tracker — StatusNotification / MeterValues / SessionEnded
 * traffic does not. Against the deployed `OSPP_HEARTBEAT_INTERVAL=30` that window is 105s.
 *
 * Long files therefore hit it one at a time and each added this step to survive: measured on
 * disk the day the default flipped, **8 of 148** files called it, which means **140** ran as
 * a station no integrator will ever operate. The docblock here used to say the other 140
 * omitted it "deliberately", to preserve the ability to script a silence test — a capability
 * exactly one file in the corpus ever used, bought at the price of the whole suite's
 * fidelity. That trade is now the other way round: the default is the faithful one, and the
 * single file whose SUBJECT is silence declares it
 * (`core/heartbeat-silence-offline-sweep.yaml`).
 *
 * The timer is torn down when the runner's `finally` calls `station.disconnect()`, which
 * invokes `stopHeartbeat()` — no explicit stop step is needed, and there is deliberately no
 * `stop_heartbeat` step: a file that wants silence wants it from the boot, not from
 * somewhere in the middle, and `suppress_heartbeat:` says so where a reader looks first.
 *
 * `interval_sec` is required and validated (fail-loud, mirroring DelayStep's `ms`). Pick a
 * value comfortably below `3.5 x server heartbeatIntervalSec`. The eight existing call sites
 * all pass 30, i.e. the value the boot Response already advertises — they are now redundant
 * rather than wrong, and are left in place because each one is a measured note about why its
 * file is long, which is worth more than the two lines it costs.
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
