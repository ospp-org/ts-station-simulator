import { randomUUID } from 'node:crypto';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

// ---------------------------------------------------------------------------
// Bounded 429 retry — Retry-After + jitter, cap 3 (opt-out via retry_on_429:false)
// ---------------------------------------------------------------------------

export interface ThrottleRetryOptions {
  /** When `false`, no retry happens — pass-through to caller's expect_status check. */
  enabled?: boolean;
  /** Max retries AFTER the first attempt (default 3 → at most 4 total fetch calls). */
  maxRetries?: number;
  /** Backoff base ms used when no Retry-After header is present (default 500). */
  base?: number;
  /** Multiplicative jitter applied to the backoff curve (±, default 0.2 = ±20%). */
  jitterPct?: number;
  /** Injectable RNG for deterministic tests. */
  rng?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable fetch for tests; defaults to global fetch at call time. */
  fetchFn?: typeof fetch;
  /** Notify on each retry (telemetry/test hook). */
  onRetry?: (info: { attempt: number; delayMs: number; url: string }) => void;
}

/**
 * Translate a 429 `Retry-After` header into a wait duration. RFC 7231 §7.1.3 allows two
 * forms — integer seconds (Laravel's `ThrottleRequests` middleware writes this) or
 * HTTP-date. When the header is absent or unparseable, fall back to exponential backoff
 * (`base × 2^attempt`) with multiplicative jitter so concurrent retriers don't synchronize.
 * `attempt` is 0-indexed: first retry is `attempt = 0`.
 */
export function computeRetryDelayMs(
  retryAfterHeader: string | null,
  attempt: number,
  options?: { base?: number; jitterPct?: number; rng?: () => number; nowMs?: number },
): number {
  const base = options?.base ?? 500;
  const jitterPct = options?.jitterPct ?? 0.2;
  const rng = options?.rng ?? Math.random;
  const nowMs = options?.nowMs ?? Date.now();

  if (retryAfterHeader !== null && retryAfterHeader !== '') {
    const trimmed = retryAfterHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const asSec = Number.parseInt(trimmed, 10);
      return Math.max(0, asSec * 1000);
    }
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - nowMs);
    }
    // Unparseable → fall through to exponential.
  }

  const exp = base * Math.pow(2, attempt);
  const jitter = 1 + (rng() * 2 - 1) * jitterPct;
  return Math.max(0, Math.round(exp * jitter));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Regenerate the `X-Idempotency-Key` header (if present) on a `RequestInit`, returning a
 * NEW init with a freshly-minted UUID for that header. All other headers preserved.
 *
 * Why this is mandatory for retries: the OSPP server's `IdempotencyMiddleware` caches
 * EVERY response under 500 (including 429s) for 86400s, keyed by the idempotency key.
 * Without regeneration, a retry with the SAME key hits the cache and replays the original
 * 429 — bypassing the rate-limit check entirely, even after the user's bucket has refilled.
 * The retry then fails not because the server is actually rate-limited, but because we're
 * looking at a stale cached response. Regenerating the key makes each retry a fresh
 * server-side request, evaluated against the CURRENT rate-limit window.
 *
 * Idempotency-key semantics nuance: this is the correct trade-off for 429-retries
 * specifically. For network-failure / timeout retries (which fetchWithThrottleRetry
 * does NOT do — those bubble up as rejected fetches), preserving the key would be right
 * so the server replays the original response. 429-retries are different: we WANT a
 * fresh evaluation past the rate-limit gate.
 */
function regenerateIdempotencyKey(init: RequestInit): RequestInit {
  const headers = init.headers;
  if (!headers) return init;

  const TARGET = 'x-idempotency-key';
  const fresh = randomUUID();

  if (headers instanceof Headers) {
    const cloned = new Headers(headers);
    for (const [k] of cloned.entries()) {
      if (k.toLowerCase() === TARGET) {
        cloned.set(k, fresh);
        return { ...init, headers: cloned };
      }
    }
    return init;
  }
  if (Array.isArray(headers)) {
    let touched = false;
    const cloned: Array<[string, string]> = headers.map(([k, v]) => {
      if (k.toLowerCase() === TARGET) {
        touched = true;
        return [k, fresh];
      }
      return [k, v];
    });
    return touched ? { ...init, headers: cloned } : init;
  }
  // Plain Record<string, string>
  const obj = headers as Record<string, string>;
  let touched = false;
  const cloned: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === TARGET) {
      cloned[k] = fresh;
      touched = true;
    } else {
      cloned[k] = v;
    }
  }
  return touched ? { ...init, headers: cloned } : init;
}

