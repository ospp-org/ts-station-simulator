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
  /**
   * The APPLICATION container, distinct from the database one above.
   *
   * Needed for exactly one thing, and only because SQL cannot do it:
   * `tenant_payment_credentials.password` is an `encrypted` Eloquent cast, so the column
   * holds Laravel ciphertext keyed by APP_KEY. A row written with a plaintext password is
   * not a credential — it throws `MerchantCredentialUnreadableException` on read, which the
   * poller treats as a PERMANENT error and pages an operator. So the ciphertext has to be
   * produced by the application itself.
   */
  appContainer: string;
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
    // Defaulted off the DB container's own naming rather than hardcoded: a run pointed at
    // the local stack (`UAT_DB_CONTAINER=csms-postgres`) wants `csms-app`, and the UAT one
    // (`csms-postgres-uat`) wants `csms-app-uat`. One override, `UAT_APP_CONTAINER`.
    appContainer:
      process.env.UAT_APP_CONTAINER ??
      ((process.env.UAT_DB_CONTAINER ?? 'csms-postgres-uat').endsWith('-uat')
        ? 'csms-app-uat'
        : 'csms-app'),
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
 * `UAT_SSH_HOST` values that mean "the docker daemon is already on this
 * machine" — take the ssh hop out and spawn `docker` directly.
 *
 * WHY THIS EXISTS, and it is not a convenience. Every privileged step in the
 * pool bootstrap funnels through {@link runUatSql}: the catalog seed, the
 * identity seed, `users.offline_enabled`, and the FK-ordered teardown. All of
 * them assumed a REMOTE database, because UAT is the only target that ever had
 * one. That assumption made the whole bootstrap — and therefore every scenario
 * that needs a provisioned station — reachable on UAT and nowhere else.
 *
 * That is a real ceiling rather than a preference. UAT deploys with
 * `git pull origin master --ff-only` (`csms-server/scripts/deploy-uat.sh:121`),
 * so it can only ever run code that is already on trunk AND already deployed;
 * on 2026-08-17 it sat 15 commits behind, missing two migrations. A server
 * change therefore has no wire-reachable target until someone deploys it, and
 * "prove it on the wire" and "do not deploy" could not both be satisfied.
 * The local dev stack bind-mounts the working tree, so it runs the code under
 * test with no deploy at all — it just could not be bootstrapped.
 *
 * WHAT IT DOES NOT CHANGE. The ssh path is untouched, and the identity pinning
 * that guards it (`sshIdentityArgs`, and the source sweep in
 * `sshIdentitiesOnly.test.ts` that catches a new call site written the old way)
 * still applies to every remote run. This branch spawns no ssh at all, so there
 * is no identity to fan out and no fail2ban counter to trip.
 *
 * WHAT IT DOES NOT PROVE. A local target is the same CODE, not the same
 * DEPLOYMENT: no image bake, no nginx edge, no supervisord consumer, no
 * public-CA broker cert. A green local run says the server logic is right; it
 * says nothing about the artefact UAT or prod would run.
 */
const LOCAL_DB_HOSTS = new Set(['local', 'localhost', '127.0.0.1', '-']);

/** True when {@link runUatSql} should skip ssh and drive docker directly. */
export function isLocalDbHost(cfg: UatDbConfig = uatDbConfigFromEnv()): boolean {
  return LOCAL_DB_HOSTS.has(cfg.sshHost.trim().toLowerCase());
}

/**
 * Run a SQL script against the target database over psql, feeding the SQL on
 * stdin. Resolves with psql stdout; rejects (with stderr) on a non-zero exit.
 * `ON_ERROR_STOP=1` makes any statement error abort the whole script.
 *
 * Remote (the default, and every UAT run): `ssh … docker exec -i … psql`.
 * Local (see {@link isLocalDbHost}): `docker exec -i … psql`, no ssh hop.
 * Both feed SQL on STDIN rather than as a `-c` argument, so the SQL text is
 * never subject to shell interpolation on either path.
 */
