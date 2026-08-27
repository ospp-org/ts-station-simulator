import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SecureVersion } from 'node:tls';
import type { StepDefinition } from './steps/Step.js';
import type { ProvisioningArtifact, ScenarioContext, StepResult } from './ScenarioContext.js';
import { createContext } from './ScenarioContext.js';
import { Station, type Handler } from '../station/Station.js';
import { BootNotificationHandler } from '../handlers/BootNotificationHandler.js';
import { OsppAction } from '@ospp/protocol';
import {
  generateStationId,
  generateSerialNumber,
  generateBayId,
  generateServiceId,
  generateOfflineTxId,
  generateSecurityEventId,
} from '../station/StationConfig.js';
import type { StationConfig, BayConfig } from '../station/StationConfig.js';
import { SendStep } from './steps/SendStep.js';
import { WaitForStep } from './steps/WaitForStep.js';
import { WaitForConnectStep } from './steps/WaitForConnectStep.js';
import { AssertStep } from './steps/AssertStep.js';
import { ApiCallStep } from './steps/ApiCallStep.js';
import { DelayStep } from './steps/DelayStep.js';
import { FundWalletStep } from './steps/FundWalletStep.js';
import { MULTIUNIT_SERVICE_ID } from './bootstrap/uatPrivileged.js';
import { StartHeartbeatStep } from './steps/StartHeartbeatStep.js';
import { FaultStep } from './steps/FaultStep.js';
import { ProvisionStep } from './steps/ProvisionStep.js';
import { ProvisionStationPoolStep } from './steps/ProvisionStationPoolStep.js';
import { ConnectMqttStep } from './steps/ConnectMqttStep.js';
import type { Step } from './steps/Step.js';
import { teardownScenarioResources } from './bootstrap/ScenarioResources.js';
import type { StationPool, PoolEntry } from './stations/StationPool.js';

/**
 * How long a scenario waits, at its end, for its backgrounded api_calls to
 * settle so their `expect_status` can be judged.
 *
 * Generous on purpose: these are the synchronous REST endpoints that block on
 * the station's own MQTT Response, so their latency is a full round trip plus
 * whatever the scenario did in between.
 */
const BACKGROUND_SETTLE_MS = 20000;

/**
 * Wait for every backgrounded api_call, and treat one that never settles as a
 * FINDING rather than a pass.
 *
 * An unsettled call is one whose assertion did not run. Resolving quietly here
 * would put back exactly the property being removed — an `expect_status` that
 * cannot fail — one layer further from where anyone would look for it.
 */