/**
 * `fetch` wrapper that retries on HTTP 429 up to a bounded cap, honoring the server's
 * `Retry-After` header when present. Non-429 responses pass straight through unchanged.
 * The retry only changes the SHAPE of timing under contention — it never silently swallows
 * a real failure: after the cap, the last 429 response is returned and the caller's
 * `expect_status` mismatch check still fires.
 *
 * Each retry MINTS A FRESH `X-Idempotency-Key` (when one is present on the request — i.e.,
 * any POST/PUT/PATCH). The server's `IdempotencyMiddleware` caches all <500 responses for
 * 86400s; reusing the same key on retry replays the cached 429 and bypasses the rate-limit
 * gate. With a fresh key per attempt, each retry is a fresh server-side request evaluated
 * against the current rate-limit window. See {@link regenerateIdempotencyKey}.
 */
export async function fetchWithThrottleRetry(
  url: string,
  init: RequestInit,
  opts: ThrottleRetryOptions = {},
): Promise<Response> {
  const enabled = opts.enabled !== false;
  const maxRetries = opts.maxRetries ?? 3;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const fetchFn = opts.fetchFn ?? fetch;

  let attempt = 0;
  let currentInit = init;
  // First attempt + up to `maxRetries` retries → at most `maxRetries + 1` fetch calls.
  while (true) {
    const response = await fetchFn(url, currentInit);
    if (!enabled || response.status !== 429 || attempt >= maxRetries) {
      return response;
    }
    const retryAfter = response.headers.get('Retry-After');
    const delayMs = computeRetryDelayMs(retryAfter, attempt, opts);
    // Drain the body so the underlying connection is freed before we sleep.
    await response.text().catch(() => undefined);
    opts.onRetry?.({ attempt, delayMs, url });
    await sleepFn(delayMs);
    // Mint a fresh X-Idempotency-Key (when present) so the next attempt is a genuine
    // server-side request, not a replay of the cached 429.
    currentInit = regenerateIdempotencyKey(currentInit);
    attempt++;
  }
}

function substituteTemplateValue(
  value: string,
  context: ScenarioContext,
): string {
  return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName: string) => {
    const trimmed = varName.trim();
    if (trimmed.startsWith('captured.')) {
      const captureKey = trimmed.slice('captured.'.length);
      const captured = context.captured.get(captureKey);
      if (captured === undefined) {
        throw new Error(`Captured variable not found: ${captureKey}`);
      }
      return String(captured);
    }
    const variable = context.variables.get(trimmed);
    if (variable === undefined) {
      throw new Error(`Template variable not found: ${trimmed}`);
    }
    return variable;
  });
}

