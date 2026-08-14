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

/**
 * The identity arguments EVERY ssh spawn in this repo must carry.
 *
 * `-i` alone only APPENDS a key: ssh still offers every identity the agent
 * holds, in agent order, before it reaches ours. On a box whose agent carries a
 * dozen deploy keys that is a dozen failed publickey attempts per connection,
 * and the UAT host's fail2ban counts them — one bootstrap fan-out has already
 * earned this machine an hour-long ban. `IdentitiesOnly=yes` is what makes `-i`
 * mean "this key and no other".
 *
 * An earlier pass worked around the fan-out by blanking `SSH_AUTH_SOCK` in the
 * LAUNCHER's environment. That is a property of whoever remembers to export it,
 * not of the call: any caller that spawns us with an inherited env (`npx
 * simulator run`, a CI step, another script) gets the fan-out back with nothing
 * to show it went missing. A spawn argument travels with the command, so the
 * flag lives here — in one function every ssh call site uses.
 */
export function sshIdentityArgs(cfg: UatDbConfig = uatDbConfigFromEnv()): string[] {
  return ['-i', cfg.sshKey, '-o', 'IdentitiesOnly=yes'];
}

/** Single-quote-escape a SQL string literal (doubles embedded quotes). */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * C-018 invariant guard. The ambient permanent platform admin user (seeded
 * once on UAT via E2EBootstrapSeeder) must NEVER appear in any teardown
 * DELETE — its model_has_roles row (organization_id NULL) is what makes
 * POST /v1/organizations work for every future e2e run. Deleting that user
 * silently cascades the NULL-scoped role binding away.
 *
 * Reads two env vars by default:
 *   - UAT_E2E_PLATFORM_ADMIN_EMAIL   (sourced from ~/.config/osp-e2e-secrets.env)
 *   - E2E_PLATFORM_ADMIN_EMAIL       (the seeder-side counterpart from
 *                                     database/seeders/E2EBootstrapSeeder.php)
 *
 * Empty-string values are treated as unset (the seeder rejects empty
 * passwords too, so empty email is invalid by symmetry). Underscore prefix
 * marks this as a test seam — production callers omit the env argument and
 * fall through to `process.env`.
 */
