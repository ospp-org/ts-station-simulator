import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _hydrateProvisioningForTesting,
  generateVariables,
  unsatisfiedVariables,
  UNHYDRATED_BAY_SLUG,
} from '../../scenarios/ScenarioRunner.js';
import type { ScenarioDefinition } from '../../scenarios/ScenarioRunner.js';
import type { TargetConfig } from '../../cli/config.js';

/**
 * `{{baySlug_N}}` — how the pay page's identity reaches a scenario, and the two ways that
 * could have gone silently wrong.
 *
 * The slug is `bays.public_slug`, and NO API returns it: the admin and dashboard station
 * reads both project `{id, bayId, bayNumber, status}`, no Resource mentions it, and the one
 * action that would have published it has no route and no caller. It is minted at
 * registration and read back by `resolveBayIdBySlug`, and in between it never leaves the
 * database. So it travels the only path there is — a privileged read at bootstrap, written
 * into the `<stationId>-bays.json` the runner already hydrates `{{bayId_N}}` from.
 */
describe('bay slug hydration', () => {
  let dir: string;
  let target: TargetConfig;
  const STATION = 'stn_abcdef01';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bayslug-'));
    target = {
      name: 'test',
      tls: { keyPattern: path.join(dir, '{{stationId}}-key.pem') },
    } as unknown as TargetConfig;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeBaysJson = (body: Record<string, unknown>) =>
    fs.writeFile(path.join(dir, `${STATION}-bays.json`), JSON.stringify(body));

  const scenario = (steps: unknown[]): ScenarioDefinition =>
    ({ name: 'x', station: { stationId: STATION, bayCount: 2 }, steps } as unknown as ScenarioDefinition);

  it('carries the slugs, index-aligned with bayIds', async () => {
    await writeBaysJson({
      stationId: STATION,
      bayIds: ['bay_1', 'bay_2'],
      baySlugs: ['SLUGforBAY1', 'SLUGforBAY2'],
    });
    const hydrated = await _hydrateProvisioningForTesting(STATION, target);
    expect(hydrated?.baySlugs).toEqual(['SLUGforBAY1', 'SLUGforBAY2']);
    expect(hydrated?.bayIds).toEqual(['bay_1', 'bay_2']);
  });

  /**
   * THE CONTROL. A short list is DROPPED whole rather than applied to the bays it happens
   * to cover — because a partially-applied list does not fail, it MISPAIRS: `{{baySlug_2}}`
   * keeps the sentinel while `{{baySlug_1}}` is real, and a scenario driving bay 2's pay
   * page would be quietly driving bay 1's, or a 404. Both halves come from one query; a
   * length disagreement means the artifact is not one this runner can trust.
   */
  it('DROPS a slug list that is not the same length as bayIds, rather than mispairing', async () => {
    await writeBaysJson({
      stationId: STATION,
      bayIds: ['bay_1', 'bay_2'],
      baySlugs: ['SLUGforBAY1'],
    });
    expect((await _hydrateProvisioningForTesting(STATION, target))?.baySlugs).toBeUndefined();
  });

  it('is simply absent on an artifact written before the read existed', async () => {
    await writeBaysJson({ stationId: STATION, bayIds: ['bay_1'] });
    const hydrated = await _hydrateProvisioningForTesting(STATION, target);
    expect(hydrated?.bayIds).toEqual(['bay_1']);
    expect(hydrated?.baySlugs).toBeUndefined();
  });

  describe('the un-hydrated sentinel', () => {
    it('is what generateVariables seeds, so preflight does not skip a pooled run', () => {
      // The gap this closes: unsatisfiedVariables runs BEFORE hydration, so a variable with
      // no default is reported missing and the CLI transparently skips every file using it
      // — including under --bootstrap-pool, the one mode where the value does arrive. The
      // file would never run anywhere. `{{bayId_N}}` has the same shape and the same fix.
      const vars = generateVariables(scenario([]), target, null);
      expect(vars.get('baySlug_1')).toBe(UNHYDRATED_BAY_SLUG);
      expect(
        unsatisfiedVariables(
          scenario([{ action: 'api_call', method: 'GET', url: '/w/{{baySlug_1}}' }]),
          target,
        ),
      ).toEqual([]);
    });

    it('cannot be mistaken for a real slug', () => {
      // A real one is Str::random(10) — ten alphanumerics, VARCHAR(16). A random
      // placeholder would look exactly like one, so an un-hydrated run would send a
      // plausible slug, collect a 404, and read as a server fault. This one reads as
      // itself in a URL, a log line and a report, before anyone reaches the 404.
      expect(UNHYDRATED_BAY_SLUG).not.toMatch(/^[A-Za-z0-9]{10}$/);
      expect(UNHYDRATED_BAY_SLUG).toContain('NO-POOL');
    });

    it('is overridden by --var, like every other generated variable', () => {
      const vars = generateVariables(
        scenario([]), target, null, new Map([['baySlug_1', 'REALSLUG12']]),
      );
      expect(vars.get('baySlug_1')).toBe('REALSLUG12');
    });
  });

  it('publishes the multi-unit service id as a variable, not as a literal in YAML', () => {
    expect(generateVariables(scenario([]), target, null).get('serviceId_multiunit'))
      .toBe('svc_multiunit');
  });
});
