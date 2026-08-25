import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  UNACKED_EVENT_SETTLE_MS,
  isUnackedEventSend,
  settleTopUpMs,
} from '../../scenarios/ScenarioRunner.js';

/**
 * THE FLOOR THE RUNNER HOLDS AFTER AN EVENT NOBODY ACKNOWLEDGES.
 *
 * See `UNACKED_EVENT_SETTLE_MS`. A `send` of an Event completes on the broker's QoS-1
 * PUBACK, which is not when the CSMS applied it, and the corpus puts an `api_call`
 * immediately after one in 49 places across 40 files — 26 of them backgrounded, where the
 * resulting 409 is a `console.warn` and the run dies three steps later on a `wait_for`
 * timeout naming a message that was never going to arrive.
 *
 * Two things are pinned here: the arithmetic (a FLOOR, so nothing is ever waited for twice)
 * and the adjacency count, so the property this exists for cannot quietly grow or vanish.
 */

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...yamlFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      out.push(full);
    }
  }

  return out;
}

interface Adjacency {
  file: string;
  step: number;
  background: boolean;
}

function scanAdjacencies(): { files: number; eventSends: number; adjacencies: Adjacency[] } {
  const files = yamlFiles(SCENARIOS_DIR);
  const adjacencies: Adjacency[] = [];
  let eventSends = 0;

  for (const file of files) {
    const doc = YAML.parse(readFileSync(file, 'utf-8')) as { steps?: unknown[] } | null;
    if (!doc || !Array.isArray(doc.steps)) continue;

    doc.steps.forEach((raw, index) => {
      const step = raw as Record<string, unknown> | null;
      if (!isUnackedEventSend(step as never)) return;
      eventSends++;
      const next = doc.steps?.[index + 1] as Record<string, unknown> | undefined;
      if (next?.action !== 'api_call') return;
      adjacencies.push({
        file: file.slice(SCENARIOS_DIR.length + 1),
        step: index,
        background: next.background === true,
      });
    });
  }

  return { files: files.length, eventSends, adjacencies };
}

describe('the runner holds an ordering the protocol cannot acknowledge', () => {
  // ---- THE ARITHMETIC: a floor, never an addition ----------------------------
  it('owes the full floor when the Event was published just now', () => {
    expect(settleTopUpMs(1_000_000, 1_000_000)).toBe(UNACKED_EVENT_SETTLE_MS);
    expect(settleTopUpMs(1_000_000, 1_000_400)).toBe(UNACKED_EVENT_SETTLE_MS - 400);
  });

  it('owes nothing once the floor has already elapsed — this never waits twice', () => {
    // A file that declares its own `delay` (full-session-lifecycle: 500ms; the three
    // maintenance read-backs: 1500ms) has already spent the time, and so has a `wait_for`
    // that took a second. Both must cost zero extra.
    expect(settleTopUpMs(1_000_000, 1_000_000 + UNACKED_EVENT_SETTLE_MS)).toBe(0);
    expect(settleTopUpMs(1_000_000, 1_000_000 + 1_500)).toBe(0);
    expect(settleTopUpMs(1_000_000, 1_099_999)).toBe(0);
  });

  it('owes nothing when no Event is outstanding', () => {
    expect(settleTopUpMs(null, 1_000_000)).toBe(0);
  });

  // ---- MATCHER CONTROL: which sends are unacknowledged -----------------------
  // Conformant sample and refusals. `Request` and `Response` both have a counterpart on the
  // wire; widening this predicate to every `send` would put a second of dead time after the
  // MeterValues floods, which is the cost this narrowing exists to avoid.
  it('counts Event sends only', () => {
    expect(isUnackedEventSend({ action: 'send', messageType: 'Event' })).toBe(true);
    expect(isUnackedEventSend({ action: 'send', messageType: 'Request' })).toBe(false);
    expect(isUnackedEventSend({ action: 'send', messageType: 'Response' })).toBe(false);
    expect(isUnackedEventSend({ action: 'send' })).toBe(false); // BootNotification's shape
    expect(isUnackedEventSend({ action: 'api_call', messageType: 'Event' })).toBe(false);
    expect(isUnackedEventSend(undefined)).toBe(false);
  });

  // ---- THE POPULATION -------------------------------------------------------
  it('measures the adjacencies this floor exists for', () => {
    const scan = scanAdjacencies();

    // Denominator: a broken glob would make every claim below vacuous.
    expect(scan.files).toBeGreaterThan(100);
    expect(scan.eventSends).toBeGreaterThan(100);

    // Measured 2026-08-25 at fbb131a: 49 adjacencies across 40 files, 26 of them
    // backgrounded. The backgrounded ones are the dangerous half — a refusal there is a
    // console.warn, so the run reports a `wait_for` timeout three steps away from the cause
    // (ApiCallStep.ts, measured 2026-08-13 on boot-disabled-station-boots-and-stays-gated).
    //
    // Pinned as a FLOOR rather than an equality: a new scenario adding one is normal and
    // must not red this. What must not happen silently is the number going to zero, which
    // would mean the predicate stopped matching and the runner stopped settling anything.
    expect(scan.adjacencies.length).toBeGreaterThanOrEqual(49);
    expect(scan.adjacencies.filter((a) => a.background).length).toBeGreaterThanOrEqual(26);
  });
});