export function _readProtectedEmailsForTesting(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [env.UAT_E2E_PLATFORM_ADMIN_EMAIL, env.E2E_PLATFORM_ADMIN_EMAIL]
    .filter((e): e is string => typeof e === 'string' && e.length > 0);
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
    ...sshIdentityArgs(cfg),
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

// ---------------------------------------------------------------------------
// Identity funding — how much is "enough"
// ---------------------------------------------------------------------------

/**
 * The server's ceiling on a REST-started session, in seconds. `config/ospp.php:230`
 * (`OSPP_MAX_SESSION_DURATION_SECONDS`, default 600) and re-enforced at the request layer,
 * `StartSessionRequest.php:56` `'max:'.(int) config('ospp.max_session_duration_seconds', 600)`.
 * A per-station `station_configurations` row can LOWER it; nothing can raise it past the
 * request rule, so no `POST /sessions/start` can ever authorize more than this many seconds.
 */
export const MAX_SESSION_DURATION_SECONDS = 600;

/**
 * Credits a single `POST /sessions/start` would authorize for {@link service} at the server's
 * maximum accepted duration. Mirrors `StartSessionAction.php:205-209` exactly:
 *
 *   creditsAuthorized = pricingType === 'Fixed'
 *       ? priceCreditsFixed
 *       : ceil(effectiveDuration / 60 * priceCreditsPerMinute)
 */
function maxCreditsAuthorizedFor(service: SeededService): number {
  if (service.pricingType === 'Fixed') return service.priceCreditsFixed ?? 0;
  return Math.ceil(MAX_SESSION_DURATION_SECONDS / 60 * (service.priceCreditsPerMinute ?? 0));
}

/**
 * The wallet balance every bootstrapped identity is seeded with — 1000 credits, DERIVED
 * rather than chosen: the largest single authorization the server can accept against the
 * seeded catalog (`ceil(600/60) × 100`). Recomputes itself if either input moves.
 *
 * WHY THIS IS THE FIX. `StartSessionAction.php:241-250` refuses a card-free start when
 * `walletQuery->getBalance() < $creditsAuthorized` — 402 `INSUFFICIENT_BALANCE` / ospp_code
 * 4001. `SessionController::start` builds the DTO with `userId` set and `paymentIntentId`
 * null, so EVERY REST start enters that gate. Seeding at balance 0 (which this file did
 * until now) meant the corpus had coherently built a world where sessions start without
 * money, because the server used to permit it. The gate is correct; the fixture was wrong.
 *
 * WHY THE MAXIMUM OF ONE START AND NOT THE SUM OF A SCENARIO'S STARTS. The online session
 * path never debits the wallet: `CompleteSessionAction.php:133-139` writes the
 * `sessions.credits_charged` COLUMN and nothing else, and the only two `WalletDebitInterface`
 * consumers in the whole server are in the Offline module (`AuthorizeOfflineSessionAction`,
 * `Reconciler`). A funded balance is therefore never drawn down by an online session, so the
 * second and sixth start in a scenario are checked against the same undiminished number as
 * the first. The requirement is a MAXIMUM, not a running total.
 *
 * WHY NOT A LARGE ROUND NUMBER. A comfortable 1_000_000 would pass everything including a
 * scenario whose subject IS the refusal — it would fund the very thing under test and report
 * a green. The tightest sufficient value keeps that scenario honest, and a scenario that
 * genuinely wants a different balance now has to say so: `wallet_balance:` in its YAML
 * (see `ScenarioDefinition.wallet_balance`), never inherited from this default.
 *
 * Offline pass ISSUANCE is not a consumer of this number: `IssueOfflinePassAction.php:92-101`
 * refuses only `balance < 0`, so 0 already satisfied it. The claim at
 * `docs/RUNNING-AGAINST-UAT.md` that the 2 offline-pass scenarios fail on wallet balance is
 * stale on both halves — see that file's own correction.
 */
export const DEFAULT_IDENTITY_WALLET_CREDITS: number =
  Math.max(...DEFAULT_SEED_SERVICES.map(maxCreditsAuthorizedFor));

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
 *   3. `bay_services`: the service→program binding, one row per (bay × station_service).
 *      This USED to be left empty on the grounds that the catalog handler does not write it
 *      either. That was true and it made two things impossible:
 *
 *        - `service-catalog-update.yaml` could never pass. `UpdateServiceCatalogAction::
 *          resolveBindings()` throws VALIDATION_ERROR when the join is empty, ungated by any
 *          flag, so the PUT could not return 202 on any run. The scenario failed every time
 *          for a fixture reason that read as a server regression.
 *        - `ServiceProgramResolver::resolve()` returned null for every start, so
 *          `StartSessionAction` OMITTED `programNumber` from the StartService REQUEST —
 *          a field `start-service-request.schema.json` makes REQUIRED. 29 scenarios waved a
 *          non-conformant server message through without noticing.
 *
 *      `program_number` is taken from `bay_programs` (MIN per bay) rather than assumed, so a
 *      binding can only ever name an ordinal the station actually DECLARED at provisioning —
 *      the same invariant `StationServiceCatalogController::bindProgram` enforces when it
 *      answers 422/3017. A station with no `bay_programs` rows therefore gets no bindings
 *      rather than an invented one: that is the pre-`bays[]` fleet, and guessing on its
 *      behalf is what 3017 exists to prevent.
 *
 *   4. `service_catalogs` audit row + `stations.current_catalog_version = '1'`: scoped to
 *      stations whose `current_catalog_version IS NULL`, so re-seeding never double-writes
 *      an audit row or restarts the monotonic-version sequence.
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
    // 3. bay_services: the service->program binding. Scoped exactly like step 2, and joined
    //    to bay_programs so program_number can only be an ordinal the bay DECLARED. MIN()
    //    picks the bay's lowest declared ordinal deterministically (the bootstrap declares
    //    one program per bay, so this is that program). A bay with no declared programs
    //    contributes no row — see the docblock.
    'INSERT INTO bay_services (bay_id, station_service_id, program_number, available)',
    'SELECT b.id, ss.id, MIN(bp.program_number), true',
    'FROM bays b',
    '  JOIN stations s ON s.id = b.station_id',
    '  JOIN station_services ss ON ss.station_id = s.id',
    '  JOIN service_definitions sd ON sd.id = ss.service_definition_id',
    '  JOIN bay_programs bp ON bp.bay_id = b.id',
    `WHERE s.station_id = ANY(${stationArr})`,
    `  AND sd.organization_id = ${orgLit}`,
    `  AND sd.service_id = ANY(${svcArr})`,
    'GROUP BY b.id, ss.id',
    'ON CONFLICT (bay_id, station_service_id) DO UPDATE SET',
    '  program_number = EXCLUDED.program_number,',
    '  available = EXCLUDED.available,',
    '  updated_at = NOW();',
    // 4. service_catalogs audit row — only for never-seeded stations (current_catalog_version
    //    IS NULL). Re-seeding never double-writes.
    'INSERT INTO service_catalogs (station_id, catalog_version, previous_catalog_version, services_data, applied_at, created_at)',
    `SELECT s.id, '1', NULL, ${servicesJsonLit}::jsonb, NOW(), NOW()`,
    'FROM stations s',
    `WHERE s.station_id = ANY(${stationArr})`,
    '  AND s.current_catalog_version IS NULL;',
    // 5. stations.current_catalog_version bump — first-push only (preserves natural
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

// ---------------------------------------------------------------------------
// Per-worker identity seed (test users + wallet + org membership + Spatie role)
// ---------------------------------------------------------------------------

/**
 * Fully-qualified Spatie `model_type` for the `User` model. Single backslashes in the value
 * are critical — Spatie compares `model_has_roles.model_type` to `User::class` (which PHP
 * renders as `App\Modules\Auth\Models\User`). Double-escaping it breaks the lookup silently
 * (the row is written, but Spatie can't find it).
 */
const USER_MODEL_TYPE = 'App\\Modules\\Auth\\Models\\User';

/**
 * One identity to seed. `walletBalance` is OPTIONAL and omission means
 * {@link DEFAULT_IDENTITY_WALLET_CREDITS} — the asymmetry is the point. Funding is what a
 * caller gets for free; an unfunded identity (balance 0) can only be produced by naming the
 * 0, which is what makes a refusal scenario's fixture legible instead of accidental.
 */
export interface SeededIdentity {
  email: string;
  walletBalance?: number;
}

/**
 * Group identities by their effective wallet balance, resolving the default. Returns
 * `Map<balance, email[]>`; insertion order follows first appearance, so the emitted SQL is
 * deterministic for a given input (the tests assert on the exact string).
 */
function groupByBalance(identities: ReadonlyArray<SeededIdentity>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const identity of identities) {
    const balance = identity.walletBalance ?? DEFAULT_IDENTITY_WALLET_CREDITS;
    const group = groups.get(balance);
    if (group) group.push(identity.email);
    else groups.set(balance, [identity.email]);
  }
  return groups;
}

