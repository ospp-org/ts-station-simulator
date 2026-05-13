import { randomUUID } from 'node:crypto';
import type { Step, StepDefinition } from './Step.js';
import type { ScenarioContext } from '../ScenarioContext.js';
import type { Station } from '../../station/Station.js';

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
  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email: context.apiCredentials.email,
      password: context.apiCredentials.password,
    }),
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
    let autoOrgId: string | undefined;
    if (token && requiresOrgHeader(url) && !explicitOrgHeader) {
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
      fetch(url, { method, headers: fetchHeaders, body })
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

    const response = await fetch(url, {
      method,
      headers: fetchHeaders,
      body,
    });

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