export function runUatSql(sql: string, cfg: UatDbConfig = uatDbConfigFromEnv()): Promise<string> {
  const psqlArgs = [
    'exec', '-i', cfg.container,
    'psql', '-U', cfg.dbUser, '-d', cfg.dbName,
    '-v', 'ON_ERROR_STOP=1', '--no-psqlrc', '-q',
  ];
  const local = isLocalDbHost(cfg);

  // The remote form has to be ONE shell word list for the login shell on the
  // far side; the local form is spawned argv-style with no shell at all.
  const remoteCmd =
    `docker exec -i ${cfg.container} psql -U ${cfg.dbUser} -d ${cfg.dbName} ` +
    `-v ON_ERROR_STOP=1 --no-psqlrc -q`;
  const sshArgs = [
    ...sshIdentityArgs(cfg),
    '-o', 'ConnectTimeout=15',
    '-o', 'BatchMode=yes',
    cfg.sshHost,
    remoteCmd,
  ];
  const command = local ? 'docker' : 'ssh';

  return new Promise<string>((resolve, reject) => {
    // TWO LITERAL SPAWNS, NOT ONE PARAMETERISED BY A VARIABLE — deliberate, and
    // the first attempt here got it wrong. `spawn(command, args)` with `command`
    // computed above is tidier and it made `sshIdentitiesOnly.test.ts`'s source
    // sweep match ZERO files: that sweep finds ssh call sites by the literal
    // `spawn('ssh'` and then asserts each one passes `sshIdentityArgs()`, which
    // is what stops a future call site from re-introducing the agent key fan-out
    // that once earned this box an hour-long fail2ban. Hiding the only call site
    // from it disarmed the guard silently — and the sweep's own "matches at least
    // 3 files" meta-check is what caught it, which is precisely why that check
    // exists. Keep the literal.
    const child = local
      ? spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) =>
      reject(new Error(`runUatSql: failed to spawn ${command} — ${err.message}`)),
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
  /**
   * `service_definitions.service_kind` — the Postgres ENUM (`UserDuration` |
   * `FixedDuration` | `MultiUnit`). Omitted means the column stays NULL, which the server
   * resolves to `UserDuration` (`StationQueryService::getServicePricing` — `ServiceKind::
   * tryFrom($service->service_kind ?? '') ?? ServiceKind::UserDuration`). Every service this
   * corpus has ever seeded is that, so omission keeps the existing world byte-identical.
   */
  serviceKind?: SeededServiceKind;
  /**
   * `station_services.fixed_duration_seconds` — REQUIRED for a kind whose duration is a
   * property of the service rather than of the request. `getServicePricing` FAILS CLOSED
   * (throws `ServicePricingUnavailableException`, page `payment_unavailable`) when a
   * FixedDuration/MultiUnit entry has no preset, so seeding the kind without this produces
   * a service the landing page refuses to quote.
   */
  fixedDurationSeconds?: number | null;
  /**
   * `station_services.max_unit_quantity` — the capacity gate on `unit_count`. Postgres
   * CHECK: NULL or >= 1. `PaymentLandingController::process` computes
   * `effectiveMax = (kind === MultiUnit && is_int(max) && max >= 1) ? max : 1` and refuses
   * `invalid_quantity` outside `1..effectiveMax`, so BOTH this and `serviceKind: 'MultiUnit'`
   * are needed before any batch can be bought — either alone caps the purchase at one unit.
   */
  maxUnitQuantity?: number | null;
}

/** The `service_kind` Postgres ENUM, as the server spells it (`App\\Shared\\Enums\\ServiceKind`). */
export type SeededServiceKind = 'UserDuration' | 'FixedDuration' | 'MultiUnit';

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
 * The service id the multi-unit seed uses, and the template name it is published under.
 * Distinct from the four in {@link DEFAULT_SEED_SERVICES} on purpose: this one is seeded
 * ONLY when a selected scenario asks for it, so the default world stays four services and
 * `device-management/service-catalog-update.yaml`'s `serviceCount: 4` keeps meaning what it
 * says. A fifth default service would have reddened that file for a fixture reason.
 */
export const MULTIUNIT_SERVICE_ID = 'svc_multiunit';

/**
 * Per-unit price, in credits, of the seeded multi-unit service.
 *
 * DELIBERATELY BELOW {@link DEFAULT_IDENTITY_WALLET_CREDITS}. `deriveRequiredWalletCredits`
 * takes the MAXIMUM over the seeded catalog, so a per-unit price above 1000 would silently
 * raise every bootstrapped identity's wallet — a change to the money fixture of all 145
 * files, made by adding a service none of them use. 200 also matches the server's own
 * `WebPaymentMultiUnitTest` (3 x 200 = 600), so a batch quote is readable against it.
 */
export const MULTIUNIT_UNIT_PRICE_CREDITS = 200;

/**
 * The actuation pulse, in seconds, the server quotes and later bills for ONE unit.
 * `getServicePricing` reads it from `station_services.fixed_duration_seconds` and REPLACES
 * the client's requested duration with it, so this — not the value posted on the form — is
 * what arrives as `StartService.payload.durationSeconds` on every unit of the batch.
 */
export const MULTIUNIT_PULSE_SECONDS = 5;

/**
 * Build the multi-unit catalog entry for a run that needs one, at the capacity the
 * scenarios selected for THAT run declared.
 *
 * `Fixed` pricing rather than per-minute, and that is not cosmetic: `getServicePricing`
 * quotes `price_credits_fixed` for a Fixed service and `ceil(seconds/60 * rate)` otherwise.
 * A dispenser priced per minute against a 5-second pulse quotes `ceil(0.083 * rate)`, which
 * is a number nobody chose — and if it rounds to 0 the quote chokepoint refuses to charge
 * and the page answers `payment_unavailable`.
 */
export function multiUnitSeedService(maxUnitQuantity: number): SeededService {
  if (!Number.isInteger(maxUnitQuantity) || maxUnitQuantity < 1) {
    throw new Error(
      `multiUnitSeedService: maxUnitQuantity must be an integer >= 1 (Postgres CHECK ` +
        `chk_station_services_max_unit_quantity), got ${JSON.stringify(maxUnitQuantity)}`,
    );
  }
  return {
    serviceId: MULTIUNIT_SERVICE_ID,
    serviceName: 'Multi-Unit Dispenser',
    pricingType: 'Fixed',
    priceCreditsFixed: MULTIUNIT_UNIT_PRICE_CREDITS,
    serviceKind: 'MultiUnit',
    fixedDurationSeconds: MULTIUNIT_PULSE_SECONDS,
    maxUnitQuantity,
  };
}

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
export function maxCreditsAuthorizedFor(service: SeededService): number {
  if (service.pricingType === 'Fixed') return service.priceCreditsFixed ?? 0;
  return Math.ceil(MAX_SESSION_DURATION_SECONDS / 60 * (service.priceCreditsPerMinute ?? 0));
}

/**
 * The balance that makes every `POST /sessions/start` against {@link services} pass the money
 * gate, and no more. The MAXIMUM of one start rather than the sum of a scenario's starts —
 * see {@link DEFAULT_IDENTITY_WALLET_CREDITS} for why the online path never draws the balance
 * down, which is what makes a maximum sufficient.
 *
 * This is the single implementation of "how much is enough". The pool bootstrap derives its
 * default from it against {@link DEFAULT_SEED_SERVICES}; a scenario that provisions its own
 * customer derives from that customer's own catalog. Two callers, one rule — a second copy is
 * how the two would drift, and the drift would surface as a 402 in whichever one was not
 * updated.
 *
 * Returns 0 for an empty list: no catalog means no start to authorize, and a caller funding
 * against nothing should get nothing rather than `-Infinity` from a bare `Math.max`.
 */
export function deriveRequiredWalletCredits(services: ReadonlyArray<SeededService>): number {
  if (services.length === 0) return 0;
  return Math.max(...services.map(maxCreditsAuthorizedFor));
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
  deriveRequiredWalletCredits(DEFAULT_SEED_SERVICES);

// ---------------------------------------------------------------------------
// Funding a customer a SCENARIO provisioned (as opposed to a pool identity)
// ---------------------------------------------------------------------------

/**
 * Read the catalog actually published on {@link stationIdString} (`stn_<hex>`), as the rows a
 * `POST /sessions/start` would price against. Returns the shape {@link maxCreditsAuthorizedFor}
 * consumes, so the funding amount is derived from the journey's OWN catalog rather than from a
 * number typed into a YAML file.
 *
 * `COPY … TO STDOUT` rather than a plain SELECT: {@link runUatSql} runs psql without `-t -A`,
 * so a SELECT would come back wrapped in an aligned table with a header and a row count. COPY
 * emits the payload alone, which is why this is one JSON line and not a parser.
 */
export async function readStationCatalogServices(
  stationIdString: string,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<SeededService[]> {
  const sql =
    `COPY (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
    `SELECT sd.service_id AS "serviceId", sd.service_name AS "serviceName", ` +
    `sd.pricing_type::text AS "pricingType", ` +
    `ss.price_credits_per_minute AS "priceCreditsPerMinute", ` +
    `ss.price_credits_fixed AS "priceCreditsFixed" ` +
    `FROM station_services ss ` +
    `JOIN service_definitions sd ON sd.id = ss.service_definition_id ` +
    `JOIN stations s ON s.id = ss.station_id ` +
    `WHERE s.station_id = ${sqlLiteral(stationIdString)}` +
    `) t) TO STDOUT;`;

  const out = (await runUatSql(sql, cfg)).trim();
  if (out === '') return [];
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) {
    throw new Error(`readStationCatalogServices: expected a JSON array, got ${out.slice(0, 200)}`);
  }
  return parsed as SeededService[];
}

/**
 * Fund the wallet of ONE user, addressed by the `users.id` uuid.
 *
 * WHY THIS IS AN UPDATE, WHEN {@link buildSeedTestUsersSql} IS EXPLICITLY AN INSERT. That
 * function's doc records the incident this rule exists for: funding once ran as a follow-up
 * `UPDATE … WHERE email LIKE 'sim-worker-%'`, which also matched the pre-existing July fixtures
 * and overwrote ten wallets, three of them legitimately non-zero. "Fund at INSERT" removed that
 * hazard by construction — an INSERT cannot reach a row the run did not create.
 *
 * A scenario that registers its own customer cannot use that shape: `RegisterAction.php:49`
 * already inserted the wallet, at balance 0, before the scenario gets control. The wallet row
 * is not ours to create. So the hazard is removed by construction a different way, and it is
 * the WHERE clause that does it:
 *
 *   - The key is `wallets.user_id`, a uuid PRIMARY KEY value the server returned to THIS run
 *     in the registration response seconds earlier. A pattern can match a row you did not
 *     create; a primary key you were just handed cannot.
 *   - `expectedCurrentBalance` is asserted in the same statement. Funding only applies to a
 *     wallet still sitting at the balance `RegisterAction` left, so if anything funded it
 *     first, this matches zero rows and the caller throws instead of overwriting.
 *
 * Both halves are checked by the row count, so a silent no-op is not a possible outcome.
 *
 * The `wallet_entries` row is written for the same reason {@link buildSeedTestUsersSql} writes
 * it: nothing reconciles `wallets.balance` against `SUM(wallet_entries)`, but the next real
 * `WalletLedger` operation computes `balance_after` from the column, so a balance without its
 * entry forks the ledger chain from the history.
 */
export function buildFundWalletByUserIdSql(
  userId: string,
  credits: number,
  expectedCurrentBalance: number = 0,
): string {
  const userLit = sqlLiteral(userId);
  return [
    'BEGIN;',
    `UPDATE wallets SET balance = ${credits}, version = version + 1, updated_at = NOW() ` +
    `WHERE user_id = ${userLit} AND balance = ${expectedCurrentBalance};`,
    `INSERT INTO wallet_entries ` +
    `(wallet_id, type, amount, balance_after, reference_type, reference_id, description, idempotency_key, created_at) ` +
    `SELECT w.id, 'credit'::wallet_entry_type, ${credits}, ${credits}, 'bonus', 'sim_scenario_fund', ` +
    `'Simulator scenario customer funding', 'sim-fund:' || w.user_id::text, NOW() ` +
    `FROM wallets w WHERE w.user_id = ${userLit} AND w.balance = ${credits};`,
    'COMMIT;',
  ].join('\n');
}

/**
 * Apply {@link buildFundWalletByUserIdSql} and prove it landed. A zero-credit request is a
 * no-op by design — an unfunded customer is a legitimate fixture (a scenario whose subject is
 * the 4001 refusal), and `wallet_entries.amount` carries `CHECK (amount > 0)` besides.
 */
export async function fundWalletByUserId(
  userId: string,
  credits: number,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  if (credits <= 0) return;

  await runUatSql(buildFundWalletByUserIdSql(userId, credits), cfg);

  const check = (await runUatSql(
    `COPY (SELECT balance FROM wallets WHERE user_id = ${sqlLiteral(userId)}) TO STDOUT;`,
    cfg,
  )).trim();

  if (check !== String(credits)) {
    throw new Error(
      `fundWalletByUserId: wallet for user ${userId} reads "${check || '(no row)'}" after ` +
      `funding ${credits} credits. The UPDATE is guarded on the wallet still being at the ` +
      `balance RegisterAction left, so this means either no wallet exists for that user or ` +
      `something funded it first — neither is safe to overwrite.`,
    );
  }
}

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
      const kind = s.serviceKind != null ? `${sqlLiteral(s.serviceKind)}::service_kind` : 'NULL::service_kind';
      return `(${orgLit}, ${sqlLiteral(s.serviceId)}, ${sqlLiteral(s.serviceName)}, ${sqlLiteral(s.pricingType)}, ${ppm}, ${pcf}, ${kind})`;
    })
    .join(',\n  ');

  // Per-service station_services columns, joined by service_id rather than assumed.
  //
  // This USED to be a cross join emitting a literal `100` for every row, which was true of
  // the four PerMinute services and of nothing else. A Fixed service seeded that way lands
  // with `price_credits_fixed` NULL, and `getServicePricing` quotes a Fixed service from
  // exactly that column — so the card would have been asked to charge 0, which the quote
  // chokepoint refuses (`payment_unavailable`). The four existing services produce the
  // identical rows they did before; the columns only start carrying values when a service
  // declares them.
  const perServiceRows = services
    .map((s) => {
      const ppm =
        s.pricingType === 'PerMinute' && s.priceCreditsPerMinute != null
          ? String(s.priceCreditsPerMinute)
          : 'NULL';
      const pcf =
        s.pricingType === 'Fixed' && s.priceCreditsFixed != null
          ? String(s.priceCreditsFixed)
          : 'NULL';
      const fds = s.fixedDurationSeconds != null ? String(s.fixedDurationSeconds) : 'NULL';
      const muq = s.maxUnitQuantity != null ? String(s.maxUnitQuantity) : 'NULL';
      return `(${sqlLiteral(s.serviceId)}, ${ppm}::int, ${pcf}::int, ${fds}::int, ${muq}::int)`;
    })
    .join(',\n    ');

  return [
    'BEGIN;',
    // 1. service_definitions: ON CONFLICT DO NOTHING (mirrors resolveOrCreateDefinition).
    'INSERT INTO service_definitions (organization_id, service_id, service_name, pricing_type, recommended_price_credits_per_minute, recommended_price_credits_fixed, service_kind)',
    'VALUES',
    `  ${defRows}`,
    'ON CONFLICT (organization_id, service_id) DO NOTHING;',
    // 2. station_services: UPSERT (mirrors updateOrInsert). Cross-join the bootstrapped
    //    stations × the seeded definitions, filtered to the seed's org + svc_* set.
    'WITH seed(service_id, ppm, pcf, fds, muq) AS (VALUES',
    `    ${perServiceRows}`,
    ')',
    'INSERT INTO station_services (station_id, service_definition_id, price_credits_per_minute, price_credits_fixed, fixed_duration_seconds, max_unit_quantity, available)',
    'SELECT s.id, sd.id, seed.ppm, seed.pcf, seed.fds, seed.muq, true',
    'FROM stations s, service_definitions sd, seed',
    `WHERE s.station_id = ANY(${stationArr})`,
    `  AND sd.organization_id = ${orgLit}`,
    '  AND sd.service_id = seed.service_id',
    `  AND sd.service_id = ANY(${svcArr})`,
    'ON CONFLICT (station_id, service_definition_id) DO UPDATE SET',
    '  price_credits_per_minute = EXCLUDED.price_credits_per_minute,',
    '  price_credits_fixed = EXCLUDED.price_credits_fixed,',
    '  fixed_duration_seconds = EXCLUDED.fixed_duration_seconds,',
    '  max_unit_quantity = EXCLUDED.max_unit_quantity,',
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

/**
 * Read the `bays.public_slug` of every bay on the given stations.
 *
 * WHY THIS HAS TO BE A DB READ. The slug is the customer-facing identity of a bay — the
 * whole of `/w/{slug}`, the pay page — and **no API returns it.** Measured over the server
 * tree: the admin station read, the dashboard station read and every `app/Http/Resources`
 * projection emit `{id, bayId, bayNumber, status}` and nothing else, and the one place that
 * would have published it (`GenerateQrCodeAction`) has no route and no caller. It is minted
 * at registration (`Bay::generateUniqueSlug`) and consumed by `resolveBayIdBySlug`, and in
 * between it never leaves the database.
 *
 * So a scenario that has to drive the pay page cannot discover its own bay's slug from the
 * wire, on any run, by any means. This is the same privileged channel the offline flag and
 * the service catalog already use, and it is the only one there is.
 *
 * `COPY … TO STDOUT` rather than a SELECT for the reason {@link readStationCatalogServices}
 * gives: {@link runUatSql} runs psql without `-t -A`, so a SELECT arrives wrapped in an
 * aligned table with a header and a row count.
 *
 * @returns stationId (the `stn_*` string) -> slugs, SORTED BY bayNumber so index N-1 is the
 *          same bay as `bayIds[N-1]` in the provisioning artifact. Stations with no bays are
 *          absent from the map rather than present-and-empty.
 */
export async function readBaySlugs(
  stationIds: string[],
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<Map<string, string[]>> {
  if (stationIds.length === 0) return new Map();
  const stationArr = `ARRAY[${stationIds.map(sqlLiteral).join(', ')}]::text[]`;
  const sql =
    `COPY (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
    `SELECT s.station_id AS "stationId", ` +
    `array_agg(b.public_slug ORDER BY b.bay_number) AS "slugs" ` +
    `FROM bays b JOIN stations s ON s.id = b.station_id ` +
    `WHERE s.station_id = ANY(${stationArr}) ` +
    `GROUP BY s.station_id` +
    `) t) TO STDOUT;`;

  const out = (await runUatSql(sql, cfg)).trim();
  if (out === '') return new Map();
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) {
    throw new Error(`readBaySlugs: expected a JSON array, got ${out.slice(0, 200)}`);
  }
  const result = new Map<string, string[]>();
  for (const row of parsed as Array<{ stationId?: unknown; slugs?: unknown }>) {
    if (typeof row.stationId !== 'string' || !Array.isArray(row.slugs)) continue;
    const slugs = row.slugs.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (slugs.length > 0) result.set(row.stationId, slugs);
  }
  return result;
}

/**
 * Read back what the multi-unit seed actually landed, and THROW if it is not what was asked
 * for.
 *
 * THIS IS NOT BELT-AND-BRACES; it closes a real hole in the seed above. The
 * `service_definitions` insert is `ON CONFLICT … DO NOTHING`, deliberately — the server's
 * own `resolveOrCreateDefinition` preserves an existing row and the seed must not diverge
 * from it. The consequence is that the seed CANNOT correct a definition already present
 * under the same `(organization_id, service_id)`. The bootstrap reuses the owner's standing
 * organisation, and the teardown's orphan sweep only fires when no `station_services` row
 * still references the definition — so a run whose teardown did not complete leaves one
 * behind, and the next run's `service_kind` is silently whatever that older row said.
 *
 * The failure that produces is the quiet kind: `service_kind` NULL resolves to
 * `UserDuration`, `effectiveMax` collapses to 1, and `POST /w/{slug}/process` answers
 * `invalid_quantity` for a `unit_count` the fixture believed it had provisioned. No batch,
 * no `unit_batches` row, and a scenario that times out at a `wait_for` several steps later
 * naming a message the server was never going to send.
 *
 * Reading the two columns that DECIDE — the definition's kind and the station service's
 * capacity — turns that into a bootstrap error that names the row.
 */
export async function verifyMultiUnitSeed(
  orgId: string,
  stationIds: string[],
  requiredUnits: number,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  if (stationIds.length === 0) return;
  const stationArr = `ARRAY[${stationIds.map(sqlLiteral).join(', ')}]::text[]`;
  const sql =
    `COPY (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (` +
    `SELECT s.station_id AS "stationId", sd.service_kind::text AS "kind", ` +
    `ss.max_unit_quantity AS "maxUnits", ss.fixed_duration_seconds AS "pulse", ` +
    `ss.price_credits_fixed AS "priceFixed" ` +
    `FROM station_services ss ` +
    `JOIN service_definitions sd ON sd.id = ss.service_definition_id ` +
    `JOIN stations s ON s.id = ss.station_id ` +
    `WHERE s.station_id = ANY(${stationArr}) ` +
    `  AND sd.organization_id = ${sqlLiteral(orgId)} ` +
    `  AND sd.service_id = ${sqlLiteral(MULTIUNIT_SERVICE_ID)}` +
    `) t) TO STDOUT;`;

  const out = (await runUatSql(sql, cfg)).trim();
  const parsed: unknown = out === '' ? [] : JSON.parse(out);
  const rows = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];

  const problems: string[] = [];
  for (const stationId of stationIds) {
    const row = rows.find((r) => r.stationId === stationId);
    if (row === undefined) {
      problems.push(`${stationId}: no ${MULTIUNIT_SERVICE_ID} station_services row at all`);
      continue;
    }
    if (row.kind !== 'MultiUnit') {
      problems.push(
        `${stationId}: service_kind is ${JSON.stringify(row.kind)}, not "MultiUnit" — a ` +
          `pre-existing service_definitions row survived ON CONFLICT DO NOTHING`,
      );
    }
    const maxUnits = typeof row.maxUnits === 'number' ? row.maxUnits : null;
    if (maxUnits === null || maxUnits < requiredUnits) {
      problems.push(
        `${stationId}: max_unit_quantity is ${JSON.stringify(row.maxUnits)}, needs >= ${requiredUnits}`,
      );
    }
    if (typeof row.pulse !== 'number' || row.pulse < 1) {
      problems.push(
        `${stationId}: fixed_duration_seconds is ${JSON.stringify(row.pulse)} — a MultiUnit ` +
          `service with no preset makes getServicePricing throw and the page answer ` +
          `payment_unavailable`,
      );
    }
    if (typeof row.priceFixed !== 'number' || row.priceFixed < 1) {
      problems.push(
        `${stationId}: price_credits_fixed is ${JSON.stringify(row.priceFixed)} — a Fixed ` +
          `service is quoted from this column, and a 0 quote is refused rather than charged`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `verifyMultiUnitSeed: the multi-unit catalog seed did not land as declared, so no ` +
        `unit_count > 1 purchase can succeed:\n  - ${problems.join('\n  - ')}`,
    );
  }
}

/**
 * POSIX single-quote a string so a REMOTE shell passes it through verbatim.
 *
 * WHY THIS EXISTS RATHER THAN `JSON.stringify`. ssh concatenates its command arguments and
 * hands them to the login shell on the far side, so whatever `runAppPhp` builds is re-parsed
 * over there. `JSON.stringify` produces a DOUBLE-quoted word, and a POSIX shell still expands
 * `$name` inside double quotes. The only caller's snippet opens with `$a = require ...`, so
 * the far-side shell substituted `$a` with the empty string and php received ` = require ...`
 * — "PHP Parse error: syntax error, unexpected token \"=\", expecting end of file". The
 * bootstrap died there AFTER provisioning five stations and seeding the catalog, and the
 * message named php, not the shell that had already eaten the variable.
 *
 * Single quotes suppress every expansion; `'\''` is the standard way to carry a literal
 * single quote through them (close, escaped quote, reopen).
 *
 * THE LOCAL BRANCH NEVER HAD THIS BUG, which is why it went unnoticed: `spawn` passes argv
 * directly with no shell between. Only a run against UAT — i.e. every pooled run — took the
 * ssh path. Proven two-armed against csms-app-uat: the double-quoted form reproduces the
 * parse error byte for byte, the single-quoted form returns the ciphertext.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a PHP snippet inside the APPLICATION container, with the framework booted, and return
 * its stdout.
 *
 * THE ONLY CALLER IS {@link seedBtCredentialForOrg}, and the narrowness is the point. This is
 * a strictly wider privilege than {@link runUatSql} — that one can only reach the database,
 * this one runs application code — so it exists for the single case where SQL is structurally
 * incapable: producing Laravel ciphertext for an `encrypted` cast.
 *
 * NOT `artisan db:seed --class=BtSandboxCredentialSeeder`, which was the obvious move and is
 * the wrong one: that seeder walks EVERY `type=tenant` organisation. On UAT that is fourteen
 * organisations and twenty-eight rows, none of which the run owns, all of them left behind.
 * This produces one string, and the row it becomes is written by the SQL channel, scoped to
 * the organisation this run created.
 */
export function runAppPhp(code: string, cfg: UatDbConfig = uatDbConfigFromEnv()): Promise<string> {
  const local = isLocalDbHost(cfg);
  const args = local
    ? ['exec', '-i', cfg.appContainer, 'php', '-r', code]
    : [
        ...sshIdentityArgs(cfg),
        '-o', 'ConnectTimeout=15',
        '-o', 'BatchMode=yes',
        cfg.sshHost,
        `docker exec -i ${cfg.appContainer} php -r ${shellSingleQuote(code)}`,
      ];

  return new Promise<string>((resolve, reject) => {
    const child = local ? spawn('docker', args) : spawn('ssh', args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code2) => {
      if (code2 === 0) resolve(out.trim());
      else reject(new Error(`runAppPhp exited ${code2}: ${err.trim() || out.trim()}`));
    });
  });
}

