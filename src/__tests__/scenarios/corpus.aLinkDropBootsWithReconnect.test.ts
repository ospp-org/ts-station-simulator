import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { bootReasonNamesAnActualBoot, type BootReason } from '@ospp/protocol';

/**
 * A LINK DROP IS NOT A RESTART - boot-notification.md §5.2, read on the corpus's own narration.
 *
 * `fault: disconnect` destroys the socket and the client dials again: the process, its uptime and its
 * sessions run on, so the boot that follows names no restart - `Reconnect`, with the uptime the
 * station already had (§5.2 rule 2). Two files about exactly that - Reconnect Recovery and Rapid
 * Reconnect - narrated each reconnect as `ErrorRecovery` with uptime 0, a restart the station never
 * made, and so exercised the server's restart path where they meant its reconnect path
 * (measured 2026-10-13). BootClaimCheck cannot see it: an `ErrorRecovery` 0 after a few seconds is a
 * coherent claim, and the falsehood is in the story the file tells.
 *
 * A disconnect CAN stand for the link loss of a real restart, and four files use it so, each named
 * below with the restart it narrates. Any other file whose boot after a `fault: disconnect` names a
 * restart fails here: either it is a reconnect and says `Reconnect`, or its restart is reviewed into
 * this list.
 */
const RESTART_NARRATIONS: Readonly<Record<string, string>> = {
  'device-management/firmware-update-full-cycle-reboot.yaml': 'the reboot onto the installed image, FirmwareUpdate',
  'device-management/firmware-unexpected-version-at-boot.yaml': 'the reboot after an install, onto another version, PowerOn',
  'device-management/firmware-rollback-detected.yaml': 'the bootloader rolling back a failed image, ErrorRecovery',
  'device-management/firmware-rebooted-during-update.yaml': 'a power loss during the download, PowerOn',
};

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }
  return out.sort();
}

describe('the scenario corpus - a link drop boots with Reconnect', () => {
  it('names a restart after a fault: disconnect only where the file narrates one', () => {
    let afterDrop = 0;
    const offenders: string[] = [];
    const narrated = new Set<string>();

    for (const file of yamlFiles(SCENARIOS_DIR)) {
      const parsed = parseYaml(readFileSync(file, 'utf-8')) as { steps?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.steps)) continue;
      const rel = path.relative(SCENARIOS_DIR, file);
      let dropped = false;
      (parsed.steps as Record<string, unknown>[]).forEach((step, i) => {
        if (step?.action === 'fault' && step.type === 'disconnect') dropped = true;
        if (step?.action !== 'send' || step.message !== 'BootNotification') return;
        const reason = (step.payload as Record<string, unknown> | undefined)?.bootReason;
        if (dropped && typeof reason === 'string') {
          afterDrop++;
          if (bootReasonNamesAnActualBoot(reason as BootReason)) {
            if (RESTART_NARRATIONS[rel] === undefined) offenders.push(`${rel} step ${i}: ${reason} after a link drop`);
            else narrated.add(rel);
          }
        }
        dropped = false;
      });
    }

    expect(afterDrop, 'boots after a fault: disconnect').toBeGreaterThanOrEqual(8);
    expect(offenders, `a reconnect narrated as a restart:\n${offenders.join('\n')}`).toEqual([]);
    // The list holds no file it no longer needs to.
    expect([...narrated].sort()).toEqual(Object.keys(RESTART_NARRATIONS).sort());
  });
});