/**
 * Build the per-run identity-seed SQL. One transaction. For each email in {@link emails}
 * (whose owners must NOT exist yet — UNIQUE on `users.email`), inserts:
 *
 *   1. `users` — copies `password_hash` from {@link copyPasswordFromEmail}'s row, so each
 *      seeded user logs in with the same password as that source user (the bootstrap's
 *      admin identity). `is_active = true`, `email_verified = true`.
 *   2. `wallets` — RegisterAction creates this when a user self-registers; AcceptInvite
 *      does NOT. We add it for safety: settlement code downstream (session stop / receipt
 *      issuance) may read or debit the wallet, and a missing row would 500 there. The
 *      balance is per-identity ({@link identities}), defaulting to
 *      {@link DEFAULT_IDENTITY_WALLET_CREDITS} — see 2b.
 *   2b. `wallet_entries` — one `credit` row per FUNDED identity, mirroring
 *      `WalletSeeder.php:36-46` (type `credit`, `balance_after` = the seeded balance,
 *      `reference_type` 'bonus'). Nothing in the server reconciles `wallets.balance`
 *      against `SUM(wallet_entries)` — `verifyBalanceChain()` has one caller and it is a
 *      test — so this row is not needed to make the balance READ. It is written because
 *      the next real `WalletLedger` operation computes its own `balance_after` from the
 *      column: without a matching entry the ledger chain silently forks from the history,
 *      and the last session that had to undo a fixture leak here could only restore the
 *      true balances BECAUSE the ledger still carried them. Skipped when the balance is 0
 *      (`CHECK (amount > 0)` on the table, and there is nothing to record).
 *   3. `organization_members` — links the user to {@link orgId} with role `tenant_operator`.
 *      The Spatie tenant_operator role doesn't carry `sessions.start` (per RolesAndPermissions
 *      Seeder.php:349-368), but the session-mutate routes are gated only on `auth.jwt +
 *      idempotency.required + throttle:session-mutate` — no Spatie permission check — so
 *      any authenticated identity works. tenant_operator is the principled non-owner role.
 *   4. `model_has_roles` — mirrors `MemberObserver::assignSpatieRole` (`MemberObserver.php:
 *      141-149`) which itself bypasses Eloquent with a raw `DB::table()->updateOrInsert`.
 *      Looks up the per-org `tenant_operator` role row; the per-org variant must exist
 *      (`MemberObserver.php:175-201` resolves it scoped to the org).
 *
 * All four are scoped by the email set, so re-running on a previously-seeded set is a no-op.
 *
 * SCOPING. Every statement here is an INSERT against rows this run is creating, keyed by
 * emails that carry the run's own `runStamp`. That is deliberate and it is the fix for a
 * real incident: a previous session funded wallets with a follow-up
 * `UPDATE … WHERE email LIKE 'sim-worker-%'`, which also matched the PRE-EXISTING July
 * fixtures and overwrote ten wallets, three of them legitimately non-zero. Funding at INSERT
 * time cannot reach a row this run did not create — the hazard is removed by construction,
 * not by being careful with a WHERE clause.
 */
