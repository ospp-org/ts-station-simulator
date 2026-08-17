import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * RE-AUTH ON 401 — one retry, tightly scoped.
 *
 * THE CEILING THIS REMOVES, measured 2026-08-17. The access token lives 900
 * seconds and nothing refreshed it, so a scenario running longer than fifteen
 * minutes could not make an authenticated API read at the end: the call came
 * back `401 {"error":"token_expired"}` and the step failed on auth instead of on
 * its assertion. `firmware-stalled-after-accept.yaml` is exactly that shape — it
 * has to out-wait a 10-minute server constant swept every five minutes, i.e. up
 * to fifteen — and it failed this way while the SERVER had done its part
 * correctly (the row was `failed`/`stalled`, verified directly in Postgres).
 *
 * WHAT A COMPLETELY BROKEN INSTRUMENT WOULD ANSWER HERE, which is the question
 * that shaped these cases. A step that blindly retried EVERY failed request
 * would satisfy "a 401 gets retried" just as well as the real fix — and would
 * quietly destroy this corpus's negative scenarios, several of whose SUBJECT is
 * a refusal. So the retry is asserted to be scoped, and three of the five cases
 * below assert that it does NOT happen:
 *
 *   - not without a token (an unauthenticated 401 is the answer, not an accident)
 *   - not more than once (a second 401 is authorization, and must surface)
 *   - not on 403 (a permission verdict; the same identity would get it again)
 *
 * A version of the fix that got any of those wrong passes the happy case and
 * fails here, which is the whole point of them being here.
 */
describe('ApiCallStep — re-auth once on 401, and only where it is safe', () => {
  const dummyStation = {} as Station;
  afterEach(() => vi.restoreAllMocks());

  /** A context that already holds a (stale) token AND the credentials to renew it. */
  function ctxWithStaleToken() {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    ctx.authToken = 'STALE_TOKEN';
    ctx.apiCredentials = { email: 'admin@test.local', password: 'pw' };
    ctx.orgId = 'org-uuid-1'; // so ensureOrgId never fetches
    return ctx;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const expired = () => json(401, { error: 'token_expired', message: 'Access token has expired' });
  const loginOk = (tok: string) => json(200, { data: { access_token: tok } });
  const ok = (body: unknown = { data: {} }) => json(200, body);

  it('retries once with a FRESH token after a 401, and the assertion then sees the retry', async () => {
    const ctx = ctxWithStaleToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(expired())                      // 1. the real call, stale token
      .mockResolvedValueOnce(loginOk('FRESH_TOKEN'))         // 2. the re-login
      .mockResolvedValueOnce(ok({ data: { status: 'failed' } })); // 3. the retry

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'GET',
        url: 'http://test.local/api/v1/admin/stations/stn_x/firmware',
        expect_status: 200,
        expect_body: { 'data.status': 'failed' },
      },
      ctx,
      dummyStation,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The FIRST call carried the stale token — otherwise this test is not
    // reproducing the situation it claims to.
    const first = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(first.Authorization).toBe('Bearer STALE_TOKEN');

    // The SECOND is the login, at the login URL.
    expect(fetchMock.mock.calls[1]![0]).toBe('http://test.local/api/v1/auth/login');

    // The THIRD is the same request with the NEW token. `Bearer FRESH_TOKEN` is
    // the load-bearing assertion: a retry that reused the stale token would get
    // the same 401 and prove nothing, and it is exactly what a fix that cleared
    // only one of the two token stores would produce.
    expect(fetchMock.mock.calls[2]![0]).toBe(
      'http://test.local/api/v1/admin/stations/stn_x/firmware',
    );
    const third = (fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>;
    expect(third.Authorization).toBe('Bearer FRESH_TOKEN');

    // And the context carries it forward, so the NEXT step does not repeat the round trip.
    expect(ctx.authToken).toBe('FRESH_TOKEN');
  });

  /**
   * WHAT THIS CASE DOES AND DOES NOT ISOLATE — measured by mutation, 2026-08-17,
   * and recorded because the first version of this comment overclaimed.
   *
   * It proves an unauthenticated 401 is returned rather than retried. It does NOT
   * isolate the `token` guard from the `apiCredentials` guard: this context has
   * neither, so both are false at once. Mutating the condition to
   * `!response.ok && context.apiCredentials` — dropping the token guard AND the
   * 401 scope — leaves this case GREEN and reddens only the 403 case below.
   *
   * That is not a hole to patch, it is the shape of the code: `ensureAuth`
   * returns a token whenever credentials exist, so "credentials present, token
   * absent" is unreachable and no test can construct it. The `token` guard is
   * documentation, and the 403 case is what actually guards the scope.
   */
  it('does NOT retry a 401 when the call was unauthenticated — that 401 is the answer', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    // No authToken and NO credentials: ensureAuth returns undefined, so the
    // request goes out unauthenticated and its 401 is the result under test.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(expired());

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'GET',
        url: 'http://test.local/api/v1/admin/stations/stn_x/firmware',
        expect_status: 401,
      },
      ctx,
      dummyStation,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries ONCE — a second 401 surfaces instead of looping', async () => {
    const ctx = ctxWithStaleToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(loginOk('FRESH_TOKEN'))
      .mockResolvedValueOnce(expired()); // the fresh token is refused too

    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'GET',
          url: 'http://test.local/api/v1/admin/stations/stn_x/firmware',
          expect_status: 200,
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/expected status 200, got 401/);

    // Three, not five: no second re-login, no second retry.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a 403 — a permission verdict is not a stale token', async () => {
    const ctx = ctxWithStaleToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(403, { error: 'forbidden' }));

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'GET',
        url: 'http://test.local/api/v1/admin/stations/stn_x/firmware',
        expect_status: 403,
      },
      ctx,
      dummyStation,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.authToken).toBe('STALE_TOKEN'); // untouched
  });

  it('mints a NEW Idempotency-Key on a retried POST rather than replaying the first', async () => {
    const ctx = ctxWithStaleToken();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(loginOk('FRESH_TOKEN'))
      .mockResolvedValueOnce(json(202, { data: {} }));

    await new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/admin/stations/stn_x/firmware',
        body: { firmwareVersion: '2.0.0' },
        expect_status: 202,
      },
      ctx,
      dummyStation,
    );

    const firstKey = ((fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];
    const retryKey = ((fetchMock.mock.calls[2]![1] as RequestInit).headers as Record<string, string>)['Idempotency-Key'];

    expect(firstKey).toBeDefined();
    expect(retryKey).toBeDefined();
    // The server caches EVERY response under 500 against the key for 86400s, so
    // reusing it would replay the 401 rather than issue the authorized request.
    expect(retryKey).not.toBe(firstKey);
  });
});
