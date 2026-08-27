import type { OsppEnvelope } from '@ospp/protocol';
import { StationPool } from './stations/StationPool.js';
import { ScenarioResourceLedger } from './bootstrap/ScenarioResources.js';
import { CookieJar } from './CookieJar.js';

/**
 * Provisioning artifact for the primary station. Populated either by
 * the in-scenario `provision` step or — when running with `--station`
 * against a target with persisted artifacts on disk — by ScenarioRunner
 * hydration from `tests/artifacts/<target>/<stationId>/bays.json`.
 *
 * Scenarios reference these via `{{ provisioning.* }}` template syntax.
 * If the namespace is referenced but the field is undefined, the
 * template engine throws (no silent fallback to random bayIds — that
 * was the root cause of V4 Finding #1).
 */
export interface ProvisioningArtifact {
  stationId: string;
  /**
   * v0.11.0 wire shape: {bayId, bayNumber} pairs, explicit and order-free.
   * provisioning-response.schema.json:21 — "This is the mapping the station needs
   * and the only one it is given."
   */
  bays?: Array<{ bayId: string; bayNumber: number }>;
  /**
   * The 0-indexed template convenience, SORTED BY bayNumber. Distinct from
   * `bays`: {{ provisioning.bayIds[0] }} means "the scenario's first bay", not
   * "bay number 1", and for a non-dense {1,3} declaration those differ. Read
   * `bays` when the bay NUMBER matters.
   */
  bayIds: string[];
  certPath?: string;
  keyPath?: string;
  chainPath?: string;
  /**
   * Per-station ECDSA-P256 receipt-signing private key (PKCS8 PEM) persisted at
   * provisioning. Surfaced by disk hydration only when the file actually exists,
   * so `run --station <id>` can wire it into the pool for SendStep to sign
   * offline TransactionEvent receipts.
   */
  receiptKeyPath?: string;
}

export interface ScenarioContext {
  /** Template variables: stationId, serialNumber, bayId_1, etc. */
  variables: Map<string, string>;
  /** Values captured by WaitFor steps */
  captured: Map<string, unknown>;
  /**
   * Primary-station provisioning artifact. Populated by ProvisionStep
   * or by ScenarioRunner disk hydration. Scenarios reference via
   * `{{ provisioning.bayIds[0] }}`, `{{ provisioning.stationId }}`, etc.
   */
  provisioning?: ProvisioningArtifact;
  /**
   * Runtime registry of provisioned stations populated by the
   * `provision_station_pool` YAML step. Scenarios reference via
   * `{{ pool.first.bayIds[0] }}`, `{{ pool.station[N].id }}`, etc.
   */
  pool: StationPool;
  /** All messages sent during the scenario */
  sentMessages: OsppEnvelope[];
  /**
   * Sent Request messageIds already claimed by a WaitForStep awaiting the
   * correlated Response. Used for Drift 7-E FIFO auto-correlation so that
   * back-to-back Requests of the same action each match their own Response
   * even when Responses arrive out of order.
   */
  consumedSentMessageIds: Set<string>;
  /**
   * Received Request messageIds already claimed by a SendStep responding to
   * them. Mirror of consumedSentMessageIds for the inverse direction so that
   * back-to-back inbound Requests of the same action each get their own
   * correlated outbound Response (OSPP: Response.messageId === Request.messageId).
   */
  consumedReceivedMessageIds: Set<string>;
  /** All messages received during the scenario */
  receivedMessages: OsppEnvelope[];
  /** Step results for reporting */
  stepResults: StepResult[];
  /** Start time of the scenario */
  startTime: number;
  /** Cached JWT token for API calls */
  authToken?: string;
  /** API base URL for auth login */
  apiBaseUrl?: string;
  /** API credentials for JWT login */
  apiCredentials?: { email: string; password: string };
  /**
   * Organization UUID for multi-tenant routing. Auto-injected as
   * `X-Organization-Id` header on /api/v1/admin/* calls by ApiCallStep.
   *
   * Resolution order: CLI `--org-id` flag → auto-discovery via GET
   * /api/v1/organizations (only when exactly one org is returned).
   * Auto-discovery is lazy on first admin api_call.
   */
  orgId?: string;
  /**
   * Server-side rows this scenario CREATED, recorded at creation from the response the
   * server answered with — never inferred from a variable name. Populated by `creates:`
   * on an `api_call` step and by the `provision` step's local artifacts; consumed by the
   * runner's per-scenario teardown. See {@link ScenarioResourceLedger}.
   */
  created: ScenarioResourceLedger;
  /**
   * In-flight `background: true` api_call requests, and what their assertions
   * found once they settled.
   *
   * A backgrounded call returns before its response exists — that is the point,
   * since the scenario must keep sending on MQTT while the REST call blocks on
   * it. The cost, until now, was that `expect_status` on such a step could only
   * `console.warn`: 37 steps across 33 files declared an expected code that
   * nothing could act on. Recording the verdict here and settling it at the end
   * of the scenario keeps the concurrency and gets the assertion back.
   */
  backgroundCalls: Promise<void>[];
  backgroundFailures: string[];
  /**
   * Cookies collected by `api_call` steps that opted in with `cookies: true`, scoped per
   * origin. Empty and unused for every scenario that does not ask for it — see
   * {@link CookieJar} for why it is opt-in and for the RFC 6265 behaviour it does NOT have.
   */
  cookies: CookieJar;
}

export interface StepResult {
  stepIndex: number;
  action: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

export function createContext(): ScenarioContext {
  return {
    variables: new Map(),
    captured: new Map(),
    pool: new StationPool(),
    sentMessages: [],
    consumedSentMessageIds: new Set(),
    consumedReceivedMessageIds: new Set(),
    receivedMessages: [],
    stepResults: [],
    startTime: Date.now(),
    created: new ScenarioResourceLedger(),
    backgroundCalls: [],
    backgroundFailures: [],
    cookies: new CookieJar(),
  };
}