async function settleBackgroundCalls(context: ScenarioContext): Promise<void> {
  if (context.backgroundCalls.length === 0) return;

  const pending = Promise.allSettled(context.backgroundCalls);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), BACKGROUND_SETTLE_MS);
  });

  try {
    const outcome = await Promise.race([pending.then(() => 'settled' as const), timeout]);
    if (outcome === 'timeout') {
      context.backgroundFailures.push(
        `${context.backgroundCalls.length} background api_call(s) had not settled after ` +
          `${BACKGROUND_SETTLE_MS}ms, so their expect_status could not be judged`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wall-clock budget for ONE scenario before the runner abandons it and moves on.
 * Measured from the 2026-08-10 116-scenario run, not guessed — see runScenarioBounded.
 * 90s clears the 60.8s band (a scenario exhausting its own 60s `wait_for` must report its
 * own error, not ours) and sits ~6x above the 14.4s slowest successful scenario.
 */
export const DEFAULT_SCENARIO_TIMEOUT_MS = 90_000;

/**
 * THE FLOOR ON AN ORDERING THE PROTOCOL CANNOT ACKNOWLEDGE.
 *
 * A `send` step whose `messageType` is `Event` completes when the BROKER acknowledges the
 * publish — `MessageSender.send` awaits a QoS-1 PUBACK (`MqttConnection.publish`). That is
 * not when the CSMS has applied it. An Event is fire-and-forget by definition: the server
 * owes it no Response, so there is nothing for a `wait_for` to synchronise on, and the
 * effect lands whenever the MQTT consumer gets to it — later under load, because the queue
 * is shared across `--workers`.
 *
 * So the step boundary is a lie, and the next step starts against a server that has not
 * caught up. When that next step is an `api_call`, the REST read races the write the Event
 * carried. `StatusNotification` is the case that matters: it is the ONLY thing that clears
 * `bays.status` from `unknown` (every accepted Boot resets it), and three server surfaces
 * refuse an `unknown` bay with 3002 BAY_NOT_READY — `POST /sessions/start`
 * (SessionStateMachine::validateBayForStart), `POST /reservations`
 * (ReservationTransitions::validateBayForReservation) and, since csms-server `e9fa3fc4`,
 * `POST .../maintenance` (SetMaintenanceModeAction::validateBayForMaintenance).
 *
 * WHY THIS IS THE RUNNER'S AND NOT A FILE'S. 49 adjacencies across 40 scenario files put an
 * `api_call` directly after an Event send with nothing in between; 26 of them fire it with
 * `background: true`, where a 409 is downgraded to a `console.warn` and the run dies three
 * steps later on a `wait_for` timeout that names the message which never arrived
 * (ApiCallStep.ts, measured 2026-08-13 on core/boot-disabled-station-boots-and-stays-gated).
 * A per-file `delay` would answer it in 40 places, which is 40 copies of one number — the
 * shape `PoolBaysCoversScenarios` exists to refuse. A step that reports itself finished
 * before its effect exists is a property of the runner.
 *
 * A FLOOR, NOT AN ADDITION. The top-up is measured from the publish and only covers the
 * REMAINDER, so a file that already waits — `full-session-lifecycle.yaml` (500 ms), the
 * three `maintenance-mode-*` read-backs (1500 ms) — pays nothing extra, and a `wait_for`
 * that happened to take a second has already satisfied it. Nothing in the corpus needs
 * editing for this, and a file that wants MORE than the floor still gets what it asks for.
 *
 * 1000 ms IS MEASURED, NOT CHOSEN. `status-all-bay-states.yaml` established it on UAT after
 * 300 ms read back the PREVIOUS state; `boot-resets-bays-to-unknown.yaml:69-71` records
 * both numbers. It is the corpus's own value, promoted from a literal repeated in scenario
 * files to the one place that can enforce it.
 */
export const UNACKED_EVENT_SETTLE_MS = 1000;

/**
 * True for a step that publishes a station EVENT — the fire-and-forget half of the
 * protocol, which the server never answers. `Request` and `Response` sends are excluded:
 * both have a counterpart on the wire, and a scenario that cares already `wait_for`s it.
 */
export function isUnackedEventSend(step: StepDefinition | undefined): boolean {
  return step?.action === 'send' && step?.messageType === 'Event';
}

/**
 * Milliseconds still owed before a server-touching step may run, given when the last
 * unacknowledged Event was published. `null` (no Event outstanding) and an elapsed time
 * already past the floor both return 0 — this never delays anything twice.
 */
export function settleTopUpMs(
  unackedEventAt: number | null,
  now: number,
  floorMs: number = UNACKED_EVENT_SETTLE_MS,
): number {
  if (unackedEventAt === null) return 0;
  const remaining = floorMs - (now - unackedEventAt);

  return remaining > 0 ? remaining : 0;
}

export interface ScenarioDefinition {
  name: string;
  target_url?: string;
  skip?: boolean;
  skip_reason?: string;
  /**
   * WHY the unconditional `skip` above, in the only distinction a machine reads — see
   * {@link SkipKind}. Defaults to `not-applicable`, which is what every `skip: true` in the
   * corpus meant before this key existed and still means without it.
   *
   * `inconclusive` exists for a scenario that is READY and whose INSTRUMENT is absent — the
   * same class `requires_files` covers for a deliberately-broken certificate, reached here
   * for a reason that is not a file on disk. `device-management/service-catalog-update` is
   * the case: `POST .../catalog/publish` authorizes `catalog.manage`, held by
   * `platform_super_admin`, `tenant_owner` and `tenant_admin`, and NO identity a scenario can
   * authenticate as holds it. The catalog round-trip is a real property and it is not being
   * proven, so a run asked for a conclusive answer has no business reporting green on it.
   *
   * Stated as a key rather than inferred, for the reason {@link SkipKind} gives: a default
   * would let a future skip acquire the harmless kind by omission.
   */
  skip_kind?: SkipKind;
  /**
   * Override the per-scenario wall-clock budget (ms). Only for a scenario whose slowness is
   * DELIBERATE — arc8-reconnect-preserve holds a connection past the server's 300s recovery
   * deadline and legitimately runs ~348s. Raising this to paper over a scenario that hangs
   * for an unknown reason is the failure this whole mechanism exists to surface.
   */
  scenario_timeout_ms?: number;
  /**
   * Conditional skip: when set AND the run is a `--bootstrap-pool` run, the scenario is
   * skipped with this reason (status 'skipped' — never failed/passed). For scenarios that are
   * incompatible with the shared pool but run fine standalone: e2e/* (self-provision their own
   * org+station → 409 vs the pool) and the cross-station regression (needs manual --var).
   * Transparent: counted as skipped so passed + failed + skipped = total.
   */
  skip_when_pooled?: string;
  /**
   * The INVERSE of `skip_when_pooled`: when set AND the run has NO bootstrapped pool, the
   * scenario is skipped with this reason (`not-applicable`). For a file whose precondition
   * is produced BY the per-run bootstrap and exists nowhere else.
   *
   * There is exactly one such precondition today and it is the reason this key exists: the
   * run's ephemeral `tenant_owner`, published to `SIM_POOL_OWNER_EMAIL` /
   * `SIM_POOL_OWNER_PASSWORD` by PoolBootstrap. It is the only identity a scenario can
   * authenticate as that holds `stations.manage_provisioning_tokens` or `catalog.manage`,
   * and it is created and destroyed inside one run.
   *
   * WHY A KEY AND NOT "SKIP WHEN THE ENV IS UNSET". `auth:` resolution THROWS on an unset
   * variable, deliberately: for the five files using `UAT_E2E_PLATFORM_ADMIN_*` an unset
   * variable means the operator forgot to source the secrets file, and a silent skip there
   * would turn a fixable mistake into a green run that proved less than it claimed. Softening
   * that globally to a skip would lose the distinction. This key states which of the two
   * situations a file is in, at the file, where it is checked before auth resolution runs.
   *
   * A file may not declare both this and `skip_when_pooled` — that pair can never run.
   */
  requires_pool?: string;
  /**
   * This scenario REGISTERS AND PROVISIONS A STATION OF ITS OWN, and must not be given one
   * from the pool. Set to the reason; the runner then takes no pool lease and resolves
   * `{{stationId}}` to `{{runStationId}}` — fresh per scenario, so nothing collides and the
   * scenario owns everything it creates (declare it in `creates:`).
   *
   * WHY IT IS NEEDED AT ALL, measured rather than assumed. Two areas cannot be reached from a
   * pool station because the pool's own bootstrap makes them unreachable, not because of any
   * permission:
   *
   *   - `POST .../catalog/publish` answers 6004 in two different situations — a station with
   *     NO services, and a station whose services are all withheld for want of a (bay,
   *     program) binding. `seedServiceCatalog` gives every pool station four services and
   *     binds all four, so on a pool station the call always succeeds.
   *   - anything whose subject is a session or command left in an unusual state: a pool
   *     station is leased to one scenario and handed straight to the next, so residue that
   *     self-heals in a minute is still a minute in which another file can meet it.
   *
   * The station must also be ONLINE for either — `requireDispatchableStation` checks
   * `is_online` before the catalog's own guards — so a file using this key provisions and
   * CONNECTS its station, which is why it pairs with `defer_mqtt_connect` and a
   * `connect_mqtt` step rather than excusing itself from the wire.
   */
  owns_station?: string;
  /**
   * On-disk fixtures this scenario cannot run without. If any path is absent the
   * scenario is SKIPPED (status 'skipped', reason names the missing file), never
   * failed and never silently passed.
   *
   * This exists for exactly one class of scenario: the ones whose subject is a
   * DELIBERATELY BROKEN certificate — revoked, expired — which by construction
   * cannot be obtained from the provisioning path (that path only ever mints
   * good certificates) and which `certs/` being gitignored keeps out of the
   * repo. Without this the scenario fails on every machine that lacks the
   * fixture, and a permanently-red line teaches everyone to ignore it — which
   * costs more than the proof was worth.
   *
   * The distinction that keeps this honest: a MISSING FIXTURE is a skip, but a
   * fixture that is present and no longer refused is a FAILURE. Nothing here
   * softens the proof itself; it only stops the absence of an instrument from
   * being reported as the failure of a property.
   *
   * Paths are resolved relative to the process CWD (the repo root), matching
   * `tls.cert`/`tls.key`/`tls.chain`.
   */
  requires_files?: string[];
  /** Actionable one-liner appended to the skip reason: how to produce the fixture. */
  requires_files_hint?: string;
  /**
   * The wallet balance, in credits, this scenario's identity must hold. Omit and the
   * scenario gets the bootstrap default (`DEFAULT_IDENTITY_WALLET_CREDITS`, 1000 — the
   * largest single authorization the server can accept against the seeded catalog), which
   * is what every scenario that is not ABOUT money wants.
   *
   * This exists for one class of scenario: the ones whose subject IS the money gate.
   * `StartSessionAction.php:241-250` refuses a card-free start when the balance does not
   * cover `creditsAuthorized` — 402 `INSUFFICIENT_BALANCE` / ospp_code 4001. Proving that
   * refusal needs an identity that cannot pay, and an identity that cannot pay must be
   * ASKED for. Before the default existed, every identity was unfunded and the refusal was
   * indistinguishable from the corpus's ambient state; a scenario claiming to prove it would
   * have passed for the wrong reason on every other file's fixture.
   *
   * The declaration is read at BOOTSTRAP time, not at run time: the CLI counts the scenarios
   * carrying a non-default value and the pool builder seeds that many extra identities at
   * the declared balance, so the runner only has to allocate one that already matches. No
   * scenario ever mutates a wallet mid-run — that would be shared mutable state a scenario
   * does not own, which is the same failure the identity pool exists to prevent.
   */
  wallet_balance?: number;
  /**
   * The number of units this scenario's batch drives. Set it and the pool bootstrap seeds
   * ONE extra catalog entry — a `MultiUnit` service with `max_unit_quantity` at least this —
   * on every pool station, and publishes its id as `{{serviceId_multiunit}}`.
   *
   * It exists because BOTH halves of the capacity gate are per-service DB state a scenario
   * cannot create for itself. `PaymentLandingController::process` computes
   * `effectiveMax = (service_kind === MultiUnit && max_unit_quantity >= 1) ? max : 1` and
   * refuses `invalid_quantity` outside `1..effectiveMax` — so against the four services the
   * pool seeds by default, every purchase is capped at one unit and no batch can be bought
   * at all. That is not a server defect and not a scenario bug; it is a fixture the corpus
   * never had.
   *
   * A declaration rather than a fifth default service, for the reason
   * `PoolBootstrapOptions.multiUnitCapacity` gives: an unconditional fifth entry reddens
   * `device-management/service-catalog-update.yaml`, which asserts `serviceCount: 4`.
   *
   * Read at BOOTSTRAP time, like `wallet_balance:` — the CLI takes the MAXIMUM across the
   * selected scenarios and the builder seeds that capacity once. A capacity of N satisfies
   * every file asking for N or fewer, so unlike an identity there is nothing to run out of.
   */
  requires_multiunit_service?: number;
  /**
   * When true, the runner skips the automatic `station.connect()` call so
   * that scenarios can run pre-provisioning API steps (signup, org, station
   * register, provisioning-token) before the station has TLS material. The
   * scenario MUST include a `connect_mqtt` step once provisioning artifacts
   * exist on disk.
   */
  defer_mqtt_connect?: boolean;
  /**
   * Per-scenario TLS-floor conformance override, layered on top of (never
   * replacing) `target.tls` for THIS scenario only — so one target (e.g.
   * `uat`) can back several TLS-pin variants without a dedicated
   * targets.yaml entry each. Node tls.connect() semantics.
   *
   *   min_version / max_version: pin an exact floor/ceiling, e.g.
   *     { min_version: 'TLSv1.2', max_version: 'TLSv1.2' } to emulate a
   *     modem capped at TLS 1.2 (A7608E-H). Omit both to inherit
   *     target.tls / MqttConnection's own default unchanged.
   *   no_client_cert: true DROPS whatever key/cert the target would
   *     otherwise supply, to prove mTLS enforcement (a connection with a
   *     valid server-CA but no client certificate must still be rejected).
   *
   * See also ConnectMqttStep's `min_version`/`max_version` fields, which
   * cover the same knob for scenarios using `defer_mqtt_connect` +
   * `connect_mqtt` (mid-scenario provisioning) instead of the automatic
   * pre-steps connect this field targets.
   */
  tls?: {
    min_version?: SecureVersion;
    max_version?: SecureVersion;
    no_client_cert?: boolean;
    /**
     * Per-scenario client identity override (ADR-0005 §7). Points the connect
     * attempt at a SPECIFIC cert/key — e.g. a revoked leaf — while leaving the
     * TLS version + CA chain at the target defaults, so a refusal can be
     * attributed to the cert alone (the S4 "one variable" discipline: the CRL
     * serial is the only variable). `{{stationId}}` is substituted. Mirrors
     * the `no_client_cert` branch, but feeds a cert instead of dropping it.
     */
    cert?: string;
    key?: string;
    /**
     * The chain PRESENTED alongside `cert` (CONS-133). Since the connect path
     * now presents leaf + chain, overriding `cert` alone would pair a foreign
     * leaf with the target's unrelated chain; set this whenever `cert` names a
     * leaf from another issuer. `{{stationId}}` is substituted.
     */
    chain?: string;
  };
  /**
   * When true, the automatic pre-steps `station.connect()` (see
   * `defer_mqtt_connect` above — this flag requires that to be unset/false)
   * is expected to be REJECTED by the broker: e.g. a TLS version below the
   * broker's floor (`tls.max_version` below the floor), or mTLS enforcement
   * rejecting a missing client cert (`tls.no_client_cert`).
   *
   * On a confirmed rejection the scenario is reported PASSED and `steps` is
   * never run — there is no connection for them to run against; author
   * this style of scenario with `steps: []`. If the connect unexpectedly
   * SUCCEEDS the scenario is reported FAILED (the conformance property
   * under test regressed) with a loud error.
   *
   * "Rejected" also covers a silent hang: some TLS handshake failures
   * surface as a bare socket reset rather than a clean TLS alert, which
   * MqttConnection deliberately swallows (see IGNORED_CODES) for unrelated
   * reasons — so a bounded timeout with neither `connect` nor `error` is
   * ALSO treated as "did not connect", not just an explicit error event.
   * See `connectExpectingFailure()`.
   */
  expect_connect_failure?: boolean;
  /**
   * Bound, in ms, on how long to wait for the rejection before a silent
   * hang is itself treated as a (still valid) rejection. Default 10000.
   */
  expect_connect_failure_timeout_ms?: number;
  /**
   * When set (alongside `expect_connect_failure`), the rejection is a PASS
   * only if its CLASSIFIED reason matches — otherwise the scenario FAILS even
   * though the connect was refused. This is what lets a revoked-cert proof
   * assert the refusal came from the broker's CRL check
   * (`broker-certificate-revoked`, invariant 6), and would NOT be satisfied by
   * a client-side TLS-version refusal (`client-tls-version`) or a bare hang.
   * See `classifyRefusalReason()`.
   */
  expect_refusal_reason?: RefusalReason;
  /**
   * MQTT 5 Clean Start. Defaults to `true` for scenarios — test runs should
   * not inherit a queued message backlog from a previous run, which delays
   * (or drops) time-sensitive responses like Heartbeat. Set to `false` only
   * when the scenario explicitly depends on session persistence (i.e. tests
   * that disconnect mid-flight and verify offline-queued commands replay
   * on reconnect).
   *
   * NOTE: Will (LWT) is delivered by the broker regardless of Clean Start —
   * setting this to `true` does NOT disable LWT.
   */
  clean_session?: boolean;
  station: {
    stationId?: string;
    bayCount: number;
    stationModel: string;
    stationVendor: string;
    behavior?: {
      accept_rate?: number;
      response_delay_ms?: [number, number];
    };
  };
  /**
   * Per-scenario auth override (C-018). When present, `context.apiCredentials`
   * is resolved from these env vars instead of `target.credentials` — used by
   * the e2e/* scenarios that need a platform_admin (NULL-scoped) identity to
   * call `POST /v1/organizations`. The default `target.credentials` is a
   * `tenant_owner` per PoolBootstrap doctrine and cannot create orgs.
   *
   * The override is scenario-local: it mutates `context.apiCredentials` only
   * for this run. `target.credentials` is never modified, so other scenarios
   * in the same suite keep the default identity.
   *
   * Mid-scenario identity switches (e.g. platform_admin → newly-onboarded
   * tenant_owner after `POST /organizations`) use `set_auth_token` on a
   * separate `POST /v1/auth/login` api_call step — see ApiCallStep.
   */
  auth?: {
    email_env: string;
    password_env: string;
  };
  steps: StepDefinition[];
}

export interface TargetConfig {
  mqttUrl: string;
  apiBaseUrl?: string;
  tls?: {
    key?: string;
    cert?: string;
    keyPattern?: string;
    certPattern?: string;
    /** Station CA chain presented alongside the leaf at connect (CONS-133) — `certs.station_ca_chain` in targets.yaml. */
    chain?: string;
    serverCa?: string;
    /** Config-level TLS floor/ceiling — see ScenarioDefinition.tls for the per-scenario override that layers on top of this. */
    minVersion?: SecureVersion;
    maxVersion?: SecureVersion;
  };
  mqttCredentials?: {
    usernameTemplate: string;
    passwordTemplate: string;
  };
  stationPool?: string[];
  credentials?: {
    email: string;
    password: string;
  };
  /**
   * Organization UUID for multi-tenant routing. When set, ApiCallStep
   * auto-injects `X-Organization-Id` on /api/v1/admin/* calls. When
   * unset and the API responds with `ORGANIZATION_REQUIRED`, ApiCallStep
   * attempts auto-discovery via GET /api/v1/organizations.
   */
  orgId?: string;
}

export interface RunOptions {
  maxWorkers?: number;
  cooldownMs?: number;
  filter?: string;
  /**
   * Per-run placeholder overrides. Each entry's key wins over the
   * matching auto-generated variable from `generateVariables()`. Used by
   * the CLI's repeatable `--var KEY=VALUE` flag to plug real bay/service
   * IDs into scenarios when exercising against an existing CSMS state.
   */
  userVars?: Map<string, string>;
}

/**
 * WHY a scenario was skipped, in the only distinction a machine needs.
 *
 * A skip is honest in the summary and in scrollback, but the EXIT CODE does not
 * move for it — only a failure does. So a run whose revocation proof skipped for
 * a missing fixture reports success, and anything that is not a human reading a
 * terminal (CI, a release script) sees green. Since the fixture directory is
 * gitignored, a fresh clone is precisely the case that triggers it.
 *
 * Making every skip exit non-zero would be wrong: some skips are genuinely
 * "this does not apply here" and always will be. The distinction that matters:
 *
 *  - `not-applicable` — the scenario cannot run in THIS invocation and nothing
 *    about the system under test is in question: an unimplemented server
 *    feature, a pool-incompatible file in a pooled run, a required `--var` the
 *    caller did not supply. Nothing was measured, and nothing was owed.
 *  - `inconclusive`   — the scenario was READY to measure and the INSTRUMENT was
 *    missing: the deliberately-broken certificate it exists to present is not on
 *    disk. A property that should have been proven was not, and the run has no
 *    business claiming success when someone asked for a conclusive one.
 *
 * Only `inconclusive` moves the exit code, and only under `--require-conclusive`.
 */
export type SkipKind = 'not-applicable' | 'inconclusive';

export interface ScenarioResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  steps: StepResult[];
  error?: string;
  /** Set only when `status === 'skipped'`. See {@link SkipKind}. */
  skipKind?: SkipKind;
}

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

const STEP_REGISTRY: ReadonlyMap<string, Step> = new Map<string, Step>([
  ['send', new SendStep()],
  ['wait_for', new WaitForStep()],
  ['wait_for_connect', new WaitForConnectStep()],
  ['assert', new AssertStep()],
  ['api_call', new ApiCallStep()],
  ['delay', new DelayStep()],
  ['start_heartbeat', new StartHeartbeatStep()],
  ['fault', new FaultStep()],
  ['provision', new ProvisionStep()],
  ['provision_station_pool', new ProvisionStationPoolStep()],
  ['connect_mqtt', new ConnectMqttStep()],
  ['fund_wallet', new FundWalletStep()],
]);

// ---------------------------------------------------------------------------
// Semaphore for parallel execution
// ---------------------------------------------------------------------------

class Semaphore {
  private count: number;
  private readonly waiting: Array<() => void> = [];

  constructor(count: number) {
    this.count = count;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    if (this.waiting.length > 0) {
      this.waiting.shift()!();
    } else {
      this.count++;
    }
  }
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

interface TemplateScope {
  variables: Map<string, string>;
  captured: Map<string, unknown>;
  provisioning?: ScenarioContext['provisioning'];
  pool?: StationPool;
}

function resolvePoolExpression(expression: string, pool: StationPool | undefined): string {
  // Supports:
  //   pool.size
  //   pool.first.id | pool.first.bayIds[N] | pool.first.certPath | ...
  //   pool.station[N].id | pool.stations[N].bayIds[M] | ...
  if (!pool) {
    throw new Error(
      `Template references pool.* but no station pool has been initialised. ` +
      `Add a 'provision_station_pool' step before this reference.`,
    );
  }
  if (expression === 'pool.size') {
    return String(pool.size());
  }
  const firstMatch = expression.match(/^pool\.first\.(.+)$/);
  if (firstMatch) {
    const entry = pool.first();
    if (!entry) {
      throw new Error('Template references pool.first.* but the pool is empty');
    }
    return resolvePoolEntryField(entry, firstMatch[1], expression);
  }
  const indexedMatch = expression.match(/^pool\.stations?\[(\d+)\]\.(.+)$/);
  if (indexedMatch) {
    const index = Number.parseInt(indexedMatch[1], 10);
    const entry = pool.at(index);
    if (!entry) {
      throw new Error(
        `Template references pool.station[${index}] but only ${pool.size()} entries are registered`,
      );
    }
    return resolvePoolEntryField(entry, indexedMatch[2], expression);
  }
  throw new Error(`Unrecognized pool template expression: ${expression}`);
}

function resolvePoolEntryField(entry: PoolEntry, field: string, fullExpression: string): string {
  // Supports id, stationId, certPath, keyPath, chainPath, brokerCaPath,
  // clientIdSuffix, bayIds[N]
  if (field === 'id' || field === 'stationId') {
    return entry.stationId;
  }
  if (field === 'certPath' && entry.certPath) return entry.certPath;
  if (field === 'keyPath' && entry.keyPath) return entry.keyPath;
  if (field === 'chainPath' && entry.chainPath) return entry.chainPath;
  if (field === 'brokerCaPath' && entry.brokerCaPath) return entry.brokerCaPath;
  if (field === 'clientIdSuffix') return entry.clientIdSuffix;
  const bayMatch = field.match(/^bayIds\[(\d+)\]$/);
  if (bayMatch) {
    const idx = Number.parseInt(bayMatch[1], 10);
    if (idx < 0 || idx >= entry.bayIds.length) {
      throw new Error(
        `Template ${fullExpression}: bayIds index ${idx} out of range (entry has ${entry.bayIds.length} bays)`,
      );
    }
    return entry.bayIds[idx];
  }
  throw new Error(`Unrecognized pool entry field: ${field} (in ${fullExpression})`);
}

function resolveProvisioningExpression(
  expression: string,
  provisioning: ScenarioContext['provisioning'] | undefined,
): string {
  if (!provisioning) {
    throw new Error(
      `Template references provisioning.* but no provisioning artifact is available. ` +
      `Add a 'provision' step before this reference, or run with --station against a ` +
      `target that has 'tests/artifacts/<target>/<stationId>/bays.json' persisted.`,
    );
  }
  if (expression === 'provisioning.stationId') return provisioning.stationId;
  if (expression === 'provisioning.certPath' && provisioning.certPath) return provisioning.certPath;
  if (expression === 'provisioning.keyPath' && provisioning.keyPath) return provisioning.keyPath;
  const bayMatch = expression.match(/^provisioning\.bayIds\[(\d+)\]$/);
  if (bayMatch) {
    const idx = Number.parseInt(bayMatch[1], 10);
    if (idx < 0 || idx >= provisioning.bayIds.length) {
      throw new Error(
        `Template ${expression}: bayIds index ${idx} out of range (provisioning has ${provisioning.bayIds.length} bays)`,
      );
    }
    return provisioning.bayIds[idx];
  }
  throw new Error(`Unrecognized provisioning template expression: ${expression}`);
}

function substituteTemplateValue(value: string, scope: TemplateScope): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const trimmed = varName.trim();
    if (trimmed.startsWith('captured.')) {
      const captureKey = trimmed.slice('captured.'.length);
      const capturedVal = scope.captured.get(captureKey);
      if (capturedVal === undefined) {
        throw new Error(`Captured variable not found: ${captureKey}`);
      }
      return String(capturedVal);
    }
    if (trimmed === 'pool.size' || trimmed.startsWith('pool.')) {
      return resolvePoolExpression(trimmed, scope.pool);
    }
    if (trimmed.startsWith('provisioning.')) {
      return resolveProvisioningExpression(trimmed, scope.provisioning);
    }
    const variable = scope.variables.get(trimmed);
    if (variable === undefined) {
      throw new Error(`Template variable not found: ${trimmed}`);
    }
    return variable;
  });
}