/** The BT iPay sandbox account, as `database/seeders/BtSandboxCredentialSeeder.php` carries it. */
const BT_SANDBOX_USERNAME = 'test_iPay3_api';
const BT_SANDBOX_PASSWORD = 'test_iPay3_ap!e4r';

/**
 * Give ONE organisation an active BT iPay credential, so the webpay landing page will serve
 * it instead of redirecting to `payment.error?reason=payment_unavailable`.
 *
 * WHY THE BOOTSTRAP HAS TO DO THIS AT ALL. `isWebpayReady()` requires an active row on the
 * SETTLING organisation, and `organizations.payment_mode` defaults to `tenant` — so the
 * settling org is the operational one, not the platform. `--bootstrap-pool` mints a FRESH
 * organisation on every run. There is therefore no moment at which a credential row could
 * pre-exist for it: not a seeder run beforehand, not a fixture, not a manual insert. Either
 * the bootstrap writes it or no pooled run can ever reach the pay page.
 *
 * WHY IT IS AN UPSERT ON (organization_id, environment). That pair is UNIQUE at the schema
 * level, and a re-run against a kept pool must be a no-op rather than a constraint violation.
 *
 * BOTH ENVIRONMENTS. `isWebpayReady` is NOT filtered by `payment.env` — any active row
 * satisfies it — but `resolveActiveForTenant`, which the charge actually uses, IS. Writing
 * only `sandbox` would pass the admission check and then fail at the charge on a server
 * configured for production, which is the shape of failure this seeds against.
 */
