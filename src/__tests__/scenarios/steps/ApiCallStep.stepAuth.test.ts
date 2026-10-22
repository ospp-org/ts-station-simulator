import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * ONE STEP AS ANOTHER IDENTITY.
 *
 * A pass is issued to the customer that asks for it, and revoked by a platform role: one file
 * proving "a wash after the revocation is refused" needs both identities, and a file-wide `auth:`
 * names one. The step's own `auth:` names the environment variables of the other, for that step
 * alone - the password reaches no template and no request body the runner prints, as the
 * file-wide override's never does either.
 */
describe('ApiCallStep - auth: for one step', () => {
  const station = {} as Station;
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SIM_TEST_STEP_EMAIL;
    delete process.env.SIM_TEST_STEP_PASSWORD;
  });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function scenarioContext() {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.authToken = 'CUSTOMER_TOKEN';
    ctx.apiCredentials = { email: 'customer@test.local', password: 'pw' };
    ctx.orgId = 'org-uuid-1';
    return ctx;
  }

  it('signs in as the identity the step names, sends its token, and leaves the scenario identity as it was', async () => {
    process.env.SIM_TEST_STEP_EMAIL = 'psa-step@test.local';
    process.env.SIM_TEST_STEP_PASSWORD = 'step-pw';
    const ctx = scenarioContext();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { data: { access_token: 'STEP_TOKEN' } }))
      .mockResolvedValueOnce(json(200, { success: true, newEpoch: 3 }));

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/admin/offline-passes/epochs/revoke',
        auth: { email_env: 'SIM_TEST_STEP_EMAIL', password_env: 'SIM_TEST_STEP_PASSWORD' },
        body: { reason: 'proof' },
        expect_status: 200,
      },
      ctx,
      station,
    );

    expect(fetchMock.mock.calls[0]![0]).toBe('http://test.local/api/v1/auth/login');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).email).toBe('psa-step@test.local');
    const sent = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(sent.Authorization).toBe('Bearer STEP_TOKEN');
    // A platform door: the scenario's organization is not this identity's to name.
    expect(sent['X-Organization-Id']).toBeUndefined();

    expect(ctx.authToken).toBe('CUSTOMER_TOKEN');
    expect(ctx.apiCredentials?.email).toBe('customer@test.local');
  });

  it('refuses a step whose identity variables are unset, before any request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'GET',
          url: 'http://test.local/api/v1/admin/offline-passes',
          auth: { email_env: 'SIM_TEST_STEP_EMAIL', password_env: 'SIM_TEST_STEP_PASSWORD' },
        },
        scenarioContext(),
        station,
      ),
    ).rejects.toThrow(/SIM_TEST_STEP_EMAIL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