/**
 * A string whose ENTIRE content is a single `{{ ... }}` token — no surrounding
 * literal text and no second token. Capture group 1 is the inner expression
 * (e.g. `captured.offlinePass`). Used to decide when a substitution may yield a
 * typed (non-string) value rather than a string interpolation.
 */
const WHOLE_TEMPLATE_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

function substituteTemplates(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    // C-015: when a field's *entire* value is a single `{{ captured.X }}` token,
    // return the captured value with its original type intact (object / array /
    // number / boolean / null) instead of coercing it to a string. This lets a
    // scenario forward a server-signed payload (e.g. an OfflinePass) verbatim:
    // the server re-canonicalizes and ECDSA-verifies the pass, so byte- and
    // type-fidelity are required. Embedded templates ("opass_{{x}}") and
    // pool.* / provisioning.* / variable tokens keep the string-interpolation
    // path below (those resolvers only ever return strings anyway).
    const whole = value.match(WHOLE_TEMPLATE_RE);
    if (whole) {
      const token = whole[1].trim();
      if (token.startsWith('captured.')) {
        const captureKey = token.slice('captured.'.length);
        const capturedVal = scope.captured.get(captureKey);
        if (capturedVal === undefined) {
          throw new Error(`Captured variable not found: ${captureKey}`);
        }
        return capturedVal;
      }
    }
    return substituteTemplateValue(value, scope);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplates(item, scope));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      // KEYS are substituted too, not only values. `expect_body` names an array element
      // by CONTENT rather than by index — `data[eventId={{runSecurityEventId}}].type` —
      // and that selector lives in the KEY position. While keys were copied verbatim the
      // one index-free way to address a row could not carry a run-generated id at all:
      // the selector compared against the literal text `{{runSecurityEventId}}`, matched
      // nothing, and the assertion resolved to undefined. Note this is the string path
      // (`substituteTemplateValue`), never the typed whole-token path — a key must stay a
      // string, and a captured object in key position would stringify to `[object Object]`.
      //
      // Blast radius, measured across the whole corpus before the change: NO YAML mapping
      // key contained `{{` (the single grep hit was prose inside a `description` block), so
      // this is a no-op everywhere except where a selector deliberately asks for it. It is
      // not free of consequence though — `substituteTemplateValue` THROWS on an unknown
      // variable, so a future key with a stray `{{` now fails loudly rather than silently
      // addressing a field that does not exist. That is the direction the failure belongs in.
      result[substituteTemplateValue(key, scope)] = substituteTemplates(val, scope);
    }
    return result;
  }
  return value;
}

export function _hydrateProvisioningForTesting(
  stationId: string,
  target: TargetConfig,
): Promise<ScenarioContext['provisioning'] | undefined> {
  return hydrateProvisioningFromDisk(stationId, target);
}

/**
 * Resolve the `context.apiCredentials` for a scenario, applying the optional
 * `scenario.auth` env-var override (C-018). Returns a fresh object literal —
 * never mutates `targetCredentials`. Throws with the offending env-var name
 * when either side is unset or empty-string so misconfiguration surfaces at
 * scenario start, not later during the first `ensureAuth` HTTP attempt.
 *
 * Underscore-prefix marks this as a public-for-testing seam — the production
 * path (`runScenario` :line ~775) calls it inline. Other test helpers in this
 * file follow the same convention (`_hydrateProvisioningForTesting`).
 */