export function buildSeedTestUsersSql(
  orgId: string,
  copyPasswordFromEmail: string,
  identities: ReadonlyArray<SeededIdentity>,
  offlineEnabled: boolean = false,
): string {
  if (identities.length === 0) return 'BEGIN;\nCOMMIT;';

  const emails = identities.map((i) => i.email);
  const orgLit = sqlLiteral(orgId);
  const copyLit = sqlLiteral(copyPasswordFromEmail);
  const emailArr = `ARRAY[${emails.map(sqlLiteral).join(', ')}]::text[]`;
  const userModelLit = sqlLiteral(USER_MODEL_TYPE);
  const offlineLit = offlineEnabled ? 'true' : 'false';

  const lines = ['BEGIN;'];

  // 1. users: one row per email, password_hash + auth_provider copied from the source user.
  //    name defaults to the email (humans don't read it in tests). offline_enabled is set
  //    per the bootstrap option so per-worker users match what the scenarios will request
  //    (e.g. offline-pass-authorize needs the caller's `offline_enabled = true`).
  for (const email of emails) {
    const emailLit = sqlLiteral(email);
    lines.push(
      `INSERT INTO users (email, password_hash, name, is_active, email_verified, offline_enabled) ` +
      `SELECT ${emailLit}, password_hash, ${emailLit}, true, true, ${offlineLit} ` +
      `FROM users WHERE email = ${copyLit};`,
    );
  }

  // 2. wallets: one row per seeded user; version 1 (mirrors RegisterAction). The balance is
  //    per-identity and defaults to DEFAULT_IDENTITY_WALLET_CREDITS — a zero balance is only
  //    ever seeded because an identity asked for one. Grouped by balance so the common case
  //    (every identity on the default) stays a single statement.
  for (const [balance, group] of groupByBalance(identities)) {
    const groupArr = `ARRAY[${group.map(sqlLiteral).join(', ')}]::text[]`;
    lines.push(
      `INSERT INTO wallets (user_id, balance, version, created_at, updated_at) ` +
      `SELECT id, ${balance}, 1, NOW(), NOW() FROM users WHERE email = ANY(${groupArr});`,
    );

    // 2b. wallet_entries: the ledger half of a funded wallet (see the doc block above).
    //     `amount` carries a CHECK (amount > 0), so an unfunded identity gets no entry —
    //     and has nothing to record anyway.
    if (balance > 0) {
      lines.push(
        `INSERT INTO wallet_entries ` +
        `(wallet_id, type, amount, balance_after, reference_type, reference_id, description, idempotency_key, created_at) ` +
        `SELECT w.id, 'credit'::wallet_entry_type, ${balance}, ${balance}, 'bonus', 'sim_bootstrap_seed', ` +
        `'Simulator bootstrap identity funding', 'sim-seed:' || u.email, NOW() ` +
        `FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.email = ANY(${groupArr});`,
      );
    }
  }

  // 3. organization_members: link each user as tenant_operator to the org.
  lines.push(
    `INSERT INTO organization_members (organization_id, user_id, role, is_active) ` +
    `SELECT ${orgLit}, id, 'tenant_operator', true FROM users WHERE email = ANY(${emailArr});`,
  );

  // 4. model_has_roles: bind Spatie tenant_operator role to each user. Mirrors
  //    MemberObserver::assignSpatieRole exactly (same columns, same {role_id, model_id,
  //    model_type, organization_id} shape).
  lines.push(
    `INSERT INTO model_has_roles (role_id, model_id, model_type, organization_id) ` +
    `SELECT ` +
    `(SELECT id FROM roles WHERE name = 'tenant_operator' AND guard_name = 'web' AND organization_id = ${orgLit}), ` +
    `u.id, ${userModelLit}, ${orgLit} ` +
    `FROM users u WHERE u.email = ANY(${emailArr});`,
  );

  lines.push('COMMIT;');
  return lines.join('\n');
}

