import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WHAT THIS GUARDS, AND — more importantly — WHAT IT DOES NOT.
 *
 * `firmware-command-timeout-no-response.yaml` is committed `skip: true` because
 * of a SERVER defect: csms-server's `PendingCommandRegistry` gives UpdateFirmware
 * a 330s Redis TTL against a 300s logical timeout, leaving `command:check-timeouts`
 * a 30-second window on a 60-second cadence, so `command_timeout` fires roughly
 * half the time. Measured 2026-08-17 twice — the same file, the same wait, FAILED
 * at the real cadence and PASSED with the scanner forced to 8s.
 *
 * THE SKIP SHOULD UN-SKIP ITSELF WHEN THE CONSTANT CHANGES. It cannot, and the
 * reason is worth writing down rather than discovering again:
 *
 *   1. The fact lives in another repo. `GRACE_PERIOD_SECONDS` is in csms-server,
 *      which this repo does not vendor, pin or depend on in any declared way.
 *   2. A test reading it by absolute path would be inert where it matters most.
 *      This repo's CI is a bare `actions/checkout` of THIS repo on ubuntu-latest
 *      (.github/workflows/ci.yml) — csms-server does not exist there, so such a
 *      test would have to `skipIf` its way out, and a gate that emits no signal
 *      is not a gate.
 *   3. The scenario COULD be made deterministic, and that route is declined on
 *      purpose. The sweep fires on wall-clock minute boundaries and 300 is a
 *      multiple of 60, so the window inherits the dispatch phase: a scan lands
 *      inside it whenever the POST goes out at second >= 30 of a minute. A
 *      `wait_until_wall_clock_second` step would therefore make this file pass
 *      every time — by manufacturing a green over a defect that hits real
 *      operators half the time, using timing knowledge no station in the field
 *      has. A scenario that passes because it knows the scheduler's phase is
 *      worse than one that is honestly skipped.
 *
 * So the forcing mechanism belongs in csms-server, where the constant is: a
 * tripwire pinning `GRACE_PERIOD_SECONDS` whose failure message names this file.
 * That is recorded in csms-server `docs/KNOWN-ISSUES.md` as part of the fix.
 *
 * WHAT IS LEFT FOR THIS FILE TO DO is guard the SENTENCE, not the fact — and that
 * is a real if smaller job, because a skip reason is the least-verified sentence
 * in any corpus and the way it fails is by decaying into "flaky, skipped". These
 * cases pin that the reason keeps its measured content and its un-skip condition,
 * so softening it is an edit someone has to make deliberately against a red test.
 *
 * WHAT A BROKEN INSTRUMENT WOULD ANSWER HERE: a test asserting only `skip: true`
 * passes against a reason that says nothing at all. The content assertions below
 * are the whole discriminating part; the `skip` assertion by itself proves
 * nothing and is only here to say which file is meant.
 */
describe('the skipped firmware scenario keeps a MEASURED reason, not a shrug', () => {
  const REL = 'scenarios/device-management/firmware-command-timeout-no-response.yaml';
  const src = fs.readFileSync(path.resolve(REL), 'utf8');

  it('is skipped and says so in the two keys the runner reads', () => {
    expect(src).toMatch(/^skip:\s*true\s*$/m);
    expect(src).toMatch(/^skip_reason:/m);
  });

  // Each of these is a claim that was MEASURED. Losing any one of them turns a
  // reproducible finding back into an opinion.
  it.each([
    ['the constant to change', /GRACE_PERIOD_SECONDS/],
    ['the component that holds it', /PendingCommandRegistry/],
    ['the physical TTL', /330s/],
    ['the logical timeout', /300s/],
    ['the window it leaves', /30s window/],
    ['the sweep cadence it loses to', /60s cadence/],
    ['the measured outcome', /~50%|50% of the time/],
    ['the un-skip condition', /Un-skip when/],
  ])('the skip_reason still names %s', (_what, pattern) => {
    // Scoped to the skip_reason block, not the whole file: the header prose
    // repeats all of these, so a whole-file match would stay green even if the
    // reason itself were gutted — which is exactly the decay this guards.
    const reason = src.match(/^skip_reason:[\s\S]*?(?=^\S|\Z)/m)?.[0] ?? '';
    expect(reason).not.toBe('');
    expect(reason).toMatch(pattern);
  });

  it('states BOTH measurements, because one direction is not a differential', () => {
    // "It failed" is a bug report. "It failed at 60s and passed at 8s, same file,
    // same wait" is the finding — the cadence was the only variable.
    expect(src).toMatch(/scanner forced to 8s/);
    expect(src).toMatch(/failed at 60s/);
  });

  it('is skipped, not gutted — the scenario is still runnable the moment it un-skips', () => {
    // A skip that quietly emptied the file would make un-skipping a rewrite
    // rather than a one-line change, and nothing else would notice.
    expect(src).toMatch(/^steps:/m);
    expect(src).toMatch(/action: api_call/);
    expect(src).toMatch(/failure_reason.*command_timeout/);
    // The wait it exists to perform is still declared.
    const declaredDelayMs = [...src.matchAll(/^\s+ms:\s*(\d+)/gm)]
      .reduce((sum, d) => sum + Number(d[1]), 0);
    expect(declaredDelayMs).toBeGreaterThanOrEqual(6 * 60_000);
  });

  it('the OTHER long firmware file is NOT skipped — slow is not a reason', () => {
    // firmware-stalled-after-accept runs ~16 minutes and passes. It is the only
    // wire proof of the stall path, and "it takes a quarter of an hour" is the
    // most tempting bad reason to skip anything in this corpus.
    const stall = fs.readFileSync(
      path.resolve('scenarios/device-management/firmware-stalled-after-accept.yaml'),
      'utf8',
    );
    expect(stall).not.toMatch(/^skip:\s*true/m);
  });
});
