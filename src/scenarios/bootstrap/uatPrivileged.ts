import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Privileged UAT database access for the per-run pool bootstrap/teardown.
 *
 * UAT runs on a remote host (Server 1) in a `csms-postgres-uat` container,
 * reachable from the dev box over SSH. A handful of operations the OSPP server
 * exposes NO application/admin/API path for — notably flipping
 * `users.offline_enabled` (DB-only, see INVESTIGATE doc Q2) and a targeted
 * FK-safe teardown of provisioned rows — are performed here as raw SQL.
 *
 * SQL is delivered over psql STDIN (`docker exec -i … psql`), never as a `-c`
 * shell argument, so SQL text is not subject to remote-shell interpolation.
 * Literal values are still single-quote-escaped via {@link sqlLiteral} as
 * defense-in-depth (inputs are trusted: hex station IDs, configured email).
 *
 * All connection parameters are overridable via env so nothing host-specific
 * is hard-coded into committed behavior beyond sane defaults.
 */
export interface UatDbConfig {
  sshHost: string;
  sshKey: string;
  container: string;
  dbUser: string;
  dbName: string;
}

export function uatDbConfigFromEnv(): UatDbConfig {
  const home = os.homedir();
  const rawKey = process.env.UAT_SSH_KEY ?? path.join(home, '.ssh', 'id_ed25519');
  return {
    sshHost: process.env.UAT_SSH_HOST ?? 'gabi@89.33.25.117',
    // Expand a leading ~ since spawn() does not run a shell to do it for us.
    sshKey: rawKey.replace(/^~(?=$|\/)/, home),
    container: process.env.UAT_DB_CONTAINER ?? 'csms-postgres-uat',
    dbUser: process.env.UAT_DB_USER ?? 'csms_uat',
    dbName: process.env.UAT_DB_NAME ?? 'csms_uat',
  };
}

/** Single-quote-escape a SQL string literal (doubles embedded quotes). */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run a SQL script against the UAT database over SSH+psql, feeding the SQL on
 * stdin. Resolves with psql stdout; rejects (with stderr) on a non-zero exit.
 * `ON_ERROR_STOP=1` makes any statement error abort the whole script.
 */
