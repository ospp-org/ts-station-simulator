import fs from 'node:fs/promises';
import { StationPool } from '../stations/StationPool.js';
import { buildTeardownSql, type PoolBootstrapHandle } from './PoolBootstrap.js';
import { runUatSql, uatDbConfigFromEnv, type UatDbConfig } from './uatPrivileged.js';

/**
 * Per-scenario record of the server-side rows a scenario CREATED, and the teardown
 * that removes exactly those.
 *
 * WHY THIS EXISTS — the hole, stated plainly.
 *
 * Cleanup in this repo was owned entirely by `--bootstrap-pool`: the bootstrap knows
 * the org, location, stations and users it minted because it minted them, and hands
 * that knowledge to `teardownPool` as a {@link PoolBootstrapHandle}. Everything else
 * relied on a scenario touching only pool-provisioned rows.
 *
 * The three `scenarios/e2e/*` files break that assumption by design. Each is a
 * production-like onboarding journey: it registers its own customer, has a platform
 * admin create an ORGANIZATION for them, adds a location, registers and provisions a
 * station. They carry `skip_when_pooled` precisely because they must NOT run against
 * the shared pool — so they run standalone, where no bootstrap ran, so no handle
 * exists, so nothing is torn down. Not three forgotten `teardown:` blocks: a runner
 * with no notion of "what did this scenario create" and one cleanup path wired to the
 * only component that happened to know. Measured on UAT 2026-08-13: eight leftover
 * `E2E Org …` organizations, one per standalone run since 2026-07-30, each with its
 * station, location and (where the run got that far) its customer.
 *
 * WHAT IT DOES NOT DO — guess. Deleting an organization CASCADEs: its cloned Spatie
 * roles, its members, its service definitions and any remaining station go with it. A
 * cleanup that inferred ownership from a naming convention (`E2E Org %`) or from a
 * captured variable that merely LOOKS like an org id would eventually cascade a real
 * tenant away. So nothing is inferred. A step declares what it created, the ledger
 * records the value the SERVER answered with, and teardown deletes that id and no
 * other. A scenario that declares nothing is torn down not at all — which is the
 * honest outcome, not a silent one.
 *
 * The SQL is not written here. {@link buildTeardownSql} is the single FK-ordered
 * builder, verified against `pg_constraint` and guarded by `teardownFkCoverage.test.ts`;
 * this module's job is to hand it a handle describing one scenario instead of one pool.
 */

/** The resource kinds a scenario step may declare it created. */
export const CREATED_RESOURCE_KINDS = [
  'organization',
  'location',
  'user',
  'station',
] as const;

export type CreatedResourceKind = (typeof CREATED_RESOURCE_KINDS)[number];

export interface RecordedResource {
  kind: CreatedResourceKind;
  /** The identifier teardown will delete by: uuid for org/location, email for user, `stn_…` for station. */
  value: string;
  /** Where it came from, for the leftovers report: `PUT /api/v1/…` + the body path. */
  origin: string;
}

/**
 * Records what one scenario created. Ownership is asserted at the moment of creation
 * (a 201 already answered), never reconstructed afterwards.
 */
export class ScenarioResourceLedger {
  private readonly resources: RecordedResource[] = [];
  private readonly artifactDirs = new Set<string>();

  /**
   * Record one created resource.
   *
   * REFUSES a second organization or a second location, loudly and in-run. Both are
   * singular in {@link PoolBootstrapHandle}, so a second one could only be dropped —
   * and a teardown that drops half of what it was told about, then reports success, is
   * the exact failure this module exists to prevent. The refusal names both ids so the
   * author sees which two collided; lifting it means teaching `buildTeardownSql` the
   * plural form, not silencing this.
   */
  record(kind: CreatedResourceKind, value: string, origin: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `creates: ${kind} resolved to ${JSON.stringify(value)} from ${origin}. The value ` +
        `teardown would delete by must be a non-empty string — check the response path.`,
      );
    }

    if (kind === 'organization' || kind === 'location') {
      const existing = this.resources.find((r) => r.kind === kind);
      if (existing && existing.value !== value) {
        throw new Error(
          `creates: this scenario declared a second ${kind} (${value}, from ${origin}) while ` +
          `already holding ${existing.value} (from ${existing.origin}). Teardown carries one ` +
          `${kind} per scenario, so the second would be LEFT BEHIND while the run reported a ` +
          `clean teardown. Split the scenario, or extend buildTeardownSql to take a ${kind} set.`,
        );
      }
    }

    if (this.resources.some((r) => r.kind === kind && r.value === value)) return;
    this.resources.push({ kind, value, origin });
  }

  /** Record a local artifact directory (keys, certs, bays.json) to remove at teardown. */
  recordArtifactDir(dir: string): void {
    this.artifactDirs.add(dir);
  }

  isEmpty(): boolean {
    return this.resources.length === 0 && this.artifactDirs.size === 0;
  }

  list(): readonly RecordedResource[] {
    return this.resources;
  }

  private valuesOf(kind: CreatedResourceKind): string[] {
    return this.resources.filter((r) => r.kind === kind).map((r) => r.value);
  }

  /**
   * Project the ledger onto the handle {@link buildTeardownSql} consumes.
   *
   * `orgId` is deliberately the CREATED org: it scopes only the seeded-service orphan
   * sweep, which is a no-op here (`seededServiceIds` empty) because a scenario's service
   * definitions are created by the server's own catalog handler inside the org and go
   * with the org's CASCADE. `createdOrgId` is the field that actually deletes, and it is
   * populated only from an explicit `creates: organization` declaration.
   */
  toHandle(): PoolBootstrapHandle {
    const createdOrgId = this.valuesOf('organization')[0];
    const locationId = this.valuesOf('location')[0];
    return {
      orgId: createdOrgId ?? '',
      createdOrgId,
      locationId,
      stationIds: this.valuesOf('station'),
      createdUserEmails: this.valuesOf('user'),
      certFiles: [],
      seededServiceIds: [],
      identityCredentials: [],
      pool: new StationPool(),
    };
  }

  /** One line per resource, for the "here is what is still on the server" report. */
  describe(): string {
    const rows = this.resources.map((r) => `    ${r.kind.padEnd(12)} ${r.value}   (${r.origin})`);
    for (const dir of this.artifactDirs) rows.push(`    ${'artifacts'.padEnd(12)} ${dir}`);
    return rows.join('\n');
  }

  artifactDirList(): string[] {
    return [...this.artifactDirs];
  }
}

/**
 * Delete everything the ledger recorded: server rows in one FK-ordered transaction,
 * then the local key/cert artifacts.
 *
 * Throws on failure — the caller is expected to turn that into a LEFTOVERS report
 * carrying {@link ScenarioResourceLedger.describe}. A teardown that swallowed its own
 * error would leave a run claiming it cleaned up, which is strictly worse than a run
 * that never tried: the ids would be gone from the console and still on the server.
 */
export async function teardownScenarioResources(
  ledger: ScenarioResourceLedger,
  dbConfig: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  if (ledger.isEmpty()) return;

  const handle = ledger.toHandle();
  if (handle.stationIds.length > 0 || handle.createdOrgId || handle.locationId ||
      (handle.createdUserEmails?.length ?? 0) > 0) {
    await runUatSql(buildTeardownSql(handle), dbConfig);
  }

  for (const dir of ledger.artifactDirList()) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
