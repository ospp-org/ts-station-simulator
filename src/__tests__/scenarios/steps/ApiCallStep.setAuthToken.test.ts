import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * set_auth_token is the C-018 mid-scenario identity switch verb: after
 * POST /organizations succeeds (as platform_admin), the scenario logs in
 * as the newly-onboarded tenant_owner via a second POST /v1/auth/login
 * and captures the fresh JWT via `set_auth_token: "data.access_token"`.
 * Every subsequent api_call MUST use that fresh token, not the cached
 * platform_admin token.
 */
describe('ApiCallStep set_auth_token (C-018 identity switch)', () => {
  // Station is only used by SendStep — ApiCallStep ignores it.
  const dummyStation = {} as Station;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures the response token and stores it in context.authToken', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.authToken = 'OLD_PLATFORM_TOKEN';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { access_token: 'NEW_CLIENT_TOKEN' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const step = new ApiCallStep();
    await step.execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/auth/login',
        body: { email: 'client@example.com', password: 'secret' },
        expect_status: 200,
        set_auth_token: 'data.access_token',
      },
      ctx,
      dummyStation,
    );

    expect(ctx.authToken).toBe('NEW_CLIENT_TOKEN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('subsequent api_call uses the newly-set token, not the previous one', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.authToken = 'OLD_PLATFORM_TOKEN';

    const fetchMock = vi.spyOn(globalThis, 'fetch')
      // Login step — returns the new client token.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { access_token: 'NEW_CLIENT_TOKEN' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // Subsequent admin step — we'll assert on its request.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: 'loc-1' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const step = new ApiCallStep();

    // Step 1: login + set_auth_token
    await step.execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/auth/login',
        body: { email: 'client@example.com', password: 'secret' },
        expect_status: 200,
        set_auth_token: 'data.access_token',
      },
      ctx,
      dummyStation,
    );

    // Step 2: subsequent call — should use the new token.
    // Pass X-Organization-Id explicitly so ApiCallStep does not trigger
    // ensureOrgId auto-discovery (which would fire another fetch and break
    // the mock sequence — and is irrelevant to this assertion).
    await step.execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/locations',
        headers: { 'X-Organization-Id': 'org-uuid-1' },
        body: { name: 'L1' },
        expect_status: 201,
      },
      ctx,
      dummyStation,
    );

    // Inspect the SECOND fetch call (the locations one).
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall).toBeDefined();
    const init = secondCall![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer NEW_CLIENT_TOKEN');
    expect(headers.Authorization).not.toContain('OLD_PLATFORM_TOKEN');
  });

  it('throws when set_auth_token jsonpath does not resolve to a non-empty string', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.authToken = 'EXISTING';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        // Response missing data.access_token deliberately.
        JSON.stringify({ data: { something_else: 'x' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const step = new ApiCallStep();
    await expect(step.execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/auth/login',
        body: { email: 'x', password: 'y' },
        expect_status: 200,
        set_auth_token: 'data.access_token',
      },
      ctx,
      dummyStation,
    )).rejects.toThrow(/set_auth_token/);

    // Existing token must remain — failure should not leave the context in a half-state.
    expect(ctx.authToken).toBe('EXISTING');
  });
});