export function runUatSql(sql: string, cfg: UatDbConfig = uatDbConfigFromEnv()): Promise<string> {
  const remoteCmd =
    `docker exec -i ${cfg.container} psql -U ${cfg.dbUser} -d ${cfg.dbName} ` +
    `-v ON_ERROR_STOP=1 --no-psqlrc -q`;
  const args = [
    '-i', cfg.sshKey,
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    cfg.sshHost,
    remoteCmd,
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) =>
      reject(new Error(`runUatSql: failed to spawn ssh — ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `runUatSql: psql exited ${code ?? 'null'} — ${(stderr || stdout).trim().slice(0, 600)}`,
          ),
        );
      }
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/**
 * Fail-fast connectivity + credentials check. Throws a clear, actionable error
 * if the UAT DB cannot be reached so the bootstrap aborts before mutating
 * anything (rather than half-provisioning then failing on the offline step).
 */
export async function assertUatDbReachable(cfg: UatDbConfig = uatDbConfigFromEnv()): Promise<void> {
  try {
    await runUatSql('SELECT 1;', cfg);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `UAT DB unreachable (${cfg.sshHost} → ${cfg.container}). Privileged steps ` +
      `(offline-enable, teardown) require SSH+psql access. Override via UAT_SSH_HOST/` +
      `UAT_SSH_KEY/UAT_DB_CONTAINER/UAT_DB_USER/UAT_DB_NAME. Underlying: ${detail}`,
    );
  }
}

/** Set users.offline_enabled for a single user by email. Idempotent. */
export async function setOfflineEnabled(
  email: string,
  enabled: boolean,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  await runUatSql(
    `UPDATE users SET offline_enabled = ${enabled ? 'true' : 'false'} WHERE email = ${sqlLiteral(email)};`,
    cfg,
  );
}

// ---------------------------------------------------------------------------
// Service catalog seed (Brief L three-tier model)
// ---------------------------------------------------------------------------

export type SeededPricingType = 'PerMinute' | 'Fixed';

export interface SeededService {
  serviceId: string;       // svc_*
  serviceName: string;
  pricingType: SeededPricingType;
  priceCreditsPerMinute?: number | null;
  priceCreditsFixed?: number | null;
}

/**
 * Canonical default service set used by the per-run pool bootstrap. Matches the runner's
 * `defaultServices` map (`ScenarioRunner.ts:374`) so `{{serviceId_1..4}}` resolves to a real
 * `station_services` row on every bootstrapped station. Names match what the runner emits
 * in outbound payloads (`PoolBootstrap.ts:386` + `ScenarioRunner.ts:483-487` for serviceId_1;
 * canonical extensions for 2..4).
 */
export const DEFAULT_SEED_SERVICES: ReadonlyArray<SeededService> = [
  { serviceId: 'svc_wash_basic',   serviceName: 'Basic Wash',   pricingType: 'PerMinute', priceCreditsPerMinute: 100 },
  { serviceId: 'svc_wash_premium', serviceName: 'Premium Wash', pricingType: 'PerMinute', priceCreditsPerMinute: 100 },
  { serviceId: 'svc_dry',          serviceName: 'Dry',          pricingType: 'PerMinute', priceCreditsPerMinute: 100 },
  { serviceId: 'svc_vacuum',       serviceName: 'Vacuum',       pricingType: 'PerMinute', priceCreditsPerMinute: 100 },
];

/**
 * Build the JSON payload byte-identical to csms-server's `ServiceItemDto::toPayload()` →
 * stored in `service_catalogs.services_data` so the audit row matches what a real
 * `UpdateServiceCatalog REQ → station Accepted` roundtrip would have written. Key order
 * follows the PHP DTO insertion order: `serviceId`, `serviceName`, `pricingType`,
 * `available`, then the pricing key for the chosen `pricingType`. JS object key order is
 * insertion order for non-integer string keys, and `JSON.stringify` preserves it.
 */
export function buildServicesPayloadJson(services: ReadonlyArray<SeededService>): string {
  const payload = services.map((s) => {
    const entry: Record<string, unknown> = {
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      pricingType: s.pricingType,
      available: true,
    };
    if (s.pricingType === 'PerMinute') {
      entry.priceCreditsPerMinute = s.priceCreditsPerMinute ?? null;
    } else {
      entry.priceCreditsFixed = s.priceCreditsFixed ?? null;
    }
    return entry;
  });
  return JSON.stringify(payload);
}

/**
 * Build the seed SQL (separated from {@link seedServiceCatalog} for unit-testability). One
 * transaction. Behavior mirrors `UpdateServiceCatalogResponseHandler::handleAccepted`:
 *
 *   1. `service_definitions`: `INSERT … ON CONFLICT (organization_id, service_id) DO NOTHING`
 *      — handler's `resolveOrCreateDefinition` returns an existing row without overwriting,
 *      so we MUST NOT overwrite either (definition updates flow through dedicated REST per
 *      Brief L-prime).
 *   2. `station_services`: `INSERT … ON CONFLICT (station_id, service_definition_id) DO
 *      UPDATE SET …` — mirrors Laravel `updateOrInsert`.
 *   3. `service_catalogs` audit row + `stations.current_catalog_version = '1'`: scoped to
 *      stations whose `current_catalog_version IS NULL`, so re-seeding never double-writes
 *      an audit row or restarts the monotonic-version sequence.
 *
 * `bay_services` is intentionally not touched (handler doesn't write it either; the write
 * path is Brief L-prime; the table is empty by design until then).
 */
export function buildSeedCatalogSql(
  orgId: string,
  stationIds: string[],
  services: ReadonlyArray<SeededService>,
): string {
  if (stationIds.length === 0 || services.length === 0) {
    return 'BEGIN;\nCOMMIT;';
  }

  const orgLit = sqlLiteral(orgId);
  const stationArr = `ARRAY[${stationIds.map(sqlLiteral).join(', ')}]::text[]`;
  const svcArr = `ARRAY[${services.map((s) => sqlLiteral(s.serviceId)).join(', ')}]::text[]`;
  const servicesJsonLit = sqlLiteral(buildServicesPayloadJson(services));

  const defRows = services
    .map((s) => {
      const ppm =
        s.pricingType === 'PerMinute' && s.priceCreditsPerMinute != null
          ? String(s.priceCreditsPerMinute)
          : 'NULL';
      const pcf =
        s.pricingType === 'Fixed' && s.priceCreditsFixed != null
          ? String(s.priceCreditsFixed)
          : 'NULL';
      return `(${orgLit}, ${sqlLiteral(s.serviceId)}, ${sqlLiteral(s.serviceName)}, ${sqlLiteral(s.pricingType)}, ${ppm}, ${pcf})`;
    })
    .join(',\n  ');

  return [
    'BEGIN;',
    // 1. service_definitions: ON CONFLICT DO NOTHING (mirrors resolveOrCreateDefinition).
    'INSERT INTO service_definitions (organization_id, service_id, service_name, pricing_type, recommended_price_credits_per_minute, recommended_price_credits_fixed)',
    'VALUES',
    `  ${defRows}`,
    'ON CONFLICT (organization_id, service_id) DO NOTHING;',
    // 2. station_services: UPSERT (mirrors updateOrInsert). Cross-join the bootstrapped
    //    stations × the seeded definitions, filtered to the seed's org + svc_* set.
    'INSERT INTO station_services (station_id, service_definition_id, price_credits_per_minute, available)',
    'SELECT s.id, sd.id, 100, true',
    'FROM stations s, service_definitions sd',
    `WHERE s.station_id = ANY(${stationArr})`,
    `  AND sd.organization_id = ${orgLit}`,
    `  AND sd.service_id = ANY(${svcArr})`,
    'ON CONFLICT (station_id, service_definition_id) DO UPDATE SET',
    '  price_credits_per_minute = EXCLUDED.price_credits_per_minute,',
    '  available = EXCLUDED.available,',
    '  updated_at = NOW();',
    // 3. service_catalogs audit row — only for never-seeded stations (current_catalog_version
    //    IS NULL). Re-seeding never double-writes.
    'INSERT INTO service_catalogs (station_id, catalog_version, previous_catalog_version, services_data, applied_at, created_at)',
    `SELECT s.id, '1', NULL, ${servicesJsonLit}::jsonb, NOW(), NOW()`,
    'FROM stations s',
    `WHERE s.station_id = ANY(${stationArr})`,
    '  AND s.current_catalog_version IS NULL;',
    // 4. stations.current_catalog_version bump — first-push only (preserves natural
    //    increment for any subsequent real UpdateServiceCatalog).
    "UPDATE stations SET current_catalog_version = '1', updated_at = NOW()",
    `WHERE station_id = ANY(${stationArr})`,
    '  AND current_catalog_version IS NULL;',
    'COMMIT;',
  ].join('\n');
}

/**
 * Seed the three-tier catalog (`service_definitions` + `station_services` + `service_catalogs`)
 * for a set of bootstrapped stations within an organization, producing rows operationally
 * indistinguishable from what `UpdateServiceCatalogResponseHandler::handleAccepted` would
 * write for a real `UpdateServiceCatalog REQ → station Accepted` MQTT roundtrip. Atomic per
 * call (see {@link buildSeedCatalogSql} for the SQL contract).
 */
export async function seedServiceCatalog(
  orgId: string,
  stationIds: string[],
  services: ReadonlyArray<SeededService>,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  if (stationIds.length === 0 || services.length === 0) return;
  await runUatSql(buildSeedCatalogSql(orgId, stationIds, services), cfg);
}