export function _resolveScenarioAuthForTesting(
  scenarioAuth: { email_env: string; password_env: string } | undefined,
  _targetCredentials: { email: string; password: string } | undefined,
  env: Record<string, string | undefined>,
): { email: string; password: string } | undefined {
  if (!scenarioAuth) {
    // Capul 2 of the UAT_EMAIL class: a scenario with NO `auth:` block returns undefined here
    // so the caller's `?? acquiredIdentity` routes to the per-scenario pool worker
    // (tenant_operator), NOT target.credentials/UAT_EMAIL (the drift-prone shared identity that
    // 401'd 56/94 scenarios). The caller's final `?? target.credentials` still covers non-pool
    // runs; in pooled mode acquiredIdentity is always set (allocator throws on depletion), so
    // the UAT_EMAIL fallback is structurally unreachable. (`_targetCredentials` kept for
    // signature stability with the 9 existing call sites / tests.)
    return undefined;
  }
  const email = env[scenarioAuth.email_env];
  const password = env[scenarioAuth.password_env];
  if (!email) {
    throw new Error(
      `scenario.auth override declared but env var "${scenarioAuth.email_env}" is unset or empty. ` +
      `Source secrets file before running (e.g. \`set -a; source ~/.config/osp-e2e-secrets.env; set +a\`).`,
    );
  }
  if (!password) {
    throw new Error(
      `scenario.auth override declared but env var "${scenarioAuth.password_env}" is unset or empty. ` +
      `Source secrets file before running (e.g. \`set -a; source ~/.config/osp-e2e-secrets.env; set +a\`).`,
    );
  }
  return { email, password };
}

export function _substituteTemplatesForTesting(
  value: unknown,
  variables: Map<string, string>,
  captured: Map<string, unknown>,
  options?: { pool?: StationPool; provisioning?: ScenarioContext['provisioning'] },
): unknown {
  return substituteTemplates(value, {
    variables,
    captured,
    pool: options?.pool,
    provisioning: options?.provisioning,
  });
}

// ---------------------------------------------------------------------------
// Variable generation
// ---------------------------------------------------------------------------

export function generateVariables(
  scenarioDef: ScenarioDefinition,
  target: TargetConfig,
  poolStationId?: string | null,
  userVars?: Map<string, string>,
): Map<string, string> {
  const vars = new Map<string, string>();

  const stationId = poolStationId ?? scenarioDef.station.stationId ?? generateStationId();
  vars.set('stationId', stationId);
  vars.set('serialNumber', generateSerialNumber());
  vars.set('target_url', target.apiBaseUrl ?? target.mqttUrl);

  // Fresh per run, so a scenario reconciling an offline transaction never hardcodes an
  // offlineTxId. The server dedups on it permanently, so a literal is reconcilable exactly
  // once per database and every later run gets `Duplicate` (see generateOfflineTxId).
  // Deliberately NOT named `offlineTxId`: security/offline-auth-transaction-reconcile*.yaml
  // REQUIRE that one as an explicit --var describing an out-of-band grant, and generating a
  // default for it would turn their honest "Template variable not found" into a confusing
  // downstream failure against a grant the server never issued.
  vars.set('runOfflineTxId', generateOfflineTxId());

  // Indexed siblings, for a scenario that reconciles SEVERAL transactions in one run and
  // needs them distinct from each other as well as from every previous run —
  // security/offline-fraud-rapid-transactions.yaml sends five. Eight is headroom, not a
  // measured limit; add more here rather than hardcoding a literal in a scenario.
  for (let i = 1; i <= 8; i++) {
    vars.set(`runOfflineTxId_${i}`, generateOfflineTxId());
  }

  // Fresh per run, for the same reason: the server dedups security events on a GLOBAL
  // unique event_id (SecurityAuditLogger.php:67), so a hardcoded one is insertable exactly
  // once per database. See generateSecurityEventId.
  vars.set('runSecurityEventId', generateSecurityEventId());

  // A station id that is FRESH PER SCENARIO and, unlike `stationId` above, is NEVER replaced
  // by the pool's. Same reason as the two ids above: a file that needs to REGISTER a station
  // of its own cannot use `stationId`, because in a pooled run that resolves to a station the
  // pool already registered and the registration answers 409 — which is precisely why the
  // three `e2e/*` parcours are `skip_when_pooled`. A file using this one owns what it creates
  // and declares it in `creates:`, so it collides with nothing and cleans up after itself.
  vars.set('runStationId', generateStationId());

  const bayCount = scenarioDef.station.bayCount;
  for (let i = 1; i <= bayCount; i++) {
    vars.set(`bayId_${i}`, generateBayId());
    // A SENTINEL, never a plausible slug — see UNHYDRATED_BAY_SLUG.
    vars.set(`baySlug_${i}`, UNHYDRATED_BAY_SLUG);
  }

  const defaultServices = ['wash_basic', 'wash_premium', 'dry', 'vacuum'];
  for (let i = 0; i < defaultServices.length; i++) {
    vars.set(`serviceId_${i + 1}`, generateServiceId(defaultServices[i]));
  }
  // The multi-unit service's id is a CONSTANT, so it resolves whether or not the row was
  // seeded — the row's existence is the business of `requires_multiunit_service:`, and
  // MultiUnitServiceDeclaredCheck is what stops a file referencing this without declaring
  // it. Publishing it as a variable rather than letting files write the literal keeps one
  // owner for the string, which is the same reason serviceId_1..4 are not literals either.
  vars.set('serviceId_multiunit', MULTIUNIT_SERVICE_ID);

  // CLI --var overrides win over auto-generated values (last-write semantics).
  if (userVars) {
    for (const [k, v] of userVars) {
      vars.set(k, v);
    }
  }

  return vars;
}

// ---------------------------------------------------------------------------
// Variable preflight — answer "can this scenario run at all?" BEFORE the run
// ---------------------------------------------------------------------------

/**
 * Every `{{token}}` the scenario actually EXECUTES — `steps` and `station`, never
 * `description`.
 *
 * The distinction is the whole correctness of this function. A scenario that documents its
 * own required `--var` in its header (single-session-drive spends nine comment lines on
 * `{{reason}}`) mentions the token in prose too, and a text-level scan cannot tell the
 * documentation from the dependency. The first version of this survey scanned raw text and
 * reported the one known-failing scenario as CLEAN, because its header explained the very
 * variable that breaks it.
 *
 * Mapping KEYS are collected as well as values: a key can carry a selector
 * (`data[eventId={{runSecurityEventId}}]`) and is substituted like any other string.
 */
function collectTemplateTokens(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) out.add(m[1].trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectTemplateTokens(v, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      collectTemplateTokens(k, out);
      collectTemplateTokens(v, out);
    }
  }
}

/**
 * The variables a scenario references that NOTHING will provide — so substitution is
 * guaranteed to throw the moment the step is reached.
 *
 * Derived by asking `generateVariables` itself what it provides, rather than restating the
 * list. A hand-copied list is a second source of truth that drifts the first time someone
 * adds a generated variable, and drift here means a preflight that either blocks a runnable
 * scenario or waves through the one it exists to catch.
 *
 * `captured.*` / `pool.*` / `provisioning.*` are resolved at step time from run state that
 * does not exist yet, so they are out of scope here by construction — this answers only
 * "was a plain variable never supplied?".
 */
/**
 * What `{{baySlug_N}}` resolves to when nothing hydrated it.
 *
 * WHY A SENTINEL AND NOT "NO DEFAULT". A variable with no default is reported by
 * {@link unsatisfiedVariables}, and the CLI's preflight then transparently SKIPS every file
 * referencing it — including in `--bootstrap-pool`, the one mode where the value does
 * arrive, because preflight runs before hydration. So "no default" would mean the pay-page
 * scenarios never run anywhere. `{{bayId_N}}` has the same shape and is handled the same
 * way: a placeholder at generate time, the real value at hydrate time.
 *
 * WHY IT IS THIS STRING AND NOT A RANDOM ONE. A random 10-character slug is exactly what a
 * real one looks like (`Str::random(10)`), so an un-hydrated run would send a plausible slug
 * to `/w/{slug}`, collect a 404, and read as a server fault — the V4 Finding #1 failure, in
 * a new place. This cannot be mistaken for a real slug in a URL, a log line or a report, and
 * it is what a reader sees before they see the 404.
 *
 * A file that needs the real value declares `requires_pool:` — the slug exists only in a
 * bootstrapped run — so the sentinel is the belt, not the trousers.
 */
export const UNHYDRATED_BAY_SLUG = 'NO-POOL-NO-SLUG';

export function unsatisfiedVariables(
  scenario: ScenarioDefinition,
  target: TargetConfig,
  userVars?: Map<string, string>,
): string[] {
  const provided = generateVariables(scenario, target, null, userVars);
  const tokens = new Set<string>();
  collectTemplateTokens(scenario.steps, tokens);
  collectTemplateTokens(scenario.station, tokens);

  const missing: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('captured.') || t.startsWith('pool.') || t.startsWith('provisioning.')) {
      continue;
    }
    if (!provided.has(t)) missing.push(t);
  }
  return missing.sort();
}

// ---------------------------------------------------------------------------
// Disk hydration — read persisted bays.json into context.provisioning
// ---------------------------------------------------------------------------

interface BaysJsonShape {
  stationId?: string;
  bayIds?: string[];
  baySlugs?: string[];
}

