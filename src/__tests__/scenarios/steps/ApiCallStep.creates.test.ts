import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `creates:` is how a self-provisioning scenario tells the runner what it just brought
 * into existence, so the per-scenario teardown deletes an id the SERVER answered with
 * rather than one a naming convention suggested. The distinction is not cosmetic: the
 * organization delete CASCADEs its roles, members, service definitions and remaining
 * stations, so an id inferred from a capture that merely looks org-shaped would
 * eventually take a real tenant with it.
 *
 * The value therefore comes from a path into THIS response and nowhere else, and every
 * way of failing to read one is an error rather than a skipped record — a row that was
 * created but not recorded is a row nothing can clean up.
 */
describe('ApiCallStep creates: — recording what the response says was created', () => {
  const dummyStation = {} as Station;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const jsonResponse = (body: unknown, status = 201): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('records the id from the response path, with the route and path as its origin', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: { organization: { id: 'org-uuid-1' } } }),
    );

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/organizations',
        body: { name: 'E2E Org' },
        expect_status: 201,
        creates: { organization: 'data.organization.id' },
      },
      ctx,
      dummyStation,
    );

    expect(ctx.created.toHandle().createdOrgId).toBe('org-uuid-1');
    expect(ctx.created.describe()).toContain('POST /api/v1/organizations → data.organization.id');
  });

  it('records alongside capture — the two are independent, and both read the same body', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ user: { id: 'u-1', email: 'e2e-stn_x@onestoppay.dev' } }),
    );

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/auth/register',
        expect_status: 201,
        capture: { user_email: 'user.email' },
        creates: { user: 'user.email' },
      },
      ctx,
      dummyStation,
    );

    expect(ctx.captured.get('user_email')).toBe('e2e-stn_x@onestoppay.dev');
    expect(ctx.created.toHandle().createdUserEmails).toEqual(['e2e-stn_x@onestoppay.dev']);
  });

  it('THROWS when the path does not resolve — a created row with no recorded id is a leak', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ data: { id: 'loc-1' } }),
    );

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'http://test.local/api/v1/locations',
          expect_status: 201,
          creates: { location: 'data.location_id' },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/did not resolve to a non-empty string/);
  });

  it('THROWS on a kind teardown cannot delete', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ data: { id: 'x' } }));

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'http://test.local/api/v1/vehicles',
          expect_status: 201,
          creates: { vehicle: 'data.id' },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/"creates" key "vehicle" is not a resource teardown can delete/);
  });

  // The status check runs first, so a call that did NOT create what it meant to records
  // nothing — the ledger never claims ownership of a row that was never made.
  it('records nothing when the call failed its expect_status', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: { code: 'VALIDATION_ERROR' } }, 422),
    );

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'http://test.local/api/v1/organizations',
          expect_status: 201,
          creates: { organization: 'data.organization.id' },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/expected status 201, got 422/);

    expect(ctx.created.isEmpty()).toBe(true);
  });

  it('REFUSES background: true — the response is never read, so the id is never recorded', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'http://test.local/api/v1/organizations',
          background: true,
          creates: { organization: 'data.organization.id' },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/"creates" is not supported with "background: true"/);
  });

  it('REFUSES expect_body_text — the body is consumed once and creates needs it as JSON', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'GET',
          url: 'http://test.local/metrics',
          expect_status: 200,
          expect_body_text: 'ok',
          creates: { organization: 'data.id' },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/cannot be combined with/);
  });
});
