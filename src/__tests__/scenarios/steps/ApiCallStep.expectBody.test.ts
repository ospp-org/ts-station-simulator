import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiCallStep } from '../../../scenarios/steps/ApiCallStep.js';
import { createContext } from '../../../scenarios/ScenarioContext.js';
import type { Station } from '../../../station/Station.js';

/**
 * `expect_body` exists because `expect_status` cannot tell one refusal from
 * another. POST /api/v1/sessions/start answers 409 for a bay that is Occupied
 * (3001 BAY_BUSY), Unavailable (3011 BAY_MAINTENANCE), Faulted/Finishing/Unknown
 * (3002 BAY_NOT_READY) alike — see csms-server
 * SessionStateMachine::validateBayForStart. So the four session-rejection
 * scenarios asserted a status that their own broken precondition also produced:
 * with the bay stuck `unknown`, `-maintenance` got its 409 from 3002 and passed
 * while proving nothing about maintenance.
 *
 * These pin the discriminating field, and pin that a mismatch FAILS rather than
 * warns — the failure mode `background: true` had.
 */
describe('ApiCallStep expect_body (refusal-reason discrimination)', () => {
  // Station is only used by SendStep — ApiCallStep ignores it.
  const dummyStation = {} as Station;

  const errorBody = (osppCode: number, code: string) =>
    new Response(
      JSON.stringify({
        error: { code, ospp_code: osppCode, message: code },
        meta: { timestamp: '2026-08-07T00:00:00Z' },
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );

  const run = async (expected: number, actual: number, actualCode: string) => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorBody(actual, actualCode));
    return new ApiCallStep().execute(
      {
        action: 'api_call',
        method: 'POST',
        url: 'http://test.local/api/v1/sessions/start',
        body: { bay_id: 'bay_x', service_id: 'svc_x', duration_seconds: 300 },
        expect_status: 409,
        expect_body: { 'error.ospp_code': expected },
      },
      ctx,
      dummyStation,
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes when the ospp_code matches', async () => {
    await expect(run(3011, 3011, 'BAY_MAINTENANCE')).resolves.toBeUndefined();
  });

  it('FAILS when the status matches but the ospp_code does not — the 3002-vs-3011 case', async () => {
    // Both are 409. This is precisely what used to pass.
    await expect(run(3011, 3002, 'BAY_NOT_READY')).rejects.toThrow(
      /expected body "error\.ospp_code" to equal 3011, but got 3002/,
    );
  });

  it('FAILS when the path is absent rather than treating undefined as a match', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'BAY_BUSY' } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'http://test.local/api/v1/sessions/start',
          expect_status: 409,
          expect_body: { 'error.ospp_code': 3001 },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/but got undefined/);
  });

  it('refuses expect_body with background: true instead of silently ignoring it', async () => {
    const ctx = createContext();
    ctx.apiBaseUrl = 'http://test.local';
    await expect(
      new ApiCallStep().execute(
        {
          action: 'api_call',
          method: 'POST',
          url: 'http://test.local/api/v1/sessions/start',
          background: true,
          expect_status: 409,
          expect_body: { 'error.ospp_code': 3001 },
        },
        ctx,
        dummyStation,
      ),
    ).rejects.toThrow(/"expect_body" is not supported with "background: true"/);
  });
});