/**
 * Attempt to hydrate a provisioning artifact for the given stationId by
 * reading a persisted `<stationId>-bays.json` (CLI provision flat layout)
 * or `<artifactsBase>/<stationId>/bays.json` (in-scenario provision layout).
 *
 * Returns undefined if no file is found at the inferred paths. Wrapped in
 * try/catch so any I/O error degrades silently to "no hydration" — the
 * downstream template engine will throw a clear actionable error if a
 * scenario actually needs `{{ provisioning.* }}` but the artifact is
 * absent (V4 Finding #1 fix: fail loud, never silently fall back to
 * random bayIds).
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function hydrateProvisioningFromDisk(
  stationId: string,
  target: TargetConfig,
): Promise<ScenarioContext['provisioning'] | undefined> {
  const candidates: string[] = [];

  // 1. CLI provision layout: <dirname(key)>/<stationId>-bays.json
  const keyTemplate = target.tls?.keyPattern ?? target.tls?.key;
  if (keyTemplate) {
    const resolvedKey = keyTemplate.replace('{{stationId}}', stationId);
    candidates.push(
      path.join(path.dirname(resolvedKey), `${stationId}-bays.json`),
    );
  }

  // 2. In-scenario ProvisionStep layout: tests/artifacts/uat/<stationId>/bays.json
  candidates.push(
    path.resolve('tests/artifacts/uat', stationId, 'bays.json'),
  );

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf-8');
      const parsed = JSON.parse(raw) as BaysJsonShape;
      if (
        typeof parsed.stationId === 'string' &&
        Array.isArray(parsed.bayIds) &&
        parsed.bayIds.length > 0
      ) {
        const resolvedKey = keyTemplate
          ? keyTemplate.replace('{{stationId}}', stationId)
          : undefined;
        const receiptKeyPath = resolvedKey?.replace(/-key\.pem$/, '-receipt-key.pem');
        return {
          stationId: parsed.stationId,
          bayIds: [...parsed.bayIds],
          // Carried only when the file actually has it, and only when it is the same
          // LENGTH as bayIds — the two are index-aligned by contract, and a shorter list
          // would silently pair a slug with the wrong bay rather than fail.
          baySlugs:
            Array.isArray(parsed.baySlugs) && parsed.baySlugs.length === parsed.bayIds.length
              ? [...parsed.baySlugs]
              : undefined,
          certPath: resolvedKey?.replace(/-key\.pem$/, '.pem'),
          keyPath: resolvedKey,
          chainPath: resolvedKey?.replace(/-key\.pem$/, '-chain.pem'),
          // Surface the receipt-signing key only when it's actually on disk —
          // bootstrap/provision persist it; a pass-form-only station may not.
          receiptKeyPath:
            receiptKeyPath !== undefined && (await fileExists(receiptKeyPath))
              ? receiptKeyPath
              : undefined,
        };
      }
    } catch {
      // File missing or unparsable — try next candidate
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Station factory
// ---------------------------------------------------------------------------

function createStationFromScenario(
  scenarioDef: ScenarioDefinition,
  variables: Map<string, string>,
  target: TargetConfig,
  provisioning?: ProvisioningArtifact,
): Station {
  // Default to clean session for scenarios. Persistent sessions accumulate
  // server-published commands while the station is offline; on reconnect
  // EMQX delivers the entire backlog before our wait_for can match, which
  // pushed Heartbeat Response past the 5s scenario timeout (K2 §34 RCA).
  const cleanSession = scenarioDef.clean_session ?? true;
  const stationId = variables.get('stationId')!;

  // THE BAY COUNT DERIVES FROM WHAT WAS PROVISIONED, NOT FROM THE SCENARIO.
  //
  // These were two independent sources for one physical fact, and they diverged:
  // `--bootstrap-pool` provisioned `--pool-bays` bays server-side while every
  // pooled scenario declared its own `station.bayCount`, so the station booted
  // declaring a topology it had not been provisioned with. Nothing compared them
  // until csms-server d11b0896 armed its boot topology gate per-station, and then
  // 109 of 130 scenarios failed on one UAT run with `status: Pending` (3018).
  //
  // Aligning the two numbers would leave two numbers. The three e2e journeys that
  // survived that run are the shape to copy: they self-provision, so their declared
  // and provisioned topologies come from ONE source and cannot drift apart.
  //
  // This is NOT the station "agreeing with the server" that §05-state-machines.md:126
  // forbids — the provisioning artifact is the STATION's own declaration of its
  // hardware, made at provisioning time and read back from its own disk. It takes the
  // fact from itself, one step earlier. TopologyStore still owns boot-to-boot
  // stability: this only decides what is written on the FIRST boot.
  //
  // The IDs still come from `variables`, not from the artifact, because hydration
  // writes them there and CLI `--var bayId_N=...` overrides are applied AFTER
  // hydration (last-write semantics). Reading the artifact directly would silently
  // discard those overrides.
  const provisionedBayCount = provisioning?.bayIds?.length ?? 0;
  const bayCount = provisionedBayCount > 0 ? provisionedBayCount : scenarioDef.station.bayCount;

  const bays: BayConfig[] = [];
  for (let i = 1; i <= bayCount; i++) {
    const bayId = variables.get(`bayId_${i}`)!;
    bays.push({
      bayId,
      bayNumber: i,
      // Programs are the station's own firmware constants; services are what the
      // server pushed. Only programs go on the wire in a StatusNotification.
      programs: [{ programNumber: 1, label: 'Basic Wash', available: true }],
      services: [
        {
          serviceId: variables.get('serviceId_1') ?? generateServiceId('wash_basic'),
          serviceName: 'Basic Wash',
          available: true,
        },
      ],
    });
  }

  const behavior = scenarioDef.station.behavior;

  const config: StationConfig = {
    stationId,
    firmwareVersion: '1.0.0',
    stationModel: scenarioDef.station.stationModel,
    stationVendor: scenarioDef.station.stationVendor,
    serialNumber: variables.get('serialNumber')!,
    bayCount,
    timezone: 'UTC',
    bays,
    behavior: {
      acceptRate: behavior?.accept_rate ?? 1.0,
      responseDelayMs: behavior?.response_delay_ms ?? [0, 0],
      heartbeatIntervalSec: 60,
      meterValuesIntervalSec: 30,
      autoRetryBoot: (behavior as Record<string, unknown> | undefined)?.auto_retry_boot !== false,
    },
  };

  // Resolve MQTT credentials with template substitution
  let mqttCredentials: { username: string; password: string } | undefined;
  if (target.mqttCredentials) {
    const stationIdHex = stationId.replace(/^stn_/, '');
    const resolveTemplate = (tpl: string): string =>
      tpl.replace('{{stationIdHex}}', stationIdHex).replace('{{stationId}}', stationId);
    const username = resolveTemplate(target.mqttCredentials.usernameTemplate);
    const password = resolveTemplate(target.mqttCredentials.passwordTemplate);
    mqttCredentials = { username, password };
  }

  // Resolve {{stationId}} in all cert path fields
  let tls = target.tls;
  if (tls) {
    const resolve = (s: string | undefined) =>
      s?.replace('{{stationId}}', stationId);
    tls = {
      key: resolve(tls.keyPattern) ?? resolve(tls.key),
      cert: resolve(tls.certPattern) ?? resolve(tls.cert),
      chain: resolve(tls.chain),
      serverCa: resolve(tls.serverCa),
      minVersion: tls.minVersion,
      maxVersion: tls.maxVersion,
    };
  }

  // Per-scenario TLS-floor conformance override — layered on top of (never
  // replacing) the target's resolved tls. See ScenarioDefinition.tls doc.
  if (scenarioDef.tls) {
    tls = {
      ...tls,
      ...(scenarioDef.tls.min_version !== undefined
        ? { minVersion: scenarioDef.tls.min_version }
        : {}),
      ...(scenarioDef.tls.max_version !== undefined
        ? { maxVersion: scenarioDef.tls.max_version }
        : {}),
    };
    if (scenarioDef.tls.no_client_cert) {
      tls = { ...tls, key: undefined, cert: undefined, chain: undefined };
    }
    // Per-scenario client identity override (ADR-0005 §7): feed a SPECIFIC
    // cert/key (e.g. a revoked leaf) with `{{stationId}}` substituted. Layered
    // after no_client_cert so the two are mutually exclusive by authoring.
    if (
      scenarioDef.tls.cert !== undefined ||
      scenarioDef.tls.key !== undefined ||
      scenarioDef.tls.chain !== undefined
    ) {
      const sub = (s: string | undefined): string | undefined =>
        s?.replace('{{stationId}}', stationId);
      tls = {
        ...tls,
        ...(scenarioDef.tls.key !== undefined ? { key: sub(scenarioDef.tls.key) } : {}),
        ...(scenarioDef.tls.cert !== undefined ? { cert: sub(scenarioDef.tls.cert) } : {}),
        ...(scenarioDef.tls.chain !== undefined ? { chain: sub(scenarioDef.tls.chain) } : {}),
      };
    }
  }

  const station = new Station(config, {
    mqttUrl: target.mqttUrl,
    stationId,
    tls,
    mqttCredentials,
    cleanSession,
  });

  // Scenario mode runs zero auto-responder handlers (the scenario scripts every
  // outbound message). But the boot Response carries the sessionKey the station
  // needs to HMAC-sign critical messages, and only BootNotificationHandler
  // captures it. Register it with autoReact=false so it ONLY captures the
  // sessionKey (no auto heartbeat / StatusNotifications — those would duplicate
  // the scenario's explicit ones and use the pre-provision bayIds). The router
  // fans out (buffer + emit), so wait_for still sees the Response.
  // Cast: handlers implement the StationContext-based Handler; registerHandler
  // expects the Station-based Handler (same SessionInfo-divergence cast the
  // `connect` command uses — see cli/index.ts).
  station.registerHandler(
    OsppAction.BOOT_NOTIFICATION,
    new BootNotificationHandler(false) as unknown as Handler,
  );

  return station;
}

/**
 * Test seam — exposes the private scenario Station factory so unit tests can
 * assert scenario-mode wiring (e.g. that a station captures the boot sessionKey).
 */
export const _createStationFromScenarioForTesting = createStationFromScenario;

// ---------------------------------------------------------------------------
// Negative-path connect — TLS-1.2-floor conformance arc (expect_connect_failure)
// ---------------------------------------------------------------------------

/**
 * Why a connect attempt was refused, attributed to a LAYER. Load-bearing for
 * the revocation proof (ADR-0005 §7, invariant 6): a "refused" boolean can be
 * satisfied by the wrong cause (a client-side TLS-version refusal, a bare
 * hang), so a revoked-cert proof must assert the refusal came specifically
 * from the broker's CRL check.
 *
 *  - `broker-certificate-revoked` — the broker rejected the leaf via its CRL
 *    check (TLS alert 44 `certificate_revoked`). THE revocation signal.
 *  - `broker-certificate-expired` — the broker rejected the leaf because it is
 *    past `notAfter` (TLS alert 45 `certificate_expired`). THE expiry signal,
 *    and it must NOT live in the bucket below: `broker-bad-certificate` also
 *    covers `unknown ca`, so an expiry scenario asserting it would pass just
 *    as happily against a leaf from the WRONG hierarchy — the untrusted-chain
 *    refusal masquerading as an expiry proof. Expiry is checked by ordinary
 *    path validation, so this alert arrives with `enable_crl_check` off too;
 *    that independence is exactly why it needs its own name.
 *  - `broker-bad-certificate`     — other broker-side cert refusal (missing
 *    client cert, unknown CA, bad certificate, handshake failure).
 *  - `client-tls-version`         — the client's own TLS stack refused before
 *    a byte reached the broker (e.g. a below-floor version pin, S3).
 *  - `timeout`                    — a bounded hang with no clean alert.
 *  - `unknown`                    — refused, but unclassifiable.
 */
export type RefusalReason =
  | 'broker-certificate-revoked'
  | 'broker-certificate-expired'
  | 'broker-bad-certificate'
  | 'client-tls-version'
  | 'timeout'
  | 'unknown';

export interface RefusalClassification {
  reason: RefusalReason;
  layer: 'broker' | 'client' | 'unknown';
}

/**
 * First entry of {@link ScenarioDefinition.requires_files} that is not on disk,
 * or null when every required fixture is present (including the empty/undefined
 * case — a scenario that requires nothing is never skipped by this).
 *
 * Returns the FIRST missing path rather than all of them: the skip reason names
 * one concrete file the reader can go and look at, and a fixture set is
 * produced as a unit anyway (leaf + key + chain), so listing three absences
 * says nothing the first does not.
 */
export function findMissingRequiredFile(required?: string[]): string | null {
  for (const p of required ?? []) {
    if (!existsSync(p)) return p;
  }
  return null;
}

/**
 * The target-level counterpart of {@link findMissingRequiredFile}: the first
 * FIXED path in `target.tls` that is not on disk, or null.
 *
 * `requires_files` is a scenario key and a target has no equivalent, so a fixed
 * path in a target's cert block — `local-mtls`'s `ca: certs/local/broker-ca.pem`
 * is the live example — is a fixture dependency no scenario can declare, silently
 * inherited by every scenario aimed at that target. Rather than widen the YAML
 * with a target-level key nobody would remember to fill in, the runner derives
 * it: a target's own config already says which files it needs.
 *
 * ONLY non-templated entries are checked, and that exclusion is load-bearing.
 * `certs/uat/{{stationId}}.pem` is written per run by provisioning and is
 * correctly absent before it — treating it as a missing fixture would make every
 * `defer_mqtt_connect` scenario inconclusive on a clean box, which is the exact
 * false alarm that teaches people to pass the override. A path with no `{{` is
 * never produced by provisioning, so its absence is unambiguous.
 *
 * `keyPattern`/`certPattern` are excluded by construction: they are patterns.
 */
export function findMissingTargetCert(target: Pick<TargetConfig, 'tls'>): string | null {
  const fixed = [target.tls?.key, target.tls?.cert, target.tls?.chain, target.tls?.serverCa]
    .filter((p): p is string => typeof p === 'string' && p.length > 0 && !p.includes('{{'));
  for (const p of fixed) {
    if (!existsSync(p)) return p;
  }
  return null;
}

