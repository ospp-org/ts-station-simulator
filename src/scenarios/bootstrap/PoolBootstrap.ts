import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TargetConfig } from '../ScenarioRunner.js';
import { StationPool } from '../stations/StationPool.js';
import {
  generateEcdsaP256KeyPair,
  buildCsr,
  exportPrivateKeyPkcs8Pem,
  exportPublicKeySpkiPem,
} from '../../cli/provision.js';
import {
  generateStationId,
  generateSerialNumber,
  generateServiceId,
} from '../../station/StationConfig.js';
import {
  assertUatDbReachable,
  setOfflineEnabled,
  seedServiceCatalog,
  seedTestUsers,
  buildTeardownTestUsersSql,
  DEFAULT_SEED_SERVICES,
  runUatSql,
  sqlLiteral,
  uatDbConfigFromEnv,
  type UatDbConfig,
} from './uatPrivileged.js';

/**
 * Per-run station-pool bootstrap (F-PROC-1 fix).
 *
 * Restores hermetic, fresh-per-run testability for the ~90 pool-dependent
 * scenarios whose permanent UAT station pool "evaporated". At suite start this
 * module, acting as a single tenant_owner identity:
 *
 *   1. Logs in (JWT) and resolves the caller's organization (admin context).
 *   2. Creates one fresh location under that org.
 *   3. Registers + provisions N fresh stations (register → token → provision),
 *      writing TLS artifacts into the target's existing `certs/<env>/` flat
 *      layout (`<id>-key.pem`, `<id>.pem`, `<id>-chain.pem`, `<id>-bays.json`)
 *      so the runner's Station.connect() and disk-hydration light up with ZERO
 *      per-scenario edits — scenarios keep using `{{stationId}}` / `{{bayId_N}}`.
 *   4. Runs the privileged offline-enable step (DB-only flag, no API path).
 *
 * The returned {@link PoolBootstrapHandle} feeds the runner's allocator
 * (`target.stationPool = handle.stationIds`) and `target.orgId`, and drives the
 * idempotent {@link teardownPool} at suite end (finally/afterAll).
 *
 * Org creation needs platform_admin; the configured UAT identity is a
 * tenant_owner, so the bootstrap REUSES that owner's existing org (stable
 * seeded infra) and only the location + stations are fresh-per-run + torn down.
 */
export interface PoolBootstrapOptions {
  /** Number of stations to provision into the pool. */
  poolSize: number;
  /** Bays per provisioned station (covers the max bayId_N any scenario uses). */
  bayCount: number;
  /** Run the privileged users.offline_enabled=true step (UAT DB). */
  enableOffline: boolean;
  /**
   * Number of test users (tenant_operator) to mint into the org for per-scenario identity
   * isolation (single-use FIFO — each scenario consumes one identity, never reused within
   * the run). CLI auto-sizes this to `max(scenarioCount, workers)` so the session-mutate
   * bucket (10/min/user, ≤4 mutations/scenario per spec) cannot be contested across tests.
   * Pass 0 to skip identity seeding entirely (legacy single-identity behavior — only useful
   * for one-shot debugging runs).
   */
  identityPoolSize: number;
  /** Explicit org UUID; when absent, discovered from the caller's memberships. */
  orgId?: string;
  /** UAT DB access config for privileged steps; defaults from env. */
  dbConfig?: UatDbConfig;
}

export interface PoolBootstrapHandle {
  orgId: string;
  /**
   * The ephemeral tenant_owner this run minted from the platform admin (Direction B:
   * the pool builder is self-sufficient on identity). Deleted at teardown. Absent on
   * legacy handles.
   */
  ephemeralOwnerEmail?: string;
  /**
   * The organization this run CREATED (platform_admin POST /organizations). Teardown
   * deletes ONLY this id — never a pre-existing org.
   */
  createdOrgId?: string;
  /** Location created this run (deleted at teardown). */
  locationId?: string;
  /** Business station_ids provisioned this run (deleted at teardown). */
  stationIds: string[];
  /** Email whose offline_enabled was flipped on (reset at teardown). */
  offlineEnabledEmail?: string;
  /** Local cert artifact files written this run (removed at teardown). */
  certFiles: string[];
  /**
   * `svc_*` codes seeded into `service_definitions` for this run's org. Teardown's
   * orphan-sweep is scoped to this set so we only remove definitions we could have created,
   * and only when no remaining `station_services` references them.
   */
  seededServiceIds: string[];
  /**
   * Per-scenario tenant_operator identities minted this run, one per identity-pool slot.
   * The runner's IdentityPoolAllocator hands these out single-use (never reused within the
   * run) so each scenario drives its own server-side `session-mutate` bucket. Teardown
   * sweeps the full FK web rooted at each user (wallets+wallet_entries, offline_passes,
   * sessions, reservations, payment_intents, vehicles, organization_members, invitations,
   * Spatie roles+perms) — see `buildTeardownTestUsersSql` for the coverage rationale.
   */
  identityCredentials: Array<{ email: string; password: string }>;
  /** Live registry — also exposes the pool via the `{{pool.*}}` namespace. */
  pool: StationPool;
}