export async function seedBtCredentialForOrg(
  orgId: string,
  cfg: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  const cipher = await runAppPhp(
    'require "/var/www/html/vendor/autoload.php";' +
      '$a = require "/var/www/html/bootstrap/app.php";' +
      '$a->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();' +
      `echo Illuminate\\Support\\Facades\\Crypt::encryptString(${JSON.stringify(BT_SANDBOX_PASSWORD)});`,
    cfg,
  );

  // A Laravel `encrypted` payload is base64 of a JSON object carrying iv/value/mac. Checking
  // the shape here is not decoration: a `php -r` that failed to boot prints a PHP warning to
  // stdout and exits 0, and that string would be INSERTed as if it were a credential — a row
  // that looks present to isWebpayReady and throws on the first real charge.
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(cipher)) {
    throw new Error(
      `seedBtCredentialForOrg: the app container did not return a Laravel ciphertext ` +
        `(got ${JSON.stringify(cipher.slice(0, 120))}). A malformed value here becomes a row ` +
        `that passes isWebpayReady and then throws MerchantCredentialUnreadableException at ` +
        `the charge, which the poller treats as permanent and pages on.`,
    );
  }

  const rows = ['sandbox', 'production']
    .map(
      (env) =>
        `(gen_random_uuid(), ${sqlLiteral(orgId)}, ${sqlLiteral(env)}, ` +
        `${sqlLiteral(BT_SANDBOX_USERNAME)}, ${sqlLiteral(cipher)}, true, NOW(), NOW())`,
    )
    .join(',\n  ');

  await runUatSql(
    [
      'BEGIN;',
      'INSERT INTO tenant_payment_credentials (id, organization_id, environment, username, password, is_active, created_at, updated_at)',
      'VALUES',
      `  ${rows}`,
      'ON CONFLICT (organization_id, environment) DO UPDATE SET',
      '  username = EXCLUDED.username,',
      '  password = EXCLUDED.password,',
      '  is_active = true,',
      '  updated_at = NOW();',
      'COMMIT;',
    ].join('\n'),
    cfg,
  );

  // Read back the two facts isWebpayReady actually consults. A silent zero here is the
  // difference between "the pay page serves" and "302 payment_unavailable at step one".
  const out = (
    await runUatSql(
      `COPY (SELECT count(*) FROM tenant_payment_credentials ` +
        `WHERE organization_id = ${sqlLiteral(orgId)} AND is_active = true) TO STDOUT;`,
      cfg,
    )
  ).trim();
  if (out !== '2') {
    throw new Error(
      `seedBtCredentialForOrg: expected 2 active credential rows for ${orgId}, found ` +
        `${JSON.stringify(out)} — the pay page would answer payment_unavailable.`,
    );
  }
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