/**
 * Classify a connect-failure detail string (the TLS-alert / OpenSSL error text
 * mqtt.js surfaces, or the runner's own timeout message) into a REASON + the
 * layer it came from. Order matters: the revocation alert is checked before
 * the generic bad-certificate bucket, and client-side version refusals before
 * broker alerts, so the most specific attribution wins.
 */
export function classifyRefusalReason(detail: string): RefusalClassification {
  const d = detail.toLowerCase();

  // Broker CRL check: TLS alert 44 = certificate_revoked. OpenSSL renders it
  // "...alert certificate revoked"; some stacks only carry the alert number.
  if (/certificate revoked/.test(d) || /\balert number 44\b/.test(d) || /alert_certificate_revoked/.test(d)) {
    return { reason: 'broker-certificate-revoked', layer: 'broker' };
  }

  // Broker path validation: TLS alert 45 = certificate_expired. Checked here,
  // beside its sibling alert and ABOVE the generic bucket, for the reason given
  // on RefusalReason: folded into `broker-bad-certificate` it would be
  // indistinguishable from `unknown ca`, and the fixture that proves expiry is
  // signed by a DIFFERENT CA than the one a UAT broker trusts — so the
  // misattribution is not hypothetical, it is the first thing that happens if
  // the scenario is pointed at the wrong target.
  if (/certificate expired/.test(d) || /\balert number 45\b/.test(d) || /alert_certificate_expired/.test(d)) {
    return { reason: 'broker-certificate-expired', layer: 'broker' };
  }

  // Client-side TLS-version refusal — the client never emits a ClientHello the
  // broker could answer (S3: Node/OpenSSL-3 refuses a below-floor pin).
  if (
    /no protocols available/.test(d) ||
    /unsupported protocol/.test(d) ||
    /wrong version number/.test(d) ||
    /protocol version/.test(d) ||
    /no_protocols_available/.test(d)
  ) {
    return { reason: 'client-tls-version', layer: 'client' };
  }

  // Other broker-side certificate refusals (mTLS enforcement, chain, expiry).
  if (
    /handshake failure/.test(d) ||
    /bad certificate/.test(d) ||
    /unknown ca/.test(d) ||
    /certificate required/.test(d) ||
    /peer did not return a certificate/.test(d) ||
    /unknown_ca/.test(d) ||
    /bad_certificate/.test(d)
  ) {
    return { reason: 'broker-bad-certificate', layer: 'broker' };
  }

  // The runner's bounded-hang message (see connectExpectingFailure).
  if (/treated as rejection/.test(d) || /no connect\/error event/.test(d)) {
    return { reason: 'timeout', layer: 'unknown' };
  }

  return { reason: 'unknown', layer: 'unknown' };
}

/**
 * Drives `station.connect()` for a scenario that declares
 * `expect_connect_failure: true` (see ScenarioDefinition doc) and resolves
 * with a human-readable description of HOW the rejection was observed.
 *
 * Throws if `station.connect()` actually SUCCEEDS — that is the failure
 * case for this style of scenario (the runner's normal catch path then
 * reports the scenario as failed, loudly, since the conformance property
 * under test — e.g. "the broker refuses TLS below its floor" — regressed).
 *
 * Races the connect attempt against a bound timeout rather than trusting
 * `station.connect()` to always settle: some TLS handshake failures surface
 * as a bare socket reset rather than a clean TLS alert, and MqttConnection
 * deliberately swallows ECONNRESET (see its IGNORED_CODES — unrelated
 * reasons, disconnect/reconnect churn) which would otherwise leave
 * station.connect()'s promise pending forever. A timeout with neither
 * `connect` nor `error` is therefore ALSO treated as "did not connect".
 */