/** Error that still carries the partially-built handle so the caller can tear down. */
export class PoolBootstrapError extends Error {
  constructor(message: string, readonly handle: PoolBootstrapHandle) {
    super(message);
    this.name = 'PoolBootstrapError';
  }
}

/** JSON-serializable subset of a handle — enough to drive {@link teardownPool}. */
export interface SerializedPoolHandle {
  orgId: string;
  ephemeralOwnerEmail?: string;
  createdOrgId?: string;
  locationId?: string;
  stationIds: string[];
  offlineEnabledEmail?: string;
  certFiles: string[];
  /** Optional for backwards-compat with handles persisted before the seed landed. */
  seededServiceIds?: string[];
  /** Optional for backwards-compat with handles persisted before per-worker identity landed. */
  identityCredentials?: Array<{ email: string; password: string }>;
}

export function serializePoolHandle(handle: PoolBootstrapHandle): SerializedPoolHandle {
  return {
    orgId: handle.orgId,
    ephemeralOwnerEmail: handle.ephemeralOwnerEmail,
    createdOrgId: handle.createdOrgId,
    locationId: handle.locationId,
    stationIds: handle.stationIds,
    offlineEnabledEmail: handle.offlineEnabledEmail,
    certFiles: handle.certFiles,
    seededServiceIds: handle.seededServiceIds,
    identityCredentials: handle.identityCredentials,
  };
}

/** Rebuild a teardown-capable handle from disk (the live `pool` is not needed for teardown). */
export function handleFromSerialized(s: SerializedPoolHandle): PoolBootstrapHandle {
  return {
    orgId: s.orgId,
    ephemeralOwnerEmail: s.ephemeralOwnerEmail,
    createdOrgId: s.createdOrgId,
    locationId: s.locationId,
    stationIds: s.stationIds ?? [],
    offlineEnabledEmail: s.offlineEnabledEmail,
    certFiles: s.certFiles ?? [],
    seededServiceIds: s.seededServiceIds ?? [],
    identityCredentials: s.identityCredentials ?? [],
    pool: new StationPool(),
  };
}

interface ProvisionResponseData {
  clientCert: string;
  stationCaChain: string;
  brokerRootCa?: string;
  bayIds?: string[];
  mqttConfig?: { brokerUri?: string; [key: string]: unknown };
}

// ---------------------------------------------------------------------------
// Typed HTTP helpers
// ---------------------------------------------------------------------------

interface ApiCallSpec {
  method: string;
  url: string;
  token?: string;
  orgId?: string;
  body?: unknown;
  expectStatus: number;
}

/**
 * Per-request timeout (ms) for bootstrap HTTP calls. Without this, a stalled
 * TCP connection to the remote UAT API hangs the WHOLE run indefinitely (Node's
 * fetch has no default timeout) — observed bootstrapping a multi-station pool,
 * where one station's request silently wedged at 0% CPU. A bounded timeout turns
 * that into a clear, actionable error instead. Overridable via env for slow links.
 */
const API_TIMEOUT_MS = Number.parseInt(process.env.UAT_API_TIMEOUT_MS ?? '30000', 10);

