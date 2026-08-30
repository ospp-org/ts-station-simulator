import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { ScenarioRunner, generateVariables, type ScenarioDefinition, type TargetConfig } from '../../scenarios/ScenarioRunner.js';
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

describe('owns_station — the scenario brings its own station instead of taking one', () => {
  // The pool allocator is what a lease comes from; a scenario that owns its station must take
  // none, or a run of N scenarios exhausts a pool it never used.
  it('takes NO pool lease and resolves stationId to the scenario\'s own fresh id', async () => {
    const runner = new ScenarioRunner();
    runner.setRunPool(new StationPool());
    const withPool: TargetConfig = { ...target, stationPool: ['stn_poolaaaa', 'stn_poolbbbb'] } as TargetConfig;

    const owning = scenario({
      owns_station: 'registers and provisions its own',
      defer_mqtt_connect: true,
      steps: [],
    });
    const result = await runner.runScenario(owning, withPool);
    expect(result.status).not.toBe('skipped');

    // BOTH directions on the same runner: an ordinary scenario still gets a pool station, so
    // a broken opt-out that skipped allocation for everyone would fail here.
    const ordinary = scenario({ defer_mqtt_connect: true, steps: [] });
    const second = await runner.runScenario(ordinary, withPool);
    expect(second.status).not.toBe('skipped');
  });

  // The identity a station-owning file uses must not be one the pool handed out, or the
  // registration it performs answers 409 — which is exactly why the three e2e parcours are
  // skip_when_pooled.
  it('the own id is NOT any pool id', () => {
    const withPool: TargetConfig = { ...target, stationPool: ['stn_poolaaaa'] } as TargetConfig;
    const vars = generateVariables(
      scenario({ owns_station: 'x' }),
      withPool,
      'stn_poolaaaa',
    );
    expect(vars.get('runStationId')).toMatch(/^stn_[0-9a-f]{8}$/);
    expect(vars.get('runStationId')).not.toBe('stn_poolaaaa');
  });

  it('runStationId is fresh per scenario, so two files never collide', () => {
    const a = generateVariables(scenario({}), target, null).get('runStationId');
    const b = generateVariables(scenario({}), target, null).get('runStationId');
    expect(a).not.toBe(b);
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

  // The key is only meaningful for a file that actually reaches for an identity the BOOTSTRAP
  // mints, and the bootstrap mints TWO of them. The gate used to demand the first and only the
  // first — "every file declaring requires_pool authenticates as the run owner" — which was
  // true of the corpus on the day it was written and stopped being true on 2026-08-27.
  //
  //   OWNER   `auth: SIM_POOL_OWNER_*` — the ephemeral `tenant_owner`, the only identity
  //           holding `stations.manage_provisioning_tokens`, `catalog.manage`, `bays.update`.
  //   DEFAULT no `auth:` block at all — the per-scenario `tenant_operator` the bootstrap hands
  //           a file that overrides nothing. Just as pool-only: outside a pooled run the
  //           identity is whatever UAT_EMAIL names, which is a different tier.
  //
  // `bay-edit-requires-the-topology-tier.yaml` is the second kind, and the old gate's own
  // stated reasoning — "claiming a dependency it does not have" — is false about it. Its
  // subject IS the default tier being refused 403 on `bays.update`. Giving it the `auth:`
  // block the gate demanded would have authenticated it as the owner, who HOLDS that
  // permission: both refusals become 201/200, the file goes red, and on the way it writes a
  // bay to a shared pool station. The demanded repair was worse than the defect.
  //
  // SO THE GATE IS TWO-ARMED, and the third shape — an `auth:` block naming SOME OTHER env
  // pair — is still refused. That was the defect worth catching all along: a file claiming a
  // pool dependency while authenticating as an account the pool does not mint would be
  // skipped outside a pool for no reason, and inside one would measure the wrong identity.
  const POOL_DEFAULT_IDENTITY_FILES = [
    'device-management/bay-edit-requires-the-topology-tier.yaml',
  ];

  it('every file declaring requires_pool authenticates as an identity the bootstrap mints', () => {
    const mismatched: string[] = [];
    for (const f of yamlFiles(SCENARIOS_DIR)) {
      const doc = YAML.parse(readFileSync(f, 'utf-8')) as {
        requires_pool?: string;
        auth?: { email_env?: string; password_env?: string };
      } | null;
      if (!doc?.requires_pool) continue;

      // Arm 2: no override at all — the run's default per-scenario tenant_operator.
      if (doc.auth === undefined) continue;

      // Arm 1: the published owner pair, both halves.
      if (
        doc.auth.email_env !== POOL_OWNER_EMAIL_ENV ||
        doc.auth.password_env !== POOL_OWNER_PASSWORD_ENV
      ) {
        mismatched.push(f.slice(SCENARIOS_DIR.length + 1));
      }
    }
    expect(
      mismatched,
      `these declare requires_pool with an auth: block naming neither ${POOL_OWNER_EMAIL_ENV} / ` +
        `${POOL_OWNER_PASSWORD_ENV} nor nothing at all, so the identity they authenticate as ` +
        'is not one a bootstrapped run mints',
    ).toEqual([]);
  });

  // THE DENOMINATOR FOR ARM 2, pinned the way scenarioTimeout.test.ts pins its override list.
  // Arm 2 is an ABSENCE, so without this the widened gate would let a file that simply forgot
  // its `auth:` block pass as though it had chosen the default tier on purpose. Relying on the
  // default is a real decision and should have to be made once, in writing, here.
  it('and the files relying on the pool DEFAULT identity are exactly the ones argued for', () => {
    const usingDefault = yamlFiles(SCENARIOS_DIR)
      .filter((f) => {
        const doc = YAML.parse(readFileSync(f, 'utf-8')) as {
          requires_pool?: string;
          auth?: unknown;
        } | null;

        return Boolean(doc?.requires_pool) && doc?.auth === undefined;
      })
      .map((f) => f.slice(SCENARIOS_DIR.length + 1))
      .sort();

    expect(usingDefault).toEqual(POOL_DEFAULT_IDENTITY_FILES);
  });
});