async function connectExpectingFailure(
  station: Station,
  timeoutMs: number,
): Promise<string> {
  const connectAttempt: Promise<string> = station.connect().then(
    () => {
      throw new Error(
        'expect_connect_failure: station.connect() succeeded — the broker was expected to REJECT this connection',
      );
    },
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  // Attach a throwaway handler so a LATE settlement (after the timeout below
  // has already won the race) never surfaces as an unhandled rejection.
  connectAttempt.catch(() => {});

  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`no connect/error event within ${timeoutMs}ms (treated as rejection)`),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([connectAttempt, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ScenarioRunner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Station pool allocator — picks stationIds from pool for sandbox targets
// ---------------------------------------------------------------------------

class StationPoolAllocator {
  private readonly pool: string[];
  private readonly inUse: Set<string> = new Set();
  private nextIndex = 0;
  private readonly waiting: Array<(stationId: string) => void> = [];

  constructor(pool: string[]) {
    this.pool = pool;
  }

  async acquire(): Promise<string> {
    // Find the next available stationId
    for (let attempts = 0; attempts < this.pool.length; attempts++) {
      const id = this.pool[this.nextIndex % this.pool.length];
      this.nextIndex++;
      if (!this.inUse.has(id)) {
        this.inUse.add(id);
        return id;
      }
    }
    // All in use — wait for one to be released
    return new Promise<string>((resolve) => this.waiting.push(resolve));
  }

  release(stationId: string): void {
    this.inUse.delete(stationId);
    if (this.waiting.length > 0) {
      this.inUse.add(stationId);
      this.waiting.shift()!(stationId);
    }
  }
}

// ---------------------------------------------------------------------------
// Identity pool allocator — per-scenario tenant_operator credentials.
//
// SINGLE-USE FIFO: every acquire() shifts one identity off the head and the
// identity is NEVER returned to the pool. Each scenario gets a unique identity
// for its lifetime, never shared with another scenario in the same run. With
// the CLI auto-sizing the pool to max(scenarioCount, workers), the session-mutate
// rate limit (10/min/user, max 4 mutations per scenario per spec) becomes
// structurally unable to overflow — no burst arithmetic, no rotation timing,
// no shared bucket between tests.
//
// History: a rotation/release variant was the first design (commit 2226b8e
// "per-worker identity isolation"). It split the bucket statistically but kept
// identities shared across scenarios within a run, so a worker firing 3+
// mutating scenarios on the same identity within 60s still overflowed →
// commit #2's 429-retry absorbed the 4xx with a 60s Retry-After, but the
// dependent MQTT wait_for steps then timed out (15s). The per-scenario model
// removes the shared bucket entirely; commit #2's retry stays as defense-in-
// depth for unrelated transient 429s but fires zero for session-mutate now.
// ---------------------------------------------------------------------------

export interface IdentityCredentials {
  email: string;
  password: string;
  /**
   * Credits this identity's wallet was seeded with. Carried on the credential so the
   * allocator can honour a scenario's `wallet_balance:` declaration without a DB read —
   * and so a serialized pool handle still says what each identity can afford.
   */
  walletBalance?: number;
  /**
   * True when this identity exists ONLY because some scenario declared `wallet_balance:`.
   * It is invisible to a plain `acquire()` — see the allocator's two-queue split.
   */
  declared?: boolean;
}

export class IdentityPoolAllocator {
  /** Default-funded identities, handed out FIFO to scenarios that declared nothing. */
  private readonly available: IdentityCredentials[];
  /**
   * Identities seeded to satisfy a `wallet_balance:` declaration. Kept OUT of the FIFO
   * queue: an unfunded identity handed to an undeclaring scenario would resurrect the exact
   * failure this whole change removes — a session start refused 402 for a reason the
   * scenario is not about, reported three steps later as a `wait_for` timeout.
   */
  private readonly reserved: IdentityCredentials[];
  private readonly initialSize: number;

  constructor(pool: IdentityCredentials[]) {
    // Defensive copy so the caller's source array stays untouched if it's
    // re-used elsewhere (e.g., serializePoolHandle).
    this.available = pool.filter((c) => !c.declared);
    this.reserved = pool.filter((c) => c.declared);
    this.initialSize = pool.length;
  }

  /**
   * Pop one identity off the FIFO queue. Throws if empty — pool depletion is
   * a programming error (the CLI's pool sizing contract guarantees enough),
   * never a runtime condition to recover from.
   *
   * With {@link walletBalance} set, takes one of the RESERVED identities seeded at exactly
   * that balance — the pool builder seeds one per declaring scenario, so a match exists
   * whenever a scenario declared it. A miss is a wiring error (a declaration the builder
   * never saw), never something to paper over by handing back a differently-funded
   * identity: that would run a refusal proof against a wallet that can pay, and pass.
   */
  acquire(walletBalance?: number): IdentityCredentials {
    if (walletBalance !== undefined) {
      const index = this.reserved.findIndex((c) => c.walletBalance === walletBalance);
      if (index === -1) {
        throw new Error(
          `IdentityPoolAllocator: no identity reserved at wallet_balance ${walletBalance} ` +
          `(${this.reserved.length} reserved left, balances: ` +
          `[${[...new Set(this.reserved.map((c) => c.walletBalance))].join(', ')}]). The pool ` +
          `builder seeds one identity per scenario declaring wallet_balance, so this means ` +
          `the declaration never reached it — check that the CLI collected the scenario's ` +
          `wallet_balance into bootstrapPool's declaredWalletBalances.`,
        );
      }
      return this.reserved.splice(index, 1)[0];
    }
    const next = this.available.shift();
    if (!next) {
      throw new Error(
        `IdentityPoolAllocator depleted: ${this.initialSize} identities consumed, ` +
        `no more available. Pool under-sized for the run — the CLI must auto-size ` +
        `--identity-pool-size to max(scenarioCount, workers) so this cannot happen.`,
      );
    }
    return next;
  }

  /** Remaining identities, both queues (diagnostics only — not used for runtime decisions). */
  remaining(): number {
    return this.available.length + this.reserved.length;
  }

  /** Initial pool size — useful in test assertions / error messages. */
  size(): number {
    return this.initialSize;
  }
}

export class ScenarioRunner {
  private poolAllocator: StationPoolAllocator | null = null;
  /**
   * Optional run-level station pool, populated by the per-run pool bootstrap.
   * When set, every scenario's `context.pool` points at it so the `{{ pool.* }}`
   * namespace resolves run-wide (revives the dormant pool machinery without a
   * per-scenario `provision_station_pool` step). Read-only from scenarios, so
   * sharing the instance across parallel scenarios is safe.
   */
  private runPool: StationPool | null = null;
  /**
   * Optional per-scenario identity pool, populated by the per-run pool bootstrap.
   * Each scenario acquires its own `(email, password)` tuple via single-use FIFO
   * (the identity is never reused within the run), so the server-side per-user
   * session-mutate bucket (10/min) can't be contested across tests. Without this,
   * all scenarios share `target.credentials` → one bucket → bursts → 429s.
   */
  private identityPoolAllocator: IdentityPoolAllocator | null = null;
  /**
   * When true, per-scenario teardown is skipped and the recorded resources are printed
   * instead — the `--keep-created` debug path, mirroring `--keep-pool`. The ids are
   * always printed in that case, so "kept" never means "lost track of".
   */
  private keepCreated = false;

  /** Install a run-level pool (see {@link runPool}). */
  setRunPool(pool: StationPool): void {
    this.runPool = pool;
  }

  /** Keep (and report) whatever the scenarios create instead of tearing it down. */
  setKeepCreated(keep: boolean): void {
    this.keepCreated = keep;
  }

  /** Install a run-level identity pool (see {@link identityPoolAllocator}). */
  setRunIdentities(credentials: IdentityCredentials[]): void {
    this.identityPoolAllocator = credentials.length > 0
      ? new IdentityPoolAllocator(credentials)
      : null;
  }

  async loadScenario(filePath: string): Promise<ScenarioDefinition> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseYaml(content) as ScenarioDefinition;

    if (!parsed.name) {
      throw new Error(`Scenario at ${filePath} is missing a "name" field`);
    }
    if (!parsed.station) {
      throw new Error(`Scenario at ${filePath} is missing a "station" field`);
    }
    if (!parsed.station.stationModel) {
      throw new Error(`Scenario '${parsed.name}' missing required field station.stationModel in YAML`);
    }
    if (!parsed.station.stationVendor) {
      throw new Error(`Scenario '${parsed.name}' missing required field station.stationVendor in YAML`);
    }
    if (!Array.isArray(parsed.steps)) {
      throw new Error(`Scenario at ${filePath} is missing a "steps" array`);
    }

    return parsed;
  }

  /**
   * Build a transparent 'skipped' result (status 'skipped', reason on a marker
   * step) tagged with WHY — see {@link SkipKind}. `kind` is explicit at every
   * call site rather than defaulted, because the difference between "does not
   * apply" and "could not be proven" is the whole point and a default would let
   * a future skip acquire the harmless one by omission.
   */
  private skippedResult(name: string, reason: string, kind: SkipKind): ScenarioResult {
    const label = kind === 'inconclusive' ? 'SKIPPED (INCONCLUSIVE)' : 'SKIPPED';
    console.log('[ScenarioRunner] %s "%s": %s', label, name, reason);
    return {
      name,
      status: 'skipped',
      skipKind: kind,
      durationMs: 0,
      steps: [{ stepIndex: -1, action: 'skip', status: 'skipped', durationMs: 0, error: reason }],
    };
  }

  /**
   * `runScenario` under a wall-clock bound, so one blocked scenario cannot cost the run.
   *
   * There is no per-step watchdog anywhere below this: a step awaiting something that never
   * arrives blocks forever, and because verdicts are only printed by the final report, ONE
   * such scenario destroys all 113 other results. That happened on the 2026-08-10 full run —
   * the log went silent for ~5 minutes and the run was nearly killed; it turned out to be a
   * slow scenario, but nothing structural distinguished the two cases.
   *
   * The bound is measured, not guessed — from the 116-scenario run of 2026-08-10:
   *   - slowest SUCCESSFUL scenario, excluding the deliberate outlier:  14.4s (Hard Reset)
   *   - slowest scenario overall, excluding the outlier:                60.8s — and those two
   *     (multiunit-*-drive) spend it inside their own `wait_for … timeout_ms: 60000`
   *   - the deliberate outlier: arc8-reconnect-preserve at 347.8s, which by design holds a
   *     connection past the server's 300s offline-recovery deadline
   * DEFAULT_SCENARIO_TIMEOUT_MS sits above the 60.8s band so a scenario that legitimately
   * exhausts a 60s `wait_for` still reports ITS OWN error rather than being masked by ours,
   * and ~6x above the real success ceiling. arc8 carries `scenario_timeout_ms` of its own.
   *
   * HONEST LIMIT: a JS promise cannot be cancelled. On timeout we return a failed result and
   * let the run continue, but the orphaned scenario keeps running; its own `finally` still
   * disconnects the station and releases it back to the pool, just later than the report
   * suggests. We attach a no-op catch so an eventual rejection cannot surface as an unhandled
   * rejection and kill the process. Bounding the RUN is the goal; reclaiming the station
   * promptly would need cancellation plumbed through every step.
   */
  private async runScenarioBounded(
    scenario: ScenarioDefinition,
    target: TargetConfig,
    userVars?: Map<string, string>,
  ): Promise<ScenarioResult> {
    const budgetMs = scenario.scenario_timeout_ms ?? DEFAULT_SCENARIO_TIMEOUT_MS;
    const startTime = Date.now();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = this.runScenario(scenario, target, userVars);

    const timeout = new Promise<ScenarioResult>(resolve => {
      timer = setTimeout(() => {
        resolve({
          name: scenario.name,
          status: 'failed',
          durationMs: Date.now() - startTime,
          steps: [{
            stepIndex: -1,
            action: 'scenario',
            status: 'failed',
            durationMs: Date.now() - startTime,
            error:
              `Scenario exceeded its ${budgetMs}ms budget and was abandoned so the run could ` +
              `continue. This is the RUNNER giving up, not an assertion failing — the scenario ` +
              `was still blocked on whatever its last step awaited. Raise it for this file with ` +
              `\`scenario_timeout_ms:\` if the wait is legitimate, or fix the step that hangs.`,
          }],
        });
      }, budgetMs);
    });

    try {
      // Whichever settles first wins; the loser is neutralised below.
      return await Promise.race([running, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // If the timeout won, `running` is orphaned — never let it reject into the void.
      void running.catch(() => undefined);
    }
  }

  async runScenario(
    scenario: ScenarioDefinition,
    target: TargetConfig,
    userVars?: Map<string, string>,
  ): Promise<ScenarioResult> {
    if (scenario.skip) {
      return this.skippedResult(
        scenario.name,
        scenario.skip_reason ?? 'marked as skip',
        scenario.skip_kind ?? 'not-applicable',
      );
    }
    // Conditional skip: a pool-incompatible scenario in a --bootstrap-pool run (this.runPool set).
    // Transparent — reported 'skipped', never silently dropped or counted as passed.
    if (scenario.skip_when_pooled && this.runPool !== null) {
      return this.skippedResult(scenario.name, scenario.skip_when_pooled, 'not-applicable');
    }
    // The inverse. Checked BEFORE auth resolution, which is the whole point: the credentials
    // this class of file needs are published by the bootstrap, so without one the `auth:`
    // block would throw "env var unset" — a message that names the wrong problem.
    if (scenario.requires_pool && this.runPool === null) {
      return this.skippedResult(
        scenario.name,
        `${scenario.requires_pool} Run with --bootstrap-pool (the identity it needs is minted ` +
          `and destroyed per run, so there is nothing to source from a secrets file).`,
        'not-applicable',
      );
    }
    // Conditional skip: a required on-disk fixture is absent (see requires_files).
    // INCONCLUSIVE — the scenario was ready and the instrument was missing.
    const missingFixture = findMissingRequiredFile(scenario.requires_files);
    if (missingFixture !== null) {
      return this.skippedResult(
        scenario.name,
        `requires_files: "${missingFixture}" is not on disk. This scenario needs a ` +
          `deliberately-broken certificate that cannot be provisioned on demand, and ` +
          `certs/ is gitignored, so the fixture does not travel with the repo. ` +
          `${scenario.requires_files_hint ?? 'See the scenario header for how to obtain it.'}`,
        'inconclusive',
      );
    }
    // Same class, one level up: a FIXED path in the target's cert block. These
    // are not declarable per scenario — `requires_files` is a scenario key and a
    // target has no equivalent — so the runner checks them here on the
    // scenario's behalf. Only non-templated paths: anything carrying `{{` is
    // produced per run by provisioning and is legitimately absent beforehand.
    const missingTargetCert = findMissingTargetCert(target);
    if (missingTargetCert !== null) {
      return this.skippedResult(
        scenario.name,
        `target fixture "${missingTargetCert}" is not on disk. It is a fixed path in the ` +
          `target's cert block (not templated, so provisioning never creates it) and certs/ ` +
          `is gitignored, so it does not travel with the repo. Every scenario aimed at this ` +
          `target inherits the dependency.`,
        'inconclusive',
      );
    }

    const context = createContext();
    // Expose the run-level bootstrap pool (if any) to `{{ pool.* }}`.
    if (this.runPool) {
      context.pool = this.runPool;
    }

    // Lazy-init pool allocator for single-scenario runs (runAll does it in bulk)
    if (!this.poolAllocator && target.stationPool?.length) {
      this.poolAllocator = new StationPoolAllocator(target.stationPool);
    }

    // Allocate stationId from pool if available (skip if YAML hardcodes one, and skip if the
    // scenario brings its own — `owns_station`, which also releases the lease it would
    // otherwise hold for a station it never touches).
    const hardcodedStationId = scenario.station.stationId &&
      !scenario.station.stationId.includes('{{');
    let poolStationId: string | null = null;
    if (this.poolAllocator && !hardcodedStationId && !scenario.owns_station) {
      poolStationId = await this.poolAllocator.acquire();
    }

    // Per-scenario identity allocation. SINGLE-USE: shifted off the FIFO pool here,
    // never released back (see IdentityPoolAllocator doc). Each scenario owns its
    // identity for its lifetime — no other scenario in this run will use the same
    // user_id, so the per-user session-mutate bucket can't be contested.
    // A `wallet_balance:` declaration is honoured here: the scenario gets one of the
    // identities the pool builder reserved at that balance, never a default-funded one.
    let acquiredIdentity: IdentityCredentials | null = null;
    if (this.identityPoolAllocator) {
      acquiredIdentity = this.identityPoolAllocator.acquire(scenario.wallet_balance);
    }

    const variables = generateVariables(scenario, target, poolStationId, userVars);
    // `owns_station` resolves the scenario's identity to its OWN fresh id. Done here rather
    // than inside generateVariables so the two ids stay one value: everything downstream —
    // the Station object, ConnectMqttStep, the cert-path templates — reads `stationId`, and
    // a scenario that owned a station under a second name would have to remember which of
    // the two each step meant.
    if (scenario.owns_station) {
      const own = variables.get('runStationId');
      if (typeof own !== 'string' || own.length === 0) {
        throw new Error(
          'owns_station is set but `runStationId` was not generated — generateVariables must ' +
            'provide it; see the key\'s docblock.',
        );
      }
      variables.set('stationId', own);
    }
    context.variables = variables;
    context.apiBaseUrl = target.apiBaseUrl;
    // Identity resolution precedence (C-018):
    //   1. scenario.auth — explicit YAML override, wins over everything. Used by
    //      e2e/* scenarios that need a platform_admin (NULL-scoped) to call
    //      POST /v1/organizations. Returns a fresh object literal — target is
    //      never mutated.
    //   2. acquiredIdentity — per-scenario tenant_operator from the run's FIFO
    //      identity pool (when --identity-pool-size > 0). Each scenario owns its
    //      slot for its lifetime; never released back.
    //   3. target.credentials — single shared identity from targets.yaml. Legacy
    //      debug-run mode and the no-pool default.
    context.apiCredentials =
      _resolveScenarioAuthForTesting(scenario.auth, target.credentials, process.env)
      ?? acquiredIdentity
      ?? target.credentials;
    context.orgId = target.orgId;

    // Eagerly hydrate context.provisioning from disk for the active stationId.
    // Scenarios that have their own `provision` step will overwrite it; the
    // hydration handles the V4 case where `simulator run --station <id>` is
    // pointed at a pre-provisioned station whose bayIds are in
    // `<certs_dir>/<stationId>-bays.json`. (V4 Finding #1.)
    //
    // When the artifact is found, real bayIds also overwrite the auto-generated
    // `bayId_N` keys in `variables` so existing scenarios that reference
    // `{{ bayId_1 }}` get the real values without needing per-scenario rewrites.
    // CLI `--var bayId_1=...` overrides still win (last-write semantics, applied
    // by generateVariables) — that order is preserved by applying user overrides
    // AFTER hydration via a re-application step below.
    const activeStationId = variables.get('stationId');
    if (activeStationId) {
      const hydrated = await hydrateProvisioningFromDisk(activeStationId, target);
      if (hydrated) {
        context.provisioning = hydrated;
        // Wire a pool entry so SendStep finds the station's receipt-signing key
        // for `run --station <id>` against a pre-provisioned station. Bootstrap
        // registers this via PoolBootstrap; disk-hydration must too, else
        // offline-receipt TransactionEvent scenarios fail with
        // "no receiptKeyPath registered". Skip if a run-pool entry already exists.
        if (context.pool.get(activeStationId) === undefined) {
          context.pool.register({
            stationId: activeStationId,
            bayIds: hydrated.bayIds,
            certPath: hydrated.certPath,
            keyPath: hydrated.keyPath,
            chainPath: hydrated.chainPath,
            receiptKeyPath: hydrated.receiptKeyPath,
          });
        }
        for (let i = 0; i < hydrated.bayIds.length; i++) {
          variables.set(`bayId_${i + 1}`, hydrated.bayIds[i]);
        }
        // The pay-page identity of each bay, overwriting the sentinel generateVariables
        // seeded. See UNHYDRATED_BAY_SLUG for why the sentinel exists at all.
        if (hydrated.baySlugs) {
          for (let i = 0; i < hydrated.baySlugs.length; i++) {
            variables.set(`baySlug_${i + 1}`, hydrated.baySlugs[i]);
          }
        }
        if (userVars) {
          for (const [k, v] of userVars) {
            variables.set(k, v);
          }
        }
        console.log(
          `[ScenarioRunner] hydrated provisioning for ${activeStationId} (${hydrated.bayIds.length} bay(s))`,
        );
      }
    }

    // `context.provisioning` is set just above by disk hydration, and ONLY by it at
    // this point: a scenario that provisions itself does so in a STEP, which has not
    // run yet. So a pool station derives its topology from the pool, and a
    // self-provisioning scenario keeps its own declared `station.bayCount` — which is
    // the same number its own `provision` step will use.
    const station = createStationFromScenario(scenario, variables, target, context.provisioning);
    const startTime = Date.now();

    try {
      if (!scenario.defer_mqtt_connect) {
        if (scenario.expect_connect_failure) {
          const timeoutMs = scenario.expect_connect_failure_timeout_ms ?? 10000;
          const detail = await connectExpectingFailure(station, timeoutMs);
          const classified = classifyRefusalReason(detail);

          // Invariant 6: when a scenario pins the reason, a refusal for the
          // WRONG reason is a FAIL — a client-side TLS-version refusal (or a
          // bare hang) must not satisfy a broker-CRL revocation proof.
          if (
            scenario.expect_refusal_reason &&
            classified.reason !== scenario.expect_refusal_reason
          ) {
            const msg =
              `expect_refusal_reason: expected '${scenario.expect_refusal_reason}' but the connection ` +
              `was refused for '${classified.reason}' (${classified.layer} layer): ${detail}`;
            console.error('[ScenarioRunner] "%s" — %s', scenario.name, msg);
            context.stepResults.push({
              stepIndex: -1,
              action: 'connect',
              status: 'failed',
              durationMs: Date.now() - startTime,
              error: msg,
            });
            return {
              name: scenario.name,
              status: 'failed',
              durationMs: Date.now() - startTime,
              error: msg,
              steps: context.stepResults,
            };
          }

          console.log(
            '[ScenarioRunner] "%s" — connect rejected as expected [%s]: %s',
            scenario.name,
            classified.reason,
            detail,
          );
          context.stepResults.push({
            stepIndex: -1,
            action: 'connect',
            status: 'passed',
            durationMs: Date.now() - startTime,
            error: `expected rejection confirmed [${classified.reason}]: ${detail}`,
          });
          return {
            name: scenario.name,
            status: 'passed',
            durationMs: Date.now() - startTime,
            steps: context.stepResults,
          };
        }
        await station.connect();
      }

      // See UNACKED_EVENT_SETTLE_MS. Held across the loop, not per step: the floor is
      // measured from the publish, so anything the scenario did in between counts towards it.
      let unackedEventAt: number | null = null;

      for (let i = 0; i < scenario.steps.length; i++) {
        const rawStep = scenario.steps[i];

        // BEFORE stepStart, so the wait belongs to the ordering and not to the step's own
        // reported duration. `action` is read off the raw step deliberately: it carries no
        // template and substitution has not run yet.
        if ((rawStep as StepDefinition | undefined)?.action === 'api_call') {
          const topUp = settleTopUpMs(unackedEventAt, Date.now());
          if (topUp > 0) {
            console.log(
              '[ScenarioRunner] settling %dms before step %d (api_call) — an unacknowledged Event is still in flight',
              topUp,
              i,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, topUp));
          }
          unackedEventAt = null;
        }

        const stepStart = Date.now();

        // Apply template substitution to the entire step definition.
        //
        // Inside its own try/catch, because this throws on an unresolved
        // `{{var}}`/`{{captured.x}}` and used to do so OUTSIDE the step loop's
        // recording — so the step result was never pushed, the console printed a
        // bare red scenario name with no steps and no message, and the failure was
        // untriageable. Two files failed exactly this way on the UAT run
        // (single-session-drive, missing a documented `--var reason`; and
        // session-rejected-invalid-service-cross-station, missing two). Attribute it
        // to the step that could not be built.
        let substitutedStep: StepDefinition;
        try {
          substitutedStep = substituteTemplates(rawStep, {
            variables: context.variables,
            captured: context.captured,
            provisioning: context.provisioning,
            pool: context.pool,
          }) as StepDefinition;
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          context.stepResults.push({
            stepIndex: i,
            action: (rawStep as StepDefinition | undefined)?.action ?? '(unresolved)',
            status: 'failed',
            durationMs: Date.now() - stepStart,
            error: `template substitution failed: ${errorMsg}`,
          });
          throw err;
        }

        const stepImpl = STEP_REGISTRY.get(substitutedStep.action);
        if (!stepImpl) {
          const result: StepResult = {
            stepIndex: i,
            action: substitutedStep.action,
            status: 'failed',
            durationMs: Date.now() - stepStart,
            error: `Unknown step action: ${substitutedStep.action}`,
          };
          context.stepResults.push(result);
          throw new Error(result.error);
        }

        try {
          await stepImpl.execute(substitutedStep, context, station);
          if (isUnackedEventSend(substitutedStep)) {
            unackedEventAt = Date.now();
          }
          context.stepResults.push({
            stepIndex: i,
            action: substitutedStep.action,
            status: 'passed',
            durationMs: Date.now() - stepStart,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          context.stepResults.push({
            stepIndex: i,
            action: substitutedStep.action,
            status: 'failed',
            durationMs: Date.now() - stepStart,
            error: errorMsg,
          });
          throw err;
        }
      }

      // Background api_calls are fired and not awaited — deliberately, so the
      // scenario can keep sending on MQTT while a synchronous REST endpoint
      // blocks on the station's Response. Their `expect_status` is still an
      // assertion, so it is settled HERE, before the scenario is allowed to
      // pass. Without this the 37 background `expect_status` steps in this
      // corpus could not fail: the verdict arrived after the step was green.
      await settleBackgroundCalls(context);
      if (context.backgroundFailures.length > 0) {
        throw new Error(context.backgroundFailures.join(' | '));
      }

      return {
        name: scenario.name,
        status: 'passed',
        durationMs: Date.now() - startTime,
        steps: context.stepResults,
      };
    } catch (err) {
      return {
        name: scenario.name,
        status: 'failed',
        durationMs: Date.now() - startTime,
        steps: context.stepResults,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        await station.disconnect();
      } catch {
        // Best-effort disconnect
      }
      if (poolStationId && this.poolAllocator) {
        this.poolAllocator.release(poolStationId);
      }
      // Identity is single-use — no release. Once a scenario completes, its identity
      // stays consumed for the rest of the run, guaranteeing no other scenario reuses
      // the same session-mutate bucket.

      // Per-scenario teardown. Runs on FAILURE too — the leftovers measured on UAT came
      // from runs that died at the step after the one that created the org, so cleaning
      // up only the green path would have caught none of them. `--keep-created` is the
      // way out for a debugging run.
      await this.teardownCreated(scenario.name, context);
    }
  }

  /**
   * Remove what the scenario declared it created, or say — precisely, with ids — what
   * is still on the server.
   *
   * The failure branch is the point of this method. A teardown that logs "complete"
   * after a failed DELETE is worse than no teardown at all: the row survives, and the
   * one place its id was ever written scrolls past claiming success. So the catch
   * prints every recorded id under a LEFTOVERS banner, and the console line is only
   * ever emitted after the SQL has actually returned.
   */
  private async teardownCreated(scenarioName: string, context: ScenarioContext): Promise<void> {
    if (context.created.isEmpty()) return;

    if (this.keepCreated) {
      console.log(
        `[teardown] "${scenarioName}" — KEPT (--keep-created); these still exist:\n` +
        context.created.describe(),
      );
      return;
    }

    try {
      await teardownScenarioResources(context.created);
      console.log(
        `[teardown] "${scenarioName}" — removed ${context.created.list().length} created ` +
        `resource(s) + local artifacts`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[teardown] LEFTOVERS — "${scenarioName}" created the following and could NOT remove ` +
        `them. They are still on the server:\n${context.created.describe()}\n` +
        `  cause: ${detail}`,
      );
    }
  }

  async runAll(
    scenarioDir: string,
    target: TargetConfig,
    options: RunOptions = {},
  ): Promise<ScenarioResult[]> {
    const entries = await fs.readdir(scenarioDir, { withFileTypes: true });
    const yamlFiles = entries
      .filter(
        (e) =>
          e.isFile() &&
          (e.name.endsWith('.yaml') || e.name.endsWith('.yml')),
      )
      .map((e) => path.join(scenarioDir, e.name))
      .sort();

    const scenarios: ScenarioDefinition[] = [];
    for (const file of yamlFiles) {
      const scenario = await this.loadScenario(file);

      if (options.filter && !scenario.name.includes(options.filter)) {
        continue;
      }

      scenarios.push(scenario);
    }

    // Initialize pool allocator if target has station_pool
    if (target.stationPool && target.stationPool.length > 0) {
      this.poolAllocator = new StationPoolAllocator(target.stationPool);
    } else {
      this.poolAllocator = null;
    }

    if (options.maxWorkers && options.maxWorkers > 1) {
      return this.runParallel(scenarios, target, options.maxWorkers, options.userVars);
    }

    const cooldownMs = options.cooldownMs ?? 3000;
    const results: ScenarioResult[] = [];
    for (let i = 0; i < scenarios.length; i++) {
      if (i > 0 && cooldownMs > 0) {
        await new Promise<void>(r => setTimeout(r, cooldownMs));
      }
      const result = await this.runScenarioBounded(scenarios[i], target, options.userVars);
      results.push(result);
    }
    return results;
  }

  async runParallel(
    scenarios: ScenarioDefinition[],
    target: TargetConfig,
    maxWorkers: number,
    userVars?: Map<string, string>,
  ): Promise<ScenarioResult[]> {
    const semaphore = new Semaphore(maxWorkers);

    const tasks = scenarios.map(async (scenario) => {
      await semaphore.acquire();
      try {
        return await this.runScenarioBounded(scenario, target, userVars);
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(tasks);
  }
}
