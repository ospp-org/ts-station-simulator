import { parse as parseYaml } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StepDefinition } from './steps/Step.js';
import type { ScenarioContext, StepResult } from './ScenarioContext.js';
import { createContext } from './ScenarioContext.js';
import { Station, type Handler } from '../station/Station.js';
import { BootNotificationHandler } from '../handlers/BootNotificationHandler.js';
import { OsppAction } from '@ospp/protocol';
import {
  generateStationId,
  generateSerialNumber,
  generateBayId,
  generateServiceId,
} from '../station/StationConfig.js';
import type { StationConfig, BayConfig } from '../station/StationConfig.js';
import { SendStep } from './steps/SendStep.js';
import { WaitForStep } from './steps/WaitForStep.js';
import { AssertStep } from './steps/AssertStep.js';
import { ApiCallStep } from './steps/ApiCallStep.js';
import { DelayStep } from './steps/DelayStep.js';
import { FaultStep } from './steps/FaultStep.js';
import { ProvisionStep } from './steps/ProvisionStep.js';
import { ProvisionStationPoolStep } from './steps/ProvisionStationPoolStep.js';
import { ConnectMqttStep } from './steps/ConnectMqttStep.js';
import type { Step } from './steps/Step.js';
import type { StationPool, PoolEntry } from './stations/StationPool.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioDefinition {
  name: string;
  target_url?: string;
  skip?: boolean;
  skip_reason?: string;
  /**
   * Conditional skip: when set AND the run is a `--bootstrap-pool` run, the scenario is
   * skipped with this reason (status 'skipped' — never failed/passed). For scenarios that are
   * incompatible with the shared pool but run fine standalone: e2e/* (self-provision their own
   * org+station → 409 vs the pool) and the cross-station regression (needs manual --var).
   * Transparent: counted as skipped so passed + failed + skipped = total.
   */
  skip_when_pooled?: string;
  /**
   * When true, the runner skips the automatic `station.connect()` call so
   * that scenarios can run pre-provisioning API steps (signup, org, station
   * register, provisioning-token) before the station has TLS material. The
   * scenario MUST include a `connect_mqtt` step once provisioning artifacts
   * exist on disk.
   */
  defer_mqtt_connect?: boolean;
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
    serverCa?: string;
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

export interface ScenarioResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  steps: StepResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

