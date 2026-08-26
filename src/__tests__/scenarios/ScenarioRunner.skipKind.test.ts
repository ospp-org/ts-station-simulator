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
 * question, nothing was measured and nothing was owed." That is true of the files that carry
 * it. It was NOT true of `device-management/service-catalog-update`, which was skipped because
 * `POST .../catalog/publish` authorizes `catalog.manage` and no identity a scenario could
 * authenticate as held it — a round-trip that was owed and was not being proven, which is the
 * definition of `inconclusive`.
 *
 * The default is pinned in BOTH directions below, because the whole point of SkipKind is that
 * a skip must not acquire the harmless kind by omission.
 *
 * ── THE FILE-SPECIFIC CASE WAS RE-POINTED, NOT DELETED, 2026-08-26 ───────────────────────
 *
 * PoolBootstrap now publishes the run's ephemeral `tenant_owner` — which has always held
 * `catalog.manage` — so the file RUNS and the property is proven rather than excused. Its
 * `inconclusive` skip is gone, and a test asserting the skip would now be pinning a state the
 * repair removed.
 *
 * What that case was DEFENDING is unchanged and is still asserted below, in its inverted
 * form. The old rule was "the `auth:` block is GONE, not merely unused — it named an identity
 * that does not hold the permission, and leaving it in place would say the opposite." The rule
 * underneath is: THE FILE MUST NEVER NAME AN IDENTITY THAT CANNOT DO THE JOB. With an identity
 * that can, the same rule requires the block to be PRESENT and to name that one. Deleting the
 * case instead would have dropped the rule along with the state it happened to be phrased in.
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

  // ---- THE FILE THAT NEEDED IT, NOW THAT IT NO LONGER DOES ------------------
  // Read off disk rather than restated, so this cannot drift from the scenario it describes.
  it('service-catalog-update runs, and names the identity that CAN publish', () => {
    const path = fileURLToPath(
      new URL('../../../scenarios/device-management/service-catalog-update.yaml', import.meta.url),
    );
    const doc = YAML.parse(readFileSync(path, 'utf-8')) as {
      skip?: boolean;
      skip_kind?: string;
      requires_pool?: string;
      auth?: { email_env?: string; password_env?: string };
      steps?: unknown[];
    };

    // The skip is LIFTED. Both keys, because `skip_kind` left behind on a running file is a
    // declaration about a skip that no longer happens.
    expect(doc.skip).toBeUndefined();
    expect(doc.skip_kind).toBeUndefined();

    // And the reason it can run is declared, not implicit: outside a bootstrapped run the
    // identity does not exist, and the file must skip as not-applicable rather than throw on
    // an unset environment variable.
    expect(doc.requires_pool).toContain('catalog.manage');

    // THE INVERTED FORM OF THE OLD RULE. The block must be PRESENT and must name the pool
    // owner — the only identity holding `catalog.manage` that a scenario can reach.
    // `UAT_E2E_PLATFORM_ADMIN_*` here would be the exact regression this case has guarded
    // since it was written: an identity named in a file that it cannot serve.
    expect(doc.auth?.email_env).toBe('SIM_POOL_OWNER_EMAIL');
    expect(doc.auth?.password_env).toBe('SIM_POOL_OWNER_PASSWORD');

    // The steps stay. They were proven on the wire against the local stack at cc92bfc and are
    // what the lifted skip now runs; a skip that had deleted them would have lost the proof.
    expect(Array.isArray(doc.steps) && doc.steps.length).toBeGreaterThan(5);
  });
});
