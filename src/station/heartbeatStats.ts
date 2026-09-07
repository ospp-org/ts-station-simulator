/**
 * PROCESS-WIDE HEARTBEAT COUNTERS, FOR THE SAME REASON `inboundSchema` HAS THEM.
 *
 * On 2026-09-07 the background Heartbeat became the scenario default. The problem with that
 * kind of change is that its correct behaviour and its total absence produce byte-identical
 * console output: **most files finish inside one interval**, so a run in which the default
 * works and a run in which it silently stopped working both print nothing about it, and both
 * pass. That is the shape RUNNING-AGAINST-UAT.md's "Reading a zero" section is about —
 * machinery built correctly and never wired, whose failure mode looks like correct behaviour.
 *
 * So the run summary prints what actually happened, with the denominator:
 *
 *   `armed`      — stations that armed a heartbeat, i.e. `startHeartbeat()` calls. Includes
 *                  the eight files whose explicit `start_heartbeat` step RE-arms an already
 *                  running timer, so it is an upper bound on stations, not a count of them.
 *   `published`  — Heartbeat REQUESTs that reached the sender. THE number: this is the one
 *                  that separates "the default is live" from "the default is a timer nobody
 *                  ever reaches".
 *   `failed`     — pulses whose publish rejected. Expected and correct after `fault: sever`,
 *                  which nulls the client; anything else is a real signal.
 *   `suppressed` — scenarios that ran with `suppress_heartbeat:` declared. The corpus has one.
 *
 * `published: 0` against `armed: 140` is NOT a defect and the summary says so: no scenario
 * outlived a single interval. It only becomes a defect next to a run that contains a file
 * long enough to need one — which is exactly the run in which a silent regression would
 * otherwise be discovered by a red assertion three steps later, blaming the server.
 */
const stats = { armed: 0, published: 0, failed: 0, suppressed: 0 };

export interface HeartbeatStats {
  armed: number;
  published: number;
  failed: number;
  suppressed: number;
}

export function heartbeatStats(): HeartbeatStats {
  return { ...stats };
}

export function recordHeartbeatArmed(): void {
  stats.armed += 1;
}

export function recordHeartbeatPublished(): void {
  stats.published += 1;
}

export function recordHeartbeatFailed(): void {
  stats.failed += 1;
}

export function recordHeartbeatSuppressed(): void {
  stats.suppressed += 1;
}

/** Test-only: reset the process-wide counters between cases. */
export function resetHeartbeatStats(): void {
  stats.armed = 0;
  stats.published = 0;
  stats.failed = 0;
  stats.suppressed = 0;
}
