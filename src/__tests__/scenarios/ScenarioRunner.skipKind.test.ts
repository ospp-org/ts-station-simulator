import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { ScenarioRunner, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';

/**
 * `skip_kind` — WHY an unconditional `skip` was taken, in the distinction `--require-conclusive`
 * reads.
 *
 * `skip: true` used to hard-code `not-applicable`: "nothing about the system under test is in
 * question, nothing was measured and nothing was owed." That is true of the three files that
 * carried it. It is NOT true of `device-management/service-catalog-update`, which is skipped
 * because `POST .../catalog/publish` authorizes `catalog.manage` and no identity a scenario can
 * authenticate as holds it. The catalog round-trip is owed and is not being proven, which is
 * the definition of `inconclusive` — the same kind `requires_files` produces for a missing
 * certificate fixture, reached for a reason that is not a file on disk.
 *
 * The default is pinned in BOTH directions below, because the whole point of SkipKind is that
 * a skip must not acquire the harmless kind by omission.
 */
const target: TargetConfig = {
  mqttUrl: 'mqtt://localhost:1883',
  apiBaseUrl: 'http://localhost:8080',
} as TargetConfig;

function scenario(overrides: Partial<ScenarioDefinition>): ScenarioDefinition {
  return {
    name: 'Test Scenario',
    station: { bayCount: 1, stationModel: 'M', stationVendor: 'V' },
    steps: [],
    ...overrides,
  } as ScenarioDefinition;
}

describe('skip_kind on an unconditional skip', () => {
  it('defaults to not-applicable, which is what every prior `skip: true` meant', async () => {
    const result = await new ScenarioRunner().runScenario(
      scenario({ skip: true, skip_reason: 'server feature not implemented' }),
      target,
    );
    expect(result.status).toBe('skipped');
    expect(result.skipKind).toBe('not-applicable');
  });

  it('carries inconclusive when the file declares it', async () => {
    const result = await new ScenarioRunner().runScenario(
      scenario({ skip: true, skip_kind: 'inconclusive', skip_reason: 'no identity holds the permission' }),
      target,
    );
    expect(result.status).toBe('skipped');
    expect(result.skipKind).toBe('inconclusive');
    expect(result.steps[0]?.error).toContain('no identity holds the permission');
  });

  // ---- THE FILE THAT NEEDED IT ----------------------------------------------
  // Read off disk rather than restated, so this cannot drift from the scenario it describes.
  it('service-catalog-update declares the inconclusive skip and no auth override', () => {
    const path = fileURLToPath(
      new URL('../../../scenarios/device-management/service-catalog-update.yaml', import.meta.url),
    );
    const doc = YAML.parse(readFileSync(path, 'utf-8')) as {
      skip?: boolean;
      skip_kind?: string;
      skip_reason?: string;
      auth?: unknown;
      steps?: unknown[];
    };

    expect(doc.skip).toBe(true);
    expect(doc.skip_kind).toBe('inconclusive');
    expect(doc.skip_reason).toContain('catalog.manage');

    // The `auth:` block is GONE, not merely unused. It named an identity that does not hold
    // the permission, and leaving it in place would say the opposite.
    expect(doc.auth).toBeUndefined();

    // The steps stay. They were proven on the wire against the local stack at cc92bfc and
    // are what a lifted skip would run; a skip that deleted them would lose the proof too.
    expect(Array.isArray(doc.steps) && doc.steps.length).toBeGreaterThan(5);
  });
});
