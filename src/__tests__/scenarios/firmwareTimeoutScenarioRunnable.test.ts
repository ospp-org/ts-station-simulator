import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WHAT THIS GUARDS NOW, AND WHY IT IS NOT THE TEST IT REPLACED.
 *
 * `firmware-command-timeout-no-response.yaml` was committed `skip: true` because of
 * a SERVER defect it measured: csms-server's `PendingCommandRegistry` gave
 * UpdateFirmware a 330s Redis TTL against a 300s logical timeout, leaving
 * `command:check-timeouts` a 30-second window on a 60-second cadence, so
 * `command_timeout` fired roughly half the time. Fixed in csms-server `d1e5881` —
 * `GRACE_PERIOD_SECONDS = 2 * SCAN_CADENCE_SECONDS` = 120, the window is now 120s
 * against the same 60s cadence, and the file is UN-SKIPPED.
 *
 * The predecessor of this file guarded the SKIP REASON — that it kept its measured
 * content instead of decaying into "flaky, skipped". That job is over: there is no
 * skip reason, and re-aiming those assertions at the header prose would be guarding
 * an essay. What is left is smaller and firmer, and it is the LOCAL half of a
 * two-repository pairing:
 *
 *   csms-server  `tests/Unit/Shared/Protocol/CommandTimeoutWindowTest.php` TRIPWIRE
 *                pins GRACE_PERIOD_SECONDS >= 2x the cadence and fails NAMING THIS
 *                SCENARIO BY PATH. It is the only thing that can notice the constant
 *                going back, because the constant is there.
 *   here         pins that the scenario stays RUNNABLE, and that the pointer to that
 *                tripwire survives. Nothing in csms-server can notice either.
 *
 * WHY THE PAIRING RATHER THAN ONE GATE. The fact lives in a repository this one does
 * not vendor, pin or depend on in any declared way, and this repo's CI is a bare
 * `actions/checkout` of THIS repo on ubuntu-latest (.github/workflows/ci.yml) — a
 * test reading csms-server by absolute path would have to `skipIf` its way out
 * exactly where it matters, and a gate that emits no signal is not a gate.
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT, because something else already does.
 * The obvious second half of "still runnable" is "still waits long enough" — a file
 * whose delays were trimmed to speed up the suite is the same non-determinism
 * arriving from the other direction. That is ALREADY pinned, and more thoroughly
 * than a copy here would be, by
 * `ScenarioRunner.scenarioTimeout.test.ts` ("is sized off the server constant it
 * waits on, and says so"): it requires the summed delays to clear
 * `300s timeout + 60s sweep period`, the `scenario_timeout_ms` budget to clear those
 * delays, and the header to state both its runtime and its `schedule:work`
 * dependency. Restating that bound here would put the same number in two files and
 * leave a reader guessing which one is authoritative — so this file cites it instead.
 *
 * WHAT A BROKEN INSTRUMENT WOULD ANSWER HERE. A test asserting only "not skipped"
 * passes against a file gutted down to its delays. The assertion below that the
 * scenario still reads back its own `failure_reason` is the one that stops that, and
 * it is the one claim about this file's CONTENT that no other test makes.
 */
describe('the command_timeout scenario is runnable, and its cross-repo pairing survives', () => {
  const REL = 'scenarios/device-management/firmware-command-timeout-no-response.yaml';
  const src = fs.readFileSync(path.resolve(REL), 'utf8');

  it('is NOT skipped, in either key the runner reads', () => {
    // ScenarioRunner returns a `skipped` result on `skip: true` BEFORE running a
    // step, and a skip never moves the exit code — so a re-skip is silent by
    // construction, and this is the only place it can be made loud.
    expect(src).not.toMatch(/^skip:\s*true/m);
    expect(src).not.toMatch(/^skip_reason:/m);
  });

  it('still asserts the verdict it exists for, not just the wait', () => {
    // A file trimmed to its delays would satisfy the sizing test in
    // ScenarioRunner.scenarioTimeout.test.ts — that one measures how long it waits,
    // never what it concludes. This is the complement, and the smallest honest form
    // of it: the token this whole scenario was written to observe.
    expect(src).toMatch(/^steps:/m);
    expect(src).toMatch(/failure_reason.*command_timeout/);
  });

  it('names the csms-server tripwire that is the other half of its determinism', () => {
    // A SENTENCE, and asserted as no more than that. This repo cannot check that the
    // named test exists, still pins the constant, or still names this file back —
    // csms-server is not present in this repo's CI. What it CAN stop is the pointer
    // being deleted, which is how a reader loses the ability to find out at all.
    expect(src).toMatch(/CommandTimeoutWindowTest/);
    expect(src).toMatch(/GRACE_PERIOD_SECONDS/);
  });

  it('names THIS file as its local guard, so a rename here cannot silently orphan it', () => {
    // Self-referential on purpose. The scenario header points at this test by name;
    // if this file is renamed and the header is not, the pairing it describes stops
    // being findable and nothing else would say so.
    // `import.meta.url`, not `__filename` — this package is `"type": "module"`.
    expect(src).toContain(path.basename(new URL(import.meta.url).pathname));
  });

  it('the OTHER long firmware file is NOT skipped either — slow is not a reason', () => {
    // firmware-stalled-after-accept runs ~16 minutes and passes. It is the only wire
    // proof of the stall path, and "it takes a quarter of an hour" is the most
    // tempting bad reason to skip anything in this corpus. Kept from the predecessor
    // of this file: the claim survived the fix unchanged.
    const stall = fs.readFileSync(
      path.resolve('scenarios/device-management/firmware-stalled-after-accept.yaml'),
      'utf8',
    );
    expect(stall).not.toMatch(/^skip:\s*true/m);
  });
});