const STEP_REGISTRY: ReadonlyMap<string, Step> = new Map<string, Step>([
  ['send', new SendStep()],
  ['wait_for', new WaitForStep()],
  ['assert', new AssertStep()],
  ['api_call', new ApiCallStep()],
  ['delay', new DelayStep()],
  ['fault', new FaultStep()],
  ['provision', new ProvisionStep()],
  ['provision_station_pool', new ProvisionStationPoolStep()],
  ['connect_mqtt', new ConnectMqttStep()],
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
      result[key] = substituteTemplates(val, scope);
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

  const bayCount = scenarioDef.station.bayCount;
  for (let i = 1; i <= bayCount; i++) {
    vars.set(`bayId_${i}`, generateBayId());
  }

  const defaultServices = ['wash_basic', 'wash_premium', 'dry', 'vacuum'];
  for (let i = 0; i < defaultServices.length; i++) {
    vars.set(`serviceId_${i + 1}`, generateServiceId(defaultServices[i]));
  }

  // CLI --var overrides win over auto-generated values (last-write semantics).
  if (userVars) {
    for (const [k, v] of userVars) {
      vars.set(k, v);
    }
  }

  return vars;
}

// ---------------------------------------------------------------------------
// Disk hydration — read persisted bays.json into context.provisioning
// ---------------------------------------------------------------------------

interface BaysJsonShape {
  stationId?: string;
  bayIds?: string[];
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
        return {
          stationId: parsed.stationId,
          bayIds: [...parsed.bayIds],
          certPath: keyTemplate
            ? keyTemplate
                .replace('{{stationId}}', stationId)
                .replace(/-key\.pem$/, '.pem')
            : undefined,
          keyPath: keyTemplate
            ? keyTemplate.replace('{{stationId}}', stationId)
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
): Station {
  // Default to clean session for scenarios. Persistent sessions accumulate
  // server-published commands while the station is offline; on reconnect
  // EMQX delivers the entire backlog before our wait_for can match, which
  // pushed Heartbeat Response past the 5s scenario timeout (K2 §34 RCA).
  const cleanSession = scenarioDef.clean_session ?? true;
  const stationId = variables.get('stationId')!;
  const bayCount = scenarioDef.station.bayCount;

  const bays: BayConfig[] = [];
  for (let i = 1; i <= bayCount; i++) {
    const bayId = variables.get(`bayId_${i}`)!;
    bays.push({
      bayId,
      bayNumber: i,
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
      serverCa: resolve(tls.serverCa),
    };
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
}

export class IdentityPoolAllocator {
  private readonly available: IdentityCredentials[];
  private readonly initialSize: number;

  constructor(pool: IdentityCredentials[]) {
    // Defensive copy so the caller's source array stays untouched if it's
    // re-used elsewhere (e.g., serializePoolHandle).
    this.available = [...pool];
    this.initialSize = pool.length;
  }

  /**
   * Pop one identity off the FIFO queue. Throws if empty — pool depletion is
   * a programming error (the CLI's pool sizing contract guarantees enough),
   * never a runtime condition to recover from.
   */
  acquire(): IdentityCredentials {
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

  /** Remaining identities (diagnostics only — not used for runtime decisions). */
  remaining(): number {
    return this.available.length;
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

  /** Install a run-level pool (see {@link runPool}). */
  setRunPool(pool: StationPool): void {
    this.runPool = pool;
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

  /** Build a transparent 'skipped' result (status 'skipped', reason on a marker step). */
  private skippedResult(name: string, reason: string): ScenarioResult {
    console.log('[ScenarioRunner] SKIPPED "%s": %s', name, reason);
    return {
      name,
      status: 'skipped',
      durationMs: 0,
      steps: [{ stepIndex: -1, action: 'skip', status: 'skipped', durationMs: 0, error: reason }],
    };
  }

  async runScenario(
    scenario: ScenarioDefinition,
    target: TargetConfig,
    userVars?: Map<string, string>,
  ): Promise<ScenarioResult> {
    if (scenario.skip) {
      return this.skippedResult(scenario.name, scenario.skip_reason ?? 'marked as skip');
    }
    // Conditional skip: a pool-incompatible scenario in a --bootstrap-pool run (this.runPool set).
    // Transparent — reported 'skipped', never silently dropped or counted as passed.
    if (scenario.skip_when_pooled && this.runPool !== null) {
      return this.skippedResult(scenario.name, scenario.skip_when_pooled);
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

    // Allocate stationId from pool if available (skip if YAML hardcodes one)
    const hardcodedStationId = scenario.station.stationId &&
      !scenario.station.stationId.includes('{{');
    let poolStationId: string | null = null;
    if (this.poolAllocator && !hardcodedStationId) {
      poolStationId = await this.poolAllocator.acquire();
    }

    // Per-scenario identity allocation. SINGLE-USE: shifted off the FIFO pool here,
    // never released back (see IdentityPoolAllocator doc). Each scenario owns its
    // identity for its lifetime — no other scenario in this run will use the same
    // user_id, so the per-user session-mutate bucket can't be contested.
    let acquiredIdentity: IdentityCredentials | null = null;
    if (this.identityPoolAllocator) {
      acquiredIdentity = this.identityPoolAllocator.acquire();
    }

    const variables = generateVariables(scenario, target, poolStationId, userVars);
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
        for (let i = 0; i < hydrated.bayIds.length; i++) {
          variables.set(`bayId_${i + 1}`, hydrated.bayIds[i]);
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

    const station = createStationFromScenario(scenario, variables, target);
    const startTime = Date.now();

    try {
      if (!scenario.defer_mqtt_connect) {
        await station.connect();
      }

      for (let i = 0; i < scenario.steps.length; i++) {
        const rawStep = scenario.steps[i];
        const stepStart = Date.now();

        // Apply template substitution to the entire step definition
        const substitutedStep = substituteTemplates(rawStep, {
          variables: context.variables,
          captured: context.captured,
          provisioning: context.provisioning,
          pool: context.pool,
        }) as StepDefinition;

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
      const result = await this.runScenario(scenarios[i], target, options.userVars);
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
        return await this.runScenario(scenario, target, userVars);
      } finally {
        semaphore.release();
      }
    });

    return Promise.all(tasks);
  }
}
