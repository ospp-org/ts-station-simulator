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

    const fetchHeaders: Record<string, string> = {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(methodRequiresIdempotencyKey(method) ? { 'X-Idempotency-Key': randomUUID() } : {}),
      ...headers,
    };

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

    if (definition.capture && typeof definition.capture === 'object') {
      const responseBody: unknown = await response.json();
      for (const [varName, path] of Object.entries(
        definition.capture as Record<string, string>,
      )) {
        const value = getNestedValue(responseBody, path);
        context.captured.set(varName, value);
      }
    }
  }
}
