import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { ScenarioRunner, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';
import { StationPool } from '../../scenarios/stations/StationPool.js';
import {
  POOL_OWNER_EMAIL_ENV,
  POOL_OWNER_PASSWORD_ENV,
  exportEphemeralOwnerToEnv,
  clearEphemeralOwnerFromEnv,
} from '../../scenarios/bootstrap/PoolBootstrap.js';

/**
 * `requires_pool` — the INVERSE of `skip_when_pooled`, for a file whose precondition the
 * per-run bootstrap PRODUCES and that exists nowhere else.
 *
 * The precondition is the run's ephemeral `tenant_owner`: the only identity a scenario can
 * authenticate as that holds `stations.manage_provisioning_tokens` or `catalog.manage`. It is
 * minted and deleted inside one run, so there is nothing to source from a secrets file, and a
 * file needing it must be SKIPPED outside a pooled run rather than fail on an unset variable.
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

const SCENARIOS_DIR = fileURLToPath(new URL('../../../scenarios', import.meta.url));

function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...yamlFiles(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }

  return out;
}

afterEach(() => {
  clearEphemeralOwnerFromEnv();
});

describe('requires_pool — a file whose identity only exists inside a bootstrapped run', () => {
  // ---- BOTH DIRECTIONS ------------------------------------------------------
  // A conditional skip asserted in one direction only is indistinguishable from an
  // unconditional one.
  it('SKIPS when there is no pool, and the reason says how to run it', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ requires_pool: 'Needs the run tenant_owner.' }),
      target,
    );
    expect(result.status).toBe('skipped');
    expect(result.steps[0]?.error).toContain('Needs the run tenant_owner.');
    expect(result.steps[0]?.error).toContain('--bootstrap-pool');
  });

  it('does NOT skip when a pool is present', async () => {
    const runner = new ScenarioRunner();
    runner.setRunPool(new StationPool());
    const result = await runner.runScenario(
      scenario({ requires_pool: 'x', defer_mqtt_connect: true, steps: [] }),
      target,
    );
    expect(result.status).not.toBe('skipped');
  });

  // The skip is 'not-applicable', never 'inconclusive': nothing about the system under test
  // is in question when the run simply was not given a pool. --require-conclusive must stay
  // green on it, which is the opposite of the catalog file's PREVIOUS state.
  it('skips as not-applicable, so --require-conclusive does not fire on it', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(scenario({ requires_pool: 'x' }), target);
    expect(result.skipKind).toBe('not-applicable');
  });

  it('refuses nothing when the key is absent (the default path is untouched)', async () => {
    const runner = new ScenarioRunner();
    const result = await runner.runScenario(
      scenario({ defer_mqtt_connect: true, steps: [] }),
      target,
    );
    expect(result.status).not.toBe('skipped');
  });
});

describe('the identity the key exists for', () => {
  it('publishes email AND password, and teardown removes both', () => {
    clearEphemeralOwnerFromEnv();
    expect(process.env[POOL_OWNER_EMAIL_ENV]).toBeUndefined();

    exportEphemeralOwnerToEnv({
      token: 't',
      orgId: 'o',
      ownerEmail: 'sim-pool-owner-abc@onestoppay.dev',
      ownerPassword: 'Pp1!deadbeef',
    });
    expect(process.env[POOL_OWNER_EMAIL_ENV]).toBe('sim-pool-owner-abc@onestoppay.dev');
    expect(process.env[POOL_OWNER_PASSWORD_ENV]).toBe('Pp1!deadbeef');

    // Both halves, because clearing only the email leaves a password in the environment of a
    // deleted account — the thing the teardown call exists to prevent.
    clearEphemeralOwnerFromEnv();
    expect(process.env[POOL_OWNER_EMAIL_ENV]).toBeUndefined();
    expect(process.env[POOL_OWNER_PASSWORD_ENV]).toBeUndefined();
  });
});

describe('the corpus uses the pair consistently', () => {
  // ---- DENOMINATOR ----------------------------------------------------------
  it('reads the corpus and finds files declaring the key', () => {
    const declaring = yamlFiles(SCENARIOS_DIR).filter((f) => {
      const doc = YAML.parse(readFileSync(f, 'utf-8')) as { requires_pool?: string } | null;

      return typeof doc?.requires_pool === 'string' && doc.requires_pool !== '';
    });
    expect(declaring.length).toBeGreaterThan(0);
  });

  // A file declaring both can never run in ANY invocation: pooled runs hit skip_when_pooled,
  // unpooled runs hit requires_pool. That is a permanently-skipped file wearing two honest
  // reasons, which is how a scenario disappears without anyone deciding to delete it.
  it('no file declares requires_pool AND skip_when_pooled', () => {
    const both: string[] = [];
    for (const f of yamlFiles(SCENARIOS_DIR)) {
      const doc = YAML.parse(readFileSync(f, 'utf-8')) as {
        requires_pool?: string;
        skip_when_pooled?: string;
      } | null;
      if (doc?.requires_pool && doc.skip_when_pooled) both.push(f.slice(SCENARIOS_DIR.length + 1));
    }
    expect(both, 'a file declaring both can never run in any invocation').toEqual([]);
  });

  // The key is only meaningful for a file that actually reaches for the run identity. A file
  // declaring it without an `auth:` block pointing at the published pair is claiming a
  // dependency it does not have, and would be skipped outside a pool for no reason.
  it('every file declaring requires_pool authenticates as the run owner', () => {
    const mismatched: string[] = [];
    for (const f of yamlFiles(SCENARIOS_DIR)) {
      const doc = YAML.parse(readFileSync(f, 'utf-8')) as {
        requires_pool?: string;
        auth?: { email_env?: string; password_env?: string };
      } | null;
      if (!doc?.requires_pool) continue;
      if (
        doc.auth?.email_env !== POOL_OWNER_EMAIL_ENV ||
        doc.auth?.password_env !== POOL_OWNER_PASSWORD_ENV
      ) {
        mismatched.push(f.slice(SCENARIOS_DIR.length + 1));
      }
    }
    expect(
      mismatched,
      `these declare requires_pool without an auth: block naming ${POOL_OWNER_EMAIL_ENV} / ` +
        `${POOL_OWNER_PASSWORD_ENV}, so the dependency they declare is not the one they have`,
    ).toEqual([]);
  });
});