/**
 * Build the per-run identity-teardown SQL. Drops all user-side state scoped to the run's
 * stamped emails. Idempotent — re-running on already-empty state matches zero rows. Returns
 * the DELETE statements (no BEGIN/COMMIT) so the caller can fold them into a larger
 * teardown transaction.
 *
 * Coverage rationale (verified against `pg_constraint` 2026-06-02; snapshot is the
 * SCHEMA_FK_GRAPH constant in `__tests__/scenarios/bootstrap/teardownFkCoverage.test.ts`,
 * which P1-asserts this builder against the graph):
 *
 *   `users` has 11 FK children. `api_keys.user_id` and `refresh_tokens.user_id` are
 *   ON DELETE CASCADE — the final `DELETE FROM users` removes them automatically.
 *   The remaining NINE FKs are NO ACTION and would block the user delete unless we
 *   delete from each child first. `wallets` itself has a NO-ACTION child
 *   (`wallet_entries.wallet_id`) so wallet_entries must precede wallets which must
 *   precede users.
 *
 *   Spatie tracks role + permission grants via two polymorphic tables
 *   (`model_has_roles`, `model_has_permissions`) — there's no actual FK on `model_id`,
 *   so they don't BLOCK the user delete, but they ARE state we seed (the runner
 *   inserts model_has_roles in the seed step) so we sweep them to avoid orphans.
 *
 *   `invitations` blocks via `invited_by` (the inviter). Our seeded sim-workers don't
 *   currently invite anyone, but defense-in-depth: delete invitations whose
 *   invited_by is in our user set OR whose email matches a stamped sim-worker.
 *
 * Order (children before parents, every NO-ACTION FK observed):
 *
 *   1. wallet_entries          (NO ACTION child of wallets — must precede wallets)
 *   2. offline_passes          (NO ACTION → users)   ← commit #3 missed this; blew up
 *   3. offline_transactions    (NO ACTION → users)
 *   4. payment_intents         (NO ACTION → users)
 *   5. sessions                (NO ACTION → users)   ← also covered by bay-path in outer
 *   6. reservations            (NO ACTION → users)   ← teardown; both safe to re-run
 *   7. vehicles                (NO ACTION → users)
 *   8. organization_members    (NO ACTION → users)
 *   9. wallets                 (NO ACTION → users; depends on wallet_entries gone first)
 *  10. invitations             (NO ACTION → users via invited_by)
 *  11. model_has_roles         (Spatie, polymorphic — no FK but seeded state)
 *  12. model_has_permissions   (Spatie, polymorphic — same)
 *  13. users                   (api_keys + refresh_tokens auto-cascade with this)
 *
 * The reverse-graph static check (`teardownFkCoverage.test.ts`) fails CI if the
 * schema gains a new NO-ACTION FK that this list doesn't cover.
 */
