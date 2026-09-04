import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * THE FIRMWARE CEILING, PINNED — "reported, never discovered".
 *
 * Three scenario files say in their own headers that nothing in this repo fetches a firmware
 * image, computes a hash, verifies an image signature or writes a partition. That sentence is
 * the entire honest content of the firmware corpus's claim about the STATION side, and until
 * now it was prose: true when written, unenforced, and exactly the kind of note that survives
 * the change which falsifies it. Audit A1-133 is what a reader does with such a note when it
 * is absent — it read "Full firmware update lifecycle" as a claim that the lifecycle happens.
 *
 * THIS TEST FAILS IN THE GOOD DIRECTION. It does not stop anyone implementing real staging;
 * it stops real staging from landing while three files still say it cannot happen. A red here
 * means the ceiling has become an UNDERSTATEMENT and the headers owe an edit.
 *
 * Two independent facts hold the ceiling up, and both are checked because either alone would
 * leave a way to be wrong:
 *
 *   1. The handler performs no I/O. Even in the interactive `connect` command — where it IS
 *      registered — it only answers and emits on a timer.
 *   2. The handler is not reachable from a scenario at all. Scenario mode registers exactly
 *      one handler, and it is BootNotificationHandler. A1-133 named the handler as the site;
 *      the site it named is not in the loop the file it named runs.
 */

const SRC = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8');
}

/** Tokens that would mean the station DISCOVERED a failure rather than reporting one. */
const IO_TOKENS = [
  'node:fs',
  'node:crypto',
  'node:https',
  "from 'axios'",
  'fetch(',
  'createHash',
  'createVerify',
  'readFile',
  'writeFile',
  'spawn',
  'execFile',
];

describe('firmware ceiling — the station reports failures, it does not discover them', () => {
  it('UpdateFirmwareHandler performs no fetch, no filesystem access and no crypto', () => {
    const src = read('handlers/UpdateFirmwareHandler.ts');
    const found = IO_TOKENS.filter((t) => src.includes(t));
    expect(
      found,
      'UpdateFirmwareHandler now touches I/O. That is an improvement, not a defect — but ' +
        'three scenario headers (firmware-update-success / -download-failure / ' +
        '-install-failure) state that nothing here fetches, hashes, verifies or writes, and ' +
        'they are now wrong. Correct the ceilings, then narrow this list.',
    ).toEqual([]);
  });

  it('its only imports are the protocol SDK and the Handler contract', () => {
    // Stronger than the token list and cheaper to reason about: a new dependency is how I/O
    // arrives in practice, and this notices it whatever the call is spelled.
    const imports = [...read('handlers/UpdateFirmwareHandler.ts').matchAll(/from '([^']+)'/g)]
      .map((m) => m[1])
      .sort();
    expect(imports).toEqual(['./Handler.js', '@ospp/protocol']);
  });

  it('scenario mode registers exactly one handler, and it is BootNotification', () => {
    // The half A1-133 named the wrong site for. A scenario's firmware phases are `send` steps
    // in the YAML; no handler produces them, so the handler's behaviour — timer or otherwise —
    // is not what any firmware scenario exercises.
    const runner = read('scenarios/ScenarioRunner.ts');
    const registrations = [...runner.matchAll(/station\.registerHandler\(\s*OsppAction\.(\w+)/g)]
      .map((m) => m[1]);
    expect(registrations).toEqual(['BOOT_NOTIFICATION']);
  });

  it('the interactive connect command DOES register the full set — the contrast is the point', () => {
    // Positive control. Without it, the assertion above would keep passing if handler
    // registration disappeared from the repo entirely, and "scenario mode runs no handlers"
    // would stop being a statement about scenario mode.
    const cli = read('cli/index.ts');
    const registered = [...cli.matchAll(/reg\(OsppAction\.(\w+)/g)].length;
    expect(registered).toBeGreaterThan(10);
    expect(cli).toContain('new UpdateFirmwareHandler()');
  });

  it('the three files that make a lifecycle claim carry the ceiling that bounds it', () => {
    const scenarios = path.resolve(SRC, '../scenarios/device-management');
    for (const f of [
      'firmware-update-success.yaml',
      'firmware-update-download-failure.yaml',
      'firmware-update-install-failure.yaml',
    ]) {
      const text = fs.readFileSync(path.join(scenarios, f), 'utf-8');
      expect(text, `${f} lost its A1-133 ceiling`).toContain('REPORTED, NEVER DISCOVERED');
    }
  });
});