function substituteTemplates(
  value: unknown,
  context: ScenarioContext,
): unknown {
  if (typeof value === 'string') {
    return substituteTemplateValue(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplates(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteTemplates(val, context);
    }
    return result;
  }
  return value;
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const tokenCache = new Map<string, string>();
const orgIdCache = new Map<string, string>();

async function ensureAuth(context: ScenarioContext): Promise<string | undefined> {
  if (context.authToken) return context.authToken;
  if (!context.apiBaseUrl || !context.apiCredentials) return undefined;

  const cacheKey = `${context.apiBaseUrl}::${context.apiCredentials.email}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    context.authToken = cached;
    return cached;
  }

  const loginUrl = `${context.apiBaseUrl}/api/v1/auth/login`;
  // Wrap login in the same 429-aware retry as ApiCallStep itself (commit f2b527b).
  // The server's `auth` limiter is `perMinute(30)->by(IP)` (brute-force protection,
  // not per-user) so per-scenario identity (93 distinct logins from one dev IP)
  // saturates it after the first ~30. The retry honors the server's Retry-After
  // header and lets the IP bucket replenish — single-shared-identity runs (1 login
  // total) never hit this path; per-scenario runs spread their logins across the
  // bucket's 60s refill window. Same retry mechanism, broader scope.
  const res = await fetchWithThrottleRetry(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email: context.apiCredentials.email,
      password: context.apiCredentials.password,
    }),
  }, {
    onRetry: ({ attempt, delayMs }) =>
      console.warn(`[ApiCallStep:auth] 429 retry ${attempt + 1}/3 for POST ${loginUrl} in ${delayMs}ms`),
  });

  if (!res.ok) {
    throw new Error(`API auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { data?: { access_token?: string } };
  const accessToken = data?.data?.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error(
      `API auth response missing data.access_token: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  tokenCache.set(cacheKey, accessToken);
  context.authToken = accessToken;
  return accessToken;
}

function methodRequiresIdempotencyKey(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH';
}

/**
 * Resolve the org UUID to inject as `X-Organization-Id`.
 *
 *   1. context.orgId (set from CLI --org-id flag) wins if present.
 *   2. Otherwise lazy-discover via GET /api/v1/organizations.
 *      Cache per (baseUrl, email). If the admin owns exactly one org,
 *      that's the auto-selected value. Zero or multi-org admins are
 *      errors — surface a clear message asking for explicit --org-id.
 *
 * Returns undefined when no resolution is possible (no auth, no baseUrl)
 * so the caller can simply skip injection.
 */
async function ensureOrgId(
  context: ScenarioContext,
  token: string,
): Promise<string | undefined> {
  if (context.orgId) return context.orgId;
  if (!context.apiBaseUrl || !context.apiCredentials) return undefined;

  const cacheKey = `${context.apiBaseUrl}::${context.apiCredentials.email}`;
  const cached = orgIdCache.get(cacheKey);
  if (cached) {
    context.orgId = cached;
    return cached;
  }

  const url = `${context.apiBaseUrl}/api/v1/organizations`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(
      `ApiCallStep: org auto-discovery failed (${res.status}): ${await res.text()}`,
    );
  }

  const body = await res.json() as { data?: Array<{ id?: string }> };
  const list = body?.data;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `ApiCallStep: admin user has no organization memberships; cannot inject X-Organization-Id. ` +
      `Set --org-id <uuid> on the simulator CLI or assign the user to an organization.`,
    );
  }
  if (list.length > 1) {
    const ids = list.map((o) => o.id).filter((id): id is string => typeof id === 'string');
    throw new Error(
      `ApiCallStep: admin user is member of ${list.length} organizations; cannot auto-pick. ` +
      `Pass --org-id <uuid> to disambiguate. Candidates: ${ids.join(', ')}`,
    );
  }

  const orgId = list[0]?.id;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error(
      `ApiCallStep: /api/v1/organizations returned an entry without a string \`id\` field`,
    );
  }

  orgIdCache.set(cacheKey, orgId);
  context.orgId = orgId;
  return orgId;
}

/**
 * Check whether the URL targets an endpoint that the server gates on
 * X-Organization-Id (currently anything under /api/v1/admin/).
 */
function requiresOrgHeader(url: string): boolean {
  return /\/api\/v1\/admin\//.test(url);
}

export class ApiCallStep implements Step {
  async execute(
    definition: StepDefinition,
    context: ScenarioContext,
    _station: Station,
  ): Promise<void> {
    const method = (definition.method as string) ?? 'GET';
    const rawUrl = definition.url as string;
    if (!rawUrl) {
      throw new Error('ApiCallStep requires a "url" field');
    }

    const url = substituteTemplateValue(rawUrl, context);
    const headers = definition.headers
      ? (substituteTemplates(definition.headers, context) as Record<string, string>)
      : undefined;
    const body = definition.body
      ? JSON.stringify(substituteTemplates(definition.body, context))
      : undefined;

    // Auto-authenticate if credentials are available
    const token = await ensureAuth(context);

    // Auto-inject X-Organization-Id for admin endpoints when not explicitly
    // supplied via scenario `headers:`. Skip for non-admin URLs (auth/login,
    // /organizations itself, etc.) so the auto-discovery call doesn't loop.
    const explicitOrgHeader =
      headers !== undefined && Object.keys(headers).some((k) => k.toLowerCase() === 'x-organization-id');
    // `omit_org_header: true` suppresses the auto-injected X-Organization-Id so a PLATFORM-scoped
    // api_call (e.g. install-certificate / trigger-cert-renewal, gated by
    // permission:platform.certificates.manage) resolves at the NULL/platform team instead of an
    // org team — where a platform_admin's NULL-scoped permission would be filtered out (403).
    // Confirmed empirically on UAT: org-less platform admin is authorized; org-scoped is 403.
    const omitOrgHeader = definition.omit_org_header === true;
    let autoOrgId: string | undefined;
    if (token && requiresOrgHeader(url) && !explicitOrgHeader && !omitOrgHeader) {
      autoOrgId = await ensureOrgId(context, token);
    }

    const fetchHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(autoOrgId ? { 'X-Organization-Id': autoOrgId } : {}),
      ...(methodRequiresIdempotencyKey(method) ? { 'X-Idempotency-Key': randomUUID() } : {}),
      ...headers,
    };

    const isBackground = definition.background === true;
    // 429 retry is on by default — only disabled with explicit `retry_on_429: false`.
    // Honors the server's Retry-After header; falls back to bounded exponential backoff +
    // jitter so concurrent retriers don't synchronize. After the cap, the last 429 reaches
    // the expect_status mismatch check exactly as before — no silent swallowing.
    const retryEnabled = definition.retry_on_429 !== false;
    const retryOpts: ThrottleRetryOptions = {
      enabled: retryEnabled,
      onRetry: ({ attempt, delayMs }) => {
        console.log(
          `[ApiCallStep${isBackground ? ':background' : ''}] 429 retry ${attempt + 1}/3 for ${method} ${url} in ${delayMs}ms`,
        );
      },
    };

    if (isBackground) {
      // Background mode: fire the request without awaiting. Required for
      // synchronous REST endpoints (e.g., POST /api/v1/sessions/start) that
      // block on the station's MQTT Response — the scenario's subsequent
      // wait_for + send Response steps must run while the fetch is in flight.
      // Errors and status mismatches log but do not fail the step; capture
      // is not supported in background mode.
      if (definition.capture !== undefined) {
        throw new Error(
          'ApiCallStep: "capture" is not supported with "background: true" (response not awaited)',
        );
      }
      fetchWithThrottleRetry(url, { method, headers: fetchHeaders, body }, retryOpts)
        .then(async (response) => {
          if (definition.expect_status !== undefined) {
            const expectedStatus = definition.expect_status as number;
            if (response.status !== expectedStatus) {
              const responseBody = await response.text();
              console.warn(
                `[ApiCallStep:background] ${method} ${url}: expected ${expectedStatus}, got ${response.status} — ${responseBody.slice(0, 200)}`,
              );
            }
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[ApiCallStep:background] ${method} ${url} failed: ${message}`);
        });
      return;
    }

    const response = await fetchWithThrottleRetry(
      url,
      { method, headers: fetchHeaders, body },
      retryOpts,
    );

    if (definition.expect_status !== undefined) {
      const expectedStatus = definition.expect_status as number;
      if (response.status !== expectedStatus) {
        const responseBody = await response.text();
        throw new Error(
          `ApiCallStep: expected status ${expectedStatus}, got ${response.status} — ${responseBody}`,
        );
      }
    }

    const needsBody =
      (definition.capture && typeof definition.capture === 'object') ||
      typeof definition.set_auth_token === 'string';

    if (needsBody) {
      const responseBody: unknown = await response.json();

      if (typeof definition.set_auth_token === 'string') {
        const tokenPath = definition.set_auth_token;
        const value = getNestedValue(responseBody, tokenPath);
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(
            `ApiCallStep: set_auth_token path "${tokenPath}" did not resolve to a non-empty string`,
          );
        }
        context.authToken = value;
      }

      if (definition.capture && typeof definition.capture === 'object') {
        for (const [varName, path] of Object.entries(
          definition.capture as Record<string, string>,
        )) {
          const value = getNestedValue(responseBody, path);
          context.captured.set(varName, value);
        }
      }
    }
  }
}