export function buildTeardownTestUsersSql(
  emails: string[],
  options?: { protectedEmails?: string[] },
): string[] {
  if (emails.length === 0) return [];

  // C-018 invariant guard (defense in depth). The platform admin email is
  // absent from PoolBootstrap.identityCredentials by construction — pool
  // emails are stamped `sim-worker-<runStamp>-<i>@test.local` — but a
  // regression that accidentally adds it here would silently delete the
  // ambient platform admin user. Throw early with a clear message so the
  // regression surfaces at CI / first-run time, not at the next e2e 403.
  // Tests can disable via `options.protectedEmails: []`.
  const protectedEmails = options?.protectedEmails ?? _readProtectedEmailsForTesting();
  const violation = emails.find((e) => protectedEmails.includes(e));
  if (violation) {
    throw new Error(
      `Teardown refused: email "${violation}" is in the protected platform-admin set ` +
      `${JSON.stringify(protectedEmails)}. The ambient platform admin user MUST persist ` +
      `across e2e runs — deleting it breaks the NULL-scoped role binding that authorizes ` +
      `POST /v1/organizations for every future run (C-018 invariant). If you genuinely need ` +
      `to remove the platform admin, do it manually via a one-off SQL or revoke the role via ` +
      `\`php artisan ospp:assign-platform-role <email> <other-role>\` — NOT through this teardown.`,
    );
  }

  const emailArr = `ARRAY[${emails.map(sqlLiteral).join(', ')}]::text[]`;
  const userIds = `SELECT id FROM users WHERE email = ANY(${emailArr})`;
  return [
    // 0. offline_auth_grants — NO-ACTION FK user_id → users (0.6.2 / B1). Must precede the
    //    users delete. Mirrors offline_transactions (swept in both station- and user-scoped
    //    teardowns); idempotent if the station-scoped sweep already removed the run's grants.
    `DELETE FROM offline_auth_grants WHERE user_id IN (${userIds});`,
    // 1. wallet_entries — child of wallets (NO ACTION). Must precede the wallets delete.
    `DELETE FROM wallet_entries WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id IN (${userIds}));`,
    // 2-9. Nine NO-ACTION FKs that point at users.id directly.
    `DELETE FROM offline_passes WHERE user_id IN (${userIds});`,
    `DELETE FROM offline_transactions WHERE user_id IN (${userIds});`,
    `DELETE FROM payment_intents WHERE user_id IN (${userIds});`,
    `DELETE FROM sessions WHERE user_id IN (${userIds});`,
    `DELETE FROM reservations WHERE user_id IN (${userIds});`,
    `DELETE FROM vehicles WHERE user_id IN (${userIds});`,
    `DELETE FROM organization_members WHERE user_id IN (${userIds});`,
    `DELETE FROM wallets WHERE user_id IN (${userIds});`,
    // 10. invitations — invited_by (NO ACTION → users) plus email match (defense-in-depth
    //     for any never-accepted invite addressed to a stamped sim-worker email).
    `DELETE FROM invitations WHERE invited_by IN (${userIds}) OR email = ANY(${emailArr});`,
    // 11-12. Spatie polymorphic — model_id is just a uuid column with no real FK, but
    //        these rows ARE state we seeded (or could have seeded), so sweep to avoid
    //        orphans. CASCADE-style behavior would have been server-side but isn't, so
    //        we own it client-side.
    `DELETE FROM model_has_roles WHERE model_id IN (${userIds});`,
    `DELETE FROM model_has_permissions WHERE model_id IN (${userIds});`,
    // 13. users — api_keys + refresh_tokens auto-delete via their CASCADE FKs.
    `DELETE FROM users WHERE email = ANY(${emailArr});`,
  ];
}

/** Seed N test users into the org. See {@link buildSeedTestUsersSql} for the contract. */
export async function seedTestUsers(
  orgId: string,
  copyPasswordFromEmail: string,
  identities: ReadonlyArray<SeededIdentity>,
  offlineEnabled: boolean = false,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  if (identities.length === 0) return;
  await runUatSql(buildSeedTestUsersSql(orgId, copyPasswordFromEmail, identities, offlineEnabled), cfg);
}