async function apiCall(spec: ApiCallSpec): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
  if (spec.token) headers['Authorization'] = `Bearer ${spec.token}`;
  if (spec.orgId) headers['X-Organization-Id'] = spec.orgId;
  if (spec.method !== 'GET') headers['X-Idempotency-Key'] = randomUUID();

  let res: Response;
  try {
    res = await fetch(spec.url, {
      method: spec.method,
      headers,
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `${spec.method} ${spec.url} timed out after ${API_TIMEOUT_MS}ms ` +
        `(set UAT_API_TIMEOUT_MS to adjust)`,
      );
    }
    throw new Error(
      `${spec.method} ${spec.url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (res.status !== spec.expectStatus) {
    const text = await res.text();
    throw new Error(
      `${spec.method} ${spec.url} → ${res.status} (expected ${spec.expectStatus}): ${text.slice(0, 400)}`,
    );
  }
  // 204 No Content has no body.
  if (res.status === 204) return undefined;
  return res.json();
}

function pluck(obj: unknown, dottedPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dottedPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`bootstrap: expected non-empty string for ${what}, got ${JSON.stringify(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Cert artifact paths — derived from the target's existing certs/<env>/ layout
// ---------------------------------------------------------------------------

interface CertPaths {
  keyPath: string;
  certPath: string;
  chainPath: string;
  baysJsonPath: string;
  brokerCaPath: string;
  receiptKeyPath: string;
  receiptPubPath: string;
}

export function certPathsFor(target: TargetConfig, stationId: string): CertPaths {
  const keyPattern = target.tls?.keyPattern ?? target.tls?.key;
  if (!keyPattern) {
    throw new Error(
      'bootstrap: target has no certs.key/key_pattern — cannot place provisioned TLS material ' +
      'where Station.connect() expects it. Add a certs: block to the target in config/targets.yaml.',
    );
  }
  const sub = (p: string): string => p.replace(/\{\{stationId\}\}/g, stationId);
  const keyPath = sub(keyPattern);
  const certPattern = target.tls?.certPattern ?? target.tls?.cert ?? keyPattern.replace(/-key\.pem$/, '.pem');
  const certPath = sub(certPattern);
  // serverCa pattern doubles as the station_ca_chain file the runner uses as the
  // MQTT TLS trust anchor (UAT broker is a private OneStopPay CA hierarchy).
  const chainPattern = target.tls?.serverCa ?? keyPattern.replace(/-key\.pem$/, '-chain.pem');
  const chainPath = sub(chainPattern);
  const dir = path.dirname(keyPath);
  return {
    keyPath,
    certPath,
    chainPath,
    baysJsonPath: path.join(dir, `${stationId}-bays.json`),
    brokerCaPath: path.join(dir, `${stationId}-broker-ca.pem`),
    // Persist the receipt-signing keypair next to the TLS material so SendStep
    // can sign TransactionEvent.receipt per spec §6.2. ProvisionStep's own
    // layout uses the same naming convention.
    receiptKeyPath: path.join(dir, `${stationId}-receipt-key.pem`),
    receiptPubPath: path.join(dir, `${stationId}-receipt-pub.pem`),
  };
}

// ---------------------------------------------------------------------------
// Ephemeral provisioning identity (Direction B) — self-sufficient on identity
// ---------------------------------------------------------------------------

/**
 * Read the PERSISTENT platform-admin credentials from the environment (sourced from
 * ~/.config/osp-e2e-secrets.env). This is the ONLY identity the pool builder needs from
 * outside — it mints everything else (an ephemeral tenant_owner + its org) itself. The pool
 * builder no longer reads UAT_EMAIL: that ad-hoc identity drifted on every DB wipe and broke
 * the builder repeatedly; the platform admin is the stable, seeded anchor (E2EBootstrapSeeder).
 */
export function platformAdminCredsFromEnv(
  env: Record<string, string | undefined> = process.env,
): { email: string; password: string } {
  const email = env.UAT_E2E_PLATFORM_ADMIN_EMAIL ?? '';
  const password = env.UAT_E2E_PLATFORM_ADMIN_PASSWORD ?? '';
  if (email === '' || password === '') {
    throw new Error(
      'PoolBootstrap requires UAT_E2E_PLATFORM_ADMIN_EMAIL and UAT_E2E_PLATFORM_ADMIN_PASSWORD ' +
      '(source ~/.config/osp-e2e-secrets.env). The pool builder mints its own ephemeral ' +
      'tenant_owner from the persistent platform admin — it no longer uses UAT_EMAIL.',
    );
  }
  return { email, password };
}

export interface EphemeralProvisioningIdentity {
  /** tenant_owner JWT for the freshly-created org — used for all provisioning calls. */
  token: string;
  /** The org this run CREATED (torn down). */
  orgId: string;
  /** The ephemeral customer promoted to tenant_owner (password-hash source + torn down). */
  ownerEmail: string;
  /** The generated password the ephemeral owner registered + logs in with. */
  ownerPassword: string;
}

/** Domain for the run-scoped ephemeral owner. A registered (active) user, deletable at teardown. */
const EPHEMERAL_OWNER_DOMAIN = 'onestoppay.dev';

/**
 * Generate a random password meeting typical complexity (upper + lower + digit + special +
 * entropy). The `Pp1!` prefix guarantees one of each class; the UUID hex supplies the entropy.
 */
function generateOwnerPassword(): string {
  return `Pp1!${randomUUID().replace(/-/g, '')}`;
}

/**
 * Mint an ephemeral tenant_owner from the persistent platform admin, reusing the e2e
 * onboarding sequence (the SINGLE provisioning-identity model — no second ad-hoc identity):
 *
 *   1. Platform admin logs in (persistent anchor).
 *   2. A fresh ephemeral customer self-registers — `register-first` so it is `is_active=true`
 *      with a real `password_hash` and can therefore LOG IN (an org-create-only owner is
 *      created inactive/passwordless → login-blocked; CreateOrganizationAction).
 *   3. Platform admin creates an org with `owner_email` = that customer → the customer is
 *      promoted to `tenant_owner` of the new org (CreateOrganizationAction → MemberObserver).
 *   4. The customer logs in → a `tenant_owner` JWT scoped to the new org, carrying
 *      `locations.create` / `stations.create` / `stations.manage_provisioning_tokens` —
 *      exactly the tenant permissions the provisioning endpoints require (a bare platform_admin
 *      is 403'd on all three).
 */
export async function acquireEphemeralProvisioningIdentity(
  apiBaseUrl: string,
  admin: { email: string; password: string },
  runStamp: string,
): Promise<EphemeralProvisioningIdentity> {
  // 1. Platform admin login.
  const adminLogin = await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/auth/login`,
    body: { email: admin.email, password: admin.password },
    expectStatus: 200,
  });
  const adminToken = requireString(pluck(adminLogin, 'data.access_token'), 'platform admin data.access_token');

  // 2. Register the ephemeral owner (active + password set → loginable).
  const ownerEmail = `sim-pool-owner-${runStamp}@${EPHEMERAL_OWNER_DOMAIN}`;
  const ownerPassword = generateOwnerPassword();
  await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/auth/register`,
    body: {
      name: `Sim Pool Owner ${runStamp}`,
      email: ownerEmail,
      password: ownerPassword,
      password_confirmation: ownerPassword,
    },
    expectStatus: 201,
  });

  // 3. Platform admin creates the org on the owner's behalf → owner promoted to tenant_owner.
  const orgRes = await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/organizations`,
    token: adminToken,
    body: { name: `Sim Pool ${runStamp}`, owner_email: ownerEmail },
    expectStatus: 201,
  });
  const orgId = requireString(pluck(orgRes, 'data.organization.id'), 'org data.organization.id');

  // 4. Login as the promoted tenant_owner.
  const ownerLogin = await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/auth/login`,
    body: { email: ownerEmail, password: ownerPassword },
    expectStatus: 200,
  });
  const token = requireString(pluck(ownerLogin, 'data.access_token'), 'ephemeral owner data.access_token');

  return { token, orgId, ownerEmail, ownerPassword };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function bootstrapPool(
  target: TargetConfig,
  options: PoolBootstrapOptions,
): Promise<PoolBootstrapHandle> {
  if (!target.apiBaseUrl) {
    throw new Error('bootstrap: target.apiBaseUrl is required');
  }
  const apiBaseUrl = target.apiBaseUrl;
  const dbConfig = options.dbConfig ?? uatDbConfigFromEnv();
  // Direction B — class-of-problem fix: the pool builder is SELF-SUFFICIENT on identity.
  // It no longer reads target.credentials/UAT_EMAIL (an ad-hoc identity nothing recreates →
  // drifts on every DB wipe → 401 → broken builder, 5× over). It mints its own ephemeral
  // tenant_owner from the PERSISTENT platform admin instead.
  const runStamp = randomUUID().slice(0, 8);

  const handle: PoolBootstrapHandle = {
    orgId: options.orgId ?? '',
    stationIds: [],
    certFiles: [],
    seededServiceIds: [],
    identityCredentials: [],
    pool: new StationPool(),
  };

  try {
    // Fail fast on privileged DB access BEFORE provisioning. The catalog seed AND teardown
    // both need it unconditionally; the offline-enable step (when on) too. A pool with no
    // catalog is worthless (every session/start 404s INVALID_SERVICE), so make DB reachability
    // a hard precondition for every bootstrap.
    await assertUatDbReachable(dbConfig);

    // 1-2. Identity — mint an ephemeral tenant_owner from the persistent platform admin
    //      (register customer → platform_admin org-create via owner_email → login as the
    //      promoted owner). Both the owner and the org it owns are deleted at teardown.
    const admin = platformAdminCredsFromEnv();
    console.log(`[bootstrap] minting ephemeral tenant_owner from platform admin ${admin.email}…`);
    const identity = await acquireEphemeralProvisioningIdentity(apiBaseUrl, admin, runStamp);
    const token = identity.token;
    handle.orgId = identity.orgId;
    handle.createdOrgId = identity.orgId;
    handle.ephemeralOwnerEmail = identity.ownerEmail;
    console.log(`[bootstrap] ephemeral owner ${identity.ownerEmail} → org ${handle.orgId}`);

    // 3. Fresh location
    const locRes = await apiCall({
      method: 'POST',
      url: `${apiBaseUrl}/api/v1/locations`,
      token,
      orgId: handle.orgId,
      body: {
        name: `Pool Bootstrap ${new Date().toISOString()}`,
        address: 'Strada Simulare 1, Bucuresti',
        latitude: 44.4268,
        longitude: 26.1025,
        city: 'Bucharest',
        country: 'RO',
      },
      expectStatus: 201,
    });
    handle.locationId = requireString(pluck(locRes, 'data.id'), 'location data.id');
    console.log(`[bootstrap] created location ${handle.locationId}`);

    // 4. Provision N stations into the pool. Each attempt uses a FRESH stationId:
    //    a timed-out provision can leave a station registered (tracked in
    //    handle.stationIds → removed by teardown), so retrying must not reuse the
    //    id (would 409). One retry absorbs a transient stall without failing the
    //    whole run.
    const ATTEMPTS = 2;
    for (let i = 0; i < options.poolSize; i++) {
      let provisioned = false;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS && !provisioned; attempt++) {
        const stationId = generateStationId();
        try {
          await registerAndProvisionStation(
            apiBaseUrl, token, handle.orgId, handle.locationId, stationId, options.bayCount, target, handle,
          );
          console.log(`[bootstrap] provisioned ${i + 1}/${options.poolSize}: ${stationId}`);
          provisioned = true;
        } catch (err) {
          lastErr = err;
          console.warn(
            `[bootstrap] station ${i + 1}/${options.poolSize} attempt ${attempt}/${ATTEMPTS} failed ` +
            `(${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      if (!provisioned) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      }
    }

    // 5. Seed the three-tier service catalog so {{serviceId_*}} resolves to a real
    //    station_services row on every bootstrapped station. Non-optional — without this,
    //    every sessions/start 404s INVALID_SERVICE (validated in GATE 1). Rows are
    //    operationally indistinguishable from what UpdateServiceCatalogResponseHandler
    //    would write for a real MQTT roundtrip (see buildSeedCatalogSql doc + design note).
    await seedServiceCatalog(handle.orgId, handle.stationIds, DEFAULT_SEED_SERVICES, dbConfig);
    handle.seededServiceIds = DEFAULT_SEED_SERVICES.map((s) => s.serviceId);
    console.log(
      `[bootstrap] seeded service catalog (${handle.seededServiceIds.length} service(s) × ` +
      `${handle.stationIds.length} station(s)): ${handle.seededServiceIds.join(', ')}`,
    );

    // 6. Per-scenario identity pool (tenant_operator users sharing UAT_PASSWORD via
    //    password_hash copy). Single-use FIFO at the runner — every scenario gets a
    //    unique `user_id` for its lifetime, no two scenarios share the same
    //    `session-mutate` (10/min) bucket. The CLI auto-sizes `identityPoolSize` to
    //    `max(scenarioCount, workers)` so the pool can't deplete by design; ≤4
    //    mutations/scenario (spec max) vs 10/min budget means rate-limit 429 is
    //    structurally impossible. Skipped when identityPoolSize === 0 (legacy debug runs).
    //    `offline_enabled` is set on the seeded users to match `options.enableOffline` so
    //    /offline/passes scenarios pass the gate without a separate flip.
    if (options.identityPoolSize > 0) {
      const sourceEmail = identity.ownerEmail;
      const sourcePassword = identity.ownerPassword;
      const emails: string[] = [];
      for (let i = 0; i < options.identityPoolSize; i++) {
        emails.push(`sim-worker-${runStamp}-${i}@test.local`);
      }
      await seedTestUsers(handle.orgId, sourceEmail, emails, options.enableOffline, dbConfig);
      handle.identityCredentials = emails.map((email) => ({ email, password: sourcePassword }));
      console.log(
        `[bootstrap] seeded ${emails.length} tenant_operator identity(ies) ` +
        `(runStamp=${runStamp}, copied password_hash from ${sourceEmail}, ` +
        `offline_enabled=${options.enableOffline})`,
      );
    }

    // 7. Privileged offline-enable on UAT_EMAIL — legacy single-identity path only. When
    //    identityPoolSize > 0 the scenarios run as the seeded per-worker users (whose
    //    offline_enabled is set in step 6), so UAT_EMAIL's flag is irrelevant.
    if (options.enableOffline && options.identityPoolSize === 0) {
      const email = identity.ownerEmail;
      await setOfflineEnabled(email, true, dbConfig);
      handle.offlineEnabledEmail = email;
      console.log(`[bootstrap] offline_enabled=true for ${email}`);
    }

    console.log(
      `[bootstrap] ready: ${handle.stationIds.length} station(s), org ${handle.orgId}, location ${handle.locationId}`,
    );
    return handle;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PoolBootstrapError(`pool bootstrap failed: ${message}`, handle);
  }
}

async function registerAndProvisionStation(
  apiBaseUrl: string,
  token: string,
  orgId: string,
  locationId: string,
  stationId: string,
  bayCount: number,
  target: TargetConfig,
  handle: PoolBootstrapHandle,
): Promise<void> {
  // Register (sets is_active=true, creates bay rows). Record the id immediately
  // so teardown removes it even if a later step throws.
  const bays = Array.from({ length: bayCount }, (_, b) => ({
    bayNumber: b + 1,
    services: [{ serviceId: generateServiceId('wash_basic'), serviceName: 'Basic Wash' }],
  }));
  await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/admin/stations`,
    token,
    orgId,
    body: { stationId, stationModel: 'WashPro X200', stationVendor: 'SimCorp', locationId, bays },
    expectStatus: 201,
  });
  handle.stationIds.push(stationId);

  // Provisioning token (raw token returned exactly once)
  const tokenRes = await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/admin/stations/${stationId}/provisioning-tokens`,
    token,
    orgId,
    body: { note: 'per-run pool bootstrap' },
    expectStatus: 201,
  });
  const rawToken = requireString(pluck(tokenRes, 'data.rawToken'), 'data.rawToken');

  // Provision: keygen + CSR + receipt key, POST /stations/provision (200 OK).
  const tlsKeys = await generateEcdsaP256KeyPair();
  const csr = await buildCsr(stationId, tlsKeys);
  const receiptKeys = await generateEcdsaP256KeyPair();
  const provRes = await apiCall({
    method: 'POST',
    url: `${apiBaseUrl}/api/v1/stations/provision`,
    body: {
      provisioningToken: rawToken,
      serialNumber: generateSerialNumber(),
      bayCount,
      tlsCsr: csr.toString('pem'),
      receiptSigningPublicKey: exportPublicKeySpkiPem(receiptKeys.publicKey),
    },
    expectStatus: 200,
  });
  const data = pluck(provRes, 'data') as ProvisionResponseData | undefined;
  if (!data) throw new Error(`provision response for ${stationId} missing data envelope`);
  const clientCert = requireString(data.clientCert, `${stationId} data.clientCert`);
  const bayIds = data.bayIds;
  if (!Array.isArray(bayIds) || bayIds.length === 0) {
    throw new Error(`provision response for ${stationId} missing data.bayIds`);
  }

  // Persist artifacts into the target's flat certs/<env>/ layout.
  const paths = certPathsFor(target, stationId);
  await fs.mkdir(path.dirname(paths.keyPath), { recursive: true });
  const writes: Array<Promise<void>> = [
    fs.writeFile(paths.keyPath, exportPrivateKeyPkcs8Pem(tlsKeys.privateKey), { mode: 0o600 }),
    fs.writeFile(paths.certPath, clientCert),
    fs.writeFile(paths.chainPath, data.stationCaChain ?? clientCert),
    fs.writeFile(paths.baysJsonPath, JSON.stringify({ stationId, bayIds }, null, 2)),
    // Receipt-signing keypair — paired with the receiptSigningPublicKey already
    // POSTed to /api/v1/stations/provision above. Without persisting the
    // private key, SendStep has no key to sign TransactionEvent.receipt with,
    // and the Reconciler's ReceiptVerifier rejects every offline-tx as
    // invalid_receipt_signature.
    fs.writeFile(paths.receiptKeyPath, exportPrivateKeyPkcs8Pem(receiptKeys.privateKey), { mode: 0o600 }),
    fs.writeFile(paths.receiptPubPath, exportPublicKeySpkiPem(receiptKeys.publicKey)),
  ];
  handle.certFiles.push(
    paths.keyPath,
    paths.certPath,
    paths.chainPath,
    paths.baysJsonPath,
    paths.receiptKeyPath,
    paths.receiptPubPath,
  );
  if (typeof data.brokerRootCa === 'string' && data.brokerRootCa.length > 0) {
    writes.push(fs.writeFile(paths.brokerCaPath, data.brokerRootCa));
    handle.certFiles.push(paths.brokerCaPath);
  }
  await Promise.all(writes);

  handle.pool.register({
    stationId,
    bayIds,
    certPath: paths.certPath,
    keyPath: paths.keyPath,
    chainPath: paths.chainPath,
    brokerCaPath: typeof data.brokerRootCa === 'string' ? paths.brokerCaPath : undefined,
    receiptKeyPath: paths.receiptKeyPath,
  });
}

// ---------------------------------------------------------------------------
// Teardown — idempotent, FK-safe, scoped strictly to this run's resources
// ---------------------------------------------------------------------------

/**
 * Reverse the bootstrap. Safe to call with a partial handle and safe to re-run
 * (every statement is WHERE-scoped to this run's ids; deleting 0 rows is not an
 * error). Removes provisioned stations (+ children), the run location, resets
 * offline_enabled, and deletes local cert artifacts. Errors are collected and
 * surfaced together so one failing concern does not skip the others.
 */
export async function teardownPool(
  handle: PoolBootstrapHandle,
  dbConfig: UatDbConfig = uatDbConfigFromEnv(),
): Promise<void> {
  const errors: string[] = [];

  // 1. Server-side rows (single transaction, FK-ordered).
  try {
    await runUatSql(buildTeardownSql(handle), dbConfig);
    console.log(
      `[teardown] removed ${handle.stationIds.length} station(s)` +
      `${handle.locationId ? ' + location' : ''}` +
      `${handle.seededServiceIds && handle.seededServiceIds.length > 0 ? ' + orphan-swept seeded service_definitions' : ''}` +
      `${handle.identityCredentials && handle.identityCredentials.length > 0 ? ` + ${handle.identityCredentials.length} seeded identity(ies)` : ''}` +
      `${handle.offlineEnabledEmail ? ' + reset offline_enabled' : ''}`,
    );
  } catch (err) {
    errors.push(`server teardown: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Local cert artifacts.
  for (const file of handle.certFiles) {
    try {
      await fs.rm(file, { force: true });
    } catch (err) {
      errors.push(`rm ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  handle.pool.clear();

  if (errors.length > 0) {
    throw new Error(`teardown completed with errors:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * FK-safe DELETE script, built from authoritative UAT schema introspection
 * (pg_constraint + information_schema), NOT assumptions:
 *
 *  - `stations.id` is uuid; `stations.station_id` is the varchar business key.
 *  - Of all FKs referencing stations/bays, ONLY `station_services(→stations)` and
 *    `bay_services(→bays)` are ON DELETE CASCADE (and `security_events` is SET
 *    NULL); every other child is NO ACTION → must be deleted explicitly.
 *  - `sessions` has NO `station_id` column — it references a bay via `bay_id`
 *    (and an org via `organization_id`); reach it through bays only.
 *  - `reservations`/`offline_transactions` reference `bays.id` (uuid) via
 *    `bay_id` (offline_transactions also has a uuid `station_id` FK).
 *  - `service_catalogs`/`station_configurations`/`firmware_updates`/
 *    `diagnostics_uploads` reference `stations.id` (uuid) via `station_id`.
 *  - `certificates`/`provisioning_tokens` carry a *varchar* `station_id` equal to
 *    the business id and have NO FK to stations — they neither cascade nor block,
 *    but are removed by business id so re-provisioning the same id can't collide
 *    on the unique cert/token rows.
 *
 * Order: bay-children → station-children (uuid FK) → station-children (varchar id)
 * → bays → stations → location → offline reset. Every clause is scoped to this
 * run's ids, so an empty pool is a harmless no-op (idempotent + safe to re-run).
 */
export function buildTeardownSql(handle: PoolBootstrapHandle): string {
  const stationArray =
    handle.stationIds.length > 0
      ? `ARRAY[${handle.stationIds.map(sqlLiteral).join(', ')}]::text[]`
      : 'ARRAY[]::text[]';
  const locationArray =
    handle.locationId
      ? `ARRAY[${sqlLiteral(handle.locationId)}]::uuid[]`
      : 'ARRAY[]::uuid[]';

  // Resolve this run's uuid sets from the varchar business station_id.
  const sids = `SELECT id FROM stations WHERE station_id = ANY(${stationArray})`;
  const bays = `SELECT id FROM bays WHERE station_id IN (${sids})`;
  const sess = `SELECT id FROM sessions WHERE bay_id IN (${bays})`;

  // Topological delete order over the AUTHORITATIVE FK graph (pg_constraint,
  // verified — not assumed; an earlier hand-guessed order shipped a bug that
  // only surfaced against real session rows in a live run). Parent ← child:
  //   sessions     ← refunds.session_id, offline_transactions.reconciled_session_id
  //   reservations ← sessions.reservation_id
  //   bays         ← reservations, sessions, offline_transactions (+ bay_services CASCADE)
  //   stations     ← bays, service_catalogs, offline_transactions, station_configurations,
  //                  firmware_updates, diagnostics_uploads (+ station_services CASCADE,
  //                  security_events SET NULL)
  //   locations    ← stations
  // certificates/provisioning_tokens carry a *varchar* station_id with NO FK —
  // removed by business id so re-provisioning can't collide on their unique rows.
  // Children deleted before parents so FK checks stay ON (a missed table fails
  // loudly, never silently orphans). Each clause is scoped to this run's ids, so
  // an empty pool is a no-op and a re-run deletes nothing (idempotent).
  const lines = [
    'BEGIN;',
    `DELETE FROM refunds WHERE session_id IN (${sess});`,
    `DELETE FROM offline_transactions WHERE station_id IN (${sids}) OR bay_id IN (${bays}) OR reconciled_session_id IN (${sess});`,
    `DELETE FROM sessions WHERE bay_id IN (${bays});`,
    `DELETE FROM reservations WHERE bay_id IN (${bays});`,
    `DELETE FROM service_catalogs WHERE station_id IN (${sids});`,
    `DELETE FROM station_configurations WHERE station_id IN (${sids});`,
    `DELETE FROM firmware_updates WHERE station_id IN (${sids});`,
    `DELETE FROM diagnostics_uploads WHERE station_id IN (${sids});`,
    `DELETE FROM provisioning_tokens WHERE station_id = ANY(${stationArray});`,
    `DELETE FROM certificates WHERE station_id = ANY(${stationArray});`,
    `DELETE FROM bays WHERE station_id IN (${sids});`,
    `DELETE FROM stations WHERE station_id = ANY(${stationArray});`,
    `DELETE FROM locations WHERE id = ANY(${locationArray});`,
  ];

  // Orphan-sweep for service_definitions we seeded — symmetric ownership with the bootstrap.
  // Scoped to (a) THIS run's org, (b) THIS run's seeded svc_* codes, (c) only rows with NO
  // remaining station_services references (FK is ON DELETE RESTRICT so the clause is
  // intent-explicit + safe). After the `DELETE FROM stations` above cascades
  // `station_services`, our seeded definitions become orphan and get swept; any definition
  // still referenced by another station's catalog is left alone. Self-heals the pre-existing
  // stale `Premium Wash` row on its first inclusion in a run's seed set.
  if (handle.orgId && handle.seededServiceIds && handle.seededServiceIds.length > 0) {
    const seededSvcArray = `ARRAY[${handle.seededServiceIds.map(sqlLiteral).join(', ')}]::text[]`;
    lines.push(
      `DELETE FROM service_definitions sd WHERE sd.organization_id = ${sqlLiteral(handle.orgId)} AND sd.service_id = ANY(${seededSvcArray}) AND NOT EXISTS (SELECT 1 FROM station_services ss WHERE ss.service_definition_id = sd.id);`,
    );
  }

  // Per-worker identity sweep — drop the four-tier user state for every seeded sim-worker.
  // Scoped strictly to THIS run's stamped emails so no real user can ever be touched. The
  // order mirrors a reverse of the seed (children before parents): model_has_roles →
  // organization_members → wallets → users. Same pattern as setOfflineEnabled reset (which
  // we don't issue when identityPoolSize > 0 — UAT_EMAIL stays untouched in that mode).
  if (handle.identityCredentials && handle.identityCredentials.length > 0) {
    const seededEmails = handle.identityCredentials.map((c) => c.email);
    lines.push(...buildTeardownTestUsersSql(seededEmails));
  }

  if (handle.offlineEnabledEmail) {
    lines.push(`UPDATE users SET offline_enabled = false WHERE email = ${sqlLiteral(handle.offlineEnabledEmail)};`);
  }

  // Ephemeral identity teardown (Direction B). The pool builder minted its OWN tenant_owner
  // + org this run (see acquireEphemeralProvisioningIdentity); both must be removed, scoped
  // STRICTLY to this run's ids — never a pre-existing org, never the persistent platform admin.
  //   - The owner is swept via the same full-FK user-teardown as the per-scenario workers,
  //     which carries the C-018 protected-emails guard: it THROWS if the owner is ever the
  //     platform admin, so an identity-confusion regression fails loudly here, not on the DB.
  //   - The org's NO-ACTION children (organization_members, corporate_policies, invitations)
  //     are deleted before the org (FK-safe; pg_constraint-verified 2026-06-15). `locations` +
  //     `sessions` (also NO-ACTION → organizations) were already removed by the station/location
  //     path above. DELETE FROM organizations then CASCADE-removes the per-org cloned `roles`
  //     (+ their model_has_roles + role_has_permissions), `model_has_roles`,
  //     `service_definitions`, `offline_passes`, and any remaining `stations`.
  if (handle.ephemeralOwnerEmail) {
    lines.push(...buildTeardownTestUsersSql([handle.ephemeralOwnerEmail]));
  }
  if (handle.createdOrgId) {
    const createdOrgLit = sqlLiteral(handle.createdOrgId);
    lines.push(
      `DELETE FROM organization_members WHERE organization_id = ${createdOrgLit};`,
      `DELETE FROM corporate_policies WHERE organization_id = ${createdOrgLit};`,
      `DELETE FROM invitations WHERE organization_id = ${createdOrgLit};`,
      `DELETE FROM organizations WHERE id = ${createdOrgLit};`,
    );
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}
